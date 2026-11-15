import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

// Crockford base32, lowercase: no i, l, o, u, so IDs survive being read aloud or retyped.
const CROCKFORD = '0123456789abcdefghjkmnpqrstvwxyz';
const ID_BODY = /^[0-9a-hjkmnp-tv-z]{16}$/;
const ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789';

export function randomBase32(length = 16) {
  // 256 is a multiple of 32, so masking a uniform byte keeps the result uniform.
  let out = '';
  for (const byte of randomBytes(length)) out += CROCKFORD[byte & 31];
  return out;
}

/** Uniform lowercase alphanumerics (rejection sampling: 252 = 7 x 36). */
export function randomAlnum(length) {
  let out = '';
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte < 252 && out.length < length) out += ALNUM[byte % 36];
    }
  }
  return out;
}

export const newPlanId = () => `pln_${randomBase32(16)}`;
export const newSecret = () => randomBytes(24).toString('base64url');
/** A fresh, unguessable ntfy topic for someone who did not bring a notify URL. */
export const newNtfyTopicUrl = () => `https://ntfy.sh/lastcall-${randomAlnum(24)}`;

export const isPlanId = (value) =>
  typeof value === 'string' && value.startsWith('pln_') && ID_BODY.test(value.slice(4));

export const sha256Hex = (value) => createHash('sha256').update(value, 'utf8').digest('hex');

/** Constant-time check of a presented secret against its stored SHA-256 hex hash. */
export function secretMatches(presented, storedHash) {
  if (typeof presented !== 'string' || presented.length === 0 || presented.length > 256) return false;
  if (typeof storedHash !== 'string' || !/^[0-9a-f]{64}$/.test(storedHash)) return false;
  const a = Buffer.from(sha256Hex(presented), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return timingSafeEqual(a, b);
}
