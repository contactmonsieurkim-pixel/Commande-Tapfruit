// Apps Script 백엔드(Code.gs + Crypto.gs)를 가짜 Google 서비스로 실행하는 테스트.
// 실행: node test_gas.js   (python3 + pycryptodome 필요: 태그 URL 생성에 사용)
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert');
const { execFileSync } = require('child_process');

const GAS = path.join(__dirname, '..', 'gas');

function makeEnv(propsInit) {
  const crypto = require('crypto');
  const props = Object.assign({}, propsInit);
  const cache = {};
  const files = {}; // id -> spreadsheet mock / drive file mock
  const sent = { mail: [], push: [] };
  const clock = { days: 0 };
  const triggers = [];
  let idSeq = 0;
  const signed = (b) => Array.from(b, (x) => (x > 127 ? x - 256 : x));
  const buf = (a) => Buffer.from(Array.from(a, (x) => x & 0xff));
  const colNum = (s) => s.split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);

  function makeSheet(name) {
    const cells = {};
    const sheet = {
      name, cells, bg: {}, protected: false,
      getName: () => sheet.name,
      setName: (n) => { sheet.name = n; return sheet; },
      getLastRow: () => Object.keys(cells).reduce((m, k) => Math.max(m, +k.split(',')[0]), 0),
      getMaxRows: () => 1000,
      setFrozenRows: () => sheet,
      protect: () => {
        sheet.protected = true;
        const p = { setDescription: () => p, getEditors: () => [], removeEditors: () => p,
                    canDomainEdit: () => false, setDomainEdit: () => p };
        return p;
      },
      getDataRange: () => ({
        getDisplayValues: () => {
          const out = [];
          for (let r = 1; r <= sheet.getLastRow(); r++) out.push([1, 2, 3, 4, 5].map((c) => cells[r + ',' + c] || ''));
          return out;
        },
      }),
      getRange: (r, c, nr, nc) => {
        if (typeof r === 'string') {
          const m = r.match(/^([A-Z]+)(\d*)(?::([A-Z]+)(\d*))?$/);
          c = colNum(m[1]); r = +m[2] || 1; nc = m[3] ? colNum(m[3]) - c + 1 : 1; nr = 1;
        }
        nr = nr || 1; nc = nc || 1;
        const rng = {
          setNumberFormat: () => rng, setFontWeight: () => rng, setVerticalAlignment: () => rng,
          setBackground: (b) => { sheet.bg[r + ',' + c] = b; return rng; },
          setValues: (v) => {
            v.forEach((row, i) => row.forEach((x, j) => {
              x = String(x);
              cells[(r + i) + ',' + (c + j)] = x[0] === "'" ? x.slice(1) : x; // 앞 ' 는 시트가 제거
            }));
            return rng;
          },
          setValue: (x) => rng.setValues([[x]]),
          getValue: () => cells[r + ',' + c] || '',
          getValues: () => Array.from({ length: nr }, (_, i) =>
            Array.from({ length: nc }, (_, j) => cells[(r + i) + ',' + (c + j)] || '')),
        };
        return rng;
      },
    };
    return sheet;
  }

  function makeSS(title) {
    const id = 'ss' + (++idSeq);
    const ss = {
      title, sheets: [makeSheet('Sheet1')], kind: 'sheet',
      getId: () => id,
      getUrl: () => 'https://docs/' + id,
      getSheets: () => ss.sheets,
      getSheetByName: (n) => ss.sheets.find((s) => s.name === n) || null,
      insertSheet: (n) => { const s = makeSheet(n); ss.sheets.push(s); return s; },
    };
    files[id] = ss;
    return ss;
  }

  const blob = (bytes, type, name) => ({
    bytes, type, name,
    getBytes: () => bytes, getContentType: () => type, getName: () => name,
  });
  const fileObj = (f) => ({
    getMimeType: () => (f.kind === 'sheet' ? 'sheets' : f.type), getId: () => f.getId(),
    moveTo: () => {}, getBlob: () => f.blob,
  });
  const folder = (fid) => ({
    getId: () => fid,
    getFilesByName: (n) => {
      const list = Object.values(files).filter((s) => s.title === n).map(fileObj);
      return { hasNext: () => list.length > 0, next: () => list.shift() };
    },
    createFolder: () => folder('folder' + (++idSeq)),
    createFile: (b) => {
      const id = 'file' + (++idSeq);
      files[id] = { kind: 'file', title: b.name, type: b.type, blob: b, getId: () => id };
      return fileObj(files[id]);
    },
  });

  const ctx = {
    console, BigInt,
    Logger: { log: () => {} },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (k) => (k in props ? props[k] : null),
      getProperties: () => Object.assign({}, props),
      setProperty: (k, v) => { props[k] = String(v); },
      deleteProperty: (k) => { delete props[k]; },
    }) },
    CacheService: { getScriptCache: () => ({
      put: (k, v) => { cache[k] = v; },
      get: (k) => (k in cache ? cache[k] : null),
    }) },
    LockService: { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) },
    Session: { getEffectiveUser: () => ({ getEmail: () => 'owner@example.com' }) },
    ScriptApp: {
      getProjectTriggers: () => triggers.slice(),
      deleteTrigger: (t) => triggers.splice(triggers.indexOf(t), 1),
      newTrigger: (fn) => {
        const b = { timeBased: () => b, everyDays: () => b, atHour: (h) => { b.hour = h; return b; },
                    inTimezone: () => b, create: () => triggers.push({ getHandlerFunction: () => fn, hour: b.hour }) };
        return b;
      },
    },
    MailApp: { sendEmail: (o) => sent.mail.push(o) },
    UrlFetchApp: {
      fetch: (url, o) => {
        sent.push.push({ url, o });
        return { getResponseCode: () => (url.includes('gone') ? 410 : 201) };
      },
    },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' },
      MacAlgorithm: { HMAC_SHA_256: 'sha256' },
      computeDigest: (a, v) => signed(crypto.createHash(a).update(buf(v)).digest()),
      computeHmacSignature: (a, v, k) => signed(crypto.createHmac(a, buf(k)).update(buf(v)).digest()),
      base64EncodeWebSafe: (v) => buf(v).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
      base64DecodeWebSafe: (s) => signed(Buffer.from(s, 'base64')),
      base64Encode: (v) => buf(v).toString('base64'),
      base64Decode: (s) => signed(Buffer.from(s, 'base64')),
      newBlob: (bytes, type, name) => blob(bytes, type, name),
      getUuid: () => crypto.randomUUID(),
      formatDate: (d, tz, fmt) => {
        d = new Date(d.getTime() + clock.days * 86400000);
        const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric',
          month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
          .formatToParts(d).map((x) => [x.type, x.value]));
        return fmt.replace('yyyy', p.year).replace('MM', p.month).replace('dd', p.day)
          .replace('HH', p.hour).replace('mm', p.minute).replace('ss', p.second);
      },
    },
    MimeType: { GOOGLE_SHEETS: 'sheets' },
    SpreadsheetApp: {
      create: (t) => makeSS(t),
      open: (f) => files[f.getId()],
      openById: (id) => files[id],
      flush: () => {},
    },
    DriveApp: {
      getFolderById: (id) => folder(id),
      getFileById: (id) => fileObj(files[id]),
    },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: (s) => ({ body: s, setMimeType() { return this; } }),
    },
  };
  vm.createContext(ctx);
  for (const f of ['Crypto.gs', 'WebPush.gs', 'Code.gs', 'Announce.gs']) {
    vm.runInContext(fs.readFileSync(path.join(GAS, f), 'utf8'), ctx, { filename: f });
  }
  ctx.setup();
  const config = files[props.CONFIG_SHEET_ID];
  config.sheets[0].getRange(2, 1, 4, 5).setValues([
    ['Nam KIM', '4321', 'TRUE', 'nam@example.com', 'TRUE'],
    ['Old Staff', '1111', 'FALSE', 'old@example.com', ''],
    ['Yuna', '2222', 'TRUE', 'yuna@example.com', ''],
    ['No Mail', '3333', 'TRUE', '', ''],
  ]);
  const call = (body) => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(body) } }).body);
  return { ctx, call, props, files, sent, clock, triggers };
}

// Python 시뮬레이터로 실제와 같은 태그 URL 생성
function tagUrls(keys, action, n) {
  const py = `
import sys, json; sys.path.insert(0, ${JSON.stringify(__dirname)})
import ntag424_setup as nt, test_ntag424 as t
keys = {k: bytes.fromhex(v) for k, v in json.loads(sys.argv[1]).items()}
import os; card = t.FakeNtag424(b"\\x04" + os.urandom(6)); tag = nt.Tag(card.transmit)
nt.program(tag, keys, t.BASE, sys.argv[2])
print(json.dumps([nt.read_and_verify(tag, keys)[0] for _ in range(int(sys.argv[3]))]))`;
  const out = execFileSync('python3', ['-c', py, JSON.stringify(keys), action, String(n)]).toString();
  return JSON.parse(out).map((u) => Object.fromEntries(new URL(u).searchParams));
}

module.exports = { makeEnv, tagUrls };
if (require.main !== module) return;

// ------------------------------------------------------------------ tests
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('ok -', name); }

const hex = () => require('crypto').randomBytes(16).toString('hex').toUpperCase();
const keys = { K0_MASTER: hex(), K1_SDM_META: hex(), K2_SDM_FILE: hex() };
const env = makeEnv({ SDM_META_KEY: keys.K1_SDM_META, SDM_FILE_KEY: keys.K2_SDM_FILE });
const [s1, s2] = tagUrls(keys, 'START', 2);
const [e1] = tagUrls(keys, 'END', 1);

test('AN12196 SUN vector', () => {
  const r = env.ctx.verifySun_('0'.repeat(32), '0'.repeat(32), 'X', 'EF963FF7828658A599F3041510671E88', '0000000000000000');
  assert.strictEqual(r, null); // 입력 문자열이 다르면 MAC 불일치
  const picc = env.ctx.AES_.decrypt(new Array(16).fill(0), env.ctx.hexToBytes_('EF963FF7828658A599F3041510671E88'));
  assert.strictEqual(env.ctx.bytesToHex_(picc.slice(1, 8)), '04DE5F1EACC040');
});

test('login rejects wrong PIN / inactive staff', () => {
  assert.strictEqual(env.call({ action: 'login', name: 'Nam KIM', pin: '0000' }).ok, false);
  assert.strictEqual(env.call({ action: 'login', name: 'Old Staff', pin: '1111' }).ok, false);
});

let token;
test('login ok (case-insensitive name)', () => {
  const r = env.call({ action: 'login', name: ' nam kim ', pin: '4321' });
  assert.ok(r.ok); assert.strictEqual(r.name, 'Nam KIM');
  token = r.token;
});

test('tap without login -> AUTH', () => {
  const r = env.call(Object.assign({ action: 'tap', token: 'nope' }, s1));
  assert.strictEqual(r.code, 'AUTH');
});

let edit;
test('tap START writes row', () => {
  const r = env.call(Object.assign({ action: 'tap', token }, s1));
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(r.info, 'START');
  assert.match(r.date, /^\d\d-\d\d$/); assert.match(r.time, /^\d\d:\d\d$/);
  edit = r.editToken;
  const ss = Object.values(env.files).find((s) => /^\d{4}-\d\d$/.test(s.title));
  const sh = ss.getSheetByName('Nam KIM');
  assert.strictEqual(ss.sheets.length, 1, 'default sheet reused');
  assert.deepStrictEqual([1, 2, 3, 4].map((c) => sh.cells['1,' + c]), ['DATE', 'TIME', 'Info', 'Modify']);
  assert.deepStrictEqual([1, 2, 3].map((c) => sh.cells['2,' + c]), [r.date, r.time, 'START']);
});

test('same link again -> REPLAY', () => {
  assert.strictEqual(env.call(Object.assign({ action: 'tap', token }, s1)).code, 'REPLAY');
});

test('tampered action -> rejected', () => {
  const r = env.call(Object.assign({ action: 'tap', token }, s2, { a: 'END' }));
  assert.strictEqual(r.ok, false); assert.notStrictEqual(r.code, 'REPLAY');
});

test('next real tap of same tag ok', () => {
  assert.ok(env.call(Object.assign({ action: 'tap', token }, s2)).ok);
});

test('END tag (different UID counter space) ok', () => {
  const r = env.call(Object.assign({ action: 'tap', token }, e1));
  assert.ok(r.ok); assert.strictEqual(r.info, 'END');
});

test('modify writes Modify column', () => {
  assert.strictEqual(env.call({ action: 'modify', token, editToken: edit, time: '25:00' }).ok, false);
  const r = env.call({ action: 'modify', token, editToken: edit, time: '08:55' });
  assert.ok(r.ok);
  const ss = Object.values(env.files).find((s) => /^\d{4}-\d\d$/.test(s.title));
  assert.strictEqual(ss.getSheetByName('Nam KIM').cells['2,4'], '08:55');
});

test('modify with unknown edit token rejected', () => {
  assert.strictEqual(env.call({ action: 'modify', token, editToken: 'x', time: '08:55' }).ok, false);
});

// ------------------------------------------------------------------ announcements
const nodeCrypto = require('crypto');
let ece = null;
try { ece = require(process.env.HTTP_ECE_PATH || 'http_ece'); } catch (e) { /* optional */ }
const recRows = (name) => {
  const sh = env.files[env.props.ANN_SHEET_ID].getSheetByName(name);
  return sh.getDataRange ? Array.from({ length: sh.getLastRow() - 1 }, (_, i) =>
    sh.getRange(i + 2, 1, 1, 8).getValues()[0]) : [];
};

test('setup: protected record sheets, daily trigger, VAPID keys', () => {
  const ss = env.files[env.props.ANN_SHEET_ID];
  assert.deepStrictEqual(ss.sheets.map((x) => x.name), ['Announcements', 'Confirmations', 'Notifications']);
  assert.ok(ss.sheets.every((x) => x.protected));
  assert.deepStrictEqual(env.triggers.map((t) => [t.getHandlerFunction(), t.hour]), [['dailyReminder', 10]]);
  env.ctx.setup(); // 다시 실행해도 중복 생성 없음
  assert.strictEqual(env.triggers.length, 1);
  assert.strictEqual(Buffer.from(env.call({ action: 'pushKey' }).publicKey, 'base64url').length, 65);
});

const yuna = env.call({ action: 'login', name: 'yuna', pin: '2222' }).token;
const ua = nodeCrypto.createECDH('prime256v1'); ua.generateKeys();
const uaAuth = nodeCrypto.randomBytes(16);

test('subscribe push devices', () => {
  assert.ok(env.call({ action: 'subscribe', token: yuna, sub: {
    endpoint: 'https://web.push.apple.com/QGuQyavXutnMHT', keys: {
      p256dh: ua.getPublicKey().toString('base64url'), auth: uaAuth.toString('base64url') } } }).ok);
  assert.ok(env.call({ action: 'subscribe', token, sub: {
    endpoint: 'https://fcm.googleapis.com/gone', keys: {
      p256dh: ua.getPublicKey().toString('base64url'), auth: uaAuth.toString('base64url') } } }).ok);
  assert.strictEqual(env.call({ action: 'subscribe', token: yuna, sub: { endpoint: 'http://x' } }).ok, false);
});

test('only admins can post', () => {
  const r = env.call({ action: 'post', token: yuna, title: 'x', content: 'y' });
  assert.strictEqual(r.ok, false);
});

const photo = 'data:image/jpeg;base64,' + nodeCrypto.randomBytes(300).toString('base64');
let annId;
test('admin posts announcement -> push + email to every active employee', () => {
  const before = { mail: env.sent.mail.length, push: env.sent.push.length };
  const r = env.call({ action: 'post', token, title: 'Kitchen rules', content: 'Wash hands.\r\nWear caps.', photos: [photo] });
  assert.ok(r.ok, JSON.stringify(r));
  annId = r.id;
  assert.strictEqual(annId, 'A0001');
  const row = recRows('Announcements')[0];
  assert.deepStrictEqual(row.slice(2, 5), ['Nam KIM', 'Kitchen rules', 'Wash hands.\nWear caps.']);
  assert.match(row[5], /^https:\/\/drive\.google\.com\/file\/d\/file\d+\/view$/);
  assert.strictEqual(row[6], 'Nam KIM, Yuna, No Mail');
  const mails = env.sent.mail.slice(before.mail);
  assert.deepStrictEqual(mails.map((m) => m.to).sort(), ['nam@example.com', 'yuna@example.com']);
  assert.strictEqual(mails[0].subject, 'I have an unread announcement !');
  assert.strictEqual(Object.keys(mails[0].inlineImages).length, 1);
  assert.match(mails[0].htmlBody, /Kitchen rules/);
  assert.strictEqual(env.sent.push.length - before.push, 2);
  assert.ok(!Object.values(env.props).some((v) => String(v).includes('/gone')), 'expired subscription removed');
});

test('push request: valid VAPID JWT + payload decrypts to the notification', () => {
  const req = env.sent.push.find((x) => x.url.includes('apple'));
  const auth = req.o.headers.Authorization.match(/^vapid t=([^,]+), k=(.+)$/);
  const [h, b, sig] = auth[1].split('.');
  const pub = Buffer.from(auth[2], 'base64url');
  const key = nodeCrypto.createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256',
    x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') } });
  assert.ok(nodeCrypto.verify('sha256', Buffer.from(h + '.' + b), { key, dsaEncoding: 'ieee-p1363' },
    Buffer.from(sig, 'base64url')));
  const claims = JSON.parse(Buffer.from(b, 'base64url'));
  assert.strictEqual(claims.aud, 'https://web.push.apple.com');
  assert.strictEqual(claims.sub, 'mailto:owner@example.com');
  assert.strictEqual(req.o.headers['Content-Encoding'], 'aes128gcm');
  if (!ece) return console.log('   (payload decryption skipped: http_ece not installed)');
  const msg = JSON.parse(ece.decrypt(Buffer.from(req.o.payload.map((x) => x & 0xff)),
    { version: 'aes128gcm', privateKey: ua, authSecret: uaAuth.toString('base64url') }));
  assert.deepStrictEqual(msg, { title: 'I have an unread announcement !', body: 'Kitchen rules',
    url: 'https://contactmonsieurkim-pixel.github.io/Commande-Tapfruit/worktime/?view=ann' });
});

test('unread count on me + on NFC tap', () => {
  assert.strictEqual(env.call({ action: 'me', token: yuna }).unread, 1);
  const [t] = tagUrls(keys, 'START', 1);
  const r = env.call(Object.assign({ action: 'tap', token: yuna }, t));
  assert.ok(r.ok); assert.strictEqual(r.unread, 1);
});

test('announcement list + photo for recipient', () => {
  const list = env.call({ action: 'anns', token: yuna }).announcements;
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].confirmedAt, null);
  assert.strictEqual(list[0].photos, 1);
  assert.strictEqual(env.call({ action: 'photo', token: yuna, id: annId, index: 0 }).dataUrl, photo);
});

let confirmedAt;
test('confirm records name + time once', () => {
  const r = env.call({ action: 'confirm', token: yuna, id: annId });
  assert.ok(r.ok); assert.strictEqual(r.unread, 0);
  confirmedAt = r.confirmedAt;
  assert.match(confirmedAt, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  assert.strictEqual(env.call({ action: 'confirm', token: yuna, id: annId }).confirmedAt, confirmedAt);
  const rows = recRows('Confirmations');
  assert.strictEqual(rows.length, 1);
  assert.deepStrictEqual(rows[0].slice(0, 4), [annId, 'Kitchen rules', 'Yuna', confirmedAt]);
});

test('employee hired after posting does not get the old announcement', () => {
  const config = env.files[env.props.CONFIG_SHEET_ID];
  config.sheets[0].getRange(6, 1, 1, 5).setValues([['Late Hire', '5555', 'TRUE', 'late@example.com', '']]);
  const late = env.call({ action: 'login', name: 'Late Hire', pin: '5555' }).token;
  assert.strictEqual(env.call({ action: 'anns', token: late }).announcements.length, 0);
  assert.strictEqual(env.call({ action: 'confirm', token: late, id: annId }).ok, false);
});

test('daily reminder: skip same day, then daily to those who have not confirmed', () => {
  const n0 = env.sent.mail.length;
  env.ctx.dailyReminder();
  assert.strictEqual(env.sent.mail.length, n0, 'no reminder on the posting day');
  env.clock.days = 1;
  env.ctx.dailyReminder();
  assert.deepStrictEqual(env.sent.mail.slice(n0).map((m) => m.to), ['nam@example.com']);
  const notes = recRows('Notifications').filter((r) => r[3].startsWith('reminder'));
  assert.deepStrictEqual(notes.map((r) => [r[2], r[3], r[4]]), [
    ['Nam KIM', 'reminder push', 'no device registered'],
    ['Nam KIM', 'reminder email', 'sent'],
    ['No Mail', 'reminder push', 'no device registered'],
    ['No Mail', 'reminder email', 'no email address'],
  ]);
  env.clock.days = 0;
});

test('admin status: who confirmed when, who is pending, integrity OK', () => {
  assert.strictEqual(env.call({ action: 'status', token: yuna }).ok, false);
  const r = env.call({ action: 'status', token });
  assert.ok(r.ok);
  assert.deepStrictEqual(r.announcements[0].confirmed, [{ name: 'Yuna', at: confirmedAt }]);
  assert.deepStrictEqual(r.announcements[0].pending, ['Nam KIM', 'No Mail']);
  assert.strictEqual(r.integrity, true);
});

test('formula-looking content is stored as text and still verifies', () => {
  const r = env.call({ action: 'post', token, title: '=1+1', content: '=HYPERLINK("x")' });
  assert.ok(r.ok);
  assert.deepStrictEqual(recRows('Announcements')[1].slice(3, 5), ['=1+1', '=HYPERLINK("x")']);
  assert.ok(env.ctx.verifyRecords().every((x) => x.ok));
});

test('manual edit or deletion in the records is detected', () => {
  const sh = env.files[env.props.ANN_SHEET_ID].getSheetByName('Confirmations');
  const orig = sh.cells['2,4'];
  sh.cells['2,4'] = '2026-01-01 09:00:00';
  let rep = env.ctx.verifyRecords();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(rep.find((x) => x.sheet === 'Confirmations'))),
    { sheet: 'Confirmations', ok: false, row: 2 });
  assert.strictEqual(env.call({ action: 'status', token }).integrity, false);
  sh.cells['2,4'] = orig;
  const notes = env.files[env.props.ANN_SHEET_ID].getSheetByName('Notifications');
  const last = notes.getLastRow();
  const saved = [1, 2, 3, 4, 5, 6].map((c) => notes.cells[last + ',' + c]);
  [1, 2, 3, 4, 5, 6].forEach((c) => delete notes.cells[last + ',' + c]);
  rep = env.ctx.verifyRecords();
  assert.strictEqual(rep.find((x) => x.sheet === 'Notifications').ok, false);
  saved.forEach((v, i) => { notes.cells[last + ',' + (i + 1)] = v; });
  assert.ok(env.ctx.verifyRecords().every((x) => x.ok));
});

console.log(`\n${passed} passed`);
