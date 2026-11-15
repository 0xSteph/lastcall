import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  isPlanId, newNtfyTopicUrl, newPlanId, newSecret, randomAlnum, randomBase32, secretMatches, sha256Hex,
} from '../src/lib/ids.mjs';

describe('ids', () => {
  it('formats plan IDs as pln_ + 16 lowercase Crockford base32 chars', () => {
    for (let i = 0; i < 200; i++) assert.match(newPlanId(), /^pln_[0-9a-hjkmnp-tv-z]{16}$/);
  });

  it('never produces the ambiguous letters i, l, o, u', () => {
    const sample = Array.from({ length: 500 }, () => randomBase32(16)).join('');
    assert.doesNotMatch(sample, /[ilou]/);
  });

  it('generates unique IDs', () => {
    assert.equal(new Set(Array.from({ length: 5000 }, newPlanId)).size, 5000);
  });

  it('recognises plan IDs', () => {
    assert.ok(isPlanId(newPlanId()));
    assert.ok(!isPlanId('pln_short'));
    assert.ok(!isPlanId('ask_0123456789abcdef'));
    assert.ok(!isPlanId('pln_0123456789ABCDEF'));
    assert.ok(!isPlanId(undefined));
  });

  it('secrets are 24 random bytes, base64url', () => {
    const secret = newSecret();
    assert.match(secret, /^[A-Za-z0-9_-]{32}$/);
    assert.equal(Buffer.from(secret, 'base64url').length, 24);
  });

  it('generated ntfy topics are lastcall- + 24 lowercase alphanumerics', () => {
    for (let i = 0; i < 100; i++) assert.match(newNtfyTopicUrl(), /^https:\/\/ntfy\.sh\/lastcall-[a-z0-9]{24}$/);
    assert.equal(randomAlnum(500).length, 500);
    assert.equal(new Set(randomAlnum(2000)).size, 36, 'uses the whole alphabet');
  });
});

describe('hashing', () => {
  it('sha256Hex matches node:crypto', () => {
    assert.equal(sha256Hex('lastcall'), createHash('sha256').update('lastcall').digest('hex'));
    assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('secretMatches accepts the right secret only', () => {
    const secret = newSecret();
    const hash = sha256Hex(secret);
    assert.equal(secretMatches(secret, hash), true);
    assert.equal(secretMatches(`${secret}x`, hash), false);
    assert.equal(secretMatches(newSecret(), hash), false);
  });

  it('secretMatches rejects missing or malformed input without throwing', () => {
    const hash = sha256Hex('s');
    for (const presented of [undefined, null, '', 42, 'x'.repeat(300)]) assert.equal(secretMatches(presented, hash), false);
    for (const stored of [undefined, '', 'nothex', 'ab'.repeat(16)]) assert.equal(secretMatches('s', stored), false);
  });
});
