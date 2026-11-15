// Outbound HTTP client for notification webhooks, with an SSRF guard.
//
// The guard runs inside the socket's DNS lookup, so the address that is checked is
// exactly the address that is dialed. Checking first and connecting later would let
// a hostile DNS server answer "public" to the check and "169.254.169.254" to the
// connect (DNS rebinding). IP literals skip DNS, so they are checked up front, after
// the WHATWG URL parser has normalised tricks like 2130706433, 0x7f.1 or 0177.0.0.1
// into dotted-quad form.

import dns from 'node:dns';
import https from 'node:https';
import net from 'node:net';

const USER_AGENT = 'LastCall/1.0 (check-in alert)';
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

const BLOCKED_V4 = [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, includes the EC2/ECS metadata endpoints
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, includes 255.255.255.255
];

const BLOCKED_V6 = [
  ['::', 96], // unspecified, loopback (::1) and deprecated IPv4-compatible addresses
  ['64:ff9b::', 96], // NAT64, can embed any IPv4 address
  ['64:ff9b:1::', 48], // local-use NAT64
  ['100::', 64], // discard
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4, can embed private IPv4 addresses
  ['fc00::', 7], // unique local, includes AWS IMDS fd00:ec2::254
  ['fe80::', 10], // link-local
  ['fec0::', 10], // deprecated site-local
  ['ff00::', 8], // multicast
];

const blockList = new net.BlockList();
for (const [address, prefix] of BLOCKED_V4) blockList.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of BLOCKED_V6) blockList.addSubnet(address, prefix, 'ipv6');

export class OutboundError extends Error {
  constructor(message, { code, retryable = false, status } = {}) {
    super(message);
    this.name = 'OutboundError';
    this.code = code;
    this.retryable = retryable;
    if (status !== undefined) this.status = status;
  }
}

/**
 * True when an address must never be contacted. IPv4-mapped IPv6 addresses
 * (::ffff:127.0.0.1) are matched against the IPv4 rules by net.BlockList.
 * Anything that is not a valid IP is treated as blocked.
 */
export function isBlockedAddress(address) {
  const bare = String(address ?? '').replace(/^\[|\]$/g, '');
  const family = net.isIP(bare);
  if (family === 0) return true;
  return blockList.check(bare, family === 4 ? 'ipv4' : 'ipv6');
}

/** Static checks that need no network: scheme, credentials, IP literals, local names. */
export function checkUrl(raw) {
  let url;
  try {
    url = raw instanceof URL ? raw : new URL(String(raw));
  } catch {
    throw new OutboundError('Webhook URL is not a valid URL.', { code: 'invalid_url' });
  }
  if (url.protocol !== 'https:') {
    throw new OutboundError('Webhook URL must use https.', { code: 'https_required' });
  }
  if (url.username || url.password) {
    throw new OutboundError('Webhook URL must not contain credentials.', { code: 'invalid_url' });
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (net.isIP(host)) {
    if (isBlockedAddress(host)) {
      throw new OutboundError('Webhook URL points to a private or reserved address.', { code: 'blocked_address' });
    }
  } else if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || !host.includes('.')) {
    throw new OutboundError('Webhook URL points to a local hostname.', { code: 'blocked_address' });
  }
  return url;
}

/**
 * A dns.lookup-compatible function that refuses to hand blocked addresses to the
 * socket. If any resolved address is blocked the whole lookup fails, so a host
 * cannot mix a public and a private record and hope the private one gets dialed.
 */
export function guardedLookup(resolve = dns.lookup) {
  return (hostname, options, callback) => {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    const opts = typeof options === 'number' ? { family: options } : { ...options };
    resolve(hostname, { ...opts, all: true }, (err, addresses) => {
      if (err) return callback(err);
      const list = (Array.isArray(addresses) ? addresses : [{ address: addresses, family: opts.family }])
        .filter((entry) => entry && entry.address);
      if (list.length === 0) {
        return callback(new OutboundError(`No addresses found for ${hostname}.`, { code: 'dns_failed', retryable: true }));
      }
      const blocked = list.find((entry) => isBlockedAddress(entry.address));
      if (blocked) {
        return callback(new OutboundError(`${hostname} resolves to a private or reserved address.`, { code: 'blocked_address' }));
      }
      if (opts.all) return callback(null, list.map(({ address, family }) => ({ address, family: family ?? net.isIP(address) })));
      return callback(null, list[0].address, list[0].family ?? net.isIP(list[0].address));
    });
  };
}

/**
 * Sends one HTTPS request through the guard. Never follows redirects (a redirect
 * could point anywhere). Resolves with {status, headers, body} for any HTTP status;
 * rejects with OutboundError for guard refusals, network errors and the timeout.
 */
export function sendRequest(rawUrl, { method = 'POST', headers = {}, body = '', timeoutMs = DEFAULT_TIMEOUT_MS, lookup } = {}) {
  let url;
  try {
    url = checkUrl(rawUrl);
  } catch (err) {
    return Promise.reject(err);
  }
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    const req = https.request(url, {
      method,
      agent: false, // a fresh socket per request, so every connection goes through the guarded lookup
      lookup: lookup ?? guardedLookup(),
      headers: {
        'user-agent': USER_AGENT,
        'content-length': Buffer.byteLength(payload),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size <= MAX_RESPONSE_BYTES) chunks.push(chunk);
      });
      res.on('end', () => finish(resolve, {
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
      res.on('error', (err) => finish(reject, toOutboundError(err)));
    });

    // One deadline for the whole exchange: DNS, connect, TLS, request and response.
    const timer = setTimeout(() => {
      req.destroy(new OutboundError(`Request timed out after ${timeoutMs} ms.`, { code: 'timeout', retryable: true }));
    }, timeoutMs);

    req.on('error', (err) => finish(reject, toOutboundError(err)));
    req.end(payload);
  });
}

function toOutboundError(err) {
  if (err instanceof OutboundError) return err;
  return new OutboundError(`Request failed: ${err.code ?? err.message}`, { code: 'network_error', retryable: true });
}

/** HTTP statuses worth retrying for callbacks. Other 4xx mean the receiver rejected us. */
export const isRetryableStatus = (status) => status === 408 || status === 425 || status === 429 || status >= 500;
