import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkUrl, guardedLookup, isBlockedAddress, isRetryableStatus, OutboundError, sendRequest } from '../src/lib/outbound.mjs';

const blockedCode = (fn) =>
  assert.throws(fn, (err) => err instanceof OutboundError && err.code === 'blocked_address');

describe('isBlockedAddress', () => {
  const blocked = [
    '127.0.0.1', '127.255.255.254', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '169.254.169.254', // EC2 instance metadata
    '169.254.170.2', // ECS task metadata
    '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '198.18.0.1',
    '::', '::1', 'fe80::1', 'fc00::1', 'fd00:ec2::254', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe', '::ffff:10.1.2.3',
    '::127.0.0.1', '64:ff9b::a9fe:a9fe', '2002:7f00:1::',
    'not-an-ip', '',
  ];
  const allowed = ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'];

  for (const ip of blocked) it(`blocks ${ip || '(empty)'}`, () => assert.equal(isBlockedAddress(ip), true));
  for (const ip of allowed) it(`allows ${ip}`, () => assert.equal(isBlockedAddress(ip), false));
});

describe('checkUrl', () => {
  it('requires https', () => {
    assert.throws(() => checkUrl('http://example.com/hook'), { code: 'https_required' });
    assert.throws(() => checkUrl('ftp://example.com/'), { code: 'https_required' });
    assert.throws(() => checkUrl('file:///etc/passwd'), { code: 'https_required' });
  });

  it('rejects malformed URLs and embedded credentials', () => {
    assert.throws(() => checkUrl('not a url'), { code: 'invalid_url' });
    assert.throws(() => checkUrl('https://user:pass@example.com/'), { code: 'invalid_url' });
  });

  it('defeats decimal, hex, octal and short-form IPv4 tricks', () => {
    // The WHATWG URL parser canonicalises all of these to 127.0.0.1 / 169.254.169.254.
    for (const url of [
      'https://2130706433/', 'https://0x7f000001/', 'https://0x7f.0.0.1/', 'https://0177.0.0.1/',
      'https://017700000001/', 'https://127.1/', 'https://2852039166/latest/meta-data/', 'https://0xA9.0xFE.0xA9.0xFE/',
    ]) {
      blockedCode(() => checkUrl(url));
    }
  });

  it('blocks IPv6 loopback, mapped and link-local literals', () => {
    for (const url of ['https://[::1]/', 'https://[::ffff:127.0.0.1]/', 'https://[::ffff:a9fe:a9fe]/', 'https://[fe80::1]/', 'https://[fd00:ec2::254]/', 'https://[::]/']) {
      blockedCode(() => checkUrl(url));
    }
  });

  it('blocks local hostnames without a DNS round trip', () => {
    for (const url of ['https://localhost/', 'https://LOCALHOST:8443/', 'https://api.localhost/', 'https://metadata.google.internal/', 'https://intranet/']) {
      blockedCode(() => checkUrl(url));
    }
  });

  it('allows public hosts and public IP literals', () => {
    assert.equal(checkUrl('https://hooks.slack.com/services/x').hostname, 'hooks.slack.com');
    assert.ok(checkUrl('https://8.8.8.8/'));
    assert.ok(checkUrl('https://[2606:4700:4700::1111]/'));
  });
});

describe('guardedLookup', () => {
  const fakeResolver = (answers) => (hostname, options, callback) => callback(null, answers[hostname] ?? []);
  const lookup = guardedLookup(fakeResolver({
    'public.example': [{ address: '93.184.216.34', family: 4 }],
    'rebind.example': [{ address: '169.254.169.254', family: 4 }],
    'mixed.example': [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }],
    'v6.example': [{ address: '::ffff:127.0.0.1', family: 6 }],
    'empty.example': [],
  }));
  const run = (host, options = {}) => new Promise((resolve) => {
    lookup(host, options, (err, address, family) => resolve({ err, address, family }));
  });

  it('passes public addresses through, in both callback styles', async () => {
    assert.deepEqual(await run('public.example'), { err: null, address: '93.184.216.34', family: 4 });
    const all = await run('public.example', { all: true });
    assert.deepEqual(all.address, [{ address: '93.184.216.34', family: 4 }]);
  });

  it('refuses hosts that resolve to blocked addresses', async () => {
    for (const host of ['rebind.example', 'mixed.example', 'v6.example']) {
      const { err } = await run(host, { all: true });
      assert.ok(err instanceof OutboundError, host);
      assert.equal(err.code, 'blocked_address');
    }
  });

  it('treats an empty answer as a retryable DNS failure', async () => {
    const { err } = await run('empty.example');
    assert.equal(err.code, 'dns_failed');
    assert.equal(err.retryable, true);
  });

  it('propagates resolver errors', async () => {
    const failing = guardedLookup((h, o, cb) => cb(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' })));
    const err = await new Promise((resolve) => failing('x.example', {}, (e) => resolve(e)));
    assert.equal(err.code, 'ENOTFOUND');
  });
});

describe('sendRequest', () => {
  it('rejects plain http before any network activity', async () => {
    await assert.rejects(sendRequest('http://example.com/hook'), { code: 'https_required' });
  });

  it('rejects private IP literals', async () => {
    await assert.rejects(sendRequest('https://10.0.0.1/hook'), { code: 'blocked_address', retryable: false });
    await assert.rejects(sendRequest('https://[::1]/hook'), { code: 'blocked_address' });
  });

  it('refuses to connect when DNS answers with a private address (rebinding)', async () => {
    const lookup = guardedLookup((h, o, cb) => cb(null, [{ address: '127.0.0.1', family: 4 }]));
    await assert.rejects(sendRequest('https://evil.example/hook', { lookup }), { code: 'blocked_address' });
  });

  it('gives up after the timeout', async () => {
    const hang = () => {}; // a lookup that never answers
    const started = Date.now();
    await assert.rejects(sendRequest('https://slow.example/hook', { lookup: hang, timeoutMs: 100 }), { code: 'timeout', retryable: true });
    assert.ok(Date.now() - started < 2000);
  });
});

describe('isRetryableStatus', () => {
  it('retries 408, 425, 429 and 5xx only', () => {
    for (const s of [408, 425, 429, 500, 502, 503]) assert.equal(isRetryableStatus(s), true, String(s));
    for (const s of [400, 401, 403, 404, 410, 422]) assert.equal(isRetryableStatus(s), false, String(s));
  });
});
