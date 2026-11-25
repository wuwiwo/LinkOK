/* LinkOK — QR encoder (byte mode, versions 1–10, EC levels L/M/Q/H).
 *
 * Written from ISO/IEC 18004 so the settings page needs no CDN and works offline.
 * Only what a pairing payload needs: 8-bit byte mode, one data segment, versions
 * 1–10 (up to 213 bytes at L). Everything else throws rather than guessing.
 *
 * Exposes LinkOK.qr = { encode(text, ecl) -> {size, modules, version, ecl, mask},
 *                       draw(canvas, text, opts) }
 * `modules` is a row-major array of booleans (true = dark), index = y*size + x.
 */
(function (root) {
  'use strict';

  // Total codewords (data + error correction) per version, index = version.
  var TOTAL_CODEWORDS = [0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346];

  // [ecCodewordsPerBlock, blockCount] per version and level.
  // Block data lengths are derived: TOTAL - ec*blocks, split as evenly as the
  // spec allows (shorter blocks first, longer blocks take the remainder).
  var EC_BLOCKS = {
    1: { L: [7, 1], M: [10, 1], Q: [13, 1], H: [17, 1] },
    2: { L: [10, 1], M: [16, 1], Q: [22, 1], H: [28, 1] },
    3: { L: [15, 1], M: [26, 1], Q: [18, 2], H: [22, 2] },
    4: { L: [20, 1], M: [18, 2], Q: [26, 2], H: [16, 4] },
    5: { L: [26, 1], M: [24, 2], Q: [18, 4], H: [22, 4] },
    6: { L: [18, 2], M: [16, 4], Q: [24, 4], H: [28, 4] },
    7: { L: [20, 2], M: [18, 4], Q: [18, 6], H: [26, 5] },
    8: { L: [24, 2], M: [22, 4], Q: [22, 6], H: [26, 6] },
    9: { L: [30, 2], M: [22, 5], Q: [20, 8], H: [24, 8] },
    10: { L: [18, 4], M: [26, 5], Q: [24, 8], H: [28, 8] }
  };

  // Alignment pattern centre coordinates per version.
  var ALIGNMENT = {
    1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
    6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50]
  };

  // Format information: the 32 valid 15-bit sequences, indexed by
  // (eclBits << 3) | mask. eclBits: L=1, M=0, Q=3, H=2. These are the values
  // printed in the spec, not something computed at runtime — so a bug in the
  // BCH code cannot hide by agreeing with itself. `_verify/qr-check.mjs`
  // recomputes them and asserts membership in this table.
  var FORMAT_BITS = [
    0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0,
    0x77c4, 0x72f3, 0x7daa, 0x789d, 0x662f, 0x6318, 0x6c41, 0x6976,
    0x1689, 0x13be, 0x1ce7, 0x19d0, 0x0762, 0x0255, 0x0d0c, 0x083b,
    0x355f, 0x3068, 0x3f31, 0x3a06, 0x24b4, 0x2183, 0x2eda, 0x2bed
  ];

  // Version information for versions 7–10 (18 bits each).
  var VERSION_BITS = { 7: 0x07c94, 8: 0x085bc, 9: 0x09a99, 10: 0x0a4d3 };

  var ECL_BITS = { L: 1, M: 0, Q: 3, H: 2 };

  // ---------------------------------------------------------------- GF(256)

  var GF_EXP = new Uint8Array(512);
  var GF_LOG = new Uint8Array(256);
  (function initGaloisField() {
    var x = 1;
    for (var i = 0; i < 255; i++) {
      GF_EXP[i] = x;
      GF_LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d; // primitive polynomial for QR
    }
    for (var j = 255; j < 512; j++) GF_EXP[j] = GF_EXP[j - 255];
  })();

  function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return GF_EXP[GF_LOG[a] + GF_LOG[b]];
  }

  // Reed–Solomon generator polynomial of the given degree, highest term first
  // (the leading 1 is implicit and omitted).
  function rsGenerator(degree) {
    var poly = [1];
    for (var i = 0; i < degree; i++) {
      var next = new Array(poly.length + 1).fill(0);
      for (var j = 0; j < poly.length; j++) {
        next[j] ^= poly[j];
        next[j + 1] ^= gfMul(poly[j], GF_EXP[i]);
      }
      poly = next;
    }
    return poly.slice(1);
  }

  function rsRemainder(data, generator) {
    var rem = new Array(generator.length).fill(0);
    for (var i = 0; i < data.length; i++) {
      var factor = data[i] ^ rem.shift();
      rem.push(0);
      for (var j = 0; j < generator.length; j++) rem[j] ^= gfMul(generator[j], factor);
    }
    return rem;
  }

  // ------------------------------------------------------------- bit stream

  function BitBuffer() {
    this.bits = [];
  }
  BitBuffer.prototype.append = function (value, length) {
    for (var i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  };
  BitBuffer.prototype.length = function () {
    return this.bits.length;
  };

  function utf8Bytes(text) {
    if (typeof TextEncoder === 'function') return Array.from(new TextEncoder().encode(text));
    // Fallback (old browsers only): encode code points by hand.
    var out = [];
    for (var i = 0; i < text.length; i++) {
      var c = text.codePointAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else {
        out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
        i++;
      }
    }
    return out;
  }

  function charCountBits(version) {
    return version <= 9 ? 8 : 16;
  }

  function dataCodewordCount(version, ecl) {
    var spec = EC_BLOCKS[version][ecl];
    return TOTAL_CODEWORDS[version] - spec[0] * spec[1];
  }

  function chooseVersion(byteCount, ecl) {
    for (var v = 1; v <= 10; v++) {
      var capacity = dataCodewordCount(v, ecl) * 8;
      if (4 + charCountBits(v) + byteCount * 8 <= capacity) return v;
    }
    throw new Error('qr: payload too long for versions 1–10 at level ' + ecl);
  }

  // Split data codewords into blocks exactly as the spec prescribes: shorter
  // blocks first, longer blocks carry one extra codeword.
  function splitBlocks(data, version, ecl) {
    var spec = EC_BLOCKS[version][ecl];
    var ecLen = spec[0];
    var blockCount = spec[1];
    var total = dataCodewordCount(version, ecl);
    var shortLen = Math.floor(total / blockCount);
    var longCount = total % blockCount;
    var shortCount = blockCount - longCount;

    var blocks = [];
    var offset = 0;
    for (var i = 0; i < blockCount; i++) {
      var len = i < shortCount ? shortLen : shortLen + 1;
      blocks.push(data.slice(offset, offset + len));
      offset += len;
    }
    if (offset !== total) throw new Error('qr: block split mismatch');
    return { blocks: blocks, ecLen: ecLen };
  }

  function interleave(blocks, ecLen) {
    var generator = rsGenerator(ecLen);
    var ecBlocks = blocks.map(function (block) {
      return rsRemainder(block, generator);
    });
    var out = [];
    var maxLen = Math.max.apply(null, blocks.map(function (b) { return b.length; }));
    for (var i = 0; i < maxLen; i++) {
      for (var b = 0; b < blocks.length; b++) {
        if (i < blocks[b].length) out.push(blocks[b][i]);
      }
    }
    for (var e = 0; e < ecLen; e++) {
      for (var b2 = 0; b2 < blocks.length; b2++) out.push(ecBlocks[b2][e]);
    }
    return out;
  }

  // Build the full sequence of codewords for the payload.
  function buildCodewords(text, version, ecl) {
    var bytes = utf8Bytes(text);
    var capacityBits = dataCodewordCount(version, ecl) * 8;
    var buffer = new BitBuffer();
    buffer.append(0x4, 4); // byte mode
    buffer.append(bytes.length, charCountBits(version));
    for (var i = 0; i < bytes.length; i++) buffer.append(bytes[i], 8);

    // Terminator, then pad to a byte boundary.
    var remaining = capacityBits - buffer.length();
    if (remaining < 0) throw new Error('qr: payload overflow');
    buffer.append(0, Math.min(4, remaining));
    buffer.append(0, (8 - (buffer.length() % 8)) % 8);

    // Pad codewords, alternating 0xEC / 0x11.
    var pad = 0xec;
    while (buffer.length() < capacityBits) {
      buffer.append(pad, 8);
      pad = pad === 0xec ? 0x11 : 0xec;
    }

    var data = [];
    for (var b = 0; b < buffer.length(); b += 8) {
      var value = 0;
      for (var k = 0; k < 8; k++) value = (value << 1) | buffer.bits[b + k];
      data.push(value);
    }

    var split = splitBlocks(data, version, ecl);
    var codewords = interleave(split.blocks, split.ecLen);
    if (codewords.length !== TOTAL_CODEWORDS[version]) {
      throw new Error('qr: codeword count mismatch');
    }
    return codewords;
  }

  // ------------------------------------------------------------------ matrix

  function Grid(size) {
    this.size = size;
    this.modules = new Array(size * size).fill(false);
    this.isFunction = new Array(size * size).fill(false);
  }
  Grid.prototype.get = function (x, y) {
    return this.modules[y * this.size + x];
  };
  Grid.prototype.set = function (x, y, dark) {
    this.modules[y * this.size + x] = dark;
  };
  Grid.prototype.setFunction = function (x, y, dark) {
    this.modules[y * this.size + x] = dark;
    this.isFunction[y * this.size + x] = true;
  };

  function drawFunctionPatterns(grid, version) {
    var size = grid.size;

    // Timing patterns.
    for (var i = 0; i < size; i++) {
      grid.setFunction(6, i, i % 2 === 0);
      grid.setFunction(i, 6, i % 2 === 0);
    }

    // Finder patterns plus their separators (drawn over the timing lines).
    [[3, 3], [size - 4, 3], [3, size - 4]].forEach(function (c) {
      for (var dy = -4; dy <= 4; dy++) {
        for (var dx = -4; dx <= 4; dx++) {
          var x = c[0] + dx;
          var y = c[1] + dy;
          if (x < 0 || x >= size || y < 0 || y >= size) continue;
          var dist = Math.max(Math.abs(dx), Math.abs(dy));
          grid.setFunction(x, y, dist !== 2 && dist !== 4);
        }
      }
    });

    // Alignment patterns, skipping the three that would overlap a finder.
    var positions = ALIGNMENT[version];
    for (var a = 0; a < positions.length; a++) {
      for (var b = 0; b < positions.length; b++) {
        var last = positions.length - 1;
        if ((a === 0 && b === 0) || (a === 0 && b === last) || (a === last && b === 0)) continue;
        for (var dy2 = -2; dy2 <= 2; dy2++) {
          for (var dx2 = -2; dx2 <= 2; dx2++) {
            var d = Math.max(Math.abs(dx2), Math.abs(dy2));
            grid.setFunction(positions[a] + dx2, positions[b] + dy2, d !== 1);
          }
        }
      }
    }

    // Reserve the format areas now so data placement skips them. Index 6 is the
    // timing line on both axes and is not part of the format information, so it
    // must keep the value the timing loop gave it.
    for (var k = 0; k <= 8; k++) {
      if (k !== 6) {
        grid.setFunction(8, k, false);
        grid.setFunction(k, 8, false);
      }
    }
    for (var m = 0; m < 8; m++) {
      grid.setFunction(size - 1 - m, 8, false);
      grid.setFunction(8, size - 1 - m, false);
    }

    // Version information block (versions 7 and up).
    if (version >= 7) {
      var bits = VERSION_BITS[version];
      for (var v = 0; v < 18; v++) {
        var bit = ((bits >>> v) & 1) === 1;
        var i2 = Math.floor(v / 3);
        var j2 = v % 3;
        grid.setFunction(size - 11 + j2, i2, bit);
        grid.setFunction(i2, size - 11 + j2, bit);
      }
    }
  }

  function placeData(grid, codewords) {
    var size = grid.size;
    var bitIndex = 0;
    var totalBits = codewords.length * 8;
    var upward = true;

    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5; // skip the vertical timing column
      for (var vert = 0; vert < size; vert++) {
        var y = upward ? size - 1 - vert : vert;
        for (var j = 0; j < 2; j++) {
          var x = right - j;
          if (grid.isFunction[y * size + x]) continue;
          if (bitIndex < totalBits) {
            var byteIndex = bitIndex >> 3;
            var bit = ((codewords[byteIndex] >>> (7 - (bitIndex & 7))) & 1) === 1;
            grid.set(x, y, bit);
            bitIndex++;
          }
          // Remainder bits stay light (already false).
        }
      }
      upward = !upward;
    }
    if (bitIndex !== totalBits) throw new Error('qr: data placement did not consume all bits');
  }

  function maskBit(mask, x, y) {
    switch (mask) {
      case 0: return (x + y) % 2 === 0;
      case 1: return y % 2 === 0;
      case 2: return x % 3 === 0;
      case 3: return (x + y) % 3 === 0;
      case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
      case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
      case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
      case 7: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
      default: throw new Error('qr: bad mask ' + mask);
    }
  }

  function applyMask(grid, mask) {
    var size = grid.size;
    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++) {
        if (grid.isFunction[y * size + x]) continue;
        if (maskBit(mask, x, y)) grid.set(x, y, !grid.get(x, y));
      }
    }
  }

  function drawFormatBits(grid, ecl, mask) {
    var size = grid.size;
    var bits = FORMAT_BITS[(ECL_BITS[ecl] << 3) | mask];
    function getBit(i) {
      return ((bits >>> i) & 1) === 1;
    }
    for (var i = 0; i <= 5; i++) grid.setFunction(8, i, getBit(i));
    grid.setFunction(8, 7, getBit(6));
    grid.setFunction(8, 8, getBit(7));
    grid.setFunction(7, 8, getBit(8));
    for (var k = 9; k < 15; k++) grid.setFunction(14 - k, 8, getBit(k));

    for (var m = 0; m < 8; m++) grid.setFunction(size - 1 - m, 8, getBit(m));
    for (var n = 8; n < 15; n++) grid.setFunction(8, size - 15 + n, getBit(n));
    grid.setFunction(8, size - 8, true); // always-dark module
  }

  function cloneGrid(grid) {
    var g = new Grid(grid.size);
    g.modules = grid.modules.slice();
    g.isFunction = grid.isFunction.slice();
    return g;
  }

  // --- Penalty scoring (ISO 18004 §8.8.2), used only to pick the mask. ---

  function penaltyRuns(grid) {
    var size = grid.size;
    var score = 0;
    for (var pass = 0; pass < 2; pass++) {
      for (var a = 0; a < size; a++) {
        var runColor = null;
        var runLength = 0;
        for (var b = 0; b < size; b++) {
          var dark = pass === 0 ? grid.get(b, a) : grid.get(a, b);
          if (dark === runColor) {
            runLength++;
          } else {
            if (runLength >= 5) score += 3 + (runLength - 5);
            runColor = dark;
            runLength = 1;
          }
        }
        if (runLength >= 5) score += 3 + (runLength - 5);
      }
    }
    return score;
  }

  function penaltyBlocks(grid) {
    var size = grid.size;
    var score = 0;
    for (var y = 0; y < size - 1; y++) {
      for (var x = 0; x < size - 1; x++) {
        var c = grid.get(x, y);
        if (c === grid.get(x + 1, y) && c === grid.get(x, y + 1) && c === grid.get(x + 1, y + 1)) {
          score += 3;
        }
      }
    }
    return score;
  }

  function penaltyFinderLike(grid) {
    var size = grid.size;
    var score = 0;
    var pattern = [true, false, true, true, true, false, true];
    function matches(getter, start) {
      for (var i = 0; i < 7; i++) if (getter(start + i) !== pattern[i]) return false;
      // Must be surrounded by at least 4 light modules on one side.
      var lightBefore = true;
      var lightAfter = true;
      for (var k = 1; k <= 4; k++) {
        if (start - k < 0) break;
        if (getter(start - k)) { lightBefore = false; break; }
      }
      for (var m = 1; m <= 4; m++) {
        if (start + 6 + m >= size) break;
        if (getter(start + 6 + m)) { lightAfter = false; break; }
      }
      return lightBefore || lightAfter;
    }
    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size - 6; x++) {
        if (matches(function (i) { return grid.get(i, y); }, x)) score += 40;
      }
    }
    for (var x2 = 0; x2 < size; x2++) {
      for (var y2 = 0; y2 < size - 6; y2++) {
        if (matches(function (i) { return grid.get(x2, i); }, y2)) score += 40;
      }
    }
    return score;
  }

  function penaltyBalance(grid) {
    var dark = 0;
    for (var i = 0; i < grid.modules.length; i++) if (grid.modules[i]) dark++;
    var total = grid.modules.length;
    var percent = (dark * 100) / total;
    var low = Math.floor(Math.abs(percent - 50) / 5);
    return low * 10;
  }

  function penalty(grid) {
    return penaltyRuns(grid) + penaltyBlocks(grid) + penaltyFinderLike(grid) + penaltyBalance(grid);
  }

  var maskCache = {};

  function encode(text, ecl) {
    ecl = ecl || 'M';
    if (!EC_BLOCKS[1][ecl]) throw new Error('qr: unknown EC level ' + ecl);
    var cacheKey = ecl + '\u0000' + text;
    if (maskCache[cacheKey]) return maskCache[cacheKey];

    var bytes = utf8Bytes(text);
    var version = chooseVersion(bytes.length, ecl);
    var codewords = buildCodewords(text, version, ecl);
    var size = version * 4 + 17;

    var base = new Grid(size);
    drawFunctionPatterns(base, version);
    placeData(base, codewords);

    var best = null;
    var bestScore = Infinity;
    for (var mask = 0; mask < 8; mask++) {
      var candidate = cloneGrid(base);
      applyMask(candidate, mask);
      drawFormatBits(candidate, ecl, mask);
      var score = penalty(candidate);
      if (score < bestScore) {
        bestScore = score;
        best = { grid: candidate, mask: mask };
      }
    }

    var result = {
      version: version,
      ecl: ecl,
      mask: best.mask,
      size: size,
      modules: best.grid.modules,
      isFunction: best.grid.isFunction,
      penalty: bestScore
    };
    maskCache[cacheKey] = result;
    return result;
  }

  // --------------------------------------------------------------- rendering

  function resolveColor(canvas, value, fallback) {
    if (!value) return fallback;
    var match = /^var\((--[a-z0-9-]+)\)$/i.exec(value.trim());
    if (!match) return value;
    var root = canvas.ownerDocument && canvas.ownerDocument.documentElement;
    var resolved = root ? getComputedStyle(root).getPropertyValue(match[1]).trim() : '';
    return resolved || fallback;
  }

  /**
   * Draw `text` as a QR code onto a canvas, crisp at any DPR.
   * opts: { size: css px, quietZone: modules (default 4), dark, light, label }
   */
  function draw(canvas, text, opts) {
    opts = opts || {};
    var qr = encode(text, opts.ecl || 'M');
    var quietZone = opts.quietZone == null ? 4 : opts.quietZone;
    var cssSize = opts.size || 240;
    var totalModules = qr.size + quietZone * 2;
    var scale = Math.max(1, Math.floor((cssSize * (window.devicePixelRatio || 1)) / totalModules));
    var pixelSize = totalModules * scale;

    canvas.width = pixelSize;
    canvas.height = pixelSize;
    canvas.style.width = cssSize + 'px';
    canvas.style.height = cssSize + 'px';

    var ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('qr: 2d context unavailable');
    ctx.imageSmoothingEnabled = false;

    var light = resolveColor(canvas, opts.light, '#ffffff');
    var dark = resolveColor(canvas, opts.dark, '#000000');

    ctx.fillStyle = light;
    ctx.fillRect(0, 0, pixelSize, pixelSize);
    ctx.fillStyle = dark;
    for (var y = 0; y < qr.size; y++) {
      for (var x = 0; x < qr.size; x++) {
        if (!qr.modules[y * qr.size + x]) continue;
        ctx.fillRect((x + quietZone) * scale, (y + quietZone) * scale, scale, scale);
      }
    }

    canvas.setAttribute('role', 'img');
    if (opts.label) canvas.setAttribute('aria-label', opts.label);
    // Expose the payload for tests and for screen-reader text elsewhere.
    canvas.setAttribute('data-qr-payload', text);
    canvas.setAttribute('data-qr-version', String(qr.version));
    canvas.setAttribute('data-qr-mask', String(qr.mask));
    return qr;
  }

  root.LinkOK = root.LinkOK || {};
  root.LinkOK.qr = {
    encode: encode,
    draw: draw,
    // exported for the verifier
    _internals: {
      FORMAT_BITS: FORMAT_BITS,
      VERSION_BITS: VERSION_BITS,
      EC_BLOCKS: EC_BLOCKS,
      ALIGNMENT: ALIGNMENT,
      TOTAL_CODEWORDS: TOTAL_CODEWORDS,
      maskBit: maskBit,
      rsGenerator: rsGenerator,
      rsRemainder: rsRemainder,
      utf8Bytes: utf8Bytes,
      dataCodewordCount: dataCodewordCount,
      splitBlocks: splitBlocks
    }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
