// Ingredients — 재료 마스터(주문 규격·가격·거래처·보관 주소). 앱 편집 = Admin(E열) 이상, 시트에서 직접 고쳐도 됨.
//
// "Ingredients" 스프레드시트 (setup() 이 만듦, INGREDIENT_SHEET_ID):
//   Ingredients   : ID | Name | Category | Unit | Storage | Address | Count | Demand | Par | Note | Active | Added | First recipe
//                   ID = ING-001 (이름을 바꿔도 연결 유지). Unit = g / ml / pcs. Storage = Shelf / Fridge / Freezer.
//                   Address = 'A-1'(지하 선반-칸, 칸은 위에서 1) 또는 냉장고의 위치 ID('PL-07', Recipes 시트 Places 탭 — 앱은 Short 'F6' 로 보여줌). 냉동 = 주소 없음.
//                   Count = Daily / Sunday (원재료 재고 조사). Demand = Recipes + Par / Usage (주간 수요 계산 방식).
//                   Active = FALSE 면 목록에서 빠짐(지우지 않음). 새 재료는 이 앱에서만 추가 (레시피 편집기는 이 목록에서 고르기만).
//   Packs         : Ingredient ID | Ingredient | Supplier | Pack | Size | Price HT | Deposit | Usual | Supplier ref | Updated | By
//                   재료 하나에 여러 줄(거래처·규격). Size = Unit 기준 양(1 L 병 = 1000 ml). Usual = TRUE 인 줄이 기본 주문.
//                   Deposit = 규격당 병 보증금. kg 당 원가에는 넣지 않고, 주문서의 예상 facture 금액에만 더함.
//   Suppliers     : Name | Order by | Email | WhatsApp | Website | Contact | Order days | Delivery | Min order HT | Note
//                   Order by = Email / WhatsApp / Website.
//   Shelves       : Shelf | Floor | Levels | Counted by   (지하 원재료 선반. 줄 순서 = 체크 순서, Counted by = 팀 이름)
//   Price history : 가격·보증금이 바뀔 때마다 한 줄 (앱에서 저장할 때).
//   Changes       : 앱에서 바꾼 것 한 줄씩 (누가 · 무엇을 · 전 → 후).
//   Counts        : 원재료 재고 조사 한 줄씩 — At | Kind | Ingredient ID | Ingredient | Address | Before | Counted | Unit | By
//                   지금 재고 = 그 재료의 마지막 Counted. Daily 재료는 저녁 Count, Sunday 재료는 일요일 조사에 나옴(주소별 화면).
// 레시피 편집기의 재료 자동완성·이름 맞추기도 이 시트의 Ingredients 탭을 씀 (예전 Recipes 시트의 Ingredients 탭은 setup 때 옮기고 숨김).

var ING_HEAD = ['ID', 'Name', 'Category', 'Unit', 'Storage', 'Address', 'Count', 'Demand', 'Par', 'Note', 'Active', 'Added', 'First recipe'];
var PACK_HEAD = ['Ingredient ID', 'Ingredient', 'Supplier', 'Pack', 'Size', 'Price HT', 'Deposit', 'Usual', 'Supplier ref', 'Updated', 'By'];
var SUP_HEAD = ['Name', 'Order by', 'Email', 'WhatsApp', 'Website', 'Contact', 'Order days', 'Delivery', 'Min order HT', 'Note'];
var SHELF_HEAD = ['Shelf', 'Floor', 'Levels', 'Counted by'];
var PRICE_HEAD = ['At', 'Ingredient ID', 'Ingredient', 'Supplier', 'Pack', 'Old price', 'New price', 'Old deposit', 'New deposit', 'By'];
var CHANGE_HEAD = ['At', 'By', 'Ingredient ID', 'Ingredient', 'What', 'Before', 'After'];
var RAWCOUNT_HEAD = ['At', 'Kind', 'Ingredient ID', 'Ingredient', 'Address', 'Before', 'Counted', 'Unit', 'By'];
var SHELF_DEFAULT = [['A', 'Basement', 6, 'Kitchen'], ['B', 'Basement', 6, 'Kitchen'], ['C', 'Basement', 6, 'Kitchen'],
                     ['D', 'Basement', 6, 'Service'], ['E', 'Basement', 6, 'Service'], ['F', 'Basement', 6, 'Service'],
                     ['G', 'Basement', 6, 'Service']];
var ING_UNITS = ['g', 'ml', 'pcs'];
var ING_STORAGE = ['Shelf', 'Fridge', 'Freezer'];
var SUP_BY = ['Email', 'WhatsApp', 'Website'];
var SHELF_MAX_LEVELS = 12;

// ------------------------------------------------------------------ 시트

function ingBook_() {
  var id = props_.getProperty('INGREDIENT_SHEET_ID');
  if (id) return SpreadsheetApp.openById(id);
  var ss = SpreadsheetApp.create('Ingredients');
  DriveApp.getFileById(ss.getId()).moveTo(folder_());
  props_.setProperty('INGREDIENT_SHEET_ID', ss.getId());
  ss.getSheets()[0].setName('Ingredients');
  return ss;
}

/** 탭이 없으면 만들고 머리글(+ 글자 형식 열). 새로 만들었으면 true. */
function ingTab_(ss, name, head, textCols) {
  var sh = ss.getSheetByName(name), fresh = !sh;
  if (!sh) sh = ss.insertSheet(name);
  if (!sh.getRange('A1').getValue()) {
    (textCols || []).forEach(function (c) { sh.getRange(c).setNumberFormat('@'); });
    sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold');
    sh.setFrozenRows(1);
    fresh = true;
  }
  return { sh: sh, fresh: fresh };
}

/** setup / 첫 사용: 탭을 만들고, 처음이면 예전 Recipes 시트의 재료 목록(또는 레시피들의 재료)을 옮겨 옴. */
function ensureIngBook_() {
  var ss = ingBook_();
  var ing = ingTab_(ss, 'Ingredients', ING_HEAD, ['A:H', 'J:M']);
  ingTab_(ss, 'Packs', PACK_HEAD, ['A:D', 'H:K']);
  ingTab_(ss, 'Suppliers', SUP_HEAD, ['A:H', 'J:J']);
  var sh = ingTab_(ss, 'Shelves', SHELF_HEAD, ['A:B', 'D:D']);
  if (sh.fresh && sh.sh.getLastRow() < 2) sh.sh.getRange(2, 1, SHELF_DEFAULT.length, 4).setValues(SHELF_DEFAULT);
  ingTab_(ss, 'Price history', PRICE_HEAD, ['A:E', 'J:J']);
  ingTab_(ss, 'Changes', CHANGE_HEAD, ['A:G']);
  ingTab_(ss, 'Counts', RAWCOUNT_HEAD, ['A:E', 'H:I']);
  if (ing.sh.getLastRow() < 2 && !props_.getProperty('ING_MIGRATED')) ingMigrate_(ing.sh);
  return ss;
}

function ingMigrate_(sh) {
  var book = recipeBook_(), old = book.getSheetByName('Ingredients'), rows = [], seen = {};
  var add = function (name, note, added, first) {
    var n = String(name || '').replace(/\s+/g, ' ').trim(), k = ingKey_(n);
    if (!n || seen[k]) return;
    seen[k] = true;
    rows.push([ingId_(rows.length + 1), n, '', 'g', '', '', 'Sunday', 'Recipes + Par', '', String(note || ''), '', String(added || ''), String(first || '')]);
  };
  if (old && old.getLastRow() > 1) {
    old.getRange(2, 1, old.getLastRow() - 1, 4).getDisplayValues().forEach(function (r) { add(r[0], r[1], r[2], r[3]); });
  }
  var today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  recipeTabs_(book).forEach(function (t) {
    var r = parseRecipe_(t.getName(), recipeValues_(t));
    r.items.forEach(function (it) { if (it.t === 'ing' || it.t === 'base') add(it.name, '', today, r.name); });
  });
  if (rows.length) sh.getRange(2, 1, rows.length, ING_HEAD.length).setValues(rows.map(function (r) { return r.map(safeCell_); }));
  if (old && !old.isSheetHidden()) old.hideSheet();
  props_.setProperty('ING_MIGRATED', '1');
}

function ingId_(n) { return 'ING-' + ('00' + n).slice(-Math.max(3, String(n).length)); }

function ingRows_(sh, width) {
  var n = sh.getLastRow() - 1;
  if (n < 1) return [];
  return sh.getRange(2, 1, n, width).getValues().map(function (r) {
    return r.map(function (v) { return v instanceof Date ? Utilities.formatDate(v, TZ, 'yyyy-MM-dd') : typeof v === 'number' ? v : String(v == null ? '' : v).trim(); });
  });
}

function ingNum_(v) {
  var n = recipeNum_(typeof v === 'string' ? v.replace(/€/g, '') : v);
  return n === null || isNaN(n) ? null : n;
}

function readPacks_(ss) {
  return ingRows_(ss.getSheetByName('Packs'), PACK_HEAD.length).filter(function (r) { return r[0]; }).map(function (r) {
    return { ingId: String(r[0]), supplier: String(r[2]), pack: String(r[3]), size: ingNum_(r[4]), price: ingNum_(r[5]),
             deposit: ingNum_(r[6]) || 0, usual: /^(true|yes|1|★)$/i.test(String(r[7])), ref: String(r[8]) };
  });
}

/** [{ id, name, cat, unit, storage, address, count, demand, par, note, active, added, first, packs: [...] }] — 시트 순서. */
function readIngMaster_(ss) {
  var packs = {};
  readPacks_(ss).forEach(function (p) { (packs[p.ingId] = packs[p.ingId] || []).push(p); });
  return ingRows_(ss.getSheetByName('Ingredients'), ING_HEAD.length).filter(function (r) { return r[0] && r[1]; }).map(function (r, i) {
    var id = String(r[0]), list = packs[id] || [];
    if (list.length && !list.some(function (p) { return p.usual; })) list[0].usual = true;
    var unit = String(r[3]).toLowerCase(), st = ING_STORAGE.filter(function (s) { return s.toLowerCase() === String(r[4]).toLowerCase(); })[0] || '';
    return { id: id, row: i + 2, name: String(r[1]).replace(/\s+/g, ' '), cat: String(r[2]), unit: ING_UNITS.indexOf(unit) >= 0 ? unit : 'g',
             storage: st, address: st === 'Freezer' ? '' : String(r[5]).toUpperCase(),
             count: /^daily$/i.test(String(r[6])) ? 'Daily' : 'Sunday', demand: /^usage/i.test(String(r[7])) ? 'Usage' : 'Recipes + Par',
             par: ingNum_(r[8]) || 0, note: String(r[9]), active: String(r[10]).toUpperCase() !== 'FALSE', added: String(r[11]), first: String(r[12]),
             packs: list.map(function (p) { return { supplier: p.supplier, pack: p.pack, size: p.size, price: p.price, deposit: p.deposit, usual: p.usual, ref: p.ref }; }) };
  });
}

function readSuppliers_(ss) {
  return ingRows_(ss.getSheetByName('Suppliers'), SUP_HEAD.length).filter(function (r) { return r[0]; }).map(function (r) {
    var by = SUP_BY.filter(function (b) { return b.toLowerCase() === String(r[1]).toLowerCase(); })[0] || 'Email';
    return { name: String(r[0]), by: by, email: String(r[2]), whatsapp: String(r[3]), website: String(r[4]), contact: String(r[5]),
             orderDays: String(r[6]), delivery: String(r[7]), min: ingNum_(r[8]), note: String(r[9]) };
  });
}

function readShelves_(ss) {
  return ingRows_(ss.getSheetByName('Shelves'), SHELF_HEAD.length).filter(function (r) { return r[0]; }).map(function (r) {
    var lv = Math.round(ingNum_(r[2]) || 6);
    return { code: String(r[0]).toUpperCase(), floor: String(r[1]) || 'Basement', levels: Math.max(1, Math.min(SHELF_MAX_LEVELS, lv)), by: String(r[3]) || 'Kitchen' };
  });
}

/** 냉장고 = Recipes 시트 Places 탭의 Fridge (지하 먼저, 그다음 Places 순서). 주소 = 위치 ID, 화면 = Short. */
function ingFridges_() {
  var list = prodPlaces_().filter(function (p) { return p.type === 'Fridge'; });
  var base = list.filter(function (p) { return /basement/i.test(p.floor); });
  return base.concat(list.filter(function (p) { return base.indexOf(p) < 0; })).map(function (p) {
    return { code: p.id, short: p.short || p.spot, floor: p.floor, label: p.label };
  });
}

/** 체크 순서대로 모든 주소: 선반(Shelves 순서 × 칸 1→n) 다음 냉장고. */
function ingAddresses_(shelves, fridges) {
  var out = [];
  shelves.forEach(function (s) {
    for (var l = 1; l <= s.levels; l++) out.push({ code: s.code + '-' + l, kind: 'Shelf', shelf: s.code, level: l, by: s.by });
  });
  fridges.forEach(function (f) { out.push({ code: f.code, kind: 'Fridge' }); });
  return out;
}

function ingVer_(x) { return recipeVer_(x); }

// ------------------------------------------------------------------ 권한

function ingUser_(req) {
  var emp = findEmployee_(whoAmI_(req.token));
  if (!emp || !(emp.admin || emp.supervisor)) fail_('Only managers (Admin) can edit ingredients.');
  return emp;
}

// ------------------------------------------------------------------ API: 보기

function ingView_(req) {
  ingUser_(req);
  var ss = ensureIngBook_(), list = readIngMaster_(ss), suppliers = readSuppliers_(ss), shelves = readShelves_(ss), fridges = ingFridges_();
  var used = {};
  recipesAll_().recipes.forEach(function (r) {
    var seen = {};
    r.items.forEach(function (it) {
      var id = (it.t === 'ing' || it.t === 'base') && /^ING-/.test(it.code || '') && it.code;
      if (id && !seen[id]) { seen[id] = true; (used[id] = used[id] || []).push(r.name); }
    });
  });
  var teams = [];
  employees_().forEach(function (e) { if (e.team && teams.indexOf(e.team) < 0) teams.push(e.team); });
  shelves.forEach(function (s) { if (teams.indexOf(s.by) < 0) teams.push(s.by); });
  return { ok: true,
           ingredients: list.filter(function (i) { return i.active; }).map(function (i) {
             var x = JSON.parse(JSON.stringify(i));
             delete x.row;
             x.ver = ingVer_(i);
             x.used = used[i.id] || [];
             return x;
           }),
           suppliers: suppliers, suppliersVer: ingVer_(suppliers),
           shelves: shelves, shelvesVer: ingVer_(shelves), fridges: fridges, teams: teams, units: ING_UNITS };
}

// ------------------------------------------------------------------ API: 저장

function ingText_(v, max, label) { return rcpText_(v, max, label).replace(/\s+/g, ' '); }

/** 화면에서 받은 재료 → 검사된 값. */
function ingClean_(x, ctx) {
  var name = ingText_(x.name, 120, 'The name');
  if (!name) fail_('Please enter the ingredient name.');
  var unit = ING_UNITS.indexOf(String(x.unit)) >= 0 ? String(x.unit) : 'g';
  var storage = ING_STORAGE.indexOf(String(x.storage)) >= 0 ? String(x.storage) : '';
  var address = storage === 'Freezer' ? '' : String(x.address || '').toUpperCase().trim();
  if (address) {
    var a = ctx.addrs[address];
    if (!a) fail_('Unknown address “' + address + '”.');
    storage = a.kind;
  }
  var par = x.par === '' || x.par == null ? 0 : ingNum_(x.par);
  if (par === null || par < 0 || par > 10000000) fail_('Par must be a number.');
  var packs = Array.isArray(x.packs) ? x.packs : [];
  if (packs.length > 20) fail_('Too many packs (max 20).');
  var usual = -1;
  packs = packs.map(function (p, i) {
    var line = 'Pack ' + (i + 1) + ': ';
    var sup = ingText_(p.supplier, 80, line + 'the supplier');
    if (!sup) fail_(line + 'please choose the supplier.');
    if (!ctx.suppliers[sup.toLowerCase()]) fail_(line + 'unknown supplier “' + sup + '”. Add it in Suppliers first.');
    sup = ctx.suppliers[sup.toLowerCase()];
    var pack = ingText_(p.pack, 120, line + 'the pack');
    if (!pack) fail_(line + 'please describe the pack (as on the order site).');
    var size = ingNum_(p.size), price = ingNum_(p.price), dep = p.deposit === '' || p.deposit == null ? 0 : ingNum_(p.deposit);
    if (size === null || size <= 0) fail_(line + 'the size must be a number (in ' + unit + ').');
    if (price === null || price < 0) fail_(line + 'the price (HT) must be a number.');
    if (dep === null || dep < 0) fail_(line + 'the deposit must be a number (or empty).');
    if (p.usual && usual < 0) usual = i;
    return { supplier: sup, pack: pack, size: size, price: Math.round(price * 10000) / 10000, deposit: Math.round(dep * 10000) / 10000,
             usual: false, ref: ingText_(p.ref, 80, line + 'the supplier reference') };
  });
  if (packs.length) packs[usual < 0 ? 0 : usual].usual = true;
  return { name: name, cat: ingText_(x.cat, 60, 'The category'), unit: unit, storage: storage, address: address,
           count: x.count === 'Daily' ? 'Daily' : 'Sunday', demand: x.demand === 'Usage' ? 'Usage' : 'Recipes + Par',
           par: par, note: ingText_(x.note, 200, 'The note'), packs: packs };
}

function ingCtx_(ss) {
  var addrs = {}, sups = {};
  ingAddresses_(readShelves_(ss), ingFridges_()).forEach(function (a) { addrs[a.code] = a; });
  readSuppliers_(ss).forEach(function (s) { sups[s.name.toLowerCase()] = s.name; });
  return { addrs: addrs, suppliers: sups };
}

function ingRow_(id, c, old) {
  return [id, c.name, c.cat, c.unit, c.storage, c.address, c.count, c.demand, c.par, c.note, '',
          old ? old.added : Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'), old ? old.first : ''];
}

function ingLog_(ss, emp, id, name, changes) {
  if (!changes.length) return;
  var at = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm');
  appendRows_(ss.getSheetByName('Changes'), changes.map(function (c) { return [at, emp.name, id, name, c[0], String(c[1]), String(c[2])]; }));
}

function packText_(p) {
  return p.supplier + ' · ' + p.pack + ' · ' + p.size + ' · ' + p.price + ' €' + (p.deposit ? ' + ' + p.deposit + ' € deposit' : '') + (p.usual ? ' ★' : '');
}

/** 새 재료(id 없음) 또는 수정(id + ver). 이름을 바꾸면 그 재료를 쓰는 레시피 탭도 같이 고침. */
function ingSave_(req) {
  var emp = ingUser_(req);
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  var out;
  try {
    var ss = ensureIngBook_(), all = readIngMaster_(ss), c = ingClean_(req.ingredient || {}, ingCtx_(ss));
    var old = req.id ? all.filter(function (i) { return i.id === String(req.id); })[0] : null;
    if (req.id && !old) fail_('This ingredient was removed. Please go back to the list.', 'CHANGED');
    if (old && String(req.ver || '') !== ingVer_(old)) {
      fail_('This ingredient was changed (maybe by someone else or in the sheet) after you opened it. Please open it again.', 'CHANGED');
    }
    var clash = all.filter(function (i) { return i !== old && i.active && ingKey_(i.name) === ingKey_(c.name); })[0];
    if (clash) fail_('“' + clash.name + '” already exists (' + clash.id + ').');
    var sh = ss.getSheetByName('Ingredients'), id, changes = [];
    if (old) {
      id = old.id;
      [['Name', 'name'], ['Category', 'cat'], ['Unit', 'unit'], ['Storage', 'storage'], ['Address', 'address'], ['Count', 'count'],
       ['Demand', 'demand'], ['Par', 'par'], ['Note', 'note']].forEach(function (f) {
        if (String(old[f[1]]) !== String(c[f[1]])) changes.push([f[0], old[f[1]], c[f[1]]]);
      });
      sh.getRange(old.row, 1, 1, ING_HEAD.length).setValues([ingRow_(id, c, old).map(safeCell_)]);
    } else {
      var max = 0;
      all.forEach(function (i) { var m = /^ING-(\d+)$/.exec(i.id); if (m) max = Math.max(max, +m[1]); });
      id = ingId_(max + 1);
      appendRows_(sh, [ingRow_(id, c, null)]);
      changes.push(['Created', '', c.name]);
    }
    var oldPacks = old ? old.packs : [];
    var before = oldPacks.map(packText_).join('\n'), after = c.packs.map(packText_).join('\n');
    if (before !== after) {
      changes.push(['Packs', before, after]);
      ingWritePacks_(ss, id, c, emp);
      var at = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm'), hist = [];
      c.packs.forEach(function (p) {
        var o = oldPacks.filter(function (q) { return q.supplier === p.supplier && q.pack === p.pack; })[0];
        if (!o || o.price !== p.price || (o.deposit || 0) !== p.deposit) {
          hist.push([at, id, c.name, p.supplier, p.pack, o ? o.price : '', p.price, o ? o.deposit || 0 : '', p.deposit, emp.name]);
        }
      });
      appendRows_(ss.getSheetByName('Price history'), hist);
    }
    ingLog_(ss, emp, id, c.name, changes);
    var renamed = old && old.name !== c.name ? codeRenameInRecipes_(id, c.name) : [];
    SpreadsheetApp.flush();
    bumpRecipes_();
    out = { ok: true, id: id, renamedIn: renamed };
  } finally {
    lock.releaseLock();
  }
  var view = ingView_(req);
  out.ingredient = view.ingredients.filter(function (i) { return i.id === out.id; })[0];
  return out;
}

function ingWritePacks_(ss, id, c, emp) {
  var sh = ss.getSheetByName('Packs'), rows = ingRows_(sh, PACK_HEAD.length).filter(function (r) { return r[0] && String(r[0]) !== id; });
  var today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  c.packs.forEach(function (p) {
    rows.push([id, c.name, p.supplier, p.pack, p.size, p.price, p.deposit || '', p.usual ? 'TRUE' : '', p.ref, today, emp.name]);
  });
  // 같은 재료 이름 칸도 최신으로 (시트에서 읽기 쉽게)
  rows.forEach(function (r) { if (String(r[0]) === id) r[1] = c.name; });
  sh.clearContents();
  sh.getRange(1, 1, rows.length + 1, PACK_HEAD.length).setValues([PACK_HEAD].concat(rows.map(function (r) { return r.map(safeCell_); })));
  sh.getRange(1, 1, 1, PACK_HEAD.length).setFontWeight('bold');
}

/** 주소 그림에서 끌어 놓기: 보관·주소만 바꿈. address = 'A-1' / 'F6' / 'FREEZER' / '' (주소 없음). */
function ingMove_(req) {
  var emp = ingUser_(req);
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var ss = ensureIngBook_(), i = readIngMaster_(ss).filter(function (x) { return x.id === String(req.id); })[0];
    if (!i) fail_('Ingredient not found.', 'CHANGED');
    var code = String(req.address || '').toUpperCase().trim(), storage = i.storage, address = '';
    if (code === 'FREEZER') storage = 'Freezer';
    else if (code) {
      var a = ingCtx_(ss).addrs[code];
      if (!a) fail_('Unknown address “' + code + '”.');
      storage = a.kind;
      address = code;
    } else if (storage === 'Freezer') storage = '';
    var sh = ss.getSheetByName('Ingredients');
    sh.getRange(i.row, 5, 1, 2).setValues([[storage, address]]);
    var ch = [];
    if (storage !== i.storage) ch.push(['Storage', i.storage, storage]);
    if (address !== i.address) ch.push(['Address', i.address, address]);
    ingLog_(ss, emp, i.id, i.name, ch);
  } finally {
    lock.releaseLock();
  }
  return { ok: true, storage: storage, address: address };
}

/** 앱에서 지우기 = Active FALSE (시트 행은 남음, 레시피는 그대로). */
function ingRemove_(req) {
  var emp = ingUser_(req);
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var ss = ensureIngBook_(), i = readIngMaster_(ss).filter(function (x) { return x.id === String(req.id); })[0];
    if (!i) fail_('Ingredient not found.');
    ss.getSheetByName('Ingredients').getRange(i.row, 11).setValue('FALSE');
    ingLog_(ss, emp, i.id, i.name, [['Removed', '', '']]);
    bumpRecipes_();
  } finally {
    lock.releaseLock();
  }
  return { ok: true };
}

/** 거래처 목록 전체 저장. 이름을 바꾸면(was) Packs 의 거래처 이름도 바꿈. 쓰는 재료가 있는 거래처는 지울 수 없음. */
function supSave_(req) {
  var emp = ingUser_(req);
  var list = Array.isArray(req.suppliers) ? req.suppliers : [], seen = {};
  if (list.length > 100) fail_('Too many suppliers (max 100).');
  var clean = list.map(function (s, i) {
    var name = ingText_(s.name, 80, 'Supplier ' + (i + 1) + ' name');
    if (!name) fail_('Supplier ' + (i + 1) + ': please enter a name.');
    if (seen[name.toLowerCase()]) fail_('Two suppliers are called “' + name + '”.');
    seen[name.toLowerCase()] = true;
    var min = s.min === '' || s.min == null ? '' : ingNum_(s.min);
    if (min === null || min < 0) fail_(name + ': minimum order must be a number.');
    return { was: ingText_(s.was, 80, 'Name'), row: [name, SUP_BY.indexOf(s.by) >= 0 ? s.by : 'Email', ingText_(s.email, 120, name + ' email'),
             ingText_(s.whatsapp, 40, name + ' WhatsApp'), ingText_(s.website, 300, name + ' website'), ingText_(s.contact, 120, name + ' contact'),
             ingText_(s.orderDays, 120, name + ' order days'), ingText_(s.delivery, 120, name + ' delivery'), min, ingText_(s.note, 300, name + ' note')] };
  });
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var ss = ensureIngBook_(), now = readSuppliers_(ss);
    if (String(req.ver || '') !== ingVer_(now)) fail_('The supplier list was changed after you opened it. Please open it again.', 'CHANGED');
    var rename = {}, kept = {};
    clean.forEach(function (s) { if (s.was) { kept[s.was] = true; if (s.was !== s.row[0]) rename[s.was] = s.row[0]; } });
    var packs = ss.getSheetByName('Packs'), prow = ingRows_(packs, PACK_HEAD.length);
    now.forEach(function (s) {
      if (kept[s.name]) return;
      var users = prow.filter(function (r) { return r[0] && String(r[2]) === s.name; });
      if (users.length) fail_('“' + s.name + '” is used by ' + users.length + ' pack(s) (e.g. ' + users[0][1] + '). Change those packs first.');
    });
    prow.forEach(function (r, i) {
      if (rename[r[2]]) packs.getRange(i + 2, 3).setValue(safeCell_(rename[r[2]]));
    });
    var sh = ss.getSheetByName('Suppliers');
    sh.clearContents();
    sh.getRange(1, 1, clean.length + 1, SUP_HEAD.length).setValues([SUP_HEAD].concat(clean.map(function (s) { return s.row.map(safeCell_); })));
    sh.getRange(1, 1, 1, SUP_HEAD.length).setFontWeight('bold');
    var ch = [];
    Object.keys(rename).forEach(function (k) { ch.push(['Supplier renamed', k, rename[k]]); });
    ingLog_(ss, emp, '', '', ch);
  } finally {
    lock.releaseLock();
  }
  var v = ingView_(req);
  return { ok: true, suppliers: v.suppliers, suppliersVer: v.suppliersVer };
}

/** 선반 하나의 칸 수 또는 조사 담당 팀 바꾸기. 줄일 때 없어지는 칸에 재료가 있으면 거절. */
function shelfSave_(req) {
  var emp = ingUser_(req);
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var ss = ensureIngBook_(), shelves = readShelves_(ss), code = String(req.shelf || '').toUpperCase();
    var idx = -1;
    shelves.forEach(function (s, i) { if (s.code === code) idx = i; });
    if (idx < 0) fail_('Shelf not found.', 'CHANGED');
    var s = shelves[idx], ch = [];
    if (req.levels != null) {
      var lv = Math.round(Number(req.levels));
      if (!(lv >= 1 && lv <= SHELF_MAX_LEVELS)) fail_('A shelf has 1 to ' + SHELF_MAX_LEVELS + ' levels.');
      if (lv < s.levels) {
        var gone = readIngMaster_(ss).filter(function (i) {
          var m = /^([A-Z0-9]+)-(\d+)$/.exec(i.address);
          return i.active && m && m[1] === code && +m[2] > lv;
        });
        if (gone.length) fail_(code + '-' + (lv + 1) + ' is not empty (' + gone[0].name + '). Move its items first.');
      }
      if (lv !== s.levels) ch.push(['Shelf ' + code + ' levels', s.levels, lv]);
      s.levels = lv;
    }
    if (req.by != null) {
      var by = ingText_(req.by, 60, 'The team');
      if (!by) fail_('Please choose a team.');
      if (by !== s.by) ch.push(['Shelf ' + code + ' counted by', s.by, by]);
      s.by = by;
    }
    ss.getSheetByName('Shelves').getRange(idx + 2, 3, 1, 2).setValues([[s.levels, safeCell_(s.by)]]);
    ingLog_(ss, emp, '', '', ch);
  } finally {
    lock.releaseLock();
  }
  return { ok: true, shelf: s };
}

// ------------------------------------------------------------------ 레시피 편집기와 연결

// ------------------------------------------------------------------ 원재료 재고 (주소별 조사)

/** 재료마다 마지막으로 센 양. { ING-001: { qty, at, address } } */
function rawStock_(ss) {
  ss = ss || ensureIngBook_();
  var sh = ss.getSheetByName('Counts') || ingTab_(ss, 'Counts', RAWCOUNT_HEAD, ['A:E', 'H:I']).sh, last = sh.getLastRow(), out = {};
  if (last < 2) return out;
  var n = Math.min(last - 1, 3000);
  sh.getRange(last - n + 1, 1, n, RAWCOUNT_HEAD.length).getValues().forEach(function (r) {
    var id = String(r[2]).trim(), q = ingNum_(r[6]);
    if (id && q !== null) out[id] = { qty: q, at: String(r[0]), address: String(r[4]) };
  });
  return out;
}

/**
 * 조사 화면에 넣을 원재료. kind = 'daily' (Count 가 Daily 인 재료) / 'sunday' (나머지).
 * → [{ placeId(냉장고면 위치 ID) | shelf(선반 글자) | freezer, title, short, items: [{ id, name, unit, address, before }] }]
 *   냉장고 재료는 그 냉장고 화면에 합쳐지고, 선반은 선반 하나 = 화면 하나(칸 순서), 냉동 재료는 'Freezer items' 한 화면.
 */
function rawCountScreens_(kind) {
  var ss = ensureIngBook_(), stock = rawStock_(ss), shelves = readShelves_(ss), fr = {}, out = [];
  ingFridges_().forEach(function (f) { fr[f.code] = f; });
  var list = readIngMaster_(ss).filter(function (i) { return i.active && (kind === 'daily' ? i.count === 'Daily' : i.count !== 'Daily'); });
  var item = function (i) { return { id: i.id, name: i.name, unit: i.unit, address: i.address, short: fr[i.address] ? fr[i.address].short : i.address,
                                     before: stock[i.id] ? stock[i.id].qty : null }; };
  var byFridge = {};
  list.forEach(function (i) { if (i.storage !== 'Freezer' && fr[i.address]) (byFridge[i.address] = byFridge[i.address] || []).push(item(i)); });
  Object.keys(byFridge).forEach(function (id) { out.push({ placeId: id, title: fr[id].label, short: fr[id].short, items: byFridge[id] }); });
  shelves.forEach(function (sh) {
    var items = list.filter(function (i) { var m = /^([A-Z0-9]+)-(\d+)$/.exec(i.address); return i.storage !== 'Freezer' && m && m[1] === sh.code && !fr[i.address]; })
      .sort(function (a, b) { return +a.address.split('-')[1] - +b.address.split('-')[1] || (a.name < b.name ? -1 : 1); }).map(item);
    if (items.length) out.push({ shelf: sh.code, title: sh.floor + ' · Shelf ' + sh.code, short: sh.code, by: sh.by, items: items });
  });
  var frozen = list.filter(function (i) { return i.storage === 'Freezer'; }).map(item);
  if (frozen.length) out.push({ freezer: true, title: 'Freezer items', short: 'Frz', items: frozen });
  return out;
}

/** 조사 저장의 원재료 부분: raw = [{ id, qty }] (화면에 나온 줄 모두). Counts 탭에 한 줄씩. */
function rawCountSave_(raw, kind, emp) {
  if (!Array.isArray(raw) || !raw.length) return 0;
  var ss = ensureIngBook_(), all = {}, stock = rawStock_(ss), at = nowMinParis_(), rows = [];
  readIngMaster_(ss).forEach(function (i) { all[i.id] = i; });
  raw.forEach(function (x) {
    var i = all[String(x.id || '')];
    if (!i) fail_('Unknown ingredient: ' + x.id);
    var q = ingNum_(x.qty);
    if (q === null || q < 0 || q > 10000000) fail_(i.name + ': please enter a number (' + i.unit + ').');
    q = Math.round(q * 10) / 10;
    rows.push([at, kind === 'sunday' ? 'Sunday' : 'Daily', i.id, i.name, i.address, stock[i.id] ? stock[i.id].qty : '', q, i.unit, emp.name]);
  });
  appendRows_(ss.getSheetByName('Counts'), rows);
  return rows.length;
}

/** setup: 예전 주소(냉장고 Short 'F6')를 위치 ID('PL-07')로. 여러 번 실행해도 안전. */
function ingAddressesToIds_() {
  var ss = ensureIngBook_(), sh = ss.getSheetByName('Ingredients'), byShort = {}, n = 0;
  ingFridges_().forEach(function (f) { byShort[String(f.short).toUpperCase()] = f.code; });
  readIngMaster_(ss).forEach(function (i) {
    var to = byShort[i.address];
    if (to && to !== i.address) { sh.getRange(i.row, 6).setValue(to); n++; }
  });
  return n;
}

/** 편집기에서 실행: 재료 수, 규격이 없는 재료, 주소가 없는 재료, 모르는 주소·거래처를 실행 로그에. */
function checkIngredients() {
  var ss = ensureIngBook_(), list = readIngMaster_(ss).filter(function (i) { return i.active; }), ctx = ingCtx_(ss);
  Logger.log('Ingredients: ' + list.length + ' · Suppliers: ' + readSuppliers_(ss).length + ' · Shelves: ' +
             readShelves_(ss).map(function (s) { return s.code + '(' + s.levels + ', ' + s.by + ')'; }).join(' '));
  list.forEach(function (i) {
    var w = [];
    if (!i.packs.length) w.push('no pack');
    if (i.storage !== 'Freezer' && !i.address) w.push('no address');
    if (i.address && !ctx.addrs[i.address]) w.push('unknown address ' + i.address);
    i.packs.forEach(function (p) { if (!ctx.suppliers[p.supplier.toLowerCase()]) w.push('unknown supplier ' + p.supplier); });
    if (w.length) Logger.log('CHECK ' + i.id + ' ' + i.name + ': ' + w.join(', '));
  });
  return list.length;
}
