// 쇼핑몰 재고 관리 — Apps Script 백엔드 (API 전용)
//
// 데이터베이스: Google 스프레드시트 1개 (탭: Products / Movements / Users / Categories / Settings)
//   - 스크립트 속성 SHEET_ID 가 있으면 그 시트를 사용
//   - 없고 스프레드시트에 바인딩된 스크립트면 그 시트를 사용
//   - 둘 다 아니면 첫 요청 때 "Inventory DB" 시트를 새로 만들고 SHEET_ID 에 저장
// 탭과 열은 자동으로 만들어지고, 열이 빠져 있으면 오른쪽에 추가됩니다. 시트를 직접 고칠 필요는 없습니다.
//
// 모든 요청: POST (Content-Type: text/plain) 본문 = JSON { action, token, ... }

var SESSION_DAYS = 30;
var LOGIN_MAX_FAIL = 5;          // 이 횟수만큼 틀리면
var LOGIN_LOCK_SEC = 10 * 60;    // 이 시간 동안 로그인 차단
var HASH_ROUNDS = 200;

var SCHEMA = {
  Products: [
    ['id', 's'], ['sku', 's'], ['name', 's'], ['category', 's'], ['option', 's'], ['unit', 's'],
    ['price', 'n'], ['cost', 'n'], ['stock', 'n'], ['minStock', 'n'], ['location', 's'],
    ['barcode', 's'], ['imageUrl', 's'], ['memo', 's'], ['active', 'b'], ['createdAt', 's'], ['updatedAt', 's'],
  ],
  Movements: [
    ['id', 's'], ['time', 's'], ['productId', 's'], ['sku', 's'], ['productName', 's'], ['type', 's'],
    ['qty', 'n'], ['before', 'n'], ['after', 'n'], ['userId', 's'], ['userName', 's'], ['note', 's'],
    ['refId', 's'], ['canceled', 'b'],
  ],
  Users: [
    ['id', 's'], ['username', 's'], ['name', 's'], ['role', 's'], ['passwordHash', 's'], ['active', 'b'],
    ['createdAt', 's'], ['lastLogin', 's'],
  ],
  Categories: [['name', 's'], ['sort', 'n']],
  Settings: [['key', 's'], ['value', 's']],
};

var DEFAULT_SETTINGS = {
  shopName: '재고 관리',
  currency: '€',
  lowStockDefault: '5',     // 새 상품의 기본 안전재고
  userCanMove: 'true',      // 사용자 모드에서 입고/출고 허용
  userCanSeeCost: 'false',  // 사용자 모드에서 원가 표시
  allowNegative: 'false',   // 재고가 0 미만으로 내려가는 출고 허용
};

// 사용자가 수정할 수 있는 상품 필드 (stock 은 입출고/조정으로만 변경)
var PRODUCT_FIELDS = ['sku', 'name', 'category', 'option', 'unit', 'price', 'cost', 'minStock',
  'location', 'barcode', 'imageUrl', 'memo', 'active'];

var props_ = PropertiesService.getScriptProperties();
var ss_ = null;
var tables_ = {};

/** (선택) 편집기에서 한 번 실행하면 DB 시트를 만들고 주소를 로그에 출력합니다. */
function setup() {
  Object.keys(SCHEMA).forEach(table_);
  Logger.log('DB 시트: ' + db_().getUrl());
}

function doGet() {
  return json_({ ok: true, service: 'inventory' });
}

function doPost(e) {
  var req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: '잘못된 요청입니다.' });
  }
  try {
    var fn = ACTIONS[req.action];
    if (!fn) return json_({ ok: false, error: '알 수 없는 요청입니다: ' + req.action });
    var out = fn(req);
    out.ok = true;
    return json_(out);
  } catch (err) {
    if (err && err.userMessage) return json_({ ok: false, error: err.userMessage, code: err.code });
    console.error(err && err.stack || err);
    return json_({ ok: false, error: '서버 오류: ' + (err && err.message || err) });
  }
}

var ACTIONS = {
  // 공개
  status: status_,
  setupAdmin: setupAdmin_,
  login: login_,
  // 로그인한 모든 사용자
  logout: logout_,
  bootstrap: bootstrap_,
  move: move_,
  history: history_,
  changePassword: changePassword_,
  // 관리자
  dashboard: dashboard_,
  saveProduct: saveProduct_,
  deleteProduct: deleteProduct_,
  adjust: adjust_,
  movements: movements_,
  cancelMovement: cancelMovement_,
  users: users_,
  saveUser: saveUser_,
  deleteUser: deleteUser_,
  saveCategories: saveCategories_,
  saveSettings: saveSettings_,
  importProducts: importProducts_,
};

// ================================================================== 인증

function status_() {
  return { needsSetup: rows_('Users').length === 0, shopName: settings_().shopName };
}

function setupAdmin_(req) {
  return withLock_(function () {
    if (rows_('Users').length > 0) fail_('이미 관리자 계정이 있습니다. 로그인하세요.');
    var user = newUser_(req, 'admin');
    insert_('Users', user);
    return session_(user);
  });
}

function login_(req) {
  var username = String(req.username || '').trim().toLowerCase();
  var password = String(req.password || '');
  if (!username || !password) fail_('아이디와 비밀번호를 입력하세요.');
  var cache = CacheService.getScriptCache();
  var failKey = 'fail_' + username;
  var fails = Number(cache.get(failKey) || 0);
  if (fails >= LOGIN_MAX_FAIL) fail_('로그인 시도가 너무 많습니다. 10분 후 다시 시도하세요.');

  var user = findUser_(function (u) { return u.username.toLowerCase() === username; });
  if (!user || !user.active || !checkPassword_(password, user.passwordHash)) {
    cache.put(failKey, String(fails + 1), LOGIN_LOCK_SEC);
    fail_('아이디 또는 비밀번호가 맞지 않습니다.');
  }
  cache.remove(failKey);
  withLock_(function () {
    var fresh = findUser_(function (u) { return u.id === user.id; });
    if (fresh) {
      fresh.lastLogin = now_();
      update_('Users', fresh);
    }
  });
  purgeSessions_();
  return session_(user);
}

function logout_(req) {
  if (req.token) props_.deleteProperty('sess_' + req.token);
  return {};
}

function changePassword_(req) {
  var me = auth_(req);
  if (!checkPassword_(String(req.oldPassword || ''), me.passwordHash)) fail_('현재 비밀번호가 맞지 않습니다.');
  checkPasswordRule_(req.newPassword);
  return withLock_(function () {
    var u = findUser_(function (x) { return x.id === me.id; });
    u.passwordHash = hashPassword_(String(req.newPassword));
    update_('Users', u);
    props_.deleteProperty('sess_' + req.token);
    return session_(u); // 비밀번호가 바뀌면 다른 기기의 로그인은 끊어짐
  });
}

function session_(user) {
  var token = Utilities.getUuid() + Utilities.getUuid().slice(0, 8);
  props_.setProperty('sess_' + token, JSON.stringify({
    u: user.id, h: user.passwordHash.slice(-12), exp: Date.now() + SESSION_DAYS * 864e5,
  }));
  return { token: token, user: publicUser_(user) };
}

/** 토큰 확인 후 사용자 반환. role='admin' 이면 관리자만 통과. */
function auth_(req, role) {
  var raw = req.token ? props_.getProperty('sess_' + req.token) : null;
  if (!raw) fail_('다시 로그인하세요.', 'AUTH');
  var s = JSON.parse(raw);
  var user = s.exp > Date.now() && findUser_(function (u) { return u.id === s.u; });
  if (!user || !user.active || user.passwordHash.slice(-12) !== s.h) {
    props_.deleteProperty('sess_' + req.token);
    fail_('다시 로그인하세요.', 'AUTH');
  }
  if (role === 'admin' && user.role !== 'admin') fail_('관리자만 할 수 있습니다.', 'FORBIDDEN');
  return user;
}

function purgeSessions_() {
  var all = props_.getProperties();
  var now = Date.now();
  Object.keys(all).forEach(function (k) {
    if (k.indexOf('sess_') !== 0) return;
    try {
      if (JSON.parse(all[k]).exp < now) props_.deleteProperty(k);
    } catch (e) {
      props_.deleteProperty(k);
    }
  });
}

function findUser_(pred) {
  var list = rows_('Users');
  for (var i = 0; i < list.length; i++) if (pred(list[i])) return list[i];
  return null;
}

function publicUser_(u) {
  return { id: u.id, username: u.username, name: u.name, role: u.role, active: u.active,
    createdAt: u.createdAt, lastLogin: u.lastLogin };
}

function newUser_(req, role) {
  var username = String(req.username || '').trim();
  if (!/^[A-Za-z0-9._-]{2,30}$/.test(username)) fail_('아이디는 영문/숫자 2~30자로 입력하세요.');
  checkPasswordRule_(req.password);
  return {
    id: newId_('U'), username: username, name: String(req.name || '').trim() || username,
    role: role === 'admin' ? 'admin' : 'user', passwordHash: hashPassword_(String(req.password)),
    active: true, createdAt: now_(), lastLogin: '',
  };
}

function checkPasswordRule_(pw) {
  if (String(pw || '').length < 4) fail_('비밀번호는 4자 이상이어야 합니다.');
}

function hashPassword_(pw, salt) {
  salt = salt || Utilities.getUuid().replace(/-/g, '').slice(0, 16);
  var h = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + ':' + pw, Utilities.Charset.UTF_8);
  for (var i = 0; i < HASH_ROUNDS; i++) h = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, h);
  return salt + '$' + Utilities.base64Encode(h);
}

function checkPassword_(pw, stored) {
  var salt = String(stored || '').split('$')[0];
  return !!salt && hashPassword_(pw, salt) === stored;
}

// ================================================================== 조회

/** 앱 시작 시 한 번에 필요한 데이터 (요청 수를 줄이기 위해). */
function bootstrap_(req) {
  var me = auth_(req);
  var st = settings_();
  var admin = me.role === 'admin';
  var showCost = admin || st.userCanSeeCost === 'true';
  var products = rows_('Products').filter(function (p) { return admin || p.active; }).map(function (p) {
    var o = strip_(p);
    if (!showCost) delete o.cost;
    return o;
  });
  var out = {
    user: publicUser_(me),
    settings: st,
    categories: categories_(),
    products: products,
  };
  if (admin) out.dbUrl = db_().getUrl();
  return out;
}

/** 상품별 기록 또는 내 기록. 관리자가 아니면 최근 50건까지. */
function history_(req) {
  var me = auth_(req);
  var admin = me.role === 'admin';
  var list = tail_('Movements', 3000).filter(function (m) {
    if (req.productId) return m.productId === req.productId;
    return m.userId === me.id;
  });
  list.reverse();
  return { movements: list.slice(0, admin ? 300 : 50).map(strip_) };
}

function dashboard_(req) {
  auth_(req, 'admin');
  var products = rows_('Products').filter(function (p) { return p.active; });
  var moves = tail_('Movements', 5000);
  var today = now_().slice(0, 10);
  var days = [];
  for (var i = 6; i >= 0; i--) {
    var d = Utilities.formatDate(new Date(Date.now() - i * 864e5), tz_(), 'yyyy-MM-dd');
    days.push({ date: d, in: 0, out: 0 });
  }
  var byDate = {};
  days.forEach(function (d) { byDate[d.date] = d; });
  var todayIn = 0, todayOut = 0;
  moves.forEach(function (m) {
    if (m.canceled || m.type === 'CANCEL') return;
    var d = byDate[m.time.slice(0, 10)];
    if (!d) return;
    if (m.type === 'IN') d.in += m.qty;
    if (m.type === 'OUT') d.out += -m.qty;
  });
  if (byDate[today]) {
    todayIn = byDate[today].in;
    todayOut = byDate[today].out;
  }
  var low = products.filter(function (p) { return p.stock <= p.minStock; })
    .sort(function (a, b) { return (a.stock - a.minStock) - (b.stock - b.minStock); });
  return {
    productCount: products.length,
    totalUnits: round_(sum_(products, function (p) { return p.stock; })),
    costValue: round_(sum_(products, function (p) { return p.stock * p.cost; })),
    retailValue: round_(sum_(products, function (p) { return p.stock * p.price; })),
    outOfStock: products.filter(function (p) { return p.stock <= 0; }).length,
    lowStock: low.slice(0, 50).map(strip_),
    lowStockCount: low.length,
    todayIn: round_(todayIn),
    todayOut: round_(todayOut),
    days: days,
    recent: moves.slice(-15).reverse().map(strip_),
  };
}

function movements_(req) {
  auth_(req, 'admin');
  var from = String(req.from || ''), to = String(req.to || '');
  var q = String(req.q || '').trim().toLowerCase();
  var list = rows_('Movements').filter(function (m) {
    var d = m.time.slice(0, 10);
    if (from && d < from) return false;
    if (to && d > to) return false;
    if (req.type && m.type !== req.type) return false;
    if (req.userId && m.userId !== req.userId) return false;
    if (req.productId && m.productId !== req.productId) return false;
    if (q && (m.sku + ' ' + m.productName + ' ' + m.note + ' ' + m.userName).toLowerCase().indexOf(q) < 0) return false;
    return true;
  });
  list.reverse();
  var limit = Math.min(Number(req.limit) || 500, 5000);
  return { total: list.length, movements: list.slice(0, limit).map(strip_) };
}

// ================================================================== 입출고

/** 입고(IN) / 출고(OUT). 관리자 또는 userCanMove 가 켜진 사용자. */
function move_(req) {
  var me = auth_(req);
  var st = settings_();
  if (me.role !== 'admin' && st.userCanMove !== 'true') fail_('입출고 권한이 없습니다. 관리자에게 문의하세요.');
  if (req.type !== 'IN' && req.type !== 'OUT') fail_('입고 또는 출고를 선택하세요.');
  var qty = positiveQty_(req.qty);
  return withLock_(function () {
    var p = findProduct_(req.productId);
    if (!p.active && me.role !== 'admin') fail_('판매 중지된 상품입니다.');
    var m = applyDelta_(p, req.type === 'IN' ? qty : -qty, req.type, me, req.note, st);
    return { product: strip_(p), movement: strip_(m) };
  });
}

/** 관리자: 실사 재고로 맞추기 (ADJUST). */
function adjust_(req) {
  var me = auth_(req, 'admin');
  var target = Number(req.stock);
  if (req.stock === '' || req.stock == null || !isFinite(target)) fail_('재고 수량을 숫자로 입력하세요.');
  target = round_(target);
  return withLock_(function () {
    var p = findProduct_(req.productId);
    var delta = round_(target - p.stock);
    if (delta === 0) fail_('현재 재고와 같습니다.');
    var m = applyDelta_(p, delta, 'ADJUST', me, req.note || '재고 조정', { allowNegative: 'true' });
    return { product: strip_(p), movement: strip_(m) };
  });
}

/** 관리자: 기록 취소 → 반대 수량으로 되돌리고 CANCEL 기록을 남김. */
function cancelMovement_(req) {
  var me = auth_(req, 'admin');
  return withLock_(function () {
    var list = rows_('Movements');
    var m = null;
    for (var i = 0; i < list.length; i++) if (list[i].id === req.id) m = list[i];
    if (!m) fail_('기록을 찾을 수 없습니다.');
    if (m.canceled) fail_('이미 취소된 기록입니다.');
    if (m.type === 'CANCEL') fail_('취소 기록은 다시 취소할 수 없습니다.');
    var p = findProduct_(m.productId, true);
    if (!p) fail_('상품이 삭제되어 되돌릴 수 없습니다.');
    var c = applyDelta_(p, -m.qty, 'CANCEL', me, '취소: ' + m.time + ' ' + typeLabel_(m.type), settings_(), m.id);
    m.canceled = true;
    update_('Movements', m);
    return { product: strip_(p), movement: strip_(c) };
  });
}

/** 상품 재고를 delta 만큼 바꾸고 기록을 남김. 잠금 안에서 호출해야 함. */
function applyDelta_(p, delta, type, me, note, st, refId) {
  var before = p.stock;
  var after = round_(before + delta);
  if (after < 0 && delta < 0 && st.allowNegative !== 'true') {
    fail_('재고가 부족합니다. (현재 ' + before + (p.unit || '') + ')');
  }
  p.stock = after;
  p.updatedAt = now_();
  update_('Products', p);
  var m = {
    id: newId_('M'), time: now_(), productId: p.id, sku: p.sku, productName: productLabel_(p),
    type: type, qty: round_(delta), before: before, after: after, userId: me.id, userName: me.name,
    note: String(note || '').slice(0, 300), refId: refId || '', canceled: false,
  };
  insert_('Movements', m);
  return m;
}

// ================================================================== 상품

function saveProduct_(req) {
  var me = auth_(req, 'admin');
  var data = req.product || {};
  return withLock_(function () {
    var all = rows_('Products');
    var p;
    if (data.id) {
      p = findProduct_(data.id);
    } else {
      var st = settings_();
      p = { id: newId_('P'), stock: 0, minStock: Number(st.lowStockDefault) || 0, active: true, createdAt: now_() };
    }
    PRODUCT_FIELDS.forEach(function (f) { if (f in data) p[f] = data[f]; });
    p = normalizeProduct_(p);
    if (!p.name) fail_('상품명을 입력하세요.');
    if (p.sku && all.some(function (x) { return x.id !== p.id && x.sku.toLowerCase() === p.sku.toLowerCase(); })) {
      fail_('이미 사용 중인 상품코드(SKU)입니다: ' + p.sku);
    }
    if (p.barcode && all.some(function (x) { return x.id !== p.id && x.barcode === p.barcode; })) {
      fail_('이미 사용 중인 바코드입니다: ' + p.barcode);
    }
    p.updatedAt = now_();
    if (p._row) {
      update_('Products', p);
    } else {
      insert_('Products', p);
      var init = round_(Number(data.stock) || 0);
      if (init !== 0) applyDelta_(p, init, init > 0 ? 'IN' : 'ADJUST', me, '초기 재고', { allowNegative: 'true' });
    }
    ensureCategory_(p.category);
    return { product: strip_(p), categories: categories_() };
  });
}

function deleteProduct_(req) {
  auth_(req, 'admin');
  return withLock_(function () {
    var p = findProduct_(req.id);
    remove_('Products', p._row);
    return {};
  });
}

/** CSV 가져오기: SKU 가 같으면 수정, 없으면 추가. stock 이 있으면 그 수량으로 맞춤(기록 남김). */
function importProducts_(req) {
  var me = auth_(req, 'admin');
  var rows = req.rows || [];
  if (!rows.length) fail_('가져올 행이 없습니다.');
  if (rows.length > 5000) fail_('한 번에 5000행까지 가져올 수 있습니다.');
  return withLock_(function () {
    var st = settings_();
    var all = rows_('Products');
    var bySku = {};
    all.forEach(function (p) { if (p.sku) bySku[p.sku.toLowerCase()] = p; });
    var added = 0, updated = 0, skipped = [];
    var newRows = [], changed = [], moves = [], cats = {};
    rows.forEach(function (r, i) {
      var sku = String(r.sku || '').trim();
      var p = sku && bySku[sku.toLowerCase()];
      var isNew = !p;
      if (isNew) {
        if (!String(r.name || '').trim()) { skipped.push(i + 1); return; }
        p = { id: newId_('P'), stock: 0, minStock: Number(st.lowStockDefault) || 0, active: true, createdAt: now_() };
      }
      PRODUCT_FIELDS.forEach(function (f) {
        if (r[f] !== undefined && r[f] !== null && String(r[f]) !== '') p[f] = r[f];
      });
      p = normalizeProduct_(p);
      p.updatedAt = now_();
      var hasStock = r.stock !== undefined && r.stock !== null && String(r.stock).trim() !== '' && isFinite(Number(r.stock));
      if (hasStock) {
        var target = round_(Number(r.stock));
        var delta = round_(target - p.stock);
        if (delta !== 0) {
          moves.push({
            id: newId_('M'), time: now_(), productId: p.id, sku: p.sku, productName: productLabel_(p),
            type: isNew && delta > 0 ? 'IN' : 'ADJUST', qty: delta, before: p.stock, after: target,
            userId: me.id, userName: me.name, note: 'CSV 가져오기', refId: '', canceled: false,
          });
          p.stock = target;
        }
      }
      if (isNew) {
        newRows.push(p);
        if (p.sku) bySku[p.sku.toLowerCase()] = p;
        added++;
      } else if (newRows.indexOf(p) < 0 && changed.indexOf(p) < 0) {
        changed.push(p);
        updated++;
      }
      if (p.category) cats[p.category] = 1;
    });
    changed.forEach(function (p) { update_('Products', p); });
    insertMany_('Products', newRows);
    insertMany_('Movements', moves);
    var known = categories_();
    insertMany_('Categories', Object.keys(cats).filter(function (c) { return known.indexOf(c) < 0; })
      .map(function (c, i) { return { name: c, sort: known.length + i + 1 }; }));
    return { added: added, updated: updated, skipped: skipped, categories: categories_() };
  });
}

function findProduct_(id, optional) {
  var list = rows_('Products');
  for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
  if (optional) return null;
  fail_('상품을 찾을 수 없습니다. 목록을 새로고침하세요.');
}

function normalizeProduct_(p) {
  ['sku', 'name', 'category', 'option', 'unit', 'location', 'barcode', 'imageUrl', 'memo'].forEach(function (f) {
    p[f] = String(p[f] == null ? '' : p[f]).trim();
  });
  ['price', 'cost', 'minStock'].forEach(function (f) {
    var n = Number(String(p[f] == null ? '' : p[f]).replace(',', '.'));
    p[f] = isFinite(n) ? round_(n) : 0;
  });
  p.active = !(p.active === false || String(p.active).toUpperCase() === 'FALSE' || p.active === '0');
  return p;
}

function productLabel_(p) {
  return p.name + (p.option ? ' / ' + p.option : '');
}

// ================================================================== 사용자 관리

function users_(req) {
  auth_(req, 'admin');
  return { users: rows_('Users').map(publicUser_) };
}

function saveUser_(req) {
  var me = auth_(req, 'admin');
  var d = req.user || {};
  return withLock_(function () {
    var list = rows_('Users');
    var u;
    if (d.id) {
      u = null;
      list.forEach(function (x) { if (x.id === d.id) u = x; });
      if (!u) fail_('사용자를 찾을 수 없습니다.');
      if (d.username !== undefined) {
        var un = String(d.username).trim();
        if (!/^[A-Za-z0-9._-]{2,30}$/.test(un)) fail_('아이디는 영문/숫자 2~30자로 입력하세요.');
        u.username = un;
      }
      if (d.name !== undefined) u.name = String(d.name).trim() || u.username;
      if (d.role !== undefined) u.role = d.role === 'admin' ? 'admin' : 'user';
      if (d.active !== undefined) u.active = d.active === true || d.active === 'true';
      if (d.password) {
        checkPasswordRule_(d.password);
        u.passwordHash = hashPassword_(String(d.password));
      }
      if (u.id === me.id && (u.role !== 'admin' || !u.active)) fail_('자기 자신의 관리자 권한은 해제할 수 없습니다.');
    } else {
      u = newUser_(d, d.role);
    }
    if (list.some(function (x) { return x.id !== u.id && x.username.toLowerCase() === u.username.toLowerCase(); })) {
      fail_('이미 있는 아이디입니다: ' + u.username);
    }
    if (u._row) update_('Users', u); else insert_('Users', u);
    return { user: publicUser_(u) };
  });
}

function deleteUser_(req) {
  var me = auth_(req, 'admin');
  if (req.id === me.id) fail_('자기 자신은 삭제할 수 없습니다.');
  return withLock_(function () {
    var u = findUser_(function (x) { return x.id === req.id; });
    if (!u) fail_('사용자를 찾을 수 없습니다.');
    remove_('Users', u._row);
    return {};
  });
}

// ================================================================== 카테고리 / 설정

function categories_() {
  return rows_('Categories').sort(function (a, b) { return a.sort - b.sort; })
    .map(function (c) { return c.name; }).filter(String);
}

function ensureCategory_(name) {
  if (!name || categories_().indexOf(name) >= 0) return;
  insert_('Categories', { name: name, sort: rows_('Categories').length + 1 });
}

/** 카테고리 목록 전체 저장. items: [{ name, oldName }] — 이름이 바뀌거나 삭제되면 상품에도 반영. */
function saveCategories_(req) {
  auth_(req, 'admin');
  var items = req.items || [];
  return withLock_(function () {
    var seen = Object.create(null);
    var names = [];
    var rename = Object.create(null);
    items.forEach(function (it) {
      var n = String(it.name || '').trim();
      if (n && !seen[n]) { seen[n] = 1; names.push(n); }
      if (it.oldName && n && it.oldName !== n) rename[it.oldName] = n;
    });
    var old = categories_();
    old.forEach(function (o) { if (!(o in rename) && !seen[o]) rename[o] = ''; });
    var products = rows_('Products');
    products.forEach(function (p) {
      if (p.category in rename) {
        p.category = rename[p.category];
        p.updatedAt = now_();
        update_('Products', p);
      }
    });
    replaceAll_('Categories', names.map(function (n, i) { return { name: n, sort: i + 1 }; }));
    return { categories: names, products: products.map(strip_) };
  });
}

function settings_() {
  var out = {};
  Object.keys(DEFAULT_SETTINGS).forEach(function (k) { out[k] = DEFAULT_SETTINGS[k]; });
  rows_('Settings').forEach(function (r) {
    if (Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, r.key)) out[r.key] = r.value;
  });
  return out;
}

function saveSettings_(req) {
  auth_(req, 'admin');
  var s = req.settings || {};
  return withLock_(function () {
    var cur = settings_();
    Object.keys(DEFAULT_SETTINGS).forEach(function (k) {
      if (s[k] !== undefined) cur[k] = String(s[k]).trim().slice(0, 100);
    });
    if (!cur.shopName) cur.shopName = DEFAULT_SETTINGS.shopName;
    replaceAll_('Settings', Object.keys(cur).map(function (k) { return { key: k, value: cur[k] }; }));
    return { settings: cur };
  });
}

// ================================================================== 시트 DB 계층

function db_() {
  if (ss_) return ss_;
  var id = props_.getProperty('SHEET_ID');
  if (id) return (ss_ = SpreadsheetApp.openById(id));
  var active = null;
  try { active = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) { /* 독립 실행 스크립트 */ }
  if (active) return (ss_ = active);
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    id = props_.getProperty('SHEET_ID');
    ss_ = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.create('Inventory DB');
    props_.setProperty('SHEET_ID', ss_.getId());
  } finally {
    lock.releaseLock();
  }
  return ss_;
}

/** 탭을 열고(없으면 생성) 열 위치를 반환. 빠진 열은 자동 추가. */
function table_(name) {
  if (tables_[name]) return tables_[name];
  var schema = SCHEMA[name];
  var ss = db_();
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    var sheets = ss.getSheets();
    var blank = sheets.length === 1 && sheets[0].getLastRow() === 0 && !SCHEMA[sheets[0].getName()];
    sheet = blank ? sheets[0].setName(name) : ss.insertSheet(name);
  }
  var width = Math.max(sheet.getLastColumn(), 1);
  var header = sheet.getLastRow() > 0
    ? sheet.getRange(1, 1, 1, width).getValues()[0].map(String)
    : [];
  while (header.length && header[header.length - 1] === '') header.pop();
  var cols = {};
  header.forEach(function (h, i) { if (h) cols[h] = i; });
  schema.forEach(function (c) {
    if (c[0] in cols) return;
    header.push(c[0]);
    cols[c[0]] = header.length - 1;
    var col = header.length;
    sheet.getRange(1, col).setValue(c[0]).setFontWeight('bold');
    // 문자열 열은 텍스트 서식 (SKU "001" 이나 날짜 모양 문자열이 바뀌지 않도록)
    if (c[1] === 's') sheet.getRange(1, col, sheet.getMaxRows(), 1).setNumberFormat('@');
  });
  sheet.setFrozenRows(1);
  var types = {};
  schema.forEach(function (c) { types[c[0]] = c[1]; });
  return (tables_[name] = { sheet: sheet, header: header, cols: cols, types: types });
}

function rows_(name) {
  return readRows_(name, 0);
}

/** 마지막 n 행만 읽기 (기록이 많아도 빠르게). */
function tail_(name, n) {
  return readRows_(name, n);
}

function readRows_(name, lastN) {
  var t = table_(name);
  var last = t.sheet.getLastRow();
  if (last < 2) return [];
  var start = lastN ? Math.max(2, last - lastN + 1) : 2;
  var values = t.sheet.getRange(start, 1, last - start + 1, t.header.length).getValues();
  var out = [];
  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    if (row.every(function (v) { return v === '' || v === null; })) continue;
    var o = { _row: start + i };
    for (var key in t.types) o[key] = fromCell_(row[t.cols[key]], t.types[key]);
    out.push(o);
  }
  return out;
}

function toRow_(t, obj) {
  return t.header.map(function (h) {
    if (!(h in t.types)) return obj._extra && h in obj._extra ? obj._extra[h] : '';
    var v = obj[h];
    if (t.types[h] === 'n') return Number(v) || 0;
    if (t.types[h] === 'b') return v === true || String(v).toUpperCase() === 'TRUE';
    return v == null ? '' : String(v);
  });
}

function insert_(name, obj) {
  insertMany_(name, [obj]);
}

function insertMany_(name, list) {
  if (!list.length) return;
  var t = table_(name);
  var start = t.sheet.getLastRow() + 1;
  t.sheet.getRange(start, 1, list.length, t.header.length).setValues(list.map(function (o) { return toRow_(t, o); }));
  list.forEach(function (o, i) { o._row = start + i; });
}

function update_(name, obj) {
  var t = table_(name);
  var cur = t.sheet.getRange(obj._row, 1, 1, t.header.length).getValues()[0];
  // 스키마에 없는 열(사용자가 추가한 열)은 그대로 유지
  var extra = {};
  t.header.forEach(function (h, i) { if (!(h in t.types)) extra[h] = cur[i]; });
  obj._extra = extra;
  t.sheet.getRange(obj._row, 1, 1, t.header.length).setValues([toRow_(t, obj)]);
  delete obj._extra;
}

function remove_(name, row) {
  table_(name).sheet.deleteRow(row);
}

function replaceAll_(name, list) {
  var t = table_(name);
  var last = t.sheet.getLastRow();
  if (last > 1) t.sheet.getRange(2, 1, last - 1, t.header.length).clearContent();
  if (list.length) {
    t.sheet.getRange(2, 1, list.length, t.header.length).setValues(list.map(function (o) { return toRow_(t, o); }));
  }
}

function fromCell_(v, type) {
  if (type === 'n') return Number(v) || 0;
  if (type === 'b') return v === true || String(v).toUpperCase() === 'TRUE';
  if (v instanceof Date) return Utilities.formatDate(v, tz_(), 'yyyy-MM-dd HH:mm:ss');
  return v == null ? '' : String(v);
}

// ================================================================== 공통

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) fail_('다른 작업이 진행 중입니다. 잠시 후 다시 시도하세요.');
  try {
    var out = fn();
    SpreadsheetApp.flush();
    return out;
  } finally {
    lock.releaseLock();
  }
}

function positiveQty_(v) {
  var n = round_(Number(String(v).replace(',', '.')));
  if (!isFinite(n) || n <= 0) fail_('수량은 0보다 큰 숫자로 입력하세요.');
  return n;
}

function typeLabel_(t) {
  return { IN: '입고', OUT: '출고', ADJUST: '조정', CANCEL: '취소' }[t] || t;
}

function strip_(o) {
  var c = {};
  for (var k in o) if (k.charAt(0) !== '_') c[k] = o[k];
  return c;
}

function sum_(list, f) {
  return list.reduce(function (s, x) { return s + f(x); }, 0);
}

function round_(n) {
  return Math.round(n * 1000) / 1000;
}

function tz_() {
  return Session.getScriptTimeZone() || 'Europe/Paris';
}

function now_() {
  return Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd HH:mm:ss');
}

function newId_(prefix) {
  return prefix + Utilities.getUuid().replace(/-/g, '').slice(0, 12);
}

function fail_(message, code) {
  var e = new Error(message);
  e.userMessage = message;
  e.code = code;
  throw e;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
