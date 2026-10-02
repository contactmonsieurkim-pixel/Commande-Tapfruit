// AES-128 / AES-CMAC (Apps Script 에는 AES 가 없어서 직접 구현)
// NTAG 424 DNA SUN(Secure Dynamic Messaging) 검증에 사용.

var AES_ = (function () {
  var SBOX = new Array(256), INV = new Array(256);
  (function () {
    var p = 1, q = 1;
    do {
      p = p ^ ((p << 1) & 0xff) ^ (p & 0x80 ? 0x1b : 0);
      q ^= q << 1; q ^= q << 2; q ^= q << 4; q &= 0xff;
      if (q & 0x80) q ^= 0x09;
      var x = q ^ ((q << 1) | (q >> 7)) ^ ((q << 2) | (q >> 6)) ^
              ((q << 3) | (q >> 5)) ^ ((q << 4) | (q >> 4));
      x = (x ^ 0x63) & 0xff;
      SBOX[p] = x; INV[x] = p;
    } while (p !== 1);
    SBOX[0] = 0x63; INV[0x63] = 0;
  })();

  function xt(b) { return ((b << 1) ^ (b & 0x80 ? 0x1b : 0)) & 0xff; }
  function mul(a, b) {
    var r = 0;
    while (b) { if (b & 1) r ^= a; a = xt(a); b >>= 1; }
    return r;
  }

  function expand(key) {
    var w = key.slice(), rcon = 1;
    for (var i = 16; i < 176; i += 4) {
      var t = w.slice(i - 4, i);
      if (i % 16 === 0) {
        t = [SBOX[t[1]] ^ rcon, SBOX[t[2]], SBOX[t[3]], SBOX[t[0]]];
        rcon = xt(rcon);
      }
      for (var j = 0; j < 4; j++) w.push(w[i - 16 + j] ^ t[j]);
    }
    return w;
  }

  function addKey(s, w, r) { for (var i = 0; i < 16; i++) s[i] ^= w[r * 16 + i]; }

  function encrypt(key, block) {
    var w = expand(key), s = block.slice();
    addKey(s, w, 0);
    for (var r = 1; r <= 10; r++) {
      var t = new Array(16);
      for (var i = 0; i < 16; i++) t[i] = SBOX[s[(i + 4 * (i % 4)) % 16]]; // SubBytes+ShiftRows
      if (r < 10) {
        for (var c = 0; c < 4; c++) {
          var a0 = t[4 * c], a1 = t[4 * c + 1], a2 = t[4 * c + 2], a3 = t[4 * c + 3];
          t[4 * c] = xt(a0) ^ xt(a1) ^ a1 ^ a2 ^ a3;
          t[4 * c + 1] = a0 ^ xt(a1) ^ xt(a2) ^ a2 ^ a3;
          t[4 * c + 2] = a0 ^ a1 ^ xt(a2) ^ xt(a3) ^ a3;
          t[4 * c + 3] = xt(a0) ^ a0 ^ a1 ^ a2 ^ xt(a3);
        }
      }
      s = t; addKey(s, w, r);
    }
    return s;
  }

  function decrypt(key, block) {
    var w = expand(key), s = block.slice();
    addKey(s, w, 10);
    for (var r = 9; r >= 0; r--) {
      var t = new Array(16);
      for (var i = 0; i < 16; i++) t[(i + 4 * (i % 4)) % 16] = INV[s[i]]; // InvShiftRows+InvSubBytes
      s = t; addKey(s, w, r);
      if (r > 0) {
        for (var c = 0; c < 4; c++) {
          var a0 = s[4 * c], a1 = s[4 * c + 1], a2 = s[4 * c + 2], a3 = s[4 * c + 3];
          s[4 * c] = mul(a0, 14) ^ mul(a1, 11) ^ mul(a2, 13) ^ mul(a3, 9);
          s[4 * c + 1] = mul(a0, 9) ^ mul(a1, 14) ^ mul(a2, 11) ^ mul(a3, 13);
          s[4 * c + 2] = mul(a0, 13) ^ mul(a1, 9) ^ mul(a2, 14) ^ mul(a3, 11);
          s[4 * c + 3] = mul(a0, 11) ^ mul(a1, 13) ^ mul(a2, 9) ^ mul(a3, 14);
        }
      }
    }
    return s;
  }

  function shl1(b) {
    var out = new Array(16);
    for (var i = 0; i < 16; i++) out[i] = ((b[i] << 1) | (i < 15 ? b[i + 1] >> 7 : 0)) & 0xff;
    if (b[0] & 0x80) out[15] ^= 0x87;
    return out;
  }

  function cmac(key, msg) {
    var k1 = shl1(encrypt(key, new Array(16).fill(0))), k2 = shl1(k1);
    var n = Math.max(1, Math.ceil(msg.length / 16));
    var full = msg.length > 0 && msg.length % 16 === 0;
    var x = new Array(16).fill(0);
    for (var i = 0; i < n; i++) {
      var blk = msg.slice(i * 16, i * 16 + 16);
      if (i === n - 1) {
        if (!full) { blk.push(0x80); while (blk.length < 16) blk.push(0); }
        var k = full ? k1 : k2;
        for (var j = 0; j < 16; j++) blk[j] ^= k[j];
      }
      for (var m = 0; m < 16; m++) x[m] ^= blk[m];
      x = encrypt(key, x);
    }
    return x;
  }

  return { encrypt: encrypt, decrypt: decrypt, cmac: cmac };
})();

function hexToBytes_(hex) {
  var out = [];
  for (var i = 0; i < hex.length; i += 2) out.push(parseInt(hex.substr(i, 2), 16));
  return out;
}

function bytesToHex_(bytes) {
  return bytes.map(function (b) { return ('0' + b.toString(16)).slice(-2); }).join('').toUpperCase();
}

/**
 * NTAG 424 SUN 검증. 태그 URL: ...?p=<PICCData 32hex>&a=<START|END>&c=<CMAC 16hex>
 * 성공 시 { uid, counter } 반환, 실패 시 null.
 */
function verifySun_(metaKeyHex, fileKeyHex, a, p, c) {
  var picc = AES_.decrypt(hexToBytes_(metaKeyHex), hexToBytes_(p));
  if (picc[0] !== 0xC7) return null;                      // UID(7) + 카운터 미러 표시
  var uid = picc.slice(1, 8), ctr = picc.slice(8, 11);
  var sv2 = [0x3C, 0xC3, 0x00, 0x01, 0x00, 0x80].concat(uid, ctr);
  var sesKey = AES_.cmac(hexToBytes_(fileKeyHex), sv2);
  var input = ('a=' + a + '&c=').split('').map(function (ch) { return ch.charCodeAt(0); });
  var full = AES_.cmac(sesKey, input);
  var mac = [];
  for (var i = 1; i < 16; i += 2) mac.push(full[i]);
  var expect = bytesToHex_(mac), got = c.toUpperCase(), diff = 0;
  for (var k = 0; k < 16; k++) diff |= expect.charCodeAt(k) ^ got.charCodeAt(k);
  if (diff !== 0) return null;
  return { uid: bytesToHex_(uid), counter: ctr[0] | (ctr[1] << 8) | (ctr[2] << 16) };
}
