// Apps Script 백엔드(Code.gs)를 가짜 Google 서비스로 실행하는 테스트.
// 실행: node test_gas.js
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert');
const crypto = require('crypto');

const GAS = path.join(__dirname, '..', 'gas');

function makeSheet(name) {
  const data = []; // data[r][c], 0-based
  const sheet = {
    name, data,
    getName: () => sheet.name,
    setName: (n) => { sheet.name = n; return sheet; },
    getLastRow: () => {
      for (let r = data.length; r > 0; r--) if ((data[r - 1] || []).some((v) => v !== '' && v != null)) return r;
      return 0;
    },
    getLastColumn: () => data.reduce((m, row) => {
      let c = (row || []).length;
      while (c > 0 && (row[c - 1] === '' || row[c - 1] == null)) c--;
      return Math.max(m, c);
    }, 0),
    getMaxRows: () => Math.max(1000, data.length),
    setFrozenRows: () => sheet,
    deleteRow: (r) => { data.splice(r - 1, 1); return sheet; },
    getRange: (r, c, nr, nc) => {
      nr = nr || 1; nc = nc || 1;
      const rng = {
        setNumberFormat: () => rng,
        setFontWeight: () => rng,
        getValues: () => Array.from({ length: nr }, (_, i) =>
          Array.from({ length: nc }, (_, j) => { const v = (data[r - 1 + i] || [])[c - 1 + j]; return v == null ? '' : v; })),
        setValues: (v) => {
          assert.strictEqual(v.length, nr, 'row count');
          v.forEach((row, i) => {
            assert.strictEqual(row.length, nc, 'col count');
            data[r - 1 + i] = data[r - 1 + i] || [];
            row.forEach((x, j) => { data[r - 1 + i][c - 1 + j] = x; });
          });
          return rng;
        },
        setValue: (x) => rng.setValues([[x]]),
        clearContent: () => rng.setValues(Array.from({ length: nr }, () => Array(nc).fill(''))),
      };
      return rng;
    },
  };
  return sheet;
}

function makeEnv() {
  const props = {};
  const cache = {};
  const files = {};
  let idSeq = 0;
  const makeSS = (title) => {
    const id = 'ss' + (++idSeq);
    const ss = {
      title, sheets: [makeSheet('Sheet1')],
      getId: () => id,
      getUrl: () => 'https://docs.google.com/spreadsheets/d/' + id,
      getSheets: () => ss.sheets,
      getSheetByName: (n) => ss.sheets.find((s) => s.name === n) || null,
      insertSheet: (n) => { const s = makeSheet(n); ss.sheets.push(s); return s; },
    };
    files[id] = ss;
    return ss;
  };
  const signed = (buf) => Array.from(buf, (b) => (b > 127 ? b - 256 : b));
  const ctx = {
    console,
    Logger: { log: () => {} },
    Session: { getScriptTimeZone: () => 'Europe/Paris' },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (k) => (k in props ? props[k] : null),
      getProperties: () => Object.assign({}, props),
      setProperty: (k, v) => { props[k] = String(v); },
      deleteProperty: (k) => { delete props[k]; },
    }) },
    CacheService: { getScriptCache: () => ({
      put: (k, v) => { cache[k] = v; },
      get: (k) => (k in cache ? cache[k] : null),
      remove: (k) => { delete cache[k]; },
    }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock: () => {}, releaseLock: () => {} }) },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' },
      Charset: { UTF_8: 'utf8' },
      getUuid: () => crypto.randomUUID(),
      computeDigest: (alg, v) => signed(crypto.createHash(alg).update(
        typeof v === 'string' ? Buffer.from(v, 'utf8') : Buffer.from(v.map((b) => b & 255))).digest()),
      base64Encode: (bytes) => Buffer.from(bytes.map((b) => b & 255)).toString('base64'),
      formatDate: (d, tz, fmt) => {
        const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric',
          month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
          .formatToParts(d).map((x) => [x.type, x.value]));
        return fmt.replace('yyyy', p.year).replace('MM', p.month).replace('dd', p.day)
          .replace('HH', p.hour).replace('mm', p.minute).replace('ss', p.second);
      },
    },
    SpreadsheetApp: {
      create: (t) => makeSS(t),
      openById: (id) => files[id],
      getActiveSpreadsheet: () => null,
      flush: () => {},
    },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: (s) => ({ body: s, setMimeType() { return this; } }),
    },
  };
  vm.createContext(ctx);
  const src = fs.readFileSync(path.join(GAS, 'Code.gs'), 'utf8');
  // 실제 Apps Script 처럼 요청마다 전역 상태(ss_, tables_)가 새로 시작되도록 매번 다시 로드
  const call = (body) => {
    vm.runInContext(src, ctx, { filename: 'Code.gs' });
    return JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(body) } }).body);
  };
  const ok = (body) => {
    const r = call(body);
    assert.ok(r.ok, body.action + ' failed: ' + r.error);
    return r;
  };
  const sheet = (name) => files[props.SHEET_ID].getSheetByName(name);
  return { ctx, call, ok, props, cache, files, sheet };
}

module.exports = { makeEnv };
if (require.main !== module) return;

// ------------------------------------------------------------------ tests
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('ok -', name); }

const env = makeEnv();
const { call, ok } = env;
let admin, staff, apple, pear;

test('status before setup creates DB and reports needsSetup', () => {
  const r = ok({ action: 'status' });
  assert.strictEqual(r.needsSetup, true);
  assert.ok(env.props.SHEET_ID);
  assert.deepStrictEqual(env.sheet('Users').getRange(1, 1, 1, 3).getValues()[0], ['id', 'username', 'name']);
  // 기본 Sheet1 은 첫 테이블로 재사용됨
  assert.ok(!env.files[env.props.SHEET_ID].getSheetByName('Sheet1'));
});

test('first admin setup, then setup is closed', () => {
  assert.strictEqual(call({ action: 'setupAdmin', username: 'a', password: '1234' }).ok, false); // 아이디 너무 짧음
  const r = ok({ action: 'setupAdmin', username: 'boss', name: '사장님', password: 'secret1' });
  admin = r.token;
  assert.strictEqual(r.user.role, 'admin');
  assert.ok(!('passwordHash' in r.user));
  assert.strictEqual(call({ action: 'setupAdmin', username: 'x2', password: 'secret1' }).ok, false);
  assert.strictEqual(ok({ action: 'status' }).needsSetup, false);
});

test('login, wrong password, lockout', () => {
  assert.strictEqual(call({ action: 'login', username: 'boss', password: 'nope' }).error, '아이디 또는 비밀번호가 맞지 않습니다.');
  const r = ok({ action: 'login', username: 'BOSS', password: 'secret1' });
  assert.ok(r.token);
  for (let i = 0; i < 5; i++) call({ action: 'login', username: 'ghost', password: 'x' });
  assert.match(call({ action: 'login', username: 'ghost', password: 'x' }).error, /너무 많습니다/);
});

test('admin creates a staff user; staff cannot use admin actions', () => {
  ok({ action: 'saveUser', token: admin, user: { username: 'staff1', name: '직원1', password: '0000', role: 'user' } });
  assert.strictEqual(call({ action: 'saveUser', token: admin, user: { username: 'Staff1', password: '0000' } }).ok, false);
  staff = ok({ action: 'login', username: 'staff1', password: '0000' }).token;
  const r = call({ action: 'saveProduct', token: staff, product: { name: 'x' } });
  assert.strictEqual(r.code, 'FORBIDDEN');
  assert.strictEqual(call({ action: 'bootstrap' }).code, 'AUTH');
});

test('admin creates products with initial stock (logged as IN)', () => {
  let r = ok({ action: 'saveProduct', token: admin, product: {
    sku: '001', name: '사과', category: '과일', option: '1kg', unit: '박스', price: '12,5', cost: 8, stock: 10, minStock: 3 } });
  apple = r.product;
  assert.strictEqual(apple.sku, '001');
  assert.strictEqual(apple.price, 12.5);
  assert.strictEqual(apple.stock, 10);
  assert.deepStrictEqual(r.categories, ['과일']);
  r = ok({ action: 'saveProduct', token: admin, product: { sku: '002', name: '배', category: '과일', cost: 5, price: 9 } });
  pear = r.product;
  assert.strictEqual(pear.stock, 0);
  assert.strictEqual(pear.minStock, 5); // lowStockDefault
  assert.match(call({ action: 'saveProduct', token: admin, product: { sku: '001', name: 'dup' } }).error, /SKU/);
  const hist = ok({ action: 'history', token: admin, productId: apple.id }).movements;
  assert.strictEqual(hist.length, 1);
  assert.strictEqual(hist[0].type, 'IN');
  assert.strictEqual(hist[0].note, '초기 재고');
});

test('editing a product does not touch stock', () => {
  const r = ok({ action: 'saveProduct', token: admin, product: { id: apple.id, name: '사과(부사)', stock: 999 } });
  assert.strictEqual(r.product.stock, 10);
  assert.strictEqual(r.product.sku, '001');
  apple = r.product;
});

test('staff bootstrap hides cost and inactive products', () => {
  ok({ action: 'saveProduct', token: admin, product: { id: pear.id, active: false } });
  let b = ok({ action: 'bootstrap', token: staff });
  assert.strictEqual(b.user.role, 'user');
  assert.strictEqual(b.products.length, 1);
  assert.ok(!('cost' in b.products[0]));
  assert.ok(!('dbUrl' in b));
  b = ok({ action: 'bootstrap', token: admin });
  assert.strictEqual(b.products.length, 2);
  assert.ok('cost' in b.products[0]);
  assert.ok(b.dbUrl);
  ok({ action: 'saveProduct', token: admin, product: { id: pear.id, active: true } });
});

test('staff IN/OUT, insufficient stock rejected', () => {
  let r = ok({ action: 'move', token: staff, productId: apple.id, type: 'OUT', qty: 4, note: '주문 #1' });
  assert.strictEqual(r.product.stock, 6);
  assert.strictEqual(r.movement.qty, -4);
  assert.strictEqual(r.movement.userName, '직원1');
  r = call({ action: 'move', token: staff, productId: apple.id, type: 'OUT', qty: 7 });
  assert.match(r.error, /재고가 부족/);
  assert.match(call({ action: 'move', token: staff, productId: apple.id, type: 'IN', qty: -1 }).error, /수량/);
  r = ok({ action: 'move', token: staff, productId: pear.id, type: 'IN', qty: '2,5' });
  assert.strictEqual(r.product.stock, 2.5);
  const mine = ok({ action: 'history', token: staff }).movements;
  assert.strictEqual(mine.length, 2);
  assert.strictEqual(mine[0].productId, pear.id); // 최신순
});

test('settings: disable staff moves, enable cost view', () => {
  ok({ action: 'saveSettings', token: admin, settings: { userCanMove: 'false', userCanSeeCost: 'true', shopName: 'Tapfruit', bogus: 1 } });
  assert.match(call({ action: 'move', token: staff, productId: apple.id, type: 'IN', qty: 1 }).error, /권한/);
  const b = ok({ action: 'bootstrap', token: staff });
  assert.ok('cost' in b.products[0]);
  assert.strictEqual(b.settings.shopName, 'Tapfruit');
  assert.ok(!('bogus' in b.settings));
  assert.strictEqual(ok({ action: 'status' }).shopName, 'Tapfruit');
  ok({ action: 'saveSettings', token: admin, settings: { userCanMove: 'true' } });
  assert.strictEqual(ok({ action: 'bootstrap', token: staff }).settings.userCanSeeCost, 'true'); // 다른 값은 유지
});

test('adjust and cancel', () => {
  let r = ok({ action: 'adjust', token: admin, productId: apple.id, stock: 20, note: '실사' });
  assert.strictEqual(r.product.stock, 20);
  assert.strictEqual(r.movement.type, 'ADJUST');
  assert.strictEqual(r.movement.qty, 14);
  const adjId = r.movement.id;
  r = ok({ action: 'cancelMovement', token: admin, id: adjId });
  assert.strictEqual(r.product.stock, 6);
  assert.strictEqual(r.movement.type, 'CANCEL');
  assert.match(call({ action: 'cancelMovement', token: admin, id: adjId }).error, /이미 취소/);
  assert.match(call({ action: 'cancelMovement', token: admin, id: r.movement.id }).error, /다시 취소/);
  const list = ok({ action: 'movements', token: admin, productId: apple.id }).movements;
  assert.ok(list.find((m) => m.id === adjId).canceled);
  assert.strictEqual(call({ action: 'cancelMovement', token: staff, id: adjId }).code, 'FORBIDDEN');
});

test('movements filters', () => {
  const today = env.ctx.now_().slice(0, 10);
  let r = ok({ action: 'movements', token: admin, from: today, to: today, type: 'OUT' });
  assert.strictEqual(r.total, 1);
  r = ok({ action: 'movements', token: admin, q: '주문' });
  assert.strictEqual(r.total, 1);
  r = ok({ action: 'movements', token: admin, from: '2999-01-01' });
  assert.strictEqual(r.total, 0);
});

test('dashboard', () => {
  const d = ok({ action: 'dashboard', token: admin });
  assert.strictEqual(d.productCount, 2);
  assert.strictEqual(d.totalUnits, 8.5);
  assert.strictEqual(d.costValue, 6 * 8 + 2.5 * 5);
  assert.strictEqual(d.lowStockCount, 1); // 배 2.5 <= 5
  assert.strictEqual(d.lowStock[0].id, pear.id);
  assert.strictEqual(d.todayIn, 12.5);
  assert.strictEqual(d.todayOut, 4);
  assert.strictEqual(d.days.length, 7);
});

test('categories rename/delete propagate to products', () => {
  ok({ action: 'saveProduct', token: admin, product: { id: pear.id, category: '채소' } });
  let r = ok({ action: 'saveCategories', token: admin, items: [
    { name: '생과일', oldName: '과일' }, { name: '선물세트' }] });
  assert.deepStrictEqual(r.categories, ['생과일', '선물세트']);
  assert.strictEqual(r.products.find((p) => p.id === apple.id).category, '생과일');
  assert.strictEqual(r.products.find((p) => p.id === pear.id).category, ''); // 채소 삭제됨
  r = ok({ action: 'saveCategories', token: admin, items: [{ name: 'constructor' }, { name: '생과일', oldName: '생과일' }] });
  assert.deepStrictEqual(r.categories, ['constructor', '생과일']);
});

test('CSV import upserts by SKU and logs stock changes', () => {
  const r = ok({ action: 'importProducts', token: admin, rows: [
    { sku: '001', price: 13, stock: 30 },          // 기존: 가격 + 재고 조정
    { sku: '003', name: '포도', category: '생과일', stock: 7, cost: 4 },
    { sku: '003', minStock: 2 },                   // 같은 파일 안 중복 SKU
    { sku: '004' },                                // 이름 없는 새 상품 → 건너뜀
    { name: '귤', category: '감귤', stock: '' },
  ] });
  assert.strictEqual(r.added, 2);
  assert.strictEqual(r.updated, 1);
  assert.deepStrictEqual(r.skipped, [4]);
  assert.ok(r.categories.includes('감귤'));
  const b = ok({ action: 'bootstrap', token: admin });
  const by = Object.fromEntries(b.products.map((p) => [p.sku || p.name, p]));
  assert.strictEqual(by['001'].stock, 30);
  assert.strictEqual(by['001'].price, 13);
  assert.strictEqual(by['001'].name, '사과(부사)');
  assert.strictEqual(by['003'].stock, 7);
  assert.strictEqual(by['003'].minStock, 2);
  assert.strictEqual(by['귤'].stock, 0);
  const notes = ok({ action: 'movements', token: admin, q: 'CSV' }).movements.map((m) => m.type).sort();
  assert.deepStrictEqual(notes, ['ADJUST', 'IN']);
});

test('user management guards', () => {
  const users = ok({ action: 'users', token: admin }).users;
  const me = users.find((u) => u.username === 'boss');
  const s = users.find((u) => u.username === 'staff1');
  assert.match(call({ action: 'saveUser', token: admin, user: { id: me.id, role: 'user' } }).error, /자기 자신/);
  assert.match(call({ action: 'deleteUser', token: admin, id: me.id }).error, /자기 자신/);
  // 비밀번호 재설정 → 기존 세션 끊김
  ok({ action: 'saveUser', token: admin, user: { id: s.id, password: '9999' } });
  assert.strictEqual(call({ action: 'bootstrap', token: staff }).code, 'AUTH');
  staff = ok({ action: 'login', username: 'staff1', password: '9999' }).token;
  // 비활성화 → 로그인 불가
  ok({ action: 'saveUser', token: admin, user: { id: s.id, active: false } });
  assert.strictEqual(call({ action: 'bootstrap', token: staff }).code, 'AUTH');
  assert.strictEqual(call({ action: 'login', username: 'staff1', password: '9999' }).ok, false);
  ok({ action: 'deleteUser', token: admin, id: s.id });
  assert.strictEqual(ok({ action: 'users', token: admin }).users.length, 1);
});

test('change own password keeps this device logged in', () => {
  assert.match(call({ action: 'changePassword', token: admin, oldPassword: 'x', newPassword: 'abcd' }).error, /현재 비밀번호/);
  const r = ok({ action: 'changePassword', token: admin, oldPassword: 'secret1', newPassword: 'newpass' });
  assert.strictEqual(call({ action: 'bootstrap', token: admin }).code, 'AUTH');
  admin = r.token;
  ok({ action: 'bootstrap', token: admin });
});

test('delete product; extra user columns in sheet survive updates', () => {
  const sh = env.sheet('Products');
  const width = sh.getLastColumn();
  sh.getRange(1, width + 1).setValue('내 메모');
  sh.getRange(2, width + 1).setValue('keep me');
  ok({ action: 'move', token: admin, productId: apple.id, type: 'IN', qty: 1 });
  assert.strictEqual(sh.getRange(2, width + 1).getValues()[0][0], 'keep me');
  ok({ action: 'deleteProduct', token: admin, id: pear.id });
  assert.ok(!ok({ action: 'bootstrap', token: admin }).products.some((p) => p.id === pear.id));
  assert.match(call({ action: 'move', token: admin, productId: pear.id, type: 'IN', qty: 1 }).error, /찾을 수 없/);
});

test('missing columns are added to an existing sheet', () => {
  const sh = env.sheet('Categories');
  sh.getRange(1, 2).setValue(''); // sort 열 제거
  const r = ok({ action: 'bootstrap', token: admin });
  assert.ok(r.categories.length > 0);
  assert.strictEqual(sh.getRange(1, 2).getValues()[0][0], 'sort');
});

test('logout', () => {
  ok({ action: 'logout', token: admin });
  assert.strictEqual(call({ action: 'bootstrap', token: admin }).code, 'AUTH');
  assert.strictEqual(call({ action: 'nope' }).ok, false);
});

console.log(`\n${passed} tests passed`);
