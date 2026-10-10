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
          for (let r = 1; r <= sheet.getLastRow(); r++) out.push([1, 2, 3, 4, 5, 6, 7, 8].map((c) => cells[r + ',' + c] || ''));
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
          getDisplayValues: () => rng.getValues(),
          getBackgrounds: () => Array.from({ length: nr }, (_, i) =>
            Array.from({ length: nc }, (_, j) => sheet.bg[(r + i) + ',' + (c + j)] || '#ffffff')),
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
    setName(n) { return blob(bytes, type, n); },
  });
  const fileObj = (f) => ({
    getMimeType: () => (f.kind === 'sheet' ? 'sheets' : f.type), getId: () => f.getId(),
    moveTo: () => {}, getBlob: () => f.blob,
    setTrashed: (v) => { f.trashed = v; },
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
        const b = { timeBased: () => b, everyDays: () => b, everyMinutes: (m) => { b.minutes = m; return b; }, atHour: (h) => { b.hour = h; return b; },
                    at: (d) => { b.at = d; return b; }, inTimezone: () => b,
                    create: () => triggers.push({ getHandlerFunction: () => fn, hour: b.hour, at: b.at, minutes: b.minutes }) };
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
        // 테스트 시계는 '지금'에만 적용 (시트의 날짜 값 등 다른 날짜는 그대로)
        const isNow = Math.abs(d.getTime() - Date.now()) < 60000;
        d = new Date((clock.fixed && isNow ? new Date(clock.fixed).getTime() : d.getTime()) + (isNow ? clock.days * 86400000 : 0));
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
  for (const f of ['Crypto.gs', 'WebPush.gs', 'Code.gs', 'Announce.gs', 'Supervisor.gs', 'Rules.gs', 'Schedule.gs', 'Receipts.gs']) {
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
  return { ctx, call, props, files, sent, clock, triggers, cache };
}

/**
 * 스케줄 스프레드시트 흉내: tabs = { 탭이름: { grid: [[셀…]…], merges: [[r,c,nr,nc]…], hiddenCols: [c…], hidden } }
 * 셀은 문자열 또는 { t: 표시 글자, v: 값(Date 등), bg, fc, b }. 행·열 번호는 1부터.
 */
function makeScheduleFile(id, title, tabs) {
  const sheet = (name, spec) => {
    const g = spec.grid, nr = g.length, nc = Math.max(...g.map((r) => r.length));
    const cell = (r, c) => { const x = (g[r] || [])[c]; return x == null ? {} : typeof x === 'string' ? { t: x } : x; };
    const grid = (f) => (r, c, h, w) => Array.from({ length: h }, (_, i) => Array.from({ length: w }, (_, j) => f(cell(r - 1 + i, c - 1 + j))));
    return {
      spec,
      getName: () => name,
      isSheetHidden: () => !!spec.hidden,
      getLastRow: () => nr,
      getLastColumn: () => nc,
      isColumnHiddenByUser: (c) => (spec.hiddenCols || []).includes(c),
      getColumnWidth: (c) => (c === 1 ? 120 : 100),
      getRange: (r, c, h, w) => ({
        getDisplayValues: () => grid((x) => x.t || '')(r, c, h, w),
        getValues: () => grid((x) => (x.v !== undefined ? x.v : x.t || ''))(r, c, h, w),
        getBackgrounds: () => grid((x) => x.bg || '#ffffff')(r, c, h, w),
        getFontColors: () => grid((x) => x.fc || '#000000')(r, c, h, w),
        getFontWeights: () => grid((x) => (x.b ? 'bold' : 'normal'))(r, c, h, w),
        getFontStyles: () => grid(() => 'normal')(r, c, h, w),
        getFontSizes: () => grid((x) => x.fs || 10)(r, c, h, w),
        getHorizontalAlignments: () => grid(() => 'general-left')(r, c, h, w),
        getMergedRanges: () => (spec.merges || []).map(([mr, mc, mh, mw]) => ({
          getRow: () => mr, getColumn: () => mc, getNumRows: () => mh, getNumColumns: () => mw })),
      }),
    };
  };
  const sheets = Object.keys(tabs).map((n) => sheet(n, tabs[n]));
  return {
    kind: 'sheet', title, sheets,
    getId: () => id, getName: () => title,
    getSheets: () => sheets,
    getSheetByName: (n) => sheets.find((x) => x.getName() === n) || null,
  };
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

module.exports = { makeEnv, tagUrls, makeScheduleFile };
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
    sh.getRange(i + 2, 1, 1, 11).getValues()[0]) : [];
};

test('setup: protected record sheets, daily trigger, VAPID keys', () => {
  const ss = env.files[env.props.ANN_SHEET_ID];
  assert.deepStrictEqual(ss.sheets.map((x) => x.name),
    ['Announcements', 'Confirmations', 'Notifications', 'Logins', 'Our Rules', 'Requests', 'Deleted', 'Receipts', 'Receipt Mails']);
  assert.ok(ss.sheets.every((x) => x.protected));
  assert.deepStrictEqual(env.triggers.map((t) => [t.getHandlerFunction(), t.hour || t.minutes]),
    [['scheduleMorning', 7], ['checkScheduleChanges', 30]]);
  const head = env.files[env.props.CONFIG_SHEET_ID].sheets[0];
  assert.deepStrictEqual([1, 2, 3, 4, 5, 6, 7, 8].map((c) => head.cells['1,' + c]),
    ['Name', 'PIN', 'Active', 'Email', 'Admin', 'Team', 'Supervisor', 'Transport receipt']);
  env.ctx.setup(); // 다시 실행해도 중복 생성 없음
  assert.strictEqual(env.triggers.length, 2);
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
  assert.strictEqual(row[7], 'Notice');
  const mails = env.sent.mail.slice(before.mail);
  assert.deepStrictEqual(mails.map((m) => m.to).sort(), ['nam@example.com', 'yuna@example.com']);
  assert.strictEqual(mails[0].subject, 'I have an unread announcement !');
  assert.strictEqual(Object.keys(mails[0].inlineImages).length, 1);
  assert.match(mails[0].htmlBody, /Kitchen rules/);
  assert.ok(!/Nam KIM/.test(mails[0].htmlBody), 'uploader is not shown');
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
    url: 'https://contactmonsieurkim-pixel.github.io/Commande-Tapfruit/worktime/?view=ann', tag: 'announcement' });
});

test('unread count on me + on NFC tap', () => {
  assert.strictEqual(env.call({ action: 'me', token: yuna }).unread, 1);
  const [t] = tagUrls(keys, 'START', 1);
  const r = env.call(Object.assign({ action: 'tap', token: yuna }, t));
  assert.ok(r.ok); assert.strictEqual(r.unread, 1);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r.tips)), [], 'announcements are never tips');
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
  const again = env.call({ action: 'confirm', token: yuna, id: annId });
  assert.strictEqual(again.confirmedAt, confirmedAt);
  assert.strictEqual(again.already, true);
  assert.strictEqual(r.already, false);
  const rows = recRows('Confirmations');
  assert.strictEqual(rows.length, 1);
  assert.deepStrictEqual(rows[0].slice(0, 4), [annId, 'Kitchen rules', 'Yuna', confirmedAt]);
});

test('employee hired after posting can read old announcements but is not asked to confirm', () => {
  const config = env.files[env.props.CONFIG_SHEET_ID];
  config.sheets[0].getRange(6, 1, 1, 5).setValues([['Late Hire', '5555', 'TRUE', 'late@example.com', '']]);
  const late = env.call({ action: 'login', name: 'Late Hire', pin: '5555' }).token;
  const list = env.call({ action: 'anns', token: late }).announcements;
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].mustConfirm, false);
  assert.strictEqual(env.call({ action: 'me', token: late }).unread, 0);
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
  assert.strictEqual(env.call({ action: 'me', token }).tips.length, 0, 'notices are not tips');
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
                      kind: 'rule', audience: { teams: ['kitchen'] } });
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(r.id, 'Rule-001');
  const row = recRows('Our Rules').slice(-1)[0];
  assert.deepStrictEqual(row.slice(0, 2), ['Rule-001', '1']);
  assert.strictEqual(env.files[env.props.ANN_SHEET_ID].getSheetByName('Our Rules').cells['2,8'], 'Yuna, No Mail');
  assert.strictEqual(env.files[env.props.ANN_SHEET_ID].getSheetByName('Our Rules').cells['2,9'], 'Teams: Kitchen');
  assert.deepStrictEqual(env.sent.mail.slice(m0).map((m) => m.to), ['yuna@example.com']);
  assert.ok(env.call({ action: 'rules', token: yuna }).rules.some((x) => x.title === 'Knife storage'));
  assert.ok(!env.call({ action: 'rules', token }).rules.some((x) => x.title === 'Knife storage'));
  assert.ok(!env.call({ action: 'anns', token: yuna }).announcements.some((a) => a.title === 'Knife storage'));
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
  assert.deepStrictEqual(titles(yuna), ['Knife storage']);
  assert.deepStrictEqual(titles(token), []);
  const config = env.files[env.props.CONFIG_SHEET_ID];
  config.sheets[0].getRange(7, 1, 1, 6).setValues([['New Cook', '7777', 'TRUE', '', '', 'Kitchen']]);
  const cook = env.call({ action: 'login', name: 'New Cook', pin: '7777' }).token;
  assert.deepStrictEqual(titles(cook), ['Knife storage']);
  assert.strictEqual(env.call({ action: 'me', token: cook }).unread, 0, 'not a recipient of old posts');
});

test('admin status shows the audience; records still verify', () => {
  const st = env.call({ action: 'status', token });
  assert.strictEqual(st.announcements.find((a) => a.title === '[Rule-001] Knife storage').audience, 'Teams: Kitchen');
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

test('status: my last clock-in/out on me (header icon)', () => {
  const r = env.call({ action: 'me', token });
  assert.ok(r.ok);
  assert.strictEqual(r.clock.info, 'END');
  assert.match(r.clock.date, /^2026-10-\d\d$/); assert.match(r.clock.time, /^\d\d:\d\d$/);
  assert.match(r.today, /^2026-10-09 \d\d:\d\d$/);
  const y = env.call({ action: 'me', token: yuna });
  assert.strictEqual(y.clock.info, 'START', 'latest tap wins (cache updated by the tap)');
  const nm = env.call({ action: 'login', name: 'No Mail', pin: '3333' });
  assert.strictEqual(env.call({ action: 'me', token: nm.token }).clock, null);
});

test('status: team view for the supervisor only, read fresh from the sheet', () => {
  assert.strictEqual(env.call({ action: 'team', token: yuna }).ok, false);
  // 관리자가 시트에서 직접 퇴근 기록을 넣어도 Team status 에는 바로 보임 (지난달 기록도 찾음)
  const ss = Object.values(env.files).find((s) => s.title === '2026-10');
  const sh = ss.getSheetByName('Yuna');
  sh.getRange(sh.getLastRow() + 1, 1, 1, 4).setValues([['10-09', '23:10', 'END', '22:50']]);
  sh.getRange(sh.getLastRow() + 1, 1, 1, 4).setValues([['', '', 'note: forgot tag', '']]);
  const sep = env.ctx.SpreadsheetApp.create('2026-09');
  sep.sheets[0].setName('No Mail');
  sep.sheets[0].getRange(1, 1, 2, 4).setValues([['DATE', 'TIME', 'Info', 'Modify'], ['09-30', '18:05', 'START', '']]);
  const r = env.call({ action: 'team', token });
  assert.ok(r.ok, JSON.stringify(r));
  const by = Object.fromEntries(r.staff.map((x) => [x.name, x]));
  assert.ok(!by['Old Staff'], 'inactive staff hidden');
  assert.deepStrictEqual(by.Yuna.clock, { info: 'END', date: '2026-10-09', time: '23:10', change: '22:50' });
  assert.strictEqual(by.Yuna.team, 'Kitchen');
  assert.deepStrictEqual(by['No Mail'].clock, { info: 'START', date: '2026-09-30', time: '18:05', change: '' });
  assert.strictEqual(env.call({ action: 'me', token: yuna }).clock.info, 'END', 'team view refreshes the cache');
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

// ------------------------------------------------------------------ Our Rules + Requests
{
  const R = makeEnv({ SDM_META_KEY: keys.K1_SDM_META, SDM_FILE_KEY: keys.K2_SDM_FILE });
  const at = (iso) => { R.clock.fixed = iso; R.clock.days = 0; };
  const sheetRows = (name, n) => {
    const sh = R.files[R.props.ANN_SHEET_ID].getSheetByName(name);
    return Array.from({ length: sh.getLastRow() - 1 }, (_, i) => sh.getRange(i + 2, 1, 1, n || 11).getValues()[0]);
  };
  const decryptFor = (req, key, auth) => JSON.parse(ece.decrypt(Buffer.from(req.o.payload.map((x) => x & 0xff)),
    { version: 'aes128gcm', privateKey: key, authSecret: auth.toString('base64url') }));
  const boss = R.call({ action: 'login', name: 'Nam KIM', pin: '4321' }).token;
  const yu = R.call({ action: 'login', name: 'Yuna', pin: '2222' }).token;
  const YU_EP = 'https://web.push.apple.com/yuna-phone';
  R.call({ action: 'subscribe', token: boss, sub: { endpoint: SUP_ENDPOINT, keys: {
    p256dh: supKey.getPublicKey().toString('base64url'), auth: supAuth.toString('base64url') } } });
  R.call({ action: 'subscribe', token: yu, sub: { endpoint: YU_EP, keys: {
    p256dh: ua.getPublicKey().toString('base64url'), auth: uaAuth.toString('base64url') } } });

  test('rules: old "Rule" announcements migrate to Rule-001… (confirmations carried over)', () => {
    // 예전 방식으로 기록된 공지 (Type = Rule) 를 직접 만들어 둠
    R.ctx.appendRecord_('Announcements', ['A0001', '2026-10-01 10:00:00', 'Nam KIM', 'Old rule A', 'Be on time.', '',
      'Nam KIM, Yuna, No Mail', 'Rule']);
    R.ctx.appendRecord_('Announcements', ['A0002', '2026-10-02 10:00:00', 'Nam KIM', 'Old notice', 'Hello.', '',
      'Nam KIM, Yuna, No Mail', 'Notice']);
    R.ctx.appendRecord_('Announcements', ['A0003', '2026-10-03 10:00:00', 'Nam KIM', 'Old rule B', 'Knives.', '',
      'Yuna, No Mail', 'Rule · Teams: Kitchen']);
    R.ctx.appendRecord_('Confirmations', ['A0001', 'Old rule A', 'Yuna', '2026-10-01 11:00:00']);
    R.props.ANN_SEQ = '3';
    const list = R.call({ action: 'rules', token: yu }).rules;
    assert.deepStrictEqual(list.map((x) => [x.id, x.title, x.confirmedAt]),
      [['Rule-001', 'Old rule A', '2026-10-01 11:00:00'], ['Rule-002', 'Old rule B', null]]);
    assert.ok(!('by' in list[0]), 'uploader not exposed');
    assert.deepStrictEqual(R.call({ action: 'rules', token: boss }).rules.map((x) => x.id), ['Rule-001']);
    assert.deepStrictEqual(R.call({ action: 'anns', token: yu }).announcements.map((x) => x.title), ['Old notice']);
    R.call({ action: 'rules', token: yu });
    assert.strictEqual(sheetRows('Our Rules').length, 2, 'migrated once');
    assert.strictEqual(R.call({ action: 'me', token: yu }).unreadRules, 1);
  });

  test('rules: new rule gets the next number and its own notification', () => {
    at('2026-10-09T10:00:00+02:00');
    const m0 = R.sent.mail.length, p0 = R.sent.push.length;
    const r = R.call({ action: 'post', token: boss, kind: 'rule', title: 'Fridge labels',
                      content: 'Label every container.', photos: [photo] });
    assert.ok(r.ok, JSON.stringify(r)); assert.strictEqual(r.id, 'Rule-003');
    const mail = R.sent.mail.slice(m0).find((m) => m.to === 'yuna@example.com');
    assert.strictEqual(mail.subject, 'Our Rules: please read and confirm');
    assert.match(mail.htmlBody, /\[Rule-003\] Fridge labels/); assert.match(mail.htmlBody, /New rule/);
    assert.ok(!/Nam KIM/.test(mail.htmlBody));
    assert.match(mail.htmlBody, /\?view=rules/);
    const p = R.sent.push.slice(p0).find((x) => x.url === YU_EP);
    if (ece) {
      const msg = decryptFor(p, ua, uaAuth);
      assert.deepStrictEqual([msg.title, msg.body, msg.tag], ['Our Rules: please read and confirm', '[Rule-003] Fridge labels', 'rules']);
    }
    assert.ok(sheetRows('Notifications', 6).some((x) => x[2] === 'Yuna' && x[3] === 'new rule email'));
    assert.strictEqual(R.call({ action: 'anns', token: yu }).announcements.length, 1, 'not an announcement');
  });

  test('rules: confirm, then an edit by a manager needs a new confirmation', () => {
    assert.strictEqual(R.call({ action: 'ruleConfirm', token: yu, id: 'Rule-003' }).ok, true);
    assert.ok(sheetRows('Confirmations', 5).some((x) => x[0] === 'Rule-003 v1' && x[2] === 'Yuna'));
    assert.strictEqual(R.call({ action: 'ruleEdit', token: yu, id: 'Rule-003', title: 'x', content: 'y' }).ok, false);
    at('2026-10-12T15:30:00+02:00');
    const p0 = R.sent.push.length;
    const e = R.call({ action: 'ruleEdit', token: boss, id: 'Rule-003', title: 'Fridge labels',
                      content: 'Label every container: what, who, date.' });
    assert.ok(e.ok, JSON.stringify(e)); assert.strictEqual(e.version, 2);
    const mine = R.call({ action: 'rules', token: yu }).rules.find((x) => x.id === 'Rule-003');
    assert.strictEqual(mine.version, 2);
    assert.strictEqual(mine.updatedAt, '2026-10-12 15:30:00');
    assert.strictEqual(mine.confirmedAt, null, 'must confirm again');
    assert.strictEqual(mine.photos, 1, 'photo kept when none uploaded');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(mine.history)),
      [{ version: 1, at: '2026-10-09 10:00:00', title: 'Fridge labels', content: 'Label every container.' }]);
    if (ece) assert.strictEqual(decryptFor(R.sent.push.slice(p0).find((x) => x.url === YU_EP), ua, uaAuth).body,
      '[Rule-003] Fridge labels (updated)');
    assert.strictEqual(R.call({ action: 'ruleConfirm', token: yu, id: 'Rule-003' }).already, false);
    assert.strictEqual(R.call({ action: 'ruleConfirm', token: yu, id: 'Rule-003' }).already, true, 'second path: no new record');
    assert.strictEqual(sheetRows('Confirmations', 5).filter((x) => x[0] === 'Rule-003 v2').length, 1);
    const st = R.call({ action: 'status', token: boss }).announcements.find((x) => x.id === 'Rule-003 v2');
    assert.strictEqual(st.title, '[Rule-003] Fridge labels (v2)');
    assert.deepStrictEqual(st.confirmed.map((c) => c.name), ['Yuna']);
  });

  test('rules: clock-in tips come from Our Rules (latest version)', () => {
    const tips = R.call({ action: 'me', token: yu }).tips;
    assert.deepStrictEqual(tips.map((t) => t.id), ['Rule-001', 'Rule-002', 'Rule-003']);
    assert.strictEqual(tips[2].content, 'Label every container: what, who, date.');
  });

  test('09:00: announcements and rules are notified separately', () => {
    at('2026-10-12T23:30:00+02:00');
    R.call({ action: 'post', token: boss, title: 'Late notice', content: 'Tomorrow.' });
    assert.strictEqual(R.call({ action: 'post', token: boss, kind: 'rule', title: 'Night rule', content: 'Lock up.' }).queued, true);
    at('2026-10-13T09:00:00+02:00');
    const m0 = R.sent.mail.length;
    R.ctx.morningRun();
    const toYuna = R.sent.mail.slice(m0).filter((m) => m.to === 'yuna@example.com');
    assert.deepStrictEqual(toYuna.map((m) => m.subject).sort(),
      ['I have an unread announcement !', 'Our Rules: please read and confirm']);
    const ruleMail = toYuna.find((m) => m.subject.startsWith('Our Rules'));
    assert.match(ruleMail.htmlBody, /\[Rule-004\] Night rule/);
    assert.match(ruleMail.htmlBody, /\[Rule-002\] Old rule B/, 'still-unconfirmed migrated rule is reminded');
  });

  test('request: any employee -> supervisor at once (even at night), private', () => {
    at('2026-10-13T23:50:00+02:00');
    const m0 = R.sent.mail.length, p0 = R.sent.push.length;
    assert.strictEqual(R.call({ action: 'request', token: yu, message: '  ' }).ok, false);
    const r = R.call({ action: 'request', token: yu, message: 'Could I swap Saturday with Leo?\nFamily event.' });
    assert.ok(r.ok);
    const sup = R.sent.push.slice(p0).filter((x) => x.url === SUP_ENDPOINT);
    assert.strictEqual(sup.length, 1);
    assert.strictEqual(R.sent.push.length - p0, 1, 'nobody else');
    if (ece) {
      const msg = decrypt(sup[0]);
      assert.strictEqual(msg.title, '✉️ Request · Yuna');
      assert.strictEqual(msg.body, 'Could I swap Saturday with Leo?\nFamily event.');
      assert.match(msg.url, /\?view=requests$/);
    }
    const mails = R.sent.mail.slice(m0);
    assert.deepStrictEqual(mails.map((m) => [m.to, m.subject]), [['nam@example.com', 'Request from Yuna']]);
    assert.deepStrictEqual(sheetRows('Requests', 4)[0].slice(0, 3),
      ['2026-10-13 23:50:00', 'Yuna', 'Could I swap Saturday with Leo?\nFamily event.']);
  });

  test('request inbox: supervisor only', () => {
    assert.strictEqual(R.call({ action: 'requests', token: yu }).ok, false);
    const r = R.call({ action: 'requests', token: boss });
    assert.deepStrictEqual(r.requests.map((x) => x.from), ['Yuna']);
    assert.strictEqual(R.call({ action: 'me', token: boss }).supervisor, true);
    assert.strictEqual(R.call({ action: 'me', token: yu }).supervisor, false);
  });

  test('new employee: must confirm every existing rule, but old announcements are read-only', () => {
    at('2026-10-14T12:00:00+02:00');
    const kitchenAnn = R.call({ action: 'post', token: boss, title: 'Kitchen only', content: 'Knives.',
                                audience: { teams: ['Kitchen'] } });
    assert.ok(kitchenAnn.ok, JSON.stringify(kitchenAnn));
    const config = R.files[R.props.CONFIG_SHEET_ID];
    config.sheets[0].getRange(9, 1, 1, 6).setValues([['New Cook', '9999', 'TRUE', 'cook@example.com', '', 'Kitchen']]);
    const cook = R.call({ action: 'login', name: 'New Cook', pin: '9999' }).token;
    const me = R.call({ action: 'me', token: cook });
    const rules = R.call({ action: 'rules', token: cook }).rules;
    assert.ok(rules.length > 0);
    assert.ok(rules.every((x) => x.mustConfirm && !x.confirmedAt));
    assert.strictEqual(me.unreadRules, rules.length);
    assert.strictEqual(me.unread, 0, 'old announcements need no confirmation');
    const anns = R.call({ action: 'anns', token: cook }).announcements;
    assert.ok(anns.some((x) => x.title === 'Kitchen only'), 'team announcement visible to a later team member');
    assert.ok(anns.every((x) => !x.mustConfirm));
    assert.deepStrictEqual(anns.map((x) => x.posted), anns.map((x) => x.posted).slice().sort().reverse(), 'newest first');
    const c = R.call({ action: 'ruleConfirm', token: cook, id: rules[0].id });
    assert.ok(c.ok); assert.strictEqual(c.unreadRules, rules.length - 1);
    const st = R.call({ action: 'status', token: boss }).announcements.find((x) => x.id === rules[1].id + ' v' + rules[1].version);
    assert.ok(st.pending.includes('New Cook'), 'manager sees the new employee as pending');
    // 09:00 리마인더에 포함
    at('2026-10-15T09:00:00+02:00');
    const n0 = R.sent.mail.length;
    R.ctx.morningRun();
    assert.ok(R.sent.mail.slice(n0).some((m) => m.to === 'cook@example.com'));
  });

  test('delete announcement: supervisor only; gone from lists, counts and status; records kept', () => {
    at('2026-10-15T12:00:00+02:00');
    const id = R.call({ action: 'post', token: boss, title: 'Wrong one', content: 'Oops.' }).id;
    assert.strictEqual(R.call({ action: 'me', token: yu }).unread > 0, true);
    const before = R.call({ action: 'me', token: yu }).unread;
    assert.strictEqual(R.call({ action: 'annDelete', token: yu, id }).ok, false);
    assert.strictEqual(R.call({ action: 'anns', token: yu }).canDelete, false);
    assert.strictEqual(R.call({ action: 'anns', token: boss }).canDelete, true);
    assert.ok(R.call({ action: 'annDelete', token: boss, id }).ok);
    assert.strictEqual(R.call({ action: 'annDelete', token: boss, id }).ok, false, 'already deleted');
    assert.ok(!R.call({ action: 'anns', token: yu }).announcements.some((x) => x.id === id));
    assert.strictEqual(R.call({ action: 'me', token: yu }).unread, before - 1);
    assert.ok(!R.call({ action: 'status', token: boss }).announcements.some((x) => x.id === id));
    assert.strictEqual(R.call({ action: 'confirm', token: yu, id }).ok, false);
    const sh = R.files[R.props.ANN_SHEET_ID].getSheetByName('Announcements');
    assert.ok(Object.values(sh.cells).includes('Wrong one'), 'original row stays in the records');
  });

  test('rules + requests: records still verify', () => {
    assert.ok(R.ctx.verifyRecords().every((x) => x.ok), JSON.stringify(R.ctx.verifyRecords()));
  });
}

// ------------------------------------------------------------------ Schedule
{
  const S = makeEnv({ SDM_META_KEY: keys.K1_SDM_META, SDM_FILE_KEY: keys.K2_SDM_FILE });
  const at = (iso) => { S.clock.fixed = iso; S.clock.days = 0; S.cache && Object.keys(S.cache).forEach((k) => delete S.cache[k]); };
  const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  // 한 주 = 6줄: 요일 / 날짜 / Morning P·F·W (A열 3줄 병합) / 빈 줄
  const week = (dates) => [
    ['', ''].concat(DAYS),
    ['Date', ''].concat(dates),
    ['Morning', 'P', { t: '09:00', bg: '#f09a37' }],
    ['', 'F', '', { t: '', bg: '#8b7cf0' }],
    ['', 'W', { t: 'Chris 23:00', bg: '#6b1f45', fc: '#ffffff', b: 1 }, '', '', '', '', '', '', '', { t: 'secret' }],
    [],
  ];
  const oct = [['', ''], []]
    .concat(week(['#REF!', '', '', { t: '1/10', v: new Date('2026-10-01T00:00:00+02:00') }, '2/10', '3/10', '4/10']))
    .concat(week(['5/10', '6/10', '7/10', '8/10', '9/10', '10/10', '11/10']))
    .concat(week(['12/10', '13/10', '14/10', '15/10', '16/10', '17/10', '18/10']))
    .concat(week(['19/10', '20/10', '21/10', '22/10', '23/10', '24/10', '25/10']))
    .concat(week(['26/10', '27/10', '28/10', '29/10', '30/10', '31/10', '1/11']));
  const merges = (n) => Array.from({ length: n }, (_, k) => [3 + 6 * k + 2, 1, 3, 1]);
  const FILE = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
  S.files[FILE] = makeScheduleFile(FILE, 'Schedule Cuisine 08,09,10', {
    10: { grid: oct, merges: merges(5), hiddenCols: [11] },
    '09': { grid: week(['28/9', '29/9', '30/9', '', '', '', '']), merges: [[3, 1, 3, 1]], hiddenCols: [11] },
    old: { grid: [['x']], hidden: true },
  });
  const cfg = S.files[S.props.CONFIG_SHEET_ID];
  const boss = S.call({ action: 'login', name: 'Nam KIM', pin: '4321' }).token;
  const yu = S.call({ action: 'login', name: 'Yuna', pin: '2222' }).token;
  S.call({ action: 'subscribe', token: boss, sub: { endpoint: SUP_ENDPOINT, keys: {
    p256dh: supKey.getPublicKey().toString('base64url'), auth: supAuth.toString('base64url') } } });
  const conf = () => {
    const sh = S.files[S.props.ANN_SHEET_ID].getSheetByName('Confirmations');
    return Array.from({ length: sh.getLastRow() - 1 }, (_, i) => sh.getRange(i + 2, 1, 1, 4).getValues()[0]);
  };

  test('schedule: setup adds the Schedules tab; nothing configured yet', () => {
    const tab = cfg.getSheetByName('Schedules');
    assert.deepStrictEqual([1, 2, 3].map((c) => tab.cells['1,' + c]), ['Name', 'Spreadsheet', 'Team']);
    const r = S.call({ action: 'schedule', token: yu });
    assert.ok(r.ok); assert.deepStrictEqual(r.schedules, []);
    assert.strictEqual(S.call({ action: 'me', token: yu }).schedulePending, 0);
  });

  test('schedule: reads the sheet directly, month tabs, weeks by Monday', () => {
    at('2026-10-09T12:00:00+02:00'); // 금요일
    cfg.getSheetByName('Schedules').getRange(2, 1, 1, 3)
      .setValues([['Kitchen', 'https://docs.google.com/spreadsheets/d/' + FILE + '/edit#gid=0', 'Kitchen']]);
    const r = S.call({ action: 'schedule', token: yu });
    assert.ok(r.ok, JSON.stringify(r));
    assert.strictEqual(r.sched, 'Kitchen');
    assert.deepStrictEqual(r.tabs.map((t) => t.label), ['October'], 'only this month and next (no November tab yet)');
    assert.strictEqual(r.tab, '10', 'opens on the month of the week to confirm');
    assert.deepStrictEqual(r.weeks.map((w) => w.monday),
      ['2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26']);
    assert.strictEqual(r.weeks[0].label, '28 Sep – 4 Oct 2026');
    assert.deepStrictEqual(r.cols, [120, 100, 100, 100, 100, 100, 100, 100, 100], 'hidden + empty columns dropped');
    const w = r.weeks[0];
    assert.strictEqual(w.rows.length, 5, 'empty last row trimmed');
    assert.deepStrictEqual(w.rows[2][0], { t: 'Morning', rs: 3 });
    assert.strictEqual(w.rows[3][0], null, 'covered by the merge');
    assert.deepStrictEqual(w.rows[4][2], { t: 'Chris 23:00', bg: '#6b1f45', fc: '#ffffff', b: 1 });
    assert.deepStrictEqual(r.weeks.map((x) => x.state), ['ended', 'started', 'overdue', 'overdue', 'early']);
    assert.deepStrictEqual(r.weeks.map((x) => !!x.mustConfirm), [false, false, true, true, true]);
    assert.strictEqual(r.weeks[4].dueLabel, 'Tue 13 Oct', 'due on the Tuesday two weeks before');
    assert.deepStrictEqual(r.pending.map((p) => p.monday), ['2026-10-12', '2026-10-19']);
    assert.strictEqual(r.weeks[2].status, undefined, 'staff do not see who confirmed');
    assert.strictEqual(S.call({ action: 'me', token: yu }).schedulePending, 2);
  });

  test('schedule: staff only get this month and next month', () => {
    const r = S.call({ action: 'schedule', token: yu, sched: 'Kitchen', file: FILE, tab: '09' });
    assert.strictEqual(r.tab, '10', 'September is not offered any more');
  });

  test('schedule: confirm needs the tick; once per person and week', () => {
    const fp = S.call({ action: 'schedule', token: yu }).weeks[2].fp;
    assert.match(fp, /^[0-9a-f]{10}$/);
    const base = { action: 'scheduleConfirm', token: yu, sched: 'Kitchen', file: FILE, tab: '10', monday: '2026-10-12', fp };
    assert.strictEqual(S.call(base).ok, false, 'agree box not ticked');
    assert.strictEqual(S.call(Object.assign({}, base, { agree: true, fp: '0000000000' })).code, 'CHANGED');
    const r = S.call(Object.assign({ agree: true }, base));
    assert.ok(r.ok, JSON.stringify(r)); assert.strictEqual(r.already, false);
    assert.strictEqual(r.confirmedAt, '2026-10-09 12:00:00');
    assert.strictEqual(r.schedulePending, 1);
    assert.strictEqual(S.call(Object.assign({ agree: true }, base)).already, true);
    assert.deepStrictEqual(conf().map((x) => x.slice(0, 3)),
      [['Schedule · Kitchen · 2026-10-12 · ' + fp, 'Schedule Kitchen: 12 Oct – 18 Oct 2026', 'Yuna']]);
    const v = S.call({ action: 'schedule', token: yu });
    assert.strictEqual(v.weeks[2].confirmedAt, '2026-10-09 12:00:00');
    assert.strictEqual(v.weeks[2].mustConfirm, false);
  });

  test('schedule: started weeks, unknown weeks and non-recipients are refused', () => {
    const weeks = S.call({ action: 'schedule', token: yu }).weeks;
    const base = { action: 'scheduleConfirm', sched: 'Kitchen', file: FILE, tab: '10', agree: true };
    assert.strictEqual(S.call(Object.assign({}, base, { token: yu, monday: '2026-10-05', fp: weeks[1].fp })).ok, false);
    assert.strictEqual(S.call(Object.assign({}, base, { token: yu, monday: '2026-11-30' })).ok, false);
    assert.strictEqual(S.call(Object.assign({}, base, { token: boss, monday: '2026-10-19', fp: weeks[3].fp })).ok, false, 'supervisor writes it');
    assert.strictEqual(S.call(Object.assign({}, base, { token: yu, sched: 'Bar', monday: '2026-10-19', fp: weeks[3].fp })).ok, false);
    assert.strictEqual(conf().length, 1);
  });

  test('schedule: managers see who has confirmed each week', () => {
    const r = S.call({ action: 'schedule', token: boss });
    assert.strictEqual(r.admin, true);
    assert.deepStrictEqual(r.weeks[2].status, { confirmed: [{ name: 'Yuna', at: '2026-10-09 12:00:00' }], changed: [], pending: ['No Mail'] });
    assert.deepStrictEqual(r.weeks[3].status.pending, ['Yuna', 'No Mail']);
    assert.strictEqual(r.weeks[0].status, undefined, 'old weeks without confirmations: nothing to show');
    assert.strictEqual(S.call({ action: 'me', token: boss }).schedulePending, 0);
  });

  test('schedule: 09:00 Tuesday -> new week + reminders in one push/email per person', () => {
    at('2026-10-13T09:00:00+02:00');
    const m0 = S.sent.mail.length;
    S.ctx.morningRun();
    const mails = S.sent.mail.slice(m0).filter((m) => m.subject.includes('Schedule'));
    assert.deepStrictEqual(mails.map((m) => m.to), ['yuna@example.com'], 'No Mail has no address; supervisor excluded');
    assert.match(mails[0].htmlBody, /19 Oct – 25 Oct 2026/);
    assert.match(mails[0].htmlBody, /26 Oct – 1 Nov 2026[\s\S]*Please confirm today \(Tue 13 Oct\)/);
    const notes = S.files[S.props.ANN_SHEET_ID].getSheetByName('Notifications');
    const rows = Array.from({ length: notes.getLastRow() - 1 }, (_, i) => notes.getRange(i + 2, 1, 1, 5).getValues()[0]);
    const sched = rows.filter((x) => x[3].includes('schedule'));
    assert.deepStrictEqual(sched.map((x) => [x[2], x[3]]), [
      ['Yuna', 'reminder schedule push'], ['Yuna', 'reminder schedule email'],
      ['No Mail', 'reminder schedule push'], ['No Mail', 'reminder schedule email']]);
  });

  test('schedule: week missing from the sheet -> supervisor is told', () => {
    at('2026-10-20T09:00:00+02:00');
    const p0 = S.sent.push.length;
    S.ctx.morningRun();
    const sup = S.sent.push.slice(p0).filter((x) => x.url === SUP_ENDPOINT);
    assert.strictEqual(sup.length, 1, 'week of 2 Nov is not in the sheet yet');
    assert.strictEqual(S.call({ action: 'me', token: yu }).schedulePending, 1, '26 Oct still unconfirmed (19 Oct has started)');
  });

  test('schedule: supervisor edits a confirmed week -> "changed", alert after it stays the same 30 min', () => {
    at('2026-10-21T10:00:00+02:00');
    const v = S.call({ action: 'schedule', token: yu });
    const w26 = v.weeks[4];
    assert.ok(S.call({ action: 'scheduleConfirm', token: yu, sched: 'Kitchen', file: FILE, tab: '10',
                       monday: w26.monday, fp: w26.fp, agree: true }).ok);
    assert.strictEqual(S.call({ action: 'me', token: yu }).schedulePending, 0);
    S.ctx.checkScheduleChanges();
    const m0 = S.sent.mail.length;
    // Supervisor 가 시트에서 26 Oct 주의 칸 하나를 바꿈
    const grid = S.files[FILE].getSheetByName('10').spec.grid;
    grid[3 + 6 * 4 + 2 - 1][3] = { t: 'Yuna 10:00', bg: '#ffff55' };
    at('2026-10-21T10:30:00+02:00'); // (캐시 2분이 지난 뒤)
    const me = S.call({ action: 'me', token: yu });
    assert.strictEqual(me.schedulePending, 1, 'badge in the Schedule button right away');
    const after = S.call({ action: 'schedule', token: yu }).weeks[4];
    assert.strictEqual(after.changed, true); assert.strictEqual(after.mustConfirm, true);
    assert.strictEqual(after.confirmedAt, null); assert.ok(after.changedAfter);
    S.ctx.checkScheduleChanges();
    assert.strictEqual(S.sent.mail.length, m0, 'first sighting: wait (supervisor may still be editing)');
    at('2026-10-21T11:00:00+02:00');
    S.ctx.checkScheduleChanges();
    const mails = S.sent.mail.slice(m0);
    assert.deepStrictEqual(mails.map((m) => [m.to, m.subject]), [['yuna@example.com', '📅 Schedule changed: please confirm again']]);
    assert.match(mails[0].htmlBody, /Changed after you agreed/);
    at('2026-10-21T11:30:00+02:00');
    S.ctx.checkScheduleChanges();
    assert.strictEqual(S.sent.mail.length, m0 + 1, 'only once per change');
    const boss2 = S.call({ action: 'schedule', token: boss }).weeks[4].status;
    assert.deepStrictEqual(boss2.changed, ['Yuna']);
    // 다시 확인
    const r = S.call({ action: 'scheduleConfirm', token: yu, sched: 'Kitchen', file: FILE, tab: '10',
                      monday: after.monday, fp: after.fp, agree: true });
    assert.ok(r.ok, JSON.stringify(r)); assert.strictEqual(r.already, false); assert.strictEqual(r.schedulePending, 0);
    assert.match(conf().slice(-1)[0][1], /\(changed\)$/);
  });

  test('schedule: a change during the week itself still asks again (until Sunday)', () => {
    at('2026-10-27T12:00:00+02:00'); // 26 Oct 주의 화요일
    const grid = S.files[FILE].getSheetByName('10').spec.grid;
    grid[3 + 6 * 4 + 2 - 1][4] = { t: 'Leo', bg: '#99ff99' };
    const w = S.call({ action: 'schedule', token: yu }).weeks[4];
    assert.strictEqual(w.state, 'started'); assert.strictEqual(w.changed, true); assert.strictEqual(w.mustConfirm, true);
    assert.ok(S.call({ action: 'scheduleConfirm', token: yu, sched: 'Kitchen', file: FILE, tab: '10',
                       monday: w.monday, fp: w.fp, agree: true }).ok);
  });

  test('schedule: "Request a change" goes to the supervisor through Request', () => {
    at('2026-10-27T23:30:00+02:00'); // 밤에도 바로
    const p0 = S.sent.push.length, m0 = S.sent.mail.length;
    const r = S.call({ action: 'request', token: yu, topic: 'schedule', about: 'Kitchen · 2 Nov – 8 Nov 2026',
                       message: 'Could I swap Saturday with Leo?' });
    assert.ok(r.ok);
    const sup = S.sent.push.slice(p0).filter((x) => x.url === SUP_ENDPOINT);
    assert.strictEqual(sup.length, 1);
    assert.deepStrictEqual(S.sent.mail.slice(m0).map((m) => m.subject), ['Schedule change request from Yuna']);
    const inbox = S.call({ action: 'requests', token: boss }).requests;
    assert.strictEqual(inbox[0].message, '[Schedule change · Kitchen · 2 Nov – 8 Nov 2026]\nCould I swap Saturday with Leo?');
  });

  test('schedule: colour table -> my shifts, who works each day', () => {
    at('2026-10-28T12:00:00+01:00');
    const cs = cfg.getSheetByName('Schedule Colors');
    assert.deepStrictEqual([1, 2].map((c) => cs.cells['1,' + c]), ['Name', 'Color']);
    cs.getRange(2, 1, 3, 1).setValues([['yuna'], ['No Mail'], ['Chris']]);
    cs.getRange(2, 2).setBackground('#f09a37');      // 칠한 칸
    cs.getRange(3, 2).setValue('#8B7CF0');           // 글자로 쓴 색
    const r = S.call({ action: 'schedule', token: yu, sched: 'Kitchen', file: FILE, tab: '10' });
    assert.deepStrictEqual(r.people, [{ name: 'Yuna', color: '#f09a37' }, { name: 'No Mail', color: '#8b7cf0' },
                                      { name: 'Chris', color: '' }]);
    const w = r.weeks[1]; // 5 Oct
    const show = (x) => [x.date, x.role, x.start, x.special, x.names.join('+')];
    assert.deepStrictEqual(w.slots.map(show), [
      ['2026-10-05', 'P', '09:00', true, 'Yuna'],
      ['2026-10-05', 'W', '23:00', true, 'Chris'],
      ['2026-10-06', 'F', '', false, 'No Mail'],
    ]);
  });

  test('schedule: a change to someone else\'s shift does not ask me again', () => {
    at('2026-11-03T10:00:00+01:00'); // 화요일: 16 Nov 주 확인 시작 -> 시트에 11월 탭 추가
    const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const nov = [
      ['', ''].concat(DAYS),
      ['Date', ''].concat(['16/11', '17/11', '18/11', '19/11', '20/11', '21/11', '22/11']),
      ['Morning', '', '09:00', '09:00', '09:00'],
      ['', '', '15:00', '15:00', '15:00'],
      ['', 'P', { t: '', bg: '#f09a37' }, { t: '', bg: '#8b7cf0' }],
      ['', 'F', { t: '', bg: '#8b7cf0' }, '', { t: 'Yuna', bg: '' }],
    ];
    S.files[FILE].sheets.push(makeScheduleFile('x', 'x', { 11: { grid: nov, merges: [[3, 1, 4, 1]] } }).sheets[0]);
    const nm = S.call({ action: 'login', name: 'No Mail', pin: '3333' }).token;
    const view = (t) => S.call({ action: 'schedule', token: t, sched: 'Kitchen', file: FILE, tab: '11' }).weeks[0];
    const yw = view(yu), nw = view(nm);
    assert.deepStrictEqual(yw.slots.filter((x) => x.names.includes('Yuna')).map((x) => [x.date, x.role, x.start, x.end]),
      [['2026-11-16', 'P', '09:00', '15:00'], ['2026-11-18', 'F', '09:00', '15:00']]);
    assert.notStrictEqual(yw.fp, nw.fp, 'each person has their own fingerprint');
    for (const [t, w] of [[yu, yw], [nm, nw]]) {
      assert.ok(S.call({ action: 'scheduleConfirm', token: t, sched: 'Kitchen', file: FILE, tab: '11',
                         monday: w.monday, fp: w.fp, agree: true }).ok);
    }
    // Supervisor 가 No Mail 의 화요일 칸만 지움 -> No Mail 만 다시 확인
    nov[4][3] = '';
    at('2026-11-03T10:30:00+01:00');
    assert.strictEqual(view(yu).changed, false, 'Yuna: her shifts are the same');
    assert.strictEqual(view(nm).changed, true);
    // 시간대 시간이 바뀌면 그 칸에서 일하는 사람만 (월요일 09:00 -> 10:00: Yuna P, No Mail F)
    nov[2][2] = '10:00';
    at('2026-11-03T11:00:00+01:00');
    assert.strictEqual(view(yu).changed, true);
    const m0 = S.sent.mail.length;
    S.ctx.checkScheduleChanges();
    at('2026-11-03T11:30:00+01:00');
    S.ctx.checkScheduleChanges();
    const sent = S.sent.mail.slice(m0).filter((m) => m.subject.includes('changed'));
    assert.deepStrictEqual(sent.map((m) => m.to), ['yuna@example.com'], 'No Mail has no email; push only');
    assert.match(sent[0].htmlBody, /16 Nov – 22 Nov 2026/);
  });

  test('schedule: month buttons = this month + next month, in that order', () => {
    at('2026-10-30T12:00:00+01:00');
    const r = S.call({ action: 'schedule', token: yu, sched: 'Kitchen' });
    assert.deepStrictEqual(r.tabs.map((t) => [t.tab, t.label]), [['10', 'October'], ['11', 'November']]);
    assert.strictEqual(S.call({ action: 'schedule', token: yu, sched: 'Kitchen', file: FILE, tab: '11' }).tab, '11');
  });

  test('schedule: an unreadable spreadsheet never breaks the home screen', () => {
    cfg.getSheetByName('Schedules').getRange(2, 2).setValue('https://docs.google.com/spreadsheets/d/NoAccessNoAccessNoAccess123/edit');
    at('2026-10-20T12:00:00+02:00');
    const me = S.call({ action: 'me', token: yu });
    assert.ok(me.ok); assert.strictEqual(me.schedulePending, 0);
    const r = S.call({ action: 'schedule', token: yu });
    assert.ok(r.ok); assert.ok(r.error);
  });

  test('schedule: server errors show their cause; checkSchedule runs from the editor', () => {
    const orig = S.ctx.schedules_;
    S.ctx.schedules_ = () => { throw new TypeError('boom'); };
    const r = S.call({ action: 'schedule', token: yu });
    S.ctx.schedules_ = orig;
    assert.strictEqual(r.ok, false);
    assert.match(r.detail, /^boom/);
    const logs = [];
    S.ctx.Logger.log = (x) => logs.push(String(x));
    S.ctx.checkSchedule();
    assert.ok(logs.some((l) => /^OK   Schedules/.test(l)), logs.join('\n'));
    assert.ok(logs.some((l) => /^FAIL .*파일 열기/.test(l)), 'the broken file is reported');
  });

  test('schedule: dates come from what the cell shows (sheet time zone does not shift them)', () => {
    // 한국 시간 자정 = 파리 전날 17:00 -> 날짜 값만 쓰면 하루 밀림
    assert.strictEqual(S.ctx.cellDate_(new Date('2026-10-01T00:00:00+09:00'), '1/10'), '2026-10-01');
    assert.strictEqual(S.ctx.cellDate_(new Date('2026-10-01T00:00:00+09:00'), ''), '2026-10-01');
  });

  test('schedule: a November week at the bottom of the October tab (no November tab)', () => {
    const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const F2 = '1ZyXwVuTsRqPoNmLkJiHgFeDcBa9876543210';
    S.files[F2] = makeScheduleFile(F2, 'Bar', { 10: { grid: [
      ['', ''].concat(DAYS), ['Date', ''].concat(['26/10', '27/10', '28/10', '29/10', '30/10', '31/10', '1/11']),
      ['Morning', 'P', { t: '', bg: '#f09a37' }],
      ['', ''].concat(DAYS), ['Date', ''].concat(['2/11', '3/11', '4/11', '5/11', '6/11', '7/11', '8/11']),
      ['Morning', 'P', { t: '', bg: '#f09a37' }],
    ] } });
    cfg.getSheetByName('Schedules').getRange(3, 1, 1, 3).setValues([['Bar', F2, 'Kitchen']]);
    at('2026-10-20T12:00:00+02:00');
    const r = S.call({ action: 'schedule', token: yu, sched: 'Bar' });
    assert.ok(r.ok, JSON.stringify(r));
    assert.deepStrictEqual(r.weeks.map((w) => [w.monday, w.slots.length]), [['2026-10-26', 1], ['2026-11-02', 1]]);
    assert.ok(S.call({ action: 'me', token: yu }).ok);
  });

  test('schedule: special times in a cell, roles, meal break (the restaurant rules)', () => {
    const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const Y = { bg: '#f09a37' }; // Yuna
    const rows = [
      ['', ''].concat(DAYS).map((t) => ({ t })),
      ['Date', ''].concat(['12/10', '13/10', '14/10', '15/10', '16/10', '17/10', '18/10']).map((t) => ({ t })),
      [{ t: 'Dinner\nTime zone 1', rs: 6, bg: '#434343' }, { bg: '#434343' }].concat(Array(7).fill({ t: '17:00', bg: '#434343' })),
      [null, { bg: '#434343' }].concat(Array(7).fill({ t: '22:30', bg: '#434343' })),
      [null, { t: 'Meal break', bg: '#434343' }, { t: '18:30-19:00' }, { t: '18:30-19:00' }, { t: '18:30-19:00' }],
      [null, { t: 'P', b: 1, bg: '#434343' }, Object.assign({ t: '23:00' }, Y), Object.assign({ t: '14:30' }, Y),
       Object.assign({ t: 'Yuna' }, Y), Object.assign({ t: 'note' }, Y), { t: '15:00 23:30', bg: '#f09a37' }],
      [null, { t: 'F', b: 1, bg: '#434343' }, { t: '' }, { t: 'Yuna' }],
      [null, { t: 'W', b: 1, bg: '#434343' }],
    ];
    const people = { byColor: { '#f09a37': 'Yuna' }, colors: { Yuna: '#f09a37' }, names: ['Yuna'] };
    const out = JSON.parse(JSON.stringify(S.ctx.weekSlots_(rows, people, '2026-10-12')))
      .map((x) => [x.date.slice(8), x.role, x.start + '-' + x.end, x.special, x.breaks.join(';'), x.names.join()]);
    assert.deepStrictEqual(out, [
      ['12', 'P', '17:00-23:00', true, 'Meal break 18:30-19:00', 'Yuna'],   // 23:00 은 끝(22:30)에 가까움
      ['13', 'P', '14:30-22:30', true, 'Meal break 18:30-19:00', 'Yuna'],   // 14:30 은 시작(17:00)에 가까움
      ['14', 'P', '17:00-22:30', false, 'Meal break 18:30-19:00', 'Yuna'],  // 이름만: 원래 시간, 글자 무시
      ['15', 'P', '17:00-22:30', false, '', 'Yuna'],                        // 다른 글자: 무시
      ['16', 'P', '15:00-23:30', true, '', 'Yuna'],                         // 시간 2개: 시작·끝
      ['13', 'F', '17:00-22:30', false, 'Meal break 18:30-19:00', 'Yuna'],  // 색 없이 이름만 적힌 칸
    ]);
  });

  test('schedule: the real kitchen layout (screenshot 1/10–4/10)', () => {
    const D = '#434343', W = '#ffffff';
    const c = (t, bg, fc) => ({ t, bg, fc });
    const e = (n) => Array(n).fill({});
    const dk = (n, t) => Array(n).fill(c(t || '', D, W));
    const days = (vals) => e(3).concat(vals); // 월~수 비어 있음 (지난달)
    const C = { o: '#f09a37', g: '#77ff55', p: '#6b1f45', v: '#8b7cf0', y: '#ffff55', s: '#999999' };
    const rows = [
      [{}, {}].concat(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map((t) => ({ t }))),
      [{ t: 'Date' }, {}].concat(days(['1/10', '2/10', '3/10', '4/10'].map((t) => ({ t })))),
      [{ t: 'Morning\nTime zone 1\n(11:00-11:30 Meal Break)', rs: 5 }, {}].concat(days(['09:00', '09:00', '09:00', '09:00'].map((t) => ({ t })))),
      [null, {}].concat(days(['15:00', '15:00', '15:30', '15:30'].map((t) => ({ t })))),
      [null, { t: 'P', b: 1 }].concat(days([c('', C.o), c('', C.o), {}, {}])),
      [null, { t: 'F', b: 1 }].concat(days([{}, {}, {}, {}])),
      [null, { t: 'W', b: 1 }].concat(days([{}, {}, {}, {}])),
      [{ t: 'Morning Time zone 2 (11:00-11:30 Meal Break)', rs: 5 }, {}].concat(days(['10:00', '10:00', '10:00', '10:00'].map((t) => ({ t })))),
      [null, {}].concat(days(['15:00', '15:00', '15:30', '15:30'].map((t) => ({ t })))),
      [null, { t: 'P', b: 1 }].concat(days([{}, {}, c('', C.g), c('', C.s)])),
      [null, { t: 'F', b: 1 }].concat(days([c('', C.p), c('', C.v), c('', C.s), c('', C.y)])),
      [null, { t: 'W', b: 1 }].concat(days([{}, {}, c('', C.y), c('', C.p)])),
      [c('Dinner\nTime zone 1\n(18:00-18:30 Meal Break)', D, W), c('', D)].concat(e(3), dk(1, '16:30'), dk(1, '16:30'), dk(2, '17:00')),
      [null, c('', D)].concat(e(3), dk(1, '22:30'), dk(3, '23:00')),
      [null, c('P', D, W)].concat(e(3), [c('', C.g), c('', C.g), c('', C.g), c('', C.g)]),
      [null, c('F', D, W)].concat(e(3), [c('', D), c('', D), c('', C.s), c('', C.y)]),
      [null, c('W', D, W)].concat(e(3), [c('23:00', C.p, W), c('', C.p), c('', C.y), c('', C.s)]),
    ];
    rows[12][0].rs = 5;
    const names = { [C.o]: 'Ana', [C.g]: 'Tom', [C.p]: 'Chris', [C.v]: 'Leo', [C.y]: 'Yuna', [C.s]: 'Sam' };
    const people = { byColor: names, colors: Object.fromEntries(Object.entries(names).map(([k, v]) => [v, k])),
                     names: Object.values(names) };
    const all = JSON.parse(JSON.stringify(S.ctx.weekSlots_(rows, people, '2026-09-28')));
    const of = (n) => all.filter((x) => x.names.includes(n))
      .map((x) => [x.date.slice(5), x.role, x.start + '-' + x.end, x.breaks.join(), x.special ? '*' : ''].join(' ')).sort();
    assert.deepStrictEqual(of('Chris'), [
      '10-01 F 10:00-15:00 Meal break 11:00 – 11:30 ',
      '10-01 W 16:30-23:00 Meal break 18:00 – 18:30 *',   // 칸 안의 23:00: 끝(22:30) 쪽
      '10-02 W 16:30-23:00 Meal break 18:00 – 18:30 ',
      '10-04 W 10:00-15:30 Meal break 11:00 – 11:30 ',
    ].sort());
    assert.deepStrictEqual(of('Yuna'), [
      '10-03 W 10:00-15:30 Meal break 11:00 – 11:30 ',
      '10-03 W 17:00-23:00 Meal break 18:00 – 18:30 ',
      '10-04 F 10:00-15:30 Meal break 11:00 – 11:30 ',
      '10-04 F 17:00-23:00 Meal break 18:00 – 18:30 ',
    ]);
    assert.ok(!all.some((x) => x.names.length === 0), 'dark background cells are not shifts');
  });

  test('schedule: a week split over two month tabs shows whole (table and shifts)', () => {
    const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const F3 = '1SplitWeekSplitWeekSplitWeek000000000';
    const blk = (dates, cells) => [['', ''].concat(DAYS), ['Date', ''].concat(dates), ['Morning', 'P'].concat(cells)];
    const Y = { t: '', bg: '#f09a37' }; // Yuna
    S.files[F3] = makeScheduleFile(F3, 'Split', {
      10: { grid: blk(['', '', '', '1/10', '2/10', '3/10', '4/10'], ['', '', '', Y, '', '', '']) },
      '09': { grid: blk(['28/9', '29/9', '30/9', '', '', '', ''], [Y, '', Y, '', '', '', '']) },
    });
    cfg.getSheetByName('Schedules').getRange(3, 1, 1, 3).setValues([['Split', F3, 'Kitchen']]);
    at('2026-10-02T12:00:00+02:00');
    const r = S.call({ action: 'schedule', token: yu, sched: 'Split' });
    assert.deepStrictEqual(r.tabs.map((t) => t.tab), ['10']);
    const w = r.weeks[0];
    assert.deepStrictEqual(w.rows[1].slice(2).map((c) => c && c.t), ['28/9', '29/9', '30/9', '1/10', '2/10', '3/10', '4/10']);
    assert.deepStrictEqual(w.rows[2].slice(2).map((c) => (c && c.bg) || ''), ['#f09a37', '', '#f09a37', '#f09a37', '', '', '']);
    assert.deepStrictEqual(w.slots.filter((x) => x.names.includes('Yuna')).map((x) => x.date),
      ['2026-09-28', '2026-09-30', '2026-10-01']);
  });

  test('schedule: P/F/W written inside the Monday column (real sheet layout)', () => {
    const D = '#434343', Wt = '#ffffff', G = '#77ff55', P = '#6b1f45';
    const t3 = (t, x) => [Object.assign({ t }, x), Object.assign({ t }, x), Object.assign({ t }, x)];
    const rows = [
      [{}].concat(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map((t) => ({ t }))),
      [{ t: 'Date' }].concat(['5/10', '6/10', '7/10', '8/10', '9/10', '10/10', '11/10'].map((t) => ({ t }))),
      [{ t: 'Morning\nTime zone 1\n(11:00-11:30 Meal Break)', rs: 5 }].concat(t3('08:30')),
      [null].concat(t3('16:30')),
      [null, { t: 'P', b: 1, bg: G }, { bg: G }, {}],          // 월요일 칸 = 'P' 글자 + Tom 색
      [null, { t: 'F', b: 1 }, {}, { bg: P }],
      [null, { t: 'W', b: 1 }, {}, {}],
      [{ t: 'Dinner\nTime zone 1\n(18:00-18:30 Meal Break)', rs: 5, bg: D, fc: Wt }].concat(t3('16:30', { bg: D })),
      [null].concat(t3('22:30', { bg: D })),
      [null, { t: 'P', bg: D, fc: Wt }, { bg: D }, { bg: D }],
      [null, { t: 'F', bg: D, fc: Wt }, { bg: D }, { bg: D }],
      [null, { t: 'W', bg: P, fc: Wt }, { t: '23:00', bg: P, fc: Wt }, { bg: D }],
    ];
    const people = { byColor: { [G]: 'Tom', [P]: 'Chris' }, colors: { Tom: G, Chris: P }, names: ['Tom', 'Chris'] };
    const out = JSON.parse(JSON.stringify(S.ctx.weekSlots_(rows, people, '2026-10-05')))
      .map((x) => [x.date.slice(8), x.role, x.start + '-' + x.end, x.special ? '*' : '-', x.names.join()].join(' ')).sort();
    assert.deepStrictEqual(out, [
      '05 P 08:30-16:30 - Tom',     // 월요일: 'P' 가 적힌 칸 자체가 Tom 의 근무
      '05 W 16:30-22:30 - Chris',   // 월요일 W 칸이 Chris 색
      '06 P 08:30-16:30 - Tom',     // 화요일 P 줄
      '06 W 16:30-23:00 * Chris',   // 칸 안의 23:00
      '07 F 08:30-16:30 - Chris',
    ]);
  });

  test('schedule: names in a cell match whole names only (LIN hsin-yu is not Yu-hsuan CHEN)', () => {
    const has = (t, n) => S.ctx.textHasName_(t, n);
    assert.strictEqual(has('LIN hsin-yu', 'Yu-hsuan CHEN'), false);
    assert.strictEqual(has('LIN hsin-yu', 'LIN hsin-yu'), true);
    assert.strictEqual(has('Yu-hsuan', 'Yu-hsuan CHEN'), true);
    assert.strictEqual(has('Chris 23:00', 'Chris'), true);
    assert.strictEqual(has('Sujeong 14:30', 'Sujeong SEO'), true);
  });

  test('schedule: records still verify', () => {
    assert.ok(S.ctx.verifyRecords().every((x) => x.ok));
  });
}

// ------------------------------------------------------------------ 교통카드 영수증
{
  const R = makeEnv({ SDM_META_KEY: keys.K1_SDM_META, SDM_FILE_KEY: keys.K2_SDM_FILE });
  const at = (iso) => { R.clock.fixed = iso; };
  const cfg = R.files[R.props.CONFIG_SHEET_ID].sheets[0];
  cfg.getRange(4, 8).setValue('');        // Yuna: 빈칸 = 대상
  cfg.getRange(5, 8).setValue('FALSE');   // No Mail: 제외
  R.ctx.Session = { getEffectiveUser: () => ({ getEmail: () => 'contact.monsieurkim@gmail.com' }) };
  const sup = R.call({ action: 'login', name: 'Nam KIM', pin: '4321' }).token;
  const yu = R.call({ action: 'login', name: 'Yuna', pin: '2222' }).token;
  const nm = R.call({ action: 'login', name: 'No Mail', pin: '3333' }).token;
  const JPG = 'data:image/jpeg;base64,' + Buffer.from('fake-jpeg').toString('base64');
  const PDF = 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4 fake').toString('base64');
  const receiptRows = () => {
    const sh = R.files[R.props.ANN_SHEET_ID].getSheetByName('Receipts');
    return Array.from({ length: sh.getLastRow() - 1 }, (_, i) => sh.getRange(i + 2, 1, 1, 6).getValues()[0]);
  };

  test('receipts: day 1 at 09:00 -> one email (no push) to those who must upload (not to exempt staff)', () => {
    at('2026-10-01T09:00:00+02:00');
    R.call({ action: 'subscribe', token: yu, sub: { endpoint: 'https://push.example/yuna-r', keys: {
      p256dh: ua.getPublicKey().toString('base64url'), auth: uaAuth.toString('base64url') } } });
    const m0 = R.sent.mail.length, p0 = R.sent.push.length;
    R.ctx.morningRun();
    const mails = R.sent.mail.slice(m0).filter((m) => /TCL pass receipt/.test(m.subject));
    assert.deepStrictEqual(mails.map((m) => m.to).sort(), ['nam@example.com', 'yuna@example.com']);
    assert.match(mails[0].subject, /TCL pass receipt \(October 2026\)/);
    assert.match(mails[0].htmlBody, /<b>5 October<\/b>/);
    assert.match(mails[0].htmlBody, /50% of your monthly transport pass/);
    assert.match(mails[0].htmlBody, /\?view=receipt/);
    assert.ok(!R.sent.push.slice(p0).some((x) => x.url.includes('yuna-r')), 'no push');
    R.ctx.morningRun(); // 두 번 실행돼도 한 번만
    assert.strictEqual(R.sent.mail.slice(m0).filter((m) => /TCL pass receipt/.test(m.subject)).length, 2);
  });

  test('receipts: no email on other days', () => {
    at('2026-10-02T09:00:00+02:00');
    const m0 = R.sent.mail.length;
    R.ctx.notifyReceipts_();
    assert.strictEqual(R.sent.mail.length, m0);
  });

  test('receipts: home button hint from day 1 to 5 until uploaded, nothing at clock-in, never for exempt staff', () => {
    at('2026-10-03T10:00:00+02:00');
    const me = R.call({ action: 'me', token: yu });
    assert.deepStrictEqual([me.receipt.month, me.receipt.label, me.receipt.deadline, me.receipt.daysLeft],
      ['2026-10', 'October 2026', '5 October', 2]);
    assert.strictEqual(R.call({ action: 'me', token: nm }).receipt, null);
    const [t] = tagUrls(keys, 'START', 1);
    const tap = R.call(Object.assign({ action: 'tap', token: yu }, t));
    assert.ok(tap.ok); assert.strictEqual(tap.receipt, undefined);
  });

  test('receipts: upload photo + PDF -> "Name yyyy-MM" files, reminder stops', () => {
    at('2026-10-04T10:00:00+02:00');
    const r = R.call({ action: 'receiptUpload', token: yu, files: [JPG, PDF] });
    assert.ok(r.ok, JSON.stringify(r));
    assert.deepStrictEqual(r.files.map((f) => [f.fileName, f.late, f.sent]),
      [['Yuna 2026-10.jpg', false, false], ['Yuna 2026-10 (2).pdf', false, false]]);
    const f = R.files[r.files[0].id];
    assert.strictEqual(f.title, 'Yuna 2026-10.jpg');
    assert.strictEqual(R.call({ action: 'me', token: yu }).receipt, null);
    assert.deepStrictEqual(receiptRows().map((x) => [x[1], x[2], x[3], x[5]]),
      [['Yuna', '2026-10', 'Yuna 2026-10.jpg', 'on time'], ['Yuna', '2026-10', 'Yuna 2026-10 (2).pdf', 'on time']]);
  });

  test('receipts: only photos/PDF are accepted', () => {
    assert.strictEqual(R.call({ action: 'receiptUpload', token: yu, files: ['data:text/html;base64,PGI+'] }).ok, false);
    assert.strictEqual(R.call({ action: 'receiptUpload', token: yu, files: [] }).ok, false);
  });

  test('receipts: own file can be deleted (name is reused), others cannot see or delete it', () => {
    const mine = R.call({ action: 'receipt', token: yu });
    const pdf = mine.files[1];
    assert.strictEqual(R.call({ action: 'receiptDelete', token: nm, id: pdf.id }).ok, false);
    assert.strictEqual(R.call({ action: 'receiptFile', token: nm, id: pdf.id }).ok, false);
    assert.match(R.call({ action: 'receiptFile', token: yu, id: pdf.id }).dataUrl, /^data:application\/pdf;base64,/);
    assert.match(R.call({ action: 'receiptFile', token: sup, id: pdf.id }).dataUrl, /^data:application\/pdf;base64,/);
    const r = R.call({ action: 'receiptDelete', token: yu, id: pdf.id });
    assert.deepStrictEqual(r.files.map((f) => f.fileName), ['Yuna 2026-10.jpg']);
    assert.ok(R.files[pdf.id].trashed);
    const again = R.call({ action: 'receiptUpload', token: yu, files: [PDF] });
    assert.deepStrictEqual(again.files.map((f) => f.fileName), ['Yuna 2026-10.jpg', 'Yuna 2026-10 (2).pdf']);
  });

  test('receipts: after the 5th the upload is marked late, no reminder', () => {
    at('2026-10-06T10:00:00+02:00');
    assert.strictEqual(R.call({ action: 'me', token: sup }).receipt, null);
    const mine = R.call({ action: 'receipt', token: sup });
    assert.strictEqual(mine.late, true);
    const r = R.call({ action: 'receiptUpload', token: sup, files: [JPG] });
    assert.deepStrictEqual(r.files.map((f) => [f.fileName, f.late]), [['Nam KIM 2026-10.jpg', true]]);
  });

  test('receipts: status page is for the supervisor only', () => {
    assert.strictEqual(R.call({ action: 'receiptStatus', token: yu }).ok, false);
    const r = R.call({ action: 'receiptStatus', token: sup });
    assert.ok(r.ok);
    assert.deepStrictEqual(r.months.map((m) => m.month), ['2026-10', '2026-09', '2026-08']);
    assert.deepStrictEqual(r.people.map((p) => [p.name, p.files.length, p.files.some((f) => f.late)]),
      [['Nam KIM', 1, true], ['Yuna', 2, false]]); // No Mail 은 제외 대상
    assert.strictEqual(r.accountant, '');
  });

  let preview;
  test('receipts: preview shows address, table and attachments; nothing is sent yet', () => {
    const m0 = R.sent.mail.length;
    assert.strictEqual(R.call({ action: 'receiptSend', token: sup, month: '2026-10', to: 'not-an-email' }).ok, false);
    assert.strictEqual(R.call({ action: 'receiptSend', token: yu, month: '2026-10', to: 'acc@example.com' }).ok, false);
    preview = R.call({ action: 'receiptSend', token: sup, month: '2026-10', to: 'acc@example.com' });
    assert.ok(preview.preview);
    // 5일 뒤에 올린 것(Nam KIM)도 그대로 같이 감
    assert.deepStrictEqual(preview.files, ['Nam KIM 2026-10.jpg', 'Yuna 2026-10.jpg', 'Yuna 2026-10 (2).pdf']);
    assert.strictEqual(preview.from, 'contact.monsieurkim@gmail.com');
    // 표에는 사람마다 제출 여부만
    const cells = [...preview.html.matchAll(/<tr><td[^>]*>([^<]+)<\/td><td[^>]*>(Yes|No)<\/td><\/tr>/g)].map((m) => m[1] + ':' + m[2]);
    assert.deepStrictEqual(cells, ['Nam KIM:Yes', 'Yuna:Yes']);
    assert.ok(!/Uploaded|\.jpg|\.pdf/.test(preview.html));
    assert.match(preview.subject, /Transport pass receipts · October 2026/);
    assert.strictEqual(R.sent.mail.length, m0);
  });

  test('receipts: confirm is refused if something changed since the preview', () => {
    const extra = R.call({ action: 'receiptUpload', token: yu, files: [JPG] }).files[2];
    const r = R.call({ action: 'receiptSend', token: sup, month: '2026-10', to: 'acc@example.com', confirm: true,
                       expect: preview.expect });
    assert.strictEqual(r.code, 'CHANGED');
    assert.ok(R.call({ action: 'receiptDelete', token: yu, id: extra.id }).ok);
  });

  test('receipts: confirm -> one email with table + attachments, files leave Drive, address remembered', () => {
    const m0 = R.sent.mail.length;
    const r = R.call({ action: 'receiptSend', token: sup, month: '2026-10', to: 'acc@example.com', confirm: true,
                       expect: preview.expect });
    assert.ok(r.ok, JSON.stringify(r));
    const mail = R.sent.mail.slice(m0);
    assert.strictEqual(mail.length, 1);
    assert.strictEqual(mail[0].to, 'acc@example.com');
    assert.strictEqual(mail[0].replyTo, 'contact.monsieurkim@gmail.com');
    assert.deepStrictEqual(Array.from(mail[0].attachments, (b) => b.getName()),
      ['Nam KIM 2026-10.jpg', 'Yuna 2026-10.jpg', 'Yuna 2026-10 (2).pdf']);
    assert.match(mail[0].htmlBody, /<td[^>]*>Yuna<\/td><td[^>]*>Yes<\/td>/);
    assert.ok(preview.expect.every((id) => R.files[id].trashed));
    const st = R.call({ action: 'receiptStatus', token: sup });
    assert.strictEqual(st.accountant, 'acc@example.com');
    assert.strictEqual(st.mails.length, 1);
    assert.ok(st.people.find((p) => p.name === 'Yuna').files.every((f) => f.sentAt));
    assert.strictEqual(R.call({ action: 'receiptDelete', token: yu, id: preview.expect[0] }).ok, false);
  });

  test('receipts: a receipt uploaded later goes out with the next send', () => {
    assert.strictEqual(R.call({ action: 'receiptSend', token: sup, month: '2026-10', to: 'acc@example.com' }).ok, false);
    at('2026-10-20T10:00:00+02:00');
    assert.ok(R.call({ action: 'receiptUpload', token: nm, files: [JPG] }).ok); // 제외 대상이어도 올리면 받음
    const p = R.call({ action: 'receiptSend', token: sup, month: '2026-10', to: 'acc@example.com' });
    assert.deepStrictEqual(p.files, ['No Mail 2026-10.jpg']);
    assert.match(p.html, /<td[^>]*>Yuna<\/td><td[^>]*>Yes<\/td>/); // 앞서 보낸 사람도 제출 Yes
  });

  test('receipts: refused when the system does not run as contact.monsieurkim@gmail.com', () => {
    const orig = R.ctx.Session;
    R.ctx.Session = { getEffectiveUser: () => ({ getEmail: () => 'someone.else@gmail.com' }) };
    const r = R.call({ action: 'receiptSend', token: sup, month: '2026-10', to: 'acc@example.com' });
    R.ctx.Session = orig;
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /contact\.monsieurkim@gmail\.com/);
  });

  test('receipts: records still verify', () => {
    assert.ok(R.ctx.verifyRecords().every((x) => x.ok));
  });
}

console.log(`\n${passed} passed`);
