// Apps Script 백엔드(Code.gs + Crypto.gs)를 가짜 Google 서비스로 실행하는 테스트.
// 실행: node test_gas.js   (python3 + pycryptodome 필요: 태그 URL 생성에 사용)
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert');
const { execFileSync } = require('child_process');

const GAS = path.join(__dirname, '..', 'gas');

function makeEnv(propsInit) {
  const props = Object.assign({}, propsInit);
  const cache = {};
  const files = {}; // id -> spreadsheet mock
  let idSeq = 0;

  function makeSheet(name) {
    const cells = {};
    const sheet = {
      name, cells, bg: {},
      getName: () => sheet.name,
      setName: (n) => { sheet.name = n; return sheet; },
      getLastRow: () => Object.keys(cells).reduce((m, k) => Math.max(m, +k.split(',')[0]), 0),
      setFrozenRows: () => sheet,
      getDataRange: () => ({
        getDisplayValues: () => {
          const out = [];
          for (let r = 1; r <= sheet.getLastRow(); r++) {
            out.push([1, 2, 3, 4].map((c) => cells[r + ',' + c] || ''));
          }
          return out;
        },
      }),
      getRange: (r, c, nr, nc) => {
        if (typeof r === 'string') return { setNumberFormat: () => ({}) };
        nr = nr || 1; nc = nc || 1;
        const rng = {
          setNumberFormat: () => rng,
          setFontWeight: () => rng,
          setBackground: (b) => { sheet.bg[r + ',' + c] = b; return rng; },
          setValues: (v) => { v.forEach((row, i) => row.forEach((x, j) => { cells[(r + i) + ',' + (c + j)] = String(x); })); return rng; },
          setValue: (x) => { cells[r + ',' + c] = String(x); return rng; },
        };
        return rng;
      },
    };
    return sheet;
  }

  function makeSS(title) {
    const id = 'ss' + (++idSeq);
    const ss = {
      title, sheets: [makeSheet('Sheet1')],
      getId: () => id,
      getUrl: () => 'https://docs/' + id,
      getSheets: () => ss.sheets,
      getSheetByName: (n) => ss.sheets.find((s) => s.name === n) || null,
      insertSheet: (n) => { const s = makeSheet(n); ss.sheets.push(s); return s; },
    };
    files[id] = ss;
    return ss;
  }

  const fileObj = (ss) => ({ getMimeType: () => 'sheets', getId: () => ss.getId(), moveTo: () => {} });

  const ctx = {
    console,
    Logger: { log: () => {} },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (k) => (k in props ? props[k] : null),
      setProperty: (k, v) => { props[k] = String(v); },
      deleteProperty: (k) => { delete props[k]; },
    }) },
    CacheService: { getScriptCache: () => ({
      put: (k, v) => { cache[k] = v; },
      get: (k) => (k in cache ? cache[k] : null),
    }) },
    LockService: { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) },
    Utilities: {
      getUuid: () => require('crypto').randomUUID(),
      formatDate: (d, tz, fmt) => {
        const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric',
          month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
          .formatToParts(d).map((x) => [x.type, x.value]));
        return fmt.replace('yyyy', p.year).replace('MM', p.month).replace('dd', p.day)
          .replace('HH', p.hour).replace('mm', p.minute);
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
      getFolderById: () => ({
        getFilesByName: (n) => {
          const list = Object.values(files).filter((s) => s.title === n).map(fileObj);
          return { hasNext: () => list.length > 0, next: () => list.shift() };
        },
      }),
      getFileById: (id) => fileObj(files[id]),
    },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: (s) => ({ body: s, setMimeType() { return this; } }),
    },
  };
  vm.createContext(ctx);
  for (const f of ['Crypto.gs', 'Code.gs']) vm.runInContext(fs.readFileSync(path.join(GAS, f), 'utf8'), ctx, { filename: f });
  ctx.setup();
  const config = files[props.CONFIG_SHEET_ID];
  config.sheets[0].getRange(3, 1, 2, 3).setValues([['Nam KIM', '4321', 'TRUE'], ['Old Staff', '1111', 'FALSE']]);
  const call = (body) => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(body) } }).body);
  return { ctx, call, props, files };
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

console.log(`\n${passed} passed`);
