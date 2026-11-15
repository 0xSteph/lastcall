/*
 * qr.js — a small, self-contained QR Code encoder for Last Call.
 *
 * Byte mode (UTF-8), error correction level M, versions 1-10
 * (up to 213 bytes, plenty for a plan or alert link). No dependencies.
 *
 *   const qr = LastCallQR.encode("https://example.com");   // { version, size, mask, modules }
 *   el.innerHTML = LastCallQR.toSvg("https://example.com", { margin: 4 });
 *
 * Works as a browser global (window.LastCallQR) and as a CommonJS module, so the
 * tests in mock/ can load it with Node.
 */
(function (root) {
  "use strict";

  // Error correction level M, indexed by version (index 0 unused).
  var ECC_PER_BLOCK = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
  var NUM_BLOCKS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
  var ECL_FORMAT_BITS_M = 0; // L=1, M=0, Q=3, H=2
  var MIN_VERSION = 1;
  var MAX_VERSION = 10;

  function utf8Bytes(str) {
    if (typeof TextEncoder !== "undefined") return Array.from(new TextEncoder().encode(str));
    var out = [];
    var s = unescape(encodeURIComponent(str));
    for (var i = 0; i < s.length; i++) out.push(s.charCodeAt(i));
    return out;
  }

  // Number of modules available for data + ECC (excludes function patterns).
  function numRawDataModules(ver) {
    var result = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      var numAlign = Math.floor(ver / 7) + 2;
      result -= (25 * numAlign - 10) * numAlign - 55;
      if (ver >= 7) result -= 36;
    }
    return result;
  }

  function numDataCodewords(ver) {
    return Math.floor(numRawDataModules(ver) / 8) - ECC_PER_BLOCK[ver] * NUM_BLOCKS[ver];
  }

  function alignmentPositions(ver) {
    if (ver === 1) return [];
    var size = ver * 4 + 17;
    var numAlign = Math.floor(ver / 7) + 2;
    var step = Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2;
    var result = [6];
    for (var pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
    return result;
  }

  // ---- Reed-Solomon over GF(2^8), polynomial 0x11D ----
  function gfMul(x, y) {
    var z = 0;
    for (var i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11d);
      z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xff;
  }

  function rsDivisor(degree) {
    var result = [];
    for (var i = 0; i < degree - 1; i++) result.push(0);
    result.push(1);
    var r = 1;
    for (var k = 0; k < degree; k++) {
      for (var j = 0; j < result.length; j++) {
        result[j] = gfMul(result[j], r);
        if (j + 1 < result.length) result[j] ^= result[j + 1];
      }
      r = gfMul(r, 0x02);
    }
    return result;
  }

  function rsRemainder(data, divisor) {
    var result = divisor.map(function () { return 0; });
    data.forEach(function (b) {
      var factor = b ^ result.shift();
      result.push(0);
      for (var i = 0; i < divisor.length; i++) result[i] ^= gfMul(divisor[i], factor);
    });
    return result;
  }

  function addEccAndInterleave(data, ver) {
    var numBlocks = NUM_BLOCKS[ver];
    var blockEccLen = ECC_PER_BLOCK[ver];
    var rawCodewords = Math.floor(numRawDataModules(ver) / 8);
    var numShortBlocks = numBlocks - (rawCodewords % numBlocks);
    var shortBlockLen = Math.floor(rawCodewords / numBlocks);
    var divisor = rsDivisor(blockEccLen);
    var blocks = [];
    for (var i = 0, k = 0; i < numBlocks; i++) {
      var dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
      k += dat.length;
      var ecc = rsRemainder(dat, divisor);
      if (i < numShortBlocks) dat.push(0); // placeholder, skipped during interleave
      blocks.push(dat.concat(ecc));
    }
    var result = [];
    for (var c = 0; c < blocks[0].length; c++) {
      for (var b = 0; b < blocks.length; b++) {
        if (c !== shortBlockLen - blockEccLen || b >= numShortBlocks) result.push(blocks[b][c]);
      }
    }
    return result;
  }

  // ---- Data segment (byte mode) ----
  function buildDataCodewords(bytes, ver) {
    var bits = [];
    function append(val, len) {
      for (var i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
    }
    append(0x4, 4); // byte mode
    append(bytes.length, ver <= 9 ? 8 : 16);
    bytes.forEach(function (b) { append(b, 8); });
    var capacity = numDataCodewords(ver) * 8;
    append(0, Math.min(4, capacity - bits.length)); // terminator
    append(0, (8 - (bits.length % 8)) % 8); // byte align
    for (var pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) append(pad, 8);
    var out = [];
    for (var j = 0; j < bits.length; j += 8) {
      var v = 0;
      for (var t = 0; t < 8; t++) v = (v << 1) | bits[j + t];
      out.push(v);
    }
    return out;
  }

  function chooseVersion(byteLen) {
    for (var ver = MIN_VERSION; ver <= MAX_VERSION; ver++) {
      var needed = 4 + (ver <= 9 ? 8 : 16) + byteLen * 8;
      if (needed <= numDataCodewords(ver) * 8) return ver;
    }
    return -1;
  }

  // ---- Matrix construction ----
  function Matrix(ver) {
    this.version = ver;
    this.size = ver * 4 + 17;
    this.modules = [];
    this.isFunction = [];
    for (var y = 0; y < this.size; y++) {
      this.modules.push(new Array(this.size).fill(false));
      this.isFunction.push(new Array(this.size).fill(false));
    }
  }

  Matrix.prototype.setFunction = function (x, y, dark) {
    this.modules[y][x] = dark;
    this.isFunction[y][x] = true;
  };

  Matrix.prototype.drawFunctionPatterns = function () {
    var size = this.size;
    for (var i = 0; i < size; i++) {
      this.setFunction(6, i, i % 2 === 0);
      this.setFunction(i, 6, i % 2 === 0);
    }
    this.drawFinder(3, 3);
    this.drawFinder(size - 4, 3);
    this.drawFinder(3, size - 4);
    var pos = alignmentPositions(this.version);
    var n = pos.length;
    for (var a = 0; a < n; a++) {
      for (var b = 0; b < n; b++) {
        if ((a === 0 && b === 0) || (a === 0 && b === n - 1) || (a === n - 1 && b === 0)) continue;
        this.drawAlignment(pos[a], pos[b]);
      }
    }
    this.drawFormatBits(0); // reserve; real bits drawn after masking
    this.drawVersion();
  };

  Matrix.prototype.drawFinder = function (x, y) {
    for (var dy = -4; dy <= 4; dy++) {
      for (var dx = -4; dx <= 4; dx++) {
        var dist = Math.max(Math.abs(dx), Math.abs(dy));
        var xx = x + dx, yy = y + dy;
        if (xx >= 0 && xx < this.size && yy >= 0 && yy < this.size) {
          this.setFunction(xx, yy, dist !== 2 && dist !== 4);
        }
      }
    }
  };

  Matrix.prototype.drawAlignment = function (x, y) {
    for (var dy = -2; dy <= 2; dy++) {
      for (var dx = -2; dx <= 2; dx++) {
        this.setFunction(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  };

  function formatBits(mask) {
    var data = (ECL_FORMAT_BITS_M << 3) | mask;
    var rem = data;
    for (var i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    return ((data << 10) | rem) ^ 0x5412;
  }

  function versionBits(ver) {
    var rem = ver;
    for (var i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    return (ver << 12) | rem;
  }

  function bit(x, i) { return ((x >>> i) & 1) !== 0; }

  Matrix.prototype.drawFormatBits = function (mask) {
    var bits = formatBits(mask);
    var size = this.size;
    var i;
    for (i = 0; i <= 5; i++) this.setFunction(8, i, bit(bits, i));
    this.setFunction(8, 7, bit(bits, 6));
    this.setFunction(8, 8, bit(bits, 7));
    this.setFunction(7, 8, bit(bits, 8));
    for (i = 9; i < 15; i++) this.setFunction(14 - i, 8, bit(bits, i));
    for (i = 0; i < 8; i++) this.setFunction(size - 1 - i, 8, bit(bits, i));
    for (i = 8; i < 15; i++) this.setFunction(8, size - 15 + i, bit(bits, i));
    this.setFunction(8, size - 8, true); // dark module
  };

  Matrix.prototype.drawVersion = function () {
    if (this.version < 7) return;
    var bits = versionBits(this.version);
    for (var i = 0; i < 18; i++) {
      var dark = bit(bits, i);
      var a = this.size - 11 + (i % 3);
      var b = Math.floor(i / 3);
      this.setFunction(a, b, dark);
      this.setFunction(b, a, dark);
    }
  };

  Matrix.prototype.drawCodewords = function (data) {
    var size = this.size;
    var i = 0;
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5; // skip vertical timing column
      for (var vert = 0; vert < size; vert++) {
        for (var j = 0; j < 2; j++) {
          var x = right - j;
          var upward = ((right + 1) & 2) === 0;
          var y = upward ? size - 1 - vert : vert;
          if (!this.isFunction[y][x] && i < data.length * 8) {
            this.modules[y][x] = bit(data[i >>> 3], 7 - (i & 7));
            i++;
          }
        }
      }
    }
  };

  var MASKS = [
    function (x, y) { return (x + y) % 2 === 0; },
    function (x, y) { return y % 2 === 0; },
    function (x, y) { return x % 3 === 0; },
    function (x, y) { return (x + y) % 3 === 0; },
    function (x, y) { return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; },
    function (x, y) { return ((x * y) % 2) + ((x * y) % 3) === 0; },
    function (x, y) { return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; },
    function (x, y) { return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; }
  ];

  Matrix.prototype.applyMask = function (mask) {
    var fn = MASKS[mask];
    for (var y = 0; y < this.size; y++) {
      for (var x = 0; x < this.size; x++) {
        if (!this.isFunction[y][x] && fn(x, y)) this.modules[y][x] = !this.modules[y][x];
      }
    }
  };

  // Standard penalty score (ISO/IEC 18004 section 7.8.3), used to pick the mask.
  Matrix.prototype.penalty = function () {
    var size = this.size, m = this.modules, score = 0, x, y;
    function lineScore(get) {
      var s = 0, run = 1;
      for (var i = 1; i <= size; i++) {
        if (i < size && get(i) === get(i - 1)) { run++; continue; }
        if (run >= 5) s += 3 + (run - 5);
        run = 1;
      }
      // finder-like 1:1:3:1:1 with 4 light modules on either side
      var p1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
      var p2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
      for (var k = 0; k + 11 <= size; k++) {
        var m1 = true, m2 = true;
        for (var t = 0; t < 11; t++) {
          var v = get(k + t) ? 1 : 0;
          if (v !== p1[t]) m1 = false;
          if (v !== p2[t]) m2 = false;
        }
        if (m1) s += 40;
        if (m2) s += 40;
      }
      return s;
    }
    for (y = 0; y < size; y++) score += lineScore(function (i) { return m[y][i]; });
    for (x = 0; x < size; x++) score += lineScore(function (i) { return m[i][x]; });
    for (y = 0; y < size - 1; y++) {
      for (x = 0; x < size - 1; x++) {
        var c = m[y][x];
        if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) score += 3;
      }
    }
    var dark = 0;
    for (y = 0; y < size; y++) for (x = 0; x < size; x++) if (m[y][x]) dark++;
    var total = size * size;
    var k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    score += Math.max(0, k) * 10;
    return score;
  };

  function encode(text, opts) {
    opts = opts || {};
    var bytes = typeof text === "string" ? utf8Bytes(text) : Array.from(text);
    var ver = chooseVersion(bytes.length);
    if (ver < 0) throw new RangeError("Data too long for a version 1-10 QR code (" + bytes.length + " bytes)");
    var codewords = addEccAndInterleave(buildDataCodewords(bytes, ver), ver);
    var base = new Matrix(ver);
    base.drawFunctionPatterns();
    base.drawCodewords(codewords);

    var bestMask = typeof opts.mask === "number" ? opts.mask : -1;
    if (bestMask < 0) {
      var bestScore = Infinity;
      for (var mask = 0; mask < 8; mask++) {
        var trial = cloneMatrix(base);
        trial.applyMask(mask);
        trial.drawFormatBits(mask);
        var sc = trial.penalty();
        if (sc < bestScore) { bestScore = sc; bestMask = mask; }
      }
    }
    base.applyMask(bestMask);
    base.drawFormatBits(bestMask);
    return { version: ver, size: base.size, mask: bestMask, modules: base.modules, isFunction: base.isFunction };
  }

  function cloneMatrix(src) {
    var m = new Matrix(src.version);
    m.modules = src.modules.map(function (r) { return r.slice(); });
    m.isFunction = src.isFunction.map(function (r) { return r.slice(); });
    return m;
  }

  // Render as an SVG string. One <path> for all dark modules, crisp at any size.
  function toSvg(text, opts) {
    opts = opts || {};
    var qr = encode(text);
    var margin = opts.margin == null ? 4 : opts.margin;
    var dim = qr.size + margin * 2;
    var d = [];
    for (var y = 0; y < qr.size; y++) {
      for (var x = 0; x < qr.size; x++) {
        if (qr.modules[y][x]) d.push("M" + (x + margin) + " " + (y + margin) + "h1v1h-1z");
      }
    }
    var fg = opts.foreground || "#000";
    var bg = opts.background || "#fff";
    var label = opts.label ? ' role="img" aria-label="' + String(opts.label).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    }) + '"' : ' aria-hidden="true"';
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + dim + " " + dim + '"' + label +
      ' shape-rendering="crispEdges"><rect width="100%" height="100%" fill="' + bg + '"/>' +
      '<path fill="' + fg + '" d="' + d.join("") + '"/></svg>';
  }

  var api = {
    encode: encode,
    toSvg: toSvg,
    // exposed for tests
    _internal: {
      formatBits: formatBits,
      versionBits: versionBits,
      rsDivisor: rsDivisor,
      rsRemainder: rsRemainder,
      gfMul: gfMul,
      numDataCodewords: numDataCodewords,
      numRawDataModules: numRawDataModules,
      alignmentPositions: alignmentPositions,
      buildDataCodewords: buildDataCodewords,
      addEccAndInterleave: addEccAndInterleave,
      ECC_PER_BLOCK: ECC_PER_BLOCK,
      NUM_BLOCKS: NUM_BLOCKS,
      MASKS: MASKS
    }
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.LastCallQR = api;
})(typeof self !== "undefined" ? self : this);
