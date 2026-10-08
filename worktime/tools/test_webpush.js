// WebPush.gs 검증: Node 내장 crypto 와 http_ece(RFC 8291 저자의 참조 구현)로 교차 확인.
// 실행: node test_webpush.js     (http_ece 검사는 `npm install http_ece` 시에만 실행)
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert');
const crypto = require('crypto');

let ece = null;
try { ece = require(process.env.HTTP_ECE_PATH || 'http_ece'); } catch (e) { /* optional */ }

const signed = (buf) => Array.from(buf, (x) => (x > 127 ? x - 256 : x));
const buf = (arr) => Buffer.from(arr.map((x) => x & 0xff));

function loadGas() {
  const ctx = {
    console,
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' },
      MacAlgorithm: { HMAC_SHA_256: 'sha256' },
      computeDigest: (alg, v) => signed(crypto.createHash(alg).update(buf(v)).digest()),
      computeHmacSignature: (alg, v, k) => signed(crypto.createHmac(alg, buf(k)).update(buf(v)).digest()),
      base64EncodeWebSafe: (v) => buf(v).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
      base64DecodeWebSafe: (s) => signed(Buffer.from(s, 'base64')),
      getUuid: () => crypto.randomUUID(),
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty: () => {} }) },
  };
  vm.createContext(ctx);
  for (const f of ['Crypto.gs', 'WebPush.gs']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'gas', f), 'utf8'), ctx, { filename: f });
  }
  vm.runInContext('var props_ = PropertiesService.getScriptProperties();', ctx);
  return ctx;
}

const g = loadGas();
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('ok -', name); }

test('P-256 public key matches Node', () => {
  for (let i = 0; i < 5; i++) {
    const node = crypto.createECDH('prime256v1'); node.generateKeys();
    assert.deepStrictEqual(buf(g.P256_.publicFromPrivate([...node.getPrivateKey()])), node.getPublicKey());
  }
});

test('ECDH matches Node', () => {
  for (let i = 0; i < 5; i++) {
    const a = crypto.createECDH('prime256v1'); a.generateKeys();
    const b = crypto.createECDH('prime256v1'); b.generateKeys();
    assert.deepStrictEqual(buf(g.P256_.ecdh([...a.getPrivateKey()], [...b.getPublicKey()])), a.computeSecret(b.getPublicKey()));
  }
});

test('ECDSA signature verifies with Node', () => {
  const kp = g.P256_.newKeyPair();
  const jwk = {
    kty: 'EC', crv: 'P-256',
    x: buf(kp.pub.slice(1, 33)).toString('base64url'), y: buf(kp.pub.slice(33)).toString('base64url'),
  };
  const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  for (const msg of ['hello', 'eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiJ9.eyJhdWQiOiJodHRwczovL3dlYi5wdXNoLmFwcGxlLmNvbSJ9']) {
    const sig = buf(g.P256_.sign(kp.d, g.utf8_(msg)));
    assert.ok(crypto.verify('sha256', Buffer.from(msg), { key, dsaEncoding: 'ieee-p1363' }, sig));
    assert.ok(!crypto.verify('sha256', Buffer.from(msg + 'x'), { key, dsaEncoding: 'ieee-p1363' }, sig));
  }
});

test('AES-128-GCM matches Node', () => {
  for (const len of [0, 1, 16, 17, 60, 300]) {
    const key = crypto.randomBytes(16), iv = crypto.randomBytes(12), pt = crypto.randomBytes(len);
    const c = crypto.createCipheriv('aes-128-gcm', key, iv);
    const expect = Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]);
    assert.deepStrictEqual(buf(g.gcmEncrypt_([...key], [...iv], [...pt])), expect, 'len ' + len);
  }
});

test('push payload decrypts with http_ece (receiver side)', () => {
  if (!ece) return console.log('   (skipped: http_ece not installed)');
  const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
  const auth = crypto.randomBytes(16);
  const msg = JSON.stringify({ title: 'I have an unread announcement !', body: 'Règles — 공지 ✅' });
  const body = buf(g.encryptPushPayload_([...ua.getPublicKey()], [...auth], g.utf8_(msg)));
  const out = ece.decrypt(body, { version: 'aes128gcm', privateKey: ua, authSecret: auth.toString('base64url') });
  assert.strictEqual(out.toString('utf8'), msg);
});

test('push payload is byte-identical to http_ece with fixed keys', () => {
  if (!ece) return console.log('   (skipped: http_ece not installed)');
  const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
  const as = crypto.createECDH('prime256v1'); as.generateKeys();
  const auth = crypto.randomBytes(16), salt = crypto.randomBytes(16);
  const plain = Buffer.from('When I grow up, I want to be a watermelon');
  const ref = ece.encrypt(plain, {
    version: 'aes128gcm', privateKey: as, dh: ua.getPublicKey().toString('base64url'),
    authSecret: auth.toString('base64url'), salt: salt.toString('base64url'), keyid: as.getPublicKey(),
  });
  const mine = buf(g.encryptPushPayload_([...ua.getPublicKey()], [...auth], [...plain],
    { d: [...as.getPrivateKey()], pub: [...as.getPublicKey()] }, [...salt]));
  assert.deepStrictEqual(mine, ref);
});

console.log(`\n${passed} passed`);
