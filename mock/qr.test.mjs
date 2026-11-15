// Tests for web/qr.js. Run: node --test mock/
//
// Besides known test vectors (format bits, version bits, the classic
// "HELLO WORLD" 1-M Reed-Solomon vector), every generated symbol is read back
// by an independent decoder written below from the ISO/IEC 18004 tables
// (hard-coded alignment positions and block structure, log/antilog GF math),
// which checks finder/timing patterns, format and version info, unmasks the
// data, de-interleaves the blocks, verifies all RS syndromes are zero and
// parses the byte-mode payload back to the original string.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export function loadBrowserModule(rel) {
  const src = fs.readFileSync(path.join(here, "..", "web", rel), "utf8");
  const mod = { exports: {} };
  new Function("module", "exports", src)(mod, mod.exports);
  return mod.exports;
}

const QR = loadBrowserModule("qr.js");

// ---------------- independent reference data ----------------
const ALIGN = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
  7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};
// Level M block structure: [ecPerBlock, [[count, dataCodewords], ...]]
const BLOCKS_M = {
  1: [10, [[1, 16]]], 2: [16, [[1, 28]]], 3: [26, [[1, 44]]], 4: [18, [[2, 32]]],
  5: [24, [[2, 43]]], 6: [16, [[4, 27]]], 7: [18, [[4, 31]]], 8: [22, [[2, 38], [2, 39]]],
  9: [22, [[3, 36], [2, 37]]], 10: [26, [[4, 43], [1, 44]]],
};
const VERSION_INFO = { 7: 0x07c94, 8: 0x085bc, 9: 0x09a99, 10: 0x0a4d3 };
// Format strings for level M, masks 0-7 (after XOR with 101010000010010).
const FORMAT_M = [
  "101010000010010", "101000100100101", "101111001111100", "101101101001011",
  "100010111111001", "100000011001110", "100111110010111", "100101010100000",
];

// GF(256) with exp/log tables (independent of qr.js's bitwise multiply)
const EXP = new Array(512), LOG = new Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}
const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

function syndromesZero(block) {
  // block = data codewords followed by ec codewords; polynomial highest degree first
  const ecLen = block.ecLen;
  for (let i = 0; i < ecLen; i++) {
    const a = EXP[i];
    let s = 0;
    for (const c of block.cw) s = mul(s, a) ^ c;
    if (s !== 0) return false;
  }
  return true;
}

// ---------------- independent decoder ----------------
function decode(modules) {
  const size = modules.length;
  const ver = (size - 17) / 4;
  assert.ok(Number.isInteger(ver) && ver >= 1 && ver <= 10, "size maps to version 1-10");
  const M = (r, c) => modules[r][c];

  // finder patterns + separators
  for (const [r0, c0] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
      const rr = r0 + r, cc = c0 + c;
      if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
      const inSep = r === -1 || r === 7 || c === -1 || c === 7;
      const ring = Math.max(Math.abs(r - 3), Math.abs(c - 3));
      const expected = inSep ? false : ring !== 2;
      assert.equal(M(rr, cc), expected, `finder module (${rr},${cc})`);
    }
  }
  // timing patterns
  for (let i = 8; i < size - 8; i++) {
    assert.equal(M(6, i), i % 2 === 0, `horizontal timing at ${i}`);
    assert.equal(M(i, 6), i % 2 === 0, `vertical timing at ${i}`);
  }
  assert.equal(M(size - 8, 8), true, "dark module");

  // format info, copy 1: bits 14..0 read around the top-left finder
  const fmt1 = [];
  for (let c = 0; c <= 5; c++) fmt1.push(M(8, c)); // bits 14..9
  fmt1.push(M(8, 7), M(8, 8), M(7, 8)); // bits 8,7,6
  for (let r = 5; r >= 0; r--) fmt1.push(M(r, 8)); // bits 5..0
  // copy 2: bottom-left (bits 14..8) then top-right (bits 7..0)
  const fmt2 = [];
  for (let r = size - 1; r >= size - 7; r--) fmt2.push(M(r, 8));
  for (let c = size - 8; c < size; c++) fmt2.push(M(8, c));
  const s1 = fmt1.map(Number).join(""), s2 = fmt2.map(Number).join("");
  assert.equal(s1, s2, "both format copies agree");
  const mask = FORMAT_M.indexOf(s1);
  assert.ok(mask >= 0, `format string ${s1} is a valid level-M code`);

  // version info
  if (ver >= 7) {
    let v1 = 0, v2 = 0;
    for (let i = 17; i >= 0; i--) {
      const r = Math.floor(i / 3), c = size - 11 + (i % 3);
      v1 = v1 * 2 + (M(r, c) ? 1 : 0); // top-right block
      v2 = v2 * 2 + (M(c, r) ? 1 : 0); // bottom-left block (transposed)
    }
    assert.equal(v1, VERSION_INFO[ver], "version info (top-right)");
    assert.equal(v2, VERSION_INFO[ver], "version info (bottom-left)");
  }

  // function-module map
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const mark = (r, c) => { if (r >= 0 && c >= 0 && r < size && c < size) fn[r][c] = true; };
  for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) mark(r, c);
  for (let r = 0; r < 9; r++) for (let c = size - 8; c < size; c++) mark(r, c);
  for (let r = size - 8; r < size; r++) for (let c = 0; c < 9; c++) mark(r, c);
  for (let i = 0; i < size; i++) { mark(6, i); mark(i, 6); }
  const al = ALIGN[ver];
  for (const r of al) for (const c of al) {
    if ((r === 6 && c === 6) || (r === 6 && c === al[al.length - 1]) || (r === al[al.length - 1] && c === 6)) continue;
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
      mark(r + dr, c + dc);
      const ring = Math.max(Math.abs(dr), Math.abs(dc));
      assert.equal(M(r + dr, c + dc), ring !== 1, `alignment module (${r + dr},${c + dc})`);
    }
  }
  if (ver >= 7) for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) { mark(i, size - 11 + j); mark(size - 11 + j, i); }

  const maskFn = [
    (i, j) => (i + j) % 2 === 0,
    (i) => i % 2 === 0,
    (i, j) => j % 3 === 0,
    (i, j) => (i + j) % 3 === 0,
    (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0,
    (i, j) => ((i * j) % 2) + ((i * j) % 3) === 0,
    (i, j) => (((i * j) % 2) + ((i * j) % 3)) % 2 === 0,
    (i, j) => (((i * j) % 3) + ((i + j) % 2)) % 2 === 0,
  ][mask]; // i = row, j = column (spec notation)

  // zig-zag read
  const bits = [];
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (let k = 0; k < size; k++) {
      const r = upward ? size - 1 - k : k;
      for (const c of [col, col - 1]) {
        if (fn[r][c]) continue;
        bits.push(M(r, c) !== maskFn(r, c));
      }
    }
    upward = !upward;
  }
  const cws = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let v = 0;
    for (let k = 0; k < 8; k++) v = (v << 1) | (bits[i + k] ? 1 : 0);
    cws.push(v);
  }

  // de-interleave
  const [ecLen, groups] = BLOCKS_M[ver];
  const blockSizes = [];
  for (const [count, n] of groups) for (let i = 0; i < count; i++) blockSizes.push(n);
  const totalData = blockSizes.reduce((a, b) => a + b, 0);
  assert.equal(cws.length, totalData + ecLen * blockSizes.length, "codeword count matches the version table");
  const blocks = blockSizes.map(() => []);
  let p = 0;
  const maxData = Math.max(...blockSizes);
  for (let i = 0; i < maxData; i++) blockSizes.forEach((n, b) => { if (i < n) blocks[b].push(cws[p++]); });
  const ecs = blockSizes.map(() => []);
  for (let i = 0; i < ecLen; i++) blockSizes.forEach((_, b) => ecs[b].push(cws[p++]));
  blocks.forEach((data, b) => {
    assert.ok(syndromesZero({ cw: data.concat(ecs[b]), ecLen }), `RS syndromes zero in block ${b}`);
  });

  // parse byte-mode payload
  const data = blocks.flat();
  const dbits = [];
  for (const b of data) for (let k = 7; k >= 0; k--) dbits.push((b >> k) & 1);
  let q = 0;
  const read = (n) => { let v = 0; for (let k = 0; k < n; k++) v = (v << 1) | dbits[q++]; return v; };
  assert.equal(read(4), 0b0100, "byte mode indicator");
  const len = read(ver <= 9 ? 8 : 16);
  const bytes = [];
  for (let i = 0; i < len; i++) bytes.push(read(8));
  const remaining = dbits.length - q;
  if (remaining >= 4) assert.equal(read(4), 0, "terminator");
  // pad codewords alternate 0xEC 0x11
  const byteStart = Math.ceil(q / 8);
  const pads = data.slice(byteStart);
  pads.forEach((b, i) => assert.equal(b, i % 2 === 0 ? 0xec : 0x11, "pad codeword"));
  return { text: Buffer.from(bytes).toString("utf8"), version: ver, mask };
}

// ---------------- tests ----------------
test("format bits match the published level-M table", () => {
  for (let mask = 0; mask < 8; mask++) {
    assert.equal(QR._internal.formatBits(mask).toString(2).padStart(15, "0"), FORMAT_M[mask]);
  }
});

test("version bits match the published table", () => {
  for (const v of [7, 8, 9, 10]) assert.equal(QR._internal.versionBits(v), VERSION_INFO[v]);
});

test("Reed-Solomon matches the HELLO WORLD 1-M vector", () => {
  const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
  const ecc = QR._internal.rsRemainder(data, QR._internal.rsDivisor(10));
  assert.deepEqual(ecc, [196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
});

test("capacity and alignment tables agree with ISO 18004", () => {
  const capacityBytesM = [0, 14, 26, 42, 62, 84, 106, 122, 152, 180, 213];
  for (let v = 1; v <= 10; v++) {
    const [ecLen, groups] = BLOCKS_M[v];
    const dataCw = groups.reduce((a, [c, n]) => a + c * n, 0);
    assert.equal(QR._internal.numDataCodewords(v), dataCw, `data codewords v${v}`);
    assert.equal(Math.floor(QR._internal.numRawDataModules(v) / 8), dataCw + ecLen * groups.reduce((a, [c]) => a + c, 0));
    assert.deepEqual(QR._internal.alignmentPositions(v), ALIGN[v], `alignment v${v}`);
    const maxBytes = Math.floor((dataCw * 8 - 4 - (v <= 9 ? 8 : 16)) / 8);
    assert.equal(maxBytes, capacityBytesM[v], `byte capacity v${v}`);
  }
});

test("encodes and independently decodes strings across versions 1-10", () => {
  const samples = [
    "",
    "A",
    "hello",
    "https://lastcall.example/alert.html",
    "http://localhost:8787/web/approve.html#id=ask_0123456789abcdef&s=AbCdEfGhIjKlMnOpQrStUvWxYz012345",
    "https://d1234abcd5678.cloudfront.net/approve.html#id=ask_7h3k9m2p4q6r8s1t&s=Zm9vYmFyYmF6cXV4cXV1eHh5ejEyMzQ1",
    "Déploiement — ✓ ünïcödé 🚀",
  ];
  for (let n = 1; n <= 213; n += 7) samples.push("x".repeat(n));
  samples.push("y".repeat(213));
  const seen = new Set();
  for (const s of samples) {
    const qr = QR.encode(s);
    const out = decode(qr.modules);
    assert.equal(out.text, s, `round trip of ${JSON.stringify(s.slice(0, 40))}`);
    assert.equal(out.mask, qr.mask);
    seen.add(qr.version);
  }
  for (let v = 1; v <= 10; v++) assert.ok(seen.has(v), `exercised version ${v}`);
});

test("every mask pattern produces a decodable symbol", () => {
  for (let mask = 0; mask < 8; mask++) {
    const s = "https://example.com/approve.html#id=ask_abc&s=" + mask;
    assert.equal(decode(QR.encode(s, { mask }).modules).text, s);
  }
});

test("rejects data that does not fit in version 10", () => {
  assert.throws(() => QR.encode("z".repeat(214)), RangeError);
});

test("toSvg emits a square SVG with a quiet zone", () => {
  const svg = QR.toSvg("hi", { margin: 4, label: 'QR "code"' });
  assert.match(svg, /^<svg[^>]+viewBox="0 0 29 29"/);
  assert.match(svg, /aria-label="QR &quot;code&quot;"/);
});
