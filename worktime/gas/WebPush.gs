// Web Push (RFC 8030 / 8291 aes128gcm / 8292 VAPID) — Apps Script 에는 ECDSA·ECDH 가 없어서 직접 구현.
// P-256 연산은 BigInt, AES 블록은 Crypto.gs 의 AES_ 사용. 해시·HMAC 은 Utilities 사용.

var P256_ = (function () {
  var p = BigInt('0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff');
  var n = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
  var b = BigInt('0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b');
  var G = {
    x: BigInt('0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296'),
    y: BigInt('0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5'),
  };
  var ZERO = BigInt(0), ONE = BigInt(1), TWO = BigInt(2), THREE = BigInt(3);

  function mod(x, m) { var r = x % m; return r < ZERO ? r + m : r; }
  function pow(x, e, m) {
    var r = ONE; x = mod(x, m);
    while (e > ZERO) { if (e & ONE) r = r * x % m; x = x * x % m; e >>= ONE; }
    return r;
  }
  function inv(x, m) { return pow(x, m - TWO, m); }

  // Jacobian 좌표 [X, Y, Z], 무한원점은 null
  function dbl(P) {
    if (!P || P[1] === ZERO) return null;
    var X = P[0], Y = P[1], Z = P[2];
    var delta = Z * Z % p, gamma = Y * Y % p, beta = X * gamma % p;
    var alpha = THREE * mod(X - delta, p) * (X + delta) % p;
    var X3 = mod(alpha * alpha - BigInt(8) * beta, p);
    var Z3 = mod((Y + Z) * (Y + Z) - gamma - delta, p);
    var Y3 = mod(alpha * mod(BigInt(4) * beta - X3, p) - BigInt(8) * gamma * gamma, p);
    return [X3, Y3, Z3];
  }
  function add(P, Q) {
    if (!P) return Q;
    if (!Q) return P;
    var Z1Z1 = P[2] * P[2] % p, Z2Z2 = Q[2] * Q[2] % p;
    var U1 = P[0] * Z2Z2 % p, U2 = Q[0] * Z1Z1 % p;
    var S1 = P[1] * Q[2] % p * Z2Z2 % p, S2 = Q[1] * P[2] % p * Z1Z1 % p;
    if (U1 === U2) return S1 === S2 ? dbl(P) : null;
    var H = mod(U2 - U1, p), I = TWO * H % p; I = I * I % p;
    var J = H * I % p, r = TWO * mod(S2 - S1, p) % p, V = U1 * I % p;
    var X3 = mod(r * r - J - TWO * V, p);
    var Y3 = mod(r * mod(V - X3, p) - TWO * S1 * J, p);
    var Z3 = mod(((P[2] + Q[2]) * (P[2] + Q[2]) - Z1Z1 - Z2Z2) * H, p);
    return [X3, Y3, Z3];
  }
  function mul(k, pt) {
    var R = null, A = [pt.x, pt.y, ONE];
    for (var i = k.toString(2), j = 0; j < i.length; j++) {
      R = dbl(R);
      if (i[j] === '1') R = add(R, A);
    }
    if (!R) throw new Error('point at infinity');
    var zi = inv(R[2], p), zi2 = zi * zi % p;
    return { x: R[0] * zi2 % p, y: R[1] * zi2 % p * zi % p };
  }
  function onCurve(pt) {
    return mod(pt.y * pt.y - (pt.x * pt.x * pt.x - THREE * pt.x + b), p) === ZERO;
  }

  function toInt(bytes) { return BigInt('0x' + (bytesToHex_(bytes) || '0')); }
  function toBytes(x) {
    var h = x.toString(16);
    while (h.length < 64) h = '0' + h;
    return hexToBytes_(h);
  }
  function pub(d) { var Q = mul(d, G); return [4].concat(toBytes(Q.x), toBytes(Q.y)); }
  function parsePub(bytes) {
    if (bytes.length !== 65 || bytes[0] !== 4) throw new Error('bad P-256 public key');
    var Q = { x: toInt(bytes.slice(1, 33)), y: toInt(bytes.slice(33, 65)) };
    if (!onCurve(Q)) throw new Error('public key not on curve');
    return Q;
  }
  function privKey() {
    var d;
    do { d = toInt(randomBytes_(32)); } while (d === ZERO || d >= n);
    return d;
  }

  return {
    n: n,
    newKeyPair: function () { var d = privKey(); return { d: toBytes(d), pub: pub(d) }; },
    publicFromPrivate: function (dBytes) { return pub(toInt(dBytes)); },
    ecdh: function (dBytes, pubBytes) { return toBytes(mul(toInt(dBytes), parsePub(pubBytes)).x); },
    // ECDSA P-256 / SHA-256, 서명은 r||s (64바이트, JWS 형식)
    sign: function (dBytes, msgBytes) {
      var d = toInt(dBytes), e = toInt(sha256_(msgBytes));
      for (;;) {
        var k = mod(toInt(hmac_(dBytes, randomBytes_(32).concat(sha256_(msgBytes)))), n - ONE) + ONE;
        var r = mod(mul(k, G).x, n);
        if (r === ZERO) continue;
        var s = mod(inv(k, n) * (e + r * d), n);
        if (s === ZERO) continue;
        return toBytes(r).concat(toBytes(s));
      }
    },
  };
})();

// ------------------------------------------------------------------ bytes / hashes

function s8_(a) { return a.map(function (x) { return x > 127 ? x - 256 : x; }); }
function u8_(a) { return Array.prototype.map.call(a, function (x) { return x & 0xff; }); }
function sha256_(bytes) { return u8_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s8_(bytes))); }
function hmac_(key, data) {
  return u8_(Utilities.computeHmacSignature(Utilities.MacAlgorithm.HMAC_SHA_256, s8_(data), s8_(key)));
}
function utf8_(str) {
  var s = unescape(encodeURIComponent(str)), out = [];
  for (var i = 0; i < s.length; i++) out.push(s.charCodeAt(i));
  return out;
}
function b64u_(bytes) { return Utilities.base64EncodeWebSafe(s8_(bytes)).replace(/=+$/, ''); }
function unb64u_(str) {
  str = String(str).replace(/\+/g, '-').replace(/\//g, '_');
  while (str.length % 4) str += '=';
  return u8_(Utilities.base64DecodeWebSafe(str));
}
var rndCounter_ = 0;
function randomBytes_(n) {
  var out = [];
  while (out.length < n) {
    out = out.concat(sha256_(utf8_(Utilities.getUuid() + Utilities.getUuid() + Date.now() + ':' + (rndCounter_++))));
  }
  return out.slice(0, n);
}

// ------------------------------------------------------------------ AES-128-GCM

function gcmEncrypt_(key, iv12, plain) {
  var H = AES_.encrypt(key, new Array(16).fill(0));
  var R = BigInt('0xE1') << BigInt(120), ONE = BigInt(1);
  var Hn = BigInt('0x' + bytesToHex_(H));
  function gmul(X) {
    var Z = BigInt(0), V = Hn;
    for (var i = 127; i >= 0; i--) {
      if ((X >> BigInt(i)) & ONE) Z ^= V;
      V = (V & ONE) ? (V >> ONE) ^ R : V >> ONE;
    }
    return Z;
  }
  function blockInt(b) { var c = b.slice(); while (c.length < 16) c.push(0); return BigInt('0x' + bytesToHex_(c)); }
  var counter = iv12.concat([0, 0, 0, 1]);
  function inc(c) {
    c = c.slice();
    for (var i = 15; i >= 12; i--) { c[i] = (c[i] + 1) & 0xff; if (c[i]) break; }
    return c;
  }
  var tagMask = AES_.encrypt(key, counter), ct = [], cb = counter;
  for (var off = 0; off < plain.length; off += 16) {
    cb = inc(cb);
    var ks = AES_.encrypt(key, cb), blk = plain.slice(off, off + 16);
    for (var i = 0; i < blk.length; i++) ct.push(blk[i] ^ ks[i]);
  }
  var S = BigInt(0);
  for (var j = 0; j < ct.length; j += 16) S = gmul(S ^ blockInt(ct.slice(j, j + 16)));
  S = gmul(S ^ BigInt(ct.length * 8)); // len(A)=0 || len(C) bits
  var tag = hexToBytes_(('0'.repeat(32) + S.toString(16)).slice(-32));
  for (var t = 0; t < 16; t++) tag[t] ^= tagMask[t];
  return ct.concat(tag);
}

// ------------------------------------------------------------------ RFC 8291 (aes128gcm)

function encryptPushPayload_(uaPublic, authSecret, plain, asKeys, salt) {
  asKeys = asKeys || P256_.newKeyPair();
  salt = salt || randomBytes_(16);
  var ecdh = P256_.ecdh(asKeys.d, uaPublic);
  var prkKey = hmac_(authSecret, ecdh);
  var keyInfo = utf8_('WebPush: info').concat([0], uaPublic, asKeys.pub);
  var ikm = hmac_(prkKey, keyInfo.concat([1]));
  var prk = hmac_(salt, ikm);
  var cek = hmac_(prk, utf8_('Content-Encoding: aes128gcm').concat([0, 1])).slice(0, 16);
  var nonce = hmac_(prk, utf8_('Content-Encoding: nonce').concat([0, 1])).slice(0, 12);
  var ct = gcmEncrypt_(cek, nonce, plain.concat([2]));
  return salt.concat([0, 0, 16, 0], [65], asKeys.pub, ct); // rs=4096
}

// ------------------------------------------------------------------ VAPID + 전송

function vapidKeys_() {
  var d = props_.getProperty('VAPID_PRIVATE');
  if (!d) {
    var kp = P256_.newKeyPair();
    props_.setProperty('VAPID_PRIVATE', b64u_(kp.d));
    props_.setProperty('VAPID_PUBLIC', b64u_(kp.pub));
    d = b64u_(kp.d);
  }
  return { d: unb64u_(d), pub: props_.getProperty('VAPID_PUBLIC') };
}

var vapidJwtCache_ = {};
function vapidJwt_(aud) {
  if (vapidJwtCache_[aud]) return vapidJwtCache_[aud];
  var keys = vapidKeys_();
  var subject = props_.getProperty('VAPID_SUBJECT') || 'mailto:' + Session.getEffectiveUser().getEmail();
  var head = b64u_(utf8_(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  var body = b64u_(utf8_(JSON.stringify({ aud: aud, exp: Math.floor(Date.now() / 1000) + 50 * 60, sub: subject })));
  var unsigned = head + '.' + body;
  return (vapidJwtCache_[aud] = unsigned + '.' + b64u_(P256_.sign(keys.d, utf8_(unsigned))));
}

/** 구독 하나로 푸시 전송. HTTP 상태코드 반환 (201 성공, 404/410 = 만료된 구독). */
function sendWebPush_(sub, message) {
  var aud = sub.endpoint.match(/^https:\/\/[^/]+/)[0];
  var body = encryptPushPayload_(unb64u_(sub.keys.p256dh), unb64u_(sub.keys.auth), utf8_(JSON.stringify(message)));
  var res = UrlFetchApp.fetch(sub.endpoint, {
    method: 'post',
    contentType: 'application/octet-stream',
    payload: s8_(body),
    headers: {
      Authorization: 'vapid t=' + vapidJwt_(aud) + ', k=' + vapidKeys_().pub,
      'Content-Encoding': 'aes128gcm',
      TTL: '86400',
      Urgency: 'high',
    },
    muteHttpExceptions: true,
  });
  return res.getResponseCode();
}
