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
  // 테스트 시계: 기본은 파리 시간 낮 12시 (실제 실행 시각과 무관하게 결과가 같도록)
  const clock = { days: 0, fixed: '2026-10-09T12:00:00+02:00' };
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
          for (let r = 1; r <= sheet.getLastRow(); r++) out.push([1, 2, 3, 4, 5, 6, 7].map((c) => cells[r + ',' + c] || ''));
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
    LockService: { getScriptLock: () => ({ waitLock: () => {}, tryLock: () => true, releaseLock: () => {} }) },
    Session: { getEffectiveUser: () => ({ getEmail: () => 'owner@example.com' }) },
    ScriptApp: {
      getProjectTriggers: () => triggers.slice(),
      deleteTrigger: (t) => triggers.splice(triggers.indexOf(t), 1),
      newTrigger: (fn) => {
        const b = { timeBased: () => b, everyDays: () => b, atHour: (h) => { b.hour = h; return b; },
                    at: (d) => { b.at = d; return b; }, inTimezone: () => b,
                    create: () => triggers.push({ getHandlerFunction: () => fn, hour: b.hour, at: b.at }) };
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
        d = new Date((clock.fixed ? new Date(clock.fixed).getTime() : d.getTime()) + clock.days * 86400000);
        if (fmt === 'Z') {
          const off = new Intl.DateTimeFormat('en-GB', { timeZone: tz, timeZoneName: 'longOffset' })
            .formatToParts(d).find((x) => x.type === 'timeZoneName').value; // GMT+02:00
          return off === 'GMT' ? '+0000' : off.slice(3).replace(':', '');
        }
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
  for (const f of ['Crypto.gs', 'WebPush.gs', 'Code.gs', 'Announce.gs', 'Supervisor.gs']) {
    vm.runInContext(fs.readFileSync(path.join(GAS, f), 'utf8'), ctx, { filename: f });
  }
  ctx.setup();
  const config = files[props.CONFIG_SHEET_ID];
  config.sheets[0].getRange(2, 1, 4, 7).setValues([
    ['Nam KIM', '4321', 'TRUE', 'nam@example.com', 'TRUE', 'Service', 'TRUE'],
    ['Old Staff', '1111', 'FALSE', 'old@example.com', '', 'Kitchen', ''],
    ['Yuna', '2222', 'TRUE', 'yuna@example.com', '', 'Kitchen', ''],
    ['No Mail', '3333', 'TRUE', '', '', 'Kitchen', ''],
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
    sh.getRange(i + 2, 1, 1, 9).getValues()[0]) : [];
};

test('setup: protected record sheets, daily trigger, VAPID keys', () => {
  const ss = env.files[env.props.ANN_SHEET_ID];
  assert.deepStrictEqual(ss.sheets.map((x) => x.name), ['Announcements', 'Confirmations', 'Notifications', 'Logins']);
  assert.ok(ss.sheets.every((x) => x.protected));
  assert.deepStrictEqual(env.triggers.map((t) => [t.getHandlerFunction(), t.hour]), [['scheduleMorning', 7]]);
  const head = env.files[env.props.CONFIG_SHEET_ID].sheets[0];
  assert.deepStrictEqual([1, 2, 3, 4, 5, 6, 7].map((c) => head.cells['1,' + c]),
    ['Name', 'PIN', 'Active', 'Email', 'Admin', 'Team', 'Supervisor']);
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
  const r = env.call({ action: 'post', token, title: 'Kitchen rules', content: 'Wash hands.\r\nWear caps.', photos: [photo], rule: true });
  assert.ok(r.ok, JSON.stringify(r));
  annId = r.id;
  assert.strictEqual(annId, 'A0001');
  const row = recRows('Announcements')[0];
  assert.deepStrictEqual(row.slice(2, 5), ['Nam KIM', 'Kitchen rules', 'Wash hands.\nWear caps.']);
  assert.match(row[5], /^https:\/\/drive\.google\.com\/file\/d\/file\d+\/view$/);
  assert.strictEqual(row[6], 'Nam KIM, Yuna, No Mail');
  assert.strictEqual(row[7], 'Rule');
  const mails = env.sent.mail.slice(before.mail);
  assert.deepStrictEqual(mails.map((m) => m.to).sort(), ['nam@example.com', 'yuna@example.com']);
  assert.strictEqual(mails[0].subject, 'I have an unread announcement !');
  assert.strictEqual(Object.keys(mails[0].inlineImages).length, 1);
  assert.match(mails[0].htmlBody, /Kitchen rules/);
  assert.strictEqual(mails[0].name, 'monsieur Kim');
  const h = mails[0].htmlBody;
  assert.ok(h.indexOf('Go to Confirm') < h.indexOf('Kitchen rules'), 'button above the content');
  assert.strictEqual(h.split('Go to Confirm').length - 1, 1, 'only one button');
  assert.ok(!/Open Work Time/.test(h));
  const refs = mails.map((m) => m.htmlBody.match(/Ref ([^<]+)</)[1]);
  assert.strictEqual(new Set(refs).size, refs.length, 'every email ends differently (no Gmail trimming)');
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
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r.tips)),
    [{ id: 'A0001', title: 'Kitchen rules', content: 'Wash hands.\nWear caps.' }]);
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
  env.ctx.morningRun();
  assert.strictEqual(env.sent.mail.length, n0, 'no reminder on the posting day');
  env.clock.days = 1;
  env.ctx.morningRun();
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
  assert.strictEqual(recRows('Announcements')[1][7], 'Notice');
  assert.strictEqual(env.call({ action: 'me', token }).tips.length, 1, 'notices are not tips');
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

// ------------------------------------------------------------------ audience (team / people)
const lastAnn = () => recRows('Announcements').slice(-1)[0];

test('staff list for the audience picker (managers only)', () => {
  assert.strictEqual(env.call({ action: 'staff', token: yuna }).ok, false);
  const r = env.call({ action: 'staff', token });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r.staff)), [
    { name: 'Nam KIM', team: 'Service' }, { name: 'Yuna', team: 'Kitchen' },
    { name: 'No Mail', team: 'Kitchen' }, { name: 'Late Hire', team: '' }]);
});

test('post to a team -> only that team is notified and must confirm', () => {
  const m0 = env.sent.mail.length;
  const r = env.call({ action: 'post', token, title: 'Knife storage', content: 'Knives on the magnet only.',
                      rule: true, audience: { teams: ['kitchen'] } });
  assert.ok(r.ok, JSON.stringify(r));
  const row = lastAnn();
  assert.strictEqual(row[6], 'Yuna, No Mail');
  assert.strictEqual(row[7], 'Rule · Teams: Kitchen');
  assert.deepStrictEqual(env.sent.mail.slice(m0).map((m) => m.to), ['yuna@example.com']);
  assert.ok(env.call({ action: 'anns', token: yuna }).announcements.some((a) => a.title === 'Knife storage'));
  assert.ok(!env.call({ action: 'anns', token }).announcements.some((a) => a.title === 'Knife storage'));
});

test('post to a team + individual people', () => {
  const r = env.call({ action: 'post', token, title: 'Terrace', content: 'Terrace opens at 18:00.',
                      audience: { teams: ['Service'], people: ['yuna'] } });
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(lastAnn()[6], 'Nam KIM, Yuna');
  assert.strictEqual(lastAnn()[7], 'Notice · Teams: Service · People: Yuna');
});

test('post to individual people only', () => {
  assert.ok(env.call({ action: 'post', token, title: 'Your locker', content: 'Locker 4 is yours.',
                       audience: { people: ['No Mail'] } }).ok);
  assert.strictEqual(lastAnn()[6], 'No Mail');
  assert.strictEqual(lastAnn()[7], 'Notice · People: No Mail');
});

test('invalid audiences are rejected and nothing is recorded', () => {
  const n = recRows('Announcements').length;
  for (const audience of [{ teams: ['Bar'] }, { people: ['Old Staff'] }, { people: ['Nobody'] }, { teams: [], people: [] }]) {
    assert.strictEqual(env.call({ action: 'post', token, title: 't', content: 'c', audience }).ok, false, JSON.stringify(audience));
  }
  assert.strictEqual(recRows('Announcements').length, n);
});

test('team rules show as tips only to that team (including new hires)', () => {
  const titles = (t) => env.call({ action: 'me', token: t }).tips.map((x) => x.title).sort();
  assert.deepStrictEqual(titles(yuna), ['Kitchen rules', 'Knife storage']);
  assert.deepStrictEqual(titles(token), ['Kitchen rules']);
  const config = env.files[env.props.CONFIG_SHEET_ID];
  config.sheets[0].getRange(7, 1, 1, 6).setValues([['New Cook', '7777', 'TRUE', '', '', 'Kitchen']]);
  const cook = env.call({ action: 'login', name: 'New Cook', pin: '7777' }).token;
  assert.deepStrictEqual(titles(cook), ['Kitchen rules', 'Knife storage']);
  assert.strictEqual(env.call({ action: 'me', token: cook }).unread, 0, 'not a recipient of old posts');
});

test('admin status shows the audience; records still verify', () => {
  const st = env.call({ action: 'status', token });
  assert.strictEqual(st.announcements.find((a) => a.title === 'Knife storage').audience, 'Teams: Kitchen');
  assert.strictEqual(st.announcements.find((a) => a.title === 'Kitchen rules').audience, 'Everyone');
  assert.strictEqual(st.integrity, true);
});

// ------------------------------------------------------------------ supervisor
const supKey = nodeCrypto.createECDH('prime256v1'); supKey.generateKeys();
const supAuth = nodeCrypto.randomBytes(16);
const SUP_ENDPOINT = 'https://web.push.apple.com/supervisor-iphone';
const pushesTo = (endpoint, from) => env.sent.push.slice(from).filter((x) => x.url === endpoint);
const decrypt = (req) => JSON.parse(ece.decrypt(Buffer.from(req.o.payload.map((x) => x & 0xff)),
  { version: 'aes128gcm', privateKey: supKey, authSecret: supAuth.toString('base64url') }));
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

test('existing records file gets the new Logins sheet on setup', () => {
  const ss = env.files[env.props.ANN_SHEET_ID];
  ss.sheets = ss.sheets.filter((x) => x.name !== 'Logins');
  delete env.props.chain_Logins;
  env.ctx.setup();
  assert.ok(ss.getSheetByName('Logins').protected);
  assert.ok(env.ctx.verifyRecords().every((x) => x.ok));
});

test('supervisor registers a device (bell)', () => {
  assert.ok(env.call({ action: 'subscribe', token, sub: { endpoint: SUP_ENDPOINT, keys: {
    p256dh: supKey.getPublicKey().toString('base64url'), auth: supAuth.toString('base64url') } } }).ok);
});

test('login on a new device -> record + push to the supervisor only', () => {
  const n0 = env.sent.push.length;
  const first = env.call({ action: 'login', name: 'No Mail', pin: '3333', device: { ua: IPHONE, standalone: true } });
  assert.ok(first.ok);
  env.call({ action: 'login', name: 'No Mail', pin: '3333', device: { ua: IPHONE, standalone: false } });
  const sup = pushesTo(SUP_ENDPOINT, n0);
  assert.strictEqual(sup.length, 2);
  assert.strictEqual(env.sent.push.length - n0, 2, 'nobody else is notified');
  const rows = recRows('Logins').filter((r) => r[1] === 'No Mail');
  assert.deepStrictEqual(rows.map((r) => [r[2], r[3]]), [['iPhone · home screen app', '1'], ['iPhone · Safari', '2']]);
  if (!ece) return console.log('   (payload check skipped: http_ece not installed)');
  const msg = decrypt(sup[1]);
  assert.strictEqual(msg.title, 'New login: No Mail');
  assert.match(msg.body, /^iPhone · Safari \(device #2\)  ·  \d\d-\d\d \d\d:\d\d$/);
});

test('every clock-in/out -> push to the supervisor: who, when, START/END', () => {
  const n0 = env.sent.push.length;
  const [t] = tagUrls(keys, 'END', 1);
  const r = env.call(Object.assign({ action: 'tap', token: yuna }, t));
  assert.ok(r.ok);
  const sup = pushesTo(SUP_ENDPOINT, n0);
  assert.strictEqual(sup.length, 1);
  if (!ece) return;
  const msg = decrypt(sup[0]);
  assert.strictEqual(msg.title, '🔴 END · Yuna');
  assert.strictEqual(msg.body, 'Yuna clocked out (END) at ' + r.time + ' · ' + r.date);
  assert.match(msg.tag, /^clock-/);
});

test('a failing push never blocks clock-in or login', () => {
  const orig = env.ctx.UrlFetchApp.fetch;
  env.ctx.UrlFetchApp.fetch = () => { throw new Error('push service down'); };
  const [t] = tagUrls(keys, 'START', 1);
  assert.ok(env.call(Object.assign({ action: 'tap', token: yuna }, t)).ok);
  assert.ok(env.call({ action: 'login', name: 'Yuna', pin: '2222' }).ok);
  env.ctx.UrlFetchApp.fetch = orig;
});

test('supervisor can be changed/added in the sheet; supervisor has manager rights', () => {
  const config = env.files[env.props.CONFIG_SHEET_ID];
  config.sheets[0].getRange(8, 1, 1, 7).setValues([['Second Boss', '8888', 'TRUE', '', '', '', 'TRUE']]);
  const boss = env.call({ action: 'login', name: 'Second Boss', pin: '8888' });
  assert.strictEqual(boss.admin, true);
  assert.ok(env.call({ action: 'status', token: boss.token }).ok);
  assert.deepStrictEqual(Array.from(env.ctx.supervisors_(), (e) => e.name), ['Nam KIM', 'Second Boss']);
  assert.strictEqual(env.call({ action: 'status', token: yuna }).ok, false);
});

// ------------------------------------------------------------------ quiet hours (23:00 - 09:00 Paris)
{
  const q = makeEnv({ SDM_META_KEY: keys.K1_SDM_META, SDM_FILE_KEY: keys.K2_SDM_FILE });
  const at = (iso) => { q.clock.fixed = iso; q.clock.days = 0; };
  const pushesTo = (endpoint, from) => q.sent.push.slice(from).filter((x) => x.url === endpoint);
  const boss = q.call({ action: 'login', name: 'Nam KIM', pin: '4321' }).token;
  const yu = q.call({ action: 'login', name: 'Yuna', pin: '2222' }).token;
  q.call({ action: 'subscribe', token: boss, sub: { endpoint: SUP_ENDPOINT, keys: {
    p256dh: supKey.getPublicKey().toString('base64url'), auth: supAuth.toString('base64url') } } });
  const rows = (name) => {
    const sh = q.files[q.props.ANN_SHEET_ID].getSheetByName(name);
    return Array.from({ length: sh.getLastRow() - 1 }, (_, i) => sh.getRange(i + 2, 1, 1, 9).getValues()[0]);
  };

  test('quiet: announcement posted at 23:30 is saved but not sent', () => {
    at('2026-10-09T23:30:00+02:00');
    const m0 = q.sent.mail.length, p0 = q.sent.push.length;
    const r = q.call({ action: 'post', token: boss, title: 'Night notice', content: 'Posted late.' });
    assert.ok(r.ok); assert.strictEqual(r.queued, true); assert.strictEqual(r.sendAt, '09:00');
    assert.strictEqual(q.sent.mail.length, m0); assert.strictEqual(q.sent.push.length, p0);
    assert.strictEqual(rows('Announcements').length, 1, 'recorded immediately');
    assert.strictEqual(q.call({ action: 'me', token: yu }).unread, 1, 'visible in the app right away');
  });

  test('quiet: clock-in/out alerts still go out at once, login alerts are held', () => {
    at('2026-10-09T23:40:00+02:00');
    const p0 = q.sent.push.length;
    const [t] = tagUrls(keys, 'END', 1);
    assert.ok(q.call(Object.assign({ action: 'tap', token: yu }, t)).ok, 'clock-out still recorded');
    at('2026-10-10T02:10:00+02:00');
    const clock = pushesTo(SUP_ENDPOINT, p0);
    assert.strictEqual(clock.length, 1, 'clock-out pushed at 23:40');
    if (ece) assert.strictEqual(decrypt(clock[0]).title, '🔴 END · Yuna');
    const p1 = q.sent.push.length;
    assert.ok(q.call({ action: 'login', name: 'No Mail', pin: '3333' }).ok);
    assert.strictEqual(q.sent.push.length, p1, 'login alert held');
    assert.strictEqual(JSON.parse(q.props.SUP_QUEUE).length, 1);
  });

  test('07:xx schedules the 09:00 sharp run (summer and winter time)', () => {
    at('2026-10-10T07:10:00+02:00');
    q.ctx.scheduleMorning();
    const runs = q.triggers.filter((x) => x.getHandlerFunction() === 'morningRun');
    assert.strictEqual(runs.length, 1);
    assert.strictEqual(runs[0].at.toISOString(), '2026-10-10T07:00:00.000Z'); // 09:00 CEST
    at('2026-11-15T07:05:00+01:00');
    q.ctx.scheduleMorning();
    assert.strictEqual(q.triggers.filter((x) => x.getHandlerFunction() === 'morningRun')[0].at.toISOString(),
      '2026-11-15T08:00:00.000Z'); // 09:00 CET
    at('2026-10-10T07:10:00+02:00');
    q.ctx.scheduleMorning();
  });

  test('a post at 08:30 is also held for 09:00', () => {
    at('2026-10-10T08:30:00+02:00');
    assert.strictEqual(q.call({ action: 'post', token: boss, title: 'Morning notice', content: 'Early.' }).queued, true);
  });

  test('09:00: one email + one push per person with everything, one overnight summary', () => {
    at('2026-10-10T09:00:00+02:00');
    const m0 = q.sent.mail.length, p0 = q.sent.push.length;
    q.ctx.morningRun();
    const mails = q.sent.mail.slice(m0);
    assert.deepStrictEqual(mails.map((m) => m.to).sort(), ['nam@example.com', 'yuna@example.com']);
    for (const m of mails) {
      assert.strictEqual(m.htmlBody.split('Night notice').length - 1, 1);
      assert.strictEqual(m.htmlBody.split('Morning notice').length - 1, 1);
    }
    const sup = pushesTo(SUP_ENDPOINT, p0);
    assert.strictEqual(sup.length, 2, 'announcement push + overnight summary');
    if (ece) {
      const msgs = sup.map(decrypt);
      const night = msgs.find((m) => m.title === 'Overnight (1)');
      assert.ok(night, JSON.stringify(msgs));
      assert.match(night.body, /^New login: No Mail  Other · browser \(first device\)  ·  10-10 02:10$/);
      assert.ok(msgs.some((m) => m.title === 'I have an unread announcement !' && /2 announcements/.test(m.body)));
    }
    assert.ok(!q.props.NOTIFY_QUEUE && !q.props.SUP_QUEUE, 'queues cleared');
    assert.strictEqual(q.triggers.filter((x) => x.getHandlerFunction() === 'morningRun').length, 0);
    assert.ok(rows('Notifications').some((r) => r[2] === 'Yuna' && r[3] === 'new email' && r[1] === 'A0001, A0002'));
  });

  test('next morning: reminder only for what is still unconfirmed', () => {
    q.call({ action: 'confirm', token: yu, id: 'A0001' });
    at('2026-10-11T09:00:00+02:00');
    const m0 = q.sent.mail.length;
    q.ctx.morningRun();
    const toYuna = q.sent.mail.slice(m0).filter((m) => m.to === 'yuna@example.com');
    assert.strictEqual(toYuna.length, 1);
    assert.ok(/Morning notice/.test(toYuna[0].htmlBody) && !/Night notice/.test(toYuna[0].htmlBody));
  });

  test('daytime: sent immediately, supervisor alerted immediately', () => {
    at('2026-10-11T10:00:00+02:00');
    const m0 = q.sent.mail.length, p0 = q.sent.push.length;
    const r = q.call({ action: 'post', token: boss, title: 'Day notice', content: 'Now.' });
    assert.ok(!r.queued); assert.ok(q.sent.mail.length > m0);
    const [t] = tagUrls(keys, 'START', 1);
    q.call(Object.assign({ action: 'tap', token: yu }, t));
    assert.ok(pushesTo(SUP_ENDPOINT, p0).length >= 2);
  });

  test('records still verify after the night', () => {
    assert.ok(q.ctx.verifyRecords().every((x) => x.ok));
  });
}

console.log(`\n${passed} passed`);
