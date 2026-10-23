// Recipes — 레시피 조회(Kitchen 팀 + Supervisor) · 편집(Supervisor, 앱 또는 시트) · Production log
//
// "Recipes" 스프레드시트 (setup() 이 만듦, RECIPE_SHEET_ID):
//   레시피마다 탭 1개. 1행 = 머리글, 2행부터 A열 종류대로 위에서 아래로 화면에 그려짐:
//     A Kind | B Name / text | C Amount | D Unit / note | E Code
//     RECIPE   이름
//     ID       레시피 코드 RCP-001 (자동. 이름을 바꿔도 메뉴·홈메이드 연결 유지)
//     MODE     Fixed (정량: C = g) / Percent (비율: C = 기준 재료 총중량 대비 %)
//     CATEGORY 분류 (목록의 칩)
//     ING      재료 이름 | 양(g 또는 %) | D 에 g/% 외의 글자 = 작은 메모 | E = 코드 ING-001 (홈메이드면 RCP-001)
//     BASE     (Percent 전용) 기준 재료. 실제로 잰 무게를 앱에서 입력, 여러 개면 합계 = 100% | E = 코드
//              재료는 Ingredients 목록(또는 다른 레시피)에 있는 것만. 이름은 코드로 찾아 늘 지금 이름으로 보임.
//     STEP     과정 설명
//     PHOTO    'Recipe Photos' 폴더의 파일 이름 | | D = 사진 설명
//     BOX      기본 보관 박스 이름 (Boxes 탭의 Name) | | | E = 박스 ID (BOX-01)
//     FILL     | 박스 하나에 들어가는 대략 g (예상 박스 수 계산용)
//     KEEP     보관 조건 | 보관 일수 (사용기한 = 만든 날 + 일수)
//     PLACE    기본 저장 위치 (Places 탭의 이름, 예: 'Ground floor · Fridge 4') | | | E = 위치 ID (PL-01)
//     COUNTIN  재고를 세는 단위: Boxes (기본, 줄 없음) / Pieces / Grams
//     COUNT    재고 조사: Daily (매일 저녁, 기본) / Sunday (일요일 조사만) / Not stored (바로 쓰고 재고로 두지 않음)
//     YIELD    메모(예: after straining) | 완성 무게 = 재료 총무게의 % (끓이고 거르면 < 100, 밥처럼 불면 > 100)
//   재료 줄의 코드가 RCP- 면(홈메이드) 앱에서 그 재료를 눌러 그 레시피로 감.
//   재료가 하나도 없는 레시피 = 'To write' (메뉴 편집기에서 "레시피 필요"로 만든 빈 레시피). 매일 09:00 Supervisor 에게 알림.
//   'Boxes' 탭: Name | Capacity | Photo | Note | ID  (박스 목록. 앱에서는 용량 + 작은 사진. ID 자동)
//   'Places' 탭: 저장 위치 목록 (Stock.gs 참고)
//   재료 목록 = 별도 'Ingredients' 스프레드시트 (Ingredients.gs). 새 재료는 그 앱(Manager › Ingredients)에서만 추가
//     (같은 재료가 여러 이름으로 갈라지지 않도록). 레시피 저장 때 목록에 없는 이름은 거절.
//     예전 이 시트의 'Ingredients' 탭은 setup 때 옮기고 숨김.
//   'How to' 탭과 이름이 _ 로 시작하는 탭, 숨긴 탭은 레시피가 아님 (앱에서 지운 레시피 = 숨긴 탭, 숨김 해제로 복구).
// "Production Log" 스프레드시트 (PROD_SHEET_ID): 프렙 입고 기록·재고·재고 조사 — Stock.gs.
// 보는 사람 = Employees F열 Team 이 RECIPE_TEAMS(스크립트 속성, 기본 'Kitchen', 쉼표로 여러 팀)인 직원 + Supervisor.
// 수정 = Supervisor 만. Made by 를 다른 사람으로 = Admin 또는 Supervisor.

var RECIPE_HEAD = ['Kind', 'Name / text', 'Amount', 'Unit / note', 'Code'];
var BOX_HEAD = ['Name', 'Capacity', 'Photo', 'Note', 'ID'];
var RECIPE_COLS = 5;
var RECIPE_SKIP_TAB = /^(boxes|places|ingredients|how to|_.*)$/i;
var RECIPE_CACHE_SEC = 60;       // 시트에서 직접 고친 것은 최대 1분 뒤 앱에 보임 (앱에서 고친 것은 바로)
var RECIPE_MAX_ITEMS = 300;

// ------------------------------------------------------------------ setup

function ensureRecipes_() {
  var ss = recipeBook_();
  if (!ss.getSheetByName('Boxes')) {
    var bx = ss.insertSheet('Boxes');
    bx.getRange(1, 1, 1, BOX_HEAD.length).setValues([BOX_HEAD]).setFontWeight('bold');
    bx.setFrozenRows(1);
  }
  if (!ss.getSheetByName('How to')) {
    var h = ss.insertSheet('How to');
    var lines = [
      ['One tab per recipe. Row 1 = header, then one line per row (A = kind). The app shows them top to bottom.'],
      ['RECIPE | name                          ID | RCP-001 (added by the app; never change it)'],
      ['MODE | Fixed or Percent            CATEGORY | e.g. Sauce'],
      ['ING | ingredient | amount (g, or % in a Percent recipe) | optional note | code (ING-001, or RCP-001 for a homemade one)'],
      ['Ingredients must be in the Ingredients list (add new ones in the app: Manager › Ingredients).'],
      ['BASE | base ingredient (Percent only; weighed at prep time; several BASE rows = their total is 100%)'],
      ['STEP | what to do                    PHOTO | file name in the Recipe Photos folder | | caption'],
      ['BOX | box name from the Boxes tab    FILL | | grams per box    KEEP | storage | days'],
      ['PLACE | usual place (name from the Places tab)    COUNT | Daily (default), Sunday or Not stored'],
      ['COUNTIN | Boxes (default), Pieces or Grams = how the stock is counted'],
      ['YIELD | note (e.g. after straining) | finished weight as % of the raw total (e.g. 60)'],
      ['An ingredient line whose code is another recipe (RCP-…) is homemade: the app opens that recipe.'],
      ['Hidden tabs, this tab, the Boxes and Places tabs and tabs starting with _ are not recipes.'],
    ];
    h.getRange(1, 1, lines.length, 1).setValues(lines);
  }
  recipePhotoFolder_();
  ensurePlaces_(ss);
  ensureIngredients_();
  prodSheet_();
  return ss;
}

function recipeBook_() {
  var id = props_.getProperty('RECIPE_SHEET_ID');
  if (id) return SpreadsheetApp.openById(id);
  var ss = SpreadsheetApp.create('Recipes');
  DriveApp.getFileById(ss.getId()).moveTo(folder_());
  props_.setProperty('RECIPE_SHEET_ID', ss.getId());
  ss.getSheets()[0].setName('Boxes').getRange(1, 1, 1, BOX_HEAD.length).setValues([BOX_HEAD]).setFontWeight('bold');
  ss.getSheets()[0].setFrozenRows(1);
  return ss;
}

function recipePhotoFolder_() {
  var id = props_.getProperty('RECIPE_PHOTO_FOLDER_ID');
  if (id) return DriveApp.getFolderById(id);
  var f = folder_().createFolder('Recipe Photos');
  props_.setProperty('RECIPE_PHOTO_FOLDER_ID', f.getId());
  return f;
}

// ------------------------------------------------------------------ 권한

function recipeTeams_() {
  return String(props_.getProperty('RECIPE_TEAMS') || 'Kitchen').split(',')
    .map(function (t) { return t.trim().toLowerCase(); }).filter(String);
}

function canSeeRecipes_(emp) {
  return !!emp && (emp.supervisor || recipeTeams_().indexOf(String(emp.team).toLowerCase()) >= 0);
}

/** 홈 화면 Recipes 아이콘 (문제가 생겨도 메인 화면을 막지 않도록). */
function safeCanSeeRecipes_(name) {
  try {
    return canSeeRecipes_(findEmployee_(name));
  } catch (err) {
    console.error(err);
    return false;
  }
}

function recipeUser_(req) {
  var emp = findEmployee_(whoAmI_(req.token));
  if (!canSeeRecipes_(emp)) fail_('Recipes are for the kitchen team.');
  return emp;
}

function recipeEditor_(req) {
  var emp = recipeUser_(req);
  if (!emp.supervisor) fail_('Only the supervisor can edit recipes.');
  return emp;
}

// ------------------------------------------------------------------ 읽기 (시트 → 레시피)

/** '1 000', '1,5', '4%', '250 g' → 숫자. 빈칸 = null, 읽을 수 없음 = NaN. */
function recipeNum_(v) {
  if (typeof v === 'number') return v;
  var s = String(v == null ? '' : v).replace(/[\s  ]/g, '').replace(/(g|%)$/i, '');
  if (s === '') return null;
  s = /^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
  var n = Number(s);
  return isFinite(n) ? n : NaN;
}

/** 탭의 행 → { name, mode, cat, items: [{t: ing|base|step|photo, …}], box, fill, keepNote, keepDays, warnings }. */
function parseRecipe_(tab, rows) {
  var r = { name: '', code: '', mode: 'fixed', cat: '', items: [], box: '', boxId: '', fill: null, keepNote: '', keepDays: null, place: '', placeId: '',
           count: 'daily', countUnit: 'box', yieldPct: null, yieldNote: '', warnings: [] };
  var warn = function (i, msg) { r.warnings.push('Row ' + (i + 1) + ': ' + msg); };
  rows.forEach(function (row, i) {
    var k = String(row[0] == null ? '' : row[0]).trim().toUpperCase();
    var b = String(row[1] == null ? '' : row[1]).trim(), d = String(row[3] == null ? '' : row[3]).trim();
    var code = String(row[4] == null ? '' : row[4]).trim().toUpperCase();
    if (!k || (i === 0 && k === 'KIND')) return;
    var n = recipeNum_(row[2]);
    if (k === 'RECIPE') r.name = b;
    else if (k === 'ID') r.code = b.toUpperCase();
    else if (k === 'COUNTIN') r.countUnit = /^p/i.test(b) ? 'pcs' : /^g/i.test(b) ? 'g' : 'box';
    else if (k === 'MODE') {
      if (!/^(fixed|percent|%)$/i.test(b)) warn(i, 'MODE must be Fixed or Percent.');
      r.mode = /^(p|%)/i.test(b) ? 'percent' : 'fixed';
    } else if (k === 'CATEGORY') r.cat = b;
    else if (k === 'ING' || k === 'BASE') {
      if (!b) { warn(i, k + ' without a name.'); return; }
      var it = { t: k === 'BASE' ? 'base' : 'ing', name: b, code: code };
      if (k === 'ING') {
        if (n === null || isNaN(n) || n < 0) { warn(i, '“' + b + '” has no valid amount.'); n = 0; }
        it.q = n;
      }
      if (d && !/^(g|%|grams?)$/i.test(d)) it.note = d;
      r.items.push(it);
    } else if (k === 'STEP') {
      if (b) r.items.push({ t: 'step', text: b });
    } else if (k === 'PHOTO') {
      if (b) r.items.push({ t: 'photo', file: b, cap: d });
    } else if (k === 'BOX') { r.box = b; r.boxId = code; }
    else if (k === 'FILL') {
      if (n === null || isNaN(n) || n <= 0) warn(i, 'FILL needs the grams per box in column C.');
      else r.fill = n;
    } else if (k === 'KEEP') {
      r.keepNote = b;
      if (n !== null && (isNaN(n) || n < 0)) warn(i, 'KEEP days must be a number.');
      else if (n !== null) r.keepDays = Math.round(n);
    } else if (k === 'PLACE') {
      var pl = (code && prodPlaceById_(code)) || prodPlace_(b);
      if (pl) { r.place = pl.label; r.placeId = pl.id; }
      else if (b) warn(i, 'Unknown place “' + b + '”. Use a name from the app, e.g. “Ground floor · Fridge 4”.');
    } else if (k === 'YIELD') {
      if (n === null || isNaN(n) || n <= 0 || n > 1000) warn(i, 'YIELD needs the finished weight as % of the raw total in column C (e.g. 60).');
      else { r.yieldPct = Math.round(n * 10) / 10; r.yieldNote = b; }
    } else if (k === 'COUNT') {
      if (!/^(daily|sunday|weekly|not stored|none)$/i.test(b)) warn(i, 'COUNT must be Daily, Sunday or Not stored.');
      r.count = /^(sunday|weekly)$/i.test(b) ? 'sunday' : /^(not stored|none)$/i.test(b) ? 'none' : 'daily';
    } else warn(i, 'Unknown kind “' + k + '”.');
  });
  if (!r.name) r.name = tab;
  var bases = r.items.filter(function (x) { return x.t === 'base'; }).length;
  if (r.mode === 'percent' && !bases) r.warnings.push('Percent recipe without a BASE row: add the ingredient the % are based on.');
  if (r.mode === 'fixed' && bases) {
    r.warnings.push('BASE rows only work in a Percent recipe. They are shown as ingredients without an amount.');
  }
  return r;
}

function recipeVer_(values) {
  return bytesToHex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, utf8_(JSON.stringify(values)))).slice(0, 16);
}

function recipeValues_(sh) {
  var last = sh.getLastRow();
  return last ? sh.getRange(1, 1, last, RECIPE_COLS).getValues().map(function (r) {
    return r.map(function (v) { return typeof v === 'number' ? v : String(v); });
  }) : [];
}

function recipeTabs_(ss) {
  return ss.getSheets().filter(function (sh) { return !RECIPE_SKIP_TAB.test(sh.getName().trim()) && !sh.isSheetHidden(); });
}

function readBoxes_(ss) {
  var sh = ss.getSheetByName('Boxes');
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, BOX_HEAD.length).getDisplayValues()
    .map(function (r) { return { name: String(r[0]).trim(), capacity: String(r[1]).trim(), photo: String(r[2]).trim(), note: String(r[3]).trim(),
                                 id: String(r[4]).trim().toUpperCase() }; })
    .filter(function (b) { return b.name; });
}

/** 박스 ID 가 빈 줄에 BOX-01 … 을 붙임 (시트에서 직접 추가한 박스). 바꿨으면 true. */
function ensureBoxIds_(ss) {
  var sh = ss.getSheetByName('Boxes');
  if (!sh) return false;
  if (sh.getRange(1, 5).getValue() !== 'ID') sh.getRange(1, 5).setValue('ID').setFontWeight('bold');
  if (sh.getLastRow() < 2) return false;
  var rows = sh.getRange(2, 1, sh.getLastRow() - 1, 5).getDisplayValues(), max = 0, changed = false;
  rows.forEach(function (r) { var m = /^BOX-(\d+)$/i.exec(String(r[4]).trim()); if (m) max = Math.max(max, +m[1]); });
  rows.forEach(function (r, i) {
    if (String(r[0]).trim() && !String(r[4]).trim()) { sh.getRange(i + 2, 5).setValue(codeOf_('BOX', ++max, 2)); changed = true; }
  });
  return changed;
}

/** 'RCP', 7, 3 → 'RCP-007'. */
function codeOf_(kind, n, width) {
  var s = String(n);
  while (s.length < (width || 3)) s = '0' + s;
  return kind + '-' + s;
}

/** 재료 이름 비교용: 대소문자·앞뒤/겹친 띄어쓰기·악센트 무시 (Crème = creme). */
function ingKey_(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** 재료 목록은 별도 'Ingredients' 스프레드시트 (Ingredients.gs). 처음이면 만들고 예전 탭을 옮김. */
function ensureIngredients_() {
  ensureIngBook_();
}

/** 재료 코드 → { name, unit, active } (지운 재료도 — 예전 레시피의 이름을 보여주려고). */
function ingCodeMap_() {
  var out = {};
  readIngMaster_(ensureIngBook_()).forEach(function (i) { out[i.id] = { name: i.name, unit: i.unit, active: i.active }; });
  return out;
}

/** { recipes: [...], boxes: [...], boxesVer } — 캐시(앱에서 고치면 RCP_VER 이 바뀌어 바로 새로 읽음). */
function recipesAll_() {
  var key = 'rcp_all_' + (props_.getProperty('RCP_VER') || '0'), cache = CacheService.getScriptCache();
  var hit = cache.get(key);
  if (hit) return JSON.parse(hit);
  var ss = recipeBook_(), ingMap = ingCodeMap_();
  if (ensureBoxIds_(ss)) SpreadsheetApp.flush();
  var out = { recipes: [], boxes: readBoxes_(ss), ingredients: [] };
  Object.keys(ingMap).forEach(function (c) { if (ingMap[c].active) out.ingredients.push({ code: c, name: ingMap[c].name, unit: ingMap[c].unit }); });
  out.boxesVer = recipeVer_(out.boxes);
  var tabs = recipeTabs_(ss), parsed = tabs.map(function (sh) { var v = recipeValues_(sh); return { sh: sh, v: v, r: parseRecipe_(sh.getName(), v) }; });
  // 코드가 없는 레시피(시트에서 새로 만든 탭)에 RCP 코드를 붙임
  var max = 0;
  parsed.forEach(function (x) { var m = /^RCP-(\d+)$/.exec(x.r.code); if (m) max = Math.max(max, +m[1]); });
  parsed.forEach(function (x) {
    if (x.r.code) return;
    x.r.code = codeOf_('RCP', ++max);
    x.v = recipeWithCode_(x.v, x.r.code);
    recipeWrite_(x.sh, x.v);
  });
  parsed.forEach(function (x) {
    x.r.id = String(x.sh.getSheetId());
    x.r.ver = recipeVer_(x.v);
    out.recipes.push(x.r);
  });
  recipeResolve_(out, ingMap);
  var s = JSON.stringify(out);
  if (s.length < 90000) {
    try {
      cache.put(key, s, RECIPE_CACHE_SEC);
    } catch (err) {
      console.error(err);
    }
  }
  return out;
}

/** 재료 줄의 이름 = 코드로 찾은 지금 이름 (코드가 없으면 이름으로 찾음). 박스 이름도 ID 로. To write 표시. */
function recipeResolve_(out, ingMap) {
  var byCode = {}, byKey = {}, ingKey = {}, boxes = {};
  out.recipes.forEach(function (r) { byCode[r.code] = r; byKey[ingKey_(r.name)] = r; });
  Object.keys(ingMap).forEach(function (c) { if (ingMap[c].active || !ingKey[ingKey_(ingMap[c].name)]) ingKey[ingKey_(ingMap[c].name)] = c; });
  out.boxes.forEach(function (b) { if (b.id) boxes[b.id] = b; });
  out.recipes.forEach(function (r) {
    r.items.forEach(function (it) {
      if (it.t !== 'ing' && it.t !== 'base') return;
      var c = it.code;
      if (!c) {
        var k = ingKey_(it.name);
        c = byKey[k] && byKey[k] !== r ? byKey[k].code : ingKey[k] || '';
        if (!c) { r.warnings.push('“' + it.name + '” is not in the ingredient list. Add it in Ingredients, then pick it here.'); return; }
        it.code = c;
      }
      if (/^RCP-/.test(c)) {
        var x = byCode[c];
        if (x) { it.name = x.name; it.recipe = x.id; } else r.warnings.push('“' + it.name + '”: recipe ' + c + ' not found (deleted?).');
      } else if (ingMap[c]) {
        it.name = ingMap[c].name;
      } else r.warnings.push('“' + it.name + '”: ingredient ' + c + ' not found.');
    });
    if (r.boxId && boxes[r.boxId]) r.box = boxes[r.boxId].name;
    r.todo = !r.items.some(function (it) { return it.t === 'ing' || it.t === 'base'; });
  });
}

/** 시트 값에 ID 줄을 넣음 (RECIPE 줄 바로 아래, 없으면 머리글 아래). */
function recipeWithCode_(values, code) {
  var v = values.length ? values.slice() : [RECIPE_HEAD.slice()];
  if (String(v[0][0]).trim().toUpperCase() !== 'KIND') v.unshift(RECIPE_HEAD.slice());
  var at = 1;
  v.forEach(function (row, i) { if (String(row[0]).trim().toUpperCase() === 'RECIPE') at = i + 1; });
  v.splice(at, 0, ['ID', code, '', '', '']);
  return v.map(function (row) { row = row.slice(0, RECIPE_COLS); while (row.length < RECIPE_COLS) row.push(''); return row; });
}

/** 탭을 통째로 다시 씀 (5열, 글자 형식). */
function recipeWrite_(sh, rows) {
  rows = rows.slice();
  rows[0] = RECIPE_HEAD.slice();
  sh.clearContents();
  sh.getRange(1, 1, rows.length, RECIPE_COLS).setNumberFormat('@').setValues(rows.map(function (r) {
    return r.map(function (v) { v = String(v == null ? '' : v); return /^[=+\-@']/.test(v) ? "'" + v : v; });
  }));
  sh.getRange(1, 1, 1, RECIPE_COLS).setFontWeight('bold');
  sh.setFrozenRows(1);
}

function recipeById_(id) {
  return recipesAll_().recipes.filter(function (r) { return r.id === String(id); })[0] || null;
}

function bumpRecipes_() {
  props_.setProperty('RCP_VER', String(Number(props_.getProperty('RCP_VER') || 0) + 1));
}

// ------------------------------------------------------------------ API: 보기

function recipesView_(req) {
  var emp = recipeUser_(req), all = recipesAll_(), sup = !!emp.supervisor, admin = emp.admin || sup;
  var out = { ok: true, me: emp.name, canEdit: sup, canPickMaker: admin, canCount: admin, boxes: all.boxes, today: todayStamp_(),
              places: prodPlaces_(),
              recipes: all.recipes.map(function (r) {
                var x = JSON.parse(JSON.stringify(r));
                if (!sup) delete x.warnings;
                return x;
              }) };
  if (sup) {
    out.boxesVer = all.boxesVer;
    out.ingredients = all.ingredients; // 재료 자동완성: [{ code, name, unit }] — 이 목록(+ 레시피)에서만 고름
  }
  if (admin) {
    // Made by 고르기: 레시피 팀 사람 먼저, 그다음 나머지
    var teams = recipeTeams_();
    out.staff = activeEmployees_().map(function (e) {
      return { name: e.name, kitchen: teams.indexOf(String(e.team).toLowerCase()) >= 0 };
    });
  }
  return out;
}

function recipePhoto_(req) {
  recipeUser_(req);
  var name = String(req.name || '').trim();
  if (!name || name.length > 200) fail_('Photo not found.');
  var cache = CacheService.getScriptCache(), key = 'rph_' + name, id = cache.get(key), file = null;
  if (id) {
    try {
      file = DriveApp.getFileById(id);
    } catch (err) {
      file = null;
    }
  }
  if (!file) {
    var it = recipePhotoFolder_().getFilesByName(name);
    if (!it.hasNext()) fail_('Photo not found: ' + name, 'NOPHOTO');
    file = it.next();
    cache.put(key, file.getId(), 21600);
  }
  var blob = file.getBlob();
  return { ok: true, name: name, dataUrl: 'data:' + blob.getContentType() + ';base64,' + Utilities.base64Encode(blob.getBytes()) };
}

// ------------------------------------------------------------------ API: 편집 (Supervisor)

/** 사진 1장 올리기 → Recipe Photos 폴더에 새 파일 이름으로 저장. 그 이름을 PHOTO 줄에 씀. */
function recipePhotoUpload_(req) {
  recipeEditor_(req);
  var p = parsePhotos_([req.photo])[0];
  var base = String(req.hint || 'photo').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'photo';
  var folder = recipePhotoFolder_(), stamp = Utilities.formatDate(new Date(), TZ, 'yyyyMMdd-HHmmss');
  var name = base + '-' + stamp + '.jpg', n = 2;
  while (folder.getFilesByName(name).hasNext()) name = base + '-' + stamp + '-' + (n++) + '.jpg';
  var file = folder.createFile(Utilities.newBlob(Utilities.base64Decode(p.data), p.type, name));
  CacheService.getScriptCache().put('rph_' + name, file.getId(), 21600);
  return { ok: true, name: name };
}

function rcpText_(v, max, label) {
  var s = String(v == null ? '' : v).replace(/\r\n?/g, '\n').trim();
  if (s.length > max) fail_(label + ' is too long (max ' + max + ' characters).');
  return s;
}

/**
 * 화면에서 받은 레시피 → 시트 행 (검사 포함). ctx = { code, ing(item, line) → { name, code }, boxes: [...] }.
 * 재료 줄은 목록(Ingredients 또는 다른 레시피)에 있는 것만 — 코드로 저장.
 */
function recipeRows_(r, ctx) {
  var name = rcpText_(r.name, 100, 'The name').replace(/\s+/g, ' ');
  if (!name) fail_('Please enter the recipe name.');
  var mode = r.mode === 'percent' ? 'percent' : 'fixed';
  var items = Array.isArray(r.items) ? r.items : [];
  if (items.length > RECIPE_MAX_ITEMS) fail_('Too many lines (max ' + RECIPE_MAX_ITEMS + ').');
  var row = function (k, b, c, d, e) { return [k, b == null ? '' : b, c == null ? '' : c, d == null ? '' : d, e == null ? '' : e]; };
  var rows = [RECIPE_HEAD.slice(), row('RECIPE', name), row('ID', ctx.code), row('MODE', mode === 'percent' ? 'Percent' : 'Fixed')];
  var cat = rcpText_(r.cat, 60, 'The category');
  if (cat) rows.push(row('CATEGORY', cat));
  var ings = 0, bases = 0;
  items.forEach(function (it, i) {
    var line = 'Line ' + (i + 1) + ': ';
    if (it.t === 'ing' || it.t === 'base') {
      var raw = rcpText_(it.name, 120, line + 'the ingredient').replace(/\s+/g, ' ');
      if (!raw && !it.code) fail_(line + 'please choose the ingredient.');
      var hit = ctx.ing({ name: raw, code: it.code }, line);
      var note = rcpText_(it.note, 80, line + 'the note');
      if (it.t === 'base') {
        if (mode !== 'percent') fail_(line + 'a base ingredient only works in a Percent recipe.');
        bases++;
        rows.push(row('BASE', hit.name, '', note || 'g', hit.code));
        return;
      }
      var q = recipeNum_(it.q);
      if (q === null || isNaN(q) || q < 0 || q > 1000000) fail_(line + 'please enter the amount of “' + hit.name + '”.');
      ings++;
      rows.push(row('ING', hit.name, String(q), note || (mode === 'percent' ? '%' : 'g'), hit.code));
    } else if (it.t === 'step') {
      var text = rcpText_(it.text, 2000, line + 'the step');
      if (text) rows.push(row('STEP', text));
    } else if (it.t === 'photo') {
      var file = rcpText_(it.file, 200, line + 'the photo name');
      if (!file) fail_(line + 'the photo has no file. Choose a photo or delete the line.');
      rows.push(row('PHOTO', file, '', rcpText_(it.cap, 200, line + 'the caption')));
    } else {
      fail_(line + 'unknown line.');
    }
  });
  if (!ings && !bases) fail_('Please add at least one ingredient.');
  if (mode === 'percent' && !bases) fail_('A Percent recipe needs a base ingredient (the one you weigh).');
  var box = rcpText_(r.box, 100, 'The box');
  if (box) {
    var bx = (ctx.boxes || []).filter(function (b) { return b.name === box || (r.boxId && b.id === r.boxId); })[0];
    rows.push(bx ? row('BOX', bx.name, '', '', bx.id) : row('BOX', box)); // 목록에 없는 박스 = 이름만 (시트에서 Boxes 탭에 추가하면 연결됨)
  }
  if (r.fill !== '' && r.fill != null) {
    var fill = recipeNum_(r.fill);
    if (fill === null || isNaN(fill) || fill <= 0) fail_('Grams per box must be a number.');
    rows.push(row('FILL', 'Per box', String(fill), 'g'));
  }
  var keepNote = rcpText_(r.keepNote, 120, 'The storage note'), days = r.keepDays;
  if (days !== '' && days != null) {
    days = recipeNum_(days);
    if (days === null || isNaN(days) || days < 0 || days > 3650) fail_('Keep days must be a number of days.');
    days = String(Math.round(days));
  } else days = '';
  if (keepNote || days) rows.push(row('KEEP', keepNote, days, days ? 'days' : ''));
  if (r.place) {
    var pl = prodPlaceById_(r.place) || prodPlace_(r.place);
    if (!pl) fail_('Unknown place: ' + r.place);
    rows.push(row('PLACE', pl.label, '', '', pl.id));
  }
  if (r.count === 'sunday') rows.push(row('COUNT', 'Sunday'));
  if (r.count === 'none') rows.push(row('COUNT', 'Not stored'));
  if (r.countUnit === 'pcs') rows.push(row('COUNTIN', 'Pieces'));
  if (r.countUnit === 'g') rows.push(row('COUNTIN', 'Grams'));
  if (r.yieldPct !== '' && r.yieldPct != null) {
    var y = recipeNum_(r.yieldPct);
    if (y === null || isNaN(y) || y <= 0 || y > 1000) fail_('Yield: the finished weight as % of the raw total (e.g. 60).');
    rows.push(row('YIELD', rcpText_(r.yieldNote, 80, 'The yield note'), String(Math.round(y * 10) / 10), '%'));
  }
  return { name: name, rows: rows };
}

function recipeTabName_(ss, name, self) {
  var base = name.replace(/[\[\]*?:\/\\']/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90) || 'Recipe';
  if (RECIPE_SKIP_TAB.test(base)) base += ' (recipe)';
  var tab = base, n = 2;
  while (true) {
    var other = ss.getSheetByName(tab);
    if (!other || other === self) return tab;
    tab = base + ' (' + (n++) + ')';
  }
}

function recipeSheetById_(ss, id) {
  return recipeTabs_(ss).filter(function (sh) { return String(sh.getSheetId()) === String(id); })[0] || null;
}

/** 다음 레시피 코드 (RCP-…). */
function nextRecipeCode_(all) {
  var max = 0;
  all.recipes.forEach(function (r) { var m = /^RCP-(\d+)$/.exec(r.code || ''); if (m) max = Math.max(max, +m[1]); });
  var seq = Number(props_.getProperty('RCP_CODE_SEQ') || 0);
  var n = Math.max(max, seq) + 1;
  props_.setProperty('RCP_CODE_SEQ', String(n)); // 지운(숨긴) 레시피의 코드를 다시 쓰지 않도록
  return codeOf_('RCP', n);
}

/** 재료 줄 하나 → { name, code }. 코드(ING-/RCP-) 또는 정확한 이름(대소문자·악센트 무시)으로 찾음. 없으면 거절. */
function recipeIngResolver_(all, ingMap, selfCode) {
  var rByCode = {}, rByKey = {}, iByKey = {};
  all.recipes.forEach(function (r) { rByCode[r.code] = r; rByKey[ingKey_(r.name)] = r; });
  Object.keys(ingMap).forEach(function (c) { if (ingMap[c].active) iByKey[ingKey_(ingMap[c].name)] = c; });
  return function (it, line) {
    var c = String(it.code || '').trim().toUpperCase(), k = ingKey_(it.name);
    if (c && c === selfCode) fail_(line + 'a recipe cannot use itself.');
    if (/^RCP-/.test(c) && rByCode[c]) return { name: rByCode[c].name, code: c };
    if (/^ING-/.test(c) && ingMap[c] && ingMap[c].active) return { name: ingMap[c].name, code: c };
    var r = rByKey[k];
    if (r && r.code !== selfCode) return { name: r.name, code: r.code };
    if (iByKey[k]) return { name: ingMap[iByKey[k]].name, code: iByKey[k] };
    fail_(line + '“' + (it.name || c) + '” is not in the ingredient list. Add it in Manager › Ingredients first, then pick it here.');
  };
}

/** 새 레시피(id 없음) 또는 수정(id + ver: 연 뒤에 시트에서 바뀌었으면 CHANGED). */
function recipeSave_(req) {
  recipeEditor_(req);
  var ss = recipeBook_(), all = recipesAll_(), ingMap = ingCodeMap_();
  var old = req.id ? all.recipes.filter(function (x) { return x.id === String(req.id); })[0] : null;
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  var sh;
  try {
    var code = old && old.code ? old.code : nextRecipeCode_(all);
    var built = recipeRows_(req.recipe || {}, { code: code, ing: recipeIngResolver_(all, ingMap, code), boxes: all.boxes });
    var clash = all.recipes.filter(function (x) { return x.code !== code && ingKey_(x.name) === ingKey_(built.name); })[0];
    if (clash) fail_('A recipe called “' + clash.name + '” already exists.');
    if (req.id) {
      sh = recipeSheetById_(ss, req.id);
      if (!sh) fail_('This recipe was deleted. Please go back to the list.', 'CHANGED');
      if (String(req.ver || '') !== recipeVer_(recipeValues_(sh))) {
        fail_('This recipe was changed (maybe in the sheet) after you opened it. Please open it again.', 'CHANGED');
      }
      if (sh.getName() !== built.name) sh.setName(recipeTabName_(ss, built.name, sh));
    } else {
      sh = ss.insertSheet(recipeTabName_(ss, built.name, null));
    }
    recipeWrite_(sh, built.rows);
    if (old && old.name !== built.name) codeRenameInRecipes_(code, built.name);
    SpreadsheetApp.flush();
    bumpRecipes_();
  } finally {
    lock.releaseLock();
  }
  return { ok: true, recipe: recipeById_(sh.getSheetId()), newIngredients: [] };
}

/** 빈 레시피(To write) 만들기 — 메뉴 편집기의 "레시피 필요". → 레시피 코드. */
function recipeStub_(name) {
  var ss = recipeBook_(), all = recipesAll_();
  name = rcpText_(name, 100, 'The name').replace(/\s+/g, ' ');
  if (!name) fail_('Please enter the name.');
  var clash = all.recipes.filter(function (x) { return ingKey_(x.name) === ingKey_(name); })[0];
  if (clash) fail_('“' + clash.name + '” is already a recipe. Pick it from the list.');
  var code = nextRecipeCode_(all);
  recipeWrite_(ss.insertSheet(recipeTabName_(ss, name, null)),
               [RECIPE_HEAD.slice(), ['RECIPE', name, '', '', ''], ['ID', code, '', '', ''], ['MODE', 'Fixed', '', '', '']]);
  SpreadsheetApp.flush();
  bumpRecipes_();
  return code;
}

/** 레시피 탭들에서 E 열 코드가 code 인 재료 줄의 이름(B)을 새 이름으로 (시트를 읽기 쉽게; 앱은 코드로 찾음). */
function codeRenameInRecipes_(code, name) {
  var touched = [];
  recipeTabs_(recipeBook_()).forEach(function (sh) {
    var vals = recipeValues_(sh), hit = false, title = sh.getName();
    vals.forEach(function (r, i) {
      var k = String(r[0]).trim().toUpperCase();
      if (k === 'RECIPE') title = String(r[1]).trim() || title;
      if ((k === 'ING' || k === 'BASE') && String(r[4]).trim().toUpperCase() === code && String(r[1]) !== name) {
        sh.getRange(i + 1, 2).setValue(safeCell_(name));
        hit = true;
      }
    });
    if (hit) touched.push(title);
  });
  return touched;
}

/** 앱에서 지우기 = 탭 숨기기 (시트에서 숨김 해제하면 돌아옴). */
function recipeDelete_(req) {
  recipeEditor_(req);
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = recipeSheetById_(recipeBook_(), req.id);
    if (!sh) fail_('Recipe not found.');
    sh.hideSheet();
    bumpRecipes_();
  } finally {
    lock.releaseLock();
  }
  return { ok: true };
}

/** 박스 목록 전체를 저장 (Boxes 탭을 다시 씀). ver: 연 뒤에 시트에서 바뀌었으면 CHANGED. */
function boxSave_(req) {
  recipeEditor_(req);
  var list = Array.isArray(req.boxes) ? req.boxes : [], seen = {};
  if (list.length > 100) fail_('Too many boxes (max 100).');
  var rows = list.map(function (b, i) {
    var name = rcpText_(b.name, 80, 'Box ' + (i + 1) + ' name').replace(/\s+/g, ' ');
    if (!name) fail_('Box ' + (i + 1) + ': please enter a name.');
    if (seen[name.toLowerCase()]) fail_('Two boxes are called “' + name + '”.');
    seen[name.toLowerCase()] = true;
    return [name, rcpText_(b.capacity, 40, name + ' capacity'), rcpText_(b.photo, 200, name + ' photo'),
            rcpText_(b.note, 120, name + ' note'), String(b.id || '').trim().toUpperCase()];
  });
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var ss = recipeBook_();
    if (String(req.ver || '') !== recipeVer_(readBoxes_(ss))) {
      fail_('The box list was changed (maybe in the sheet) after you opened it. Please open it again.', 'CHANGED');
    }
    // 박스 ID 는 그대로 (레시피는 ID 로 연결 → 이름을 바꿔도 끊기지 않음). 새 박스 = 새 ID.
    // 이름만 적힌 레시피의 BOX 줄(옛 형식·시트에서 쓴 것)은 바꾸기 전에 지금 이름으로 ID 를 붙여 둠.
    ensureBoxIds_(ss);
    var oldIds = {};
    readBoxes_(ss).forEach(function (b) { oldIds[b.name.toLowerCase()] = b.id; });
    recipeTabs_(ss).forEach(function (t) {
      recipeValues_(t).forEach(function (r, i) {
        if (String(r[0]).trim().toUpperCase() === 'BOX' && !String(r[4]).trim() && oldIds[String(r[1]).trim().toLowerCase()]) {
          t.getRange(i + 1, 5).setValue(oldIds[String(r[1]).trim().toLowerCase()]);
        }
      });
    });
    var known = {}, max = 0;
    readBoxes_(ss).forEach(function (b) { if (b.id) known[b.id] = true; var m = /^BOX-(\d+)$/.exec(b.id); if (m) max = Math.max(max, +m[1]); });
    var seq = Number(props_.getProperty('BOX_SEQ') || 0);
    max = Math.max(max, seq);
    rows.forEach(function (r) { if (!r[4] || !known[r[4]]) r[4] = codeOf_('BOX', ++max, 2); known[r[4]] = false; });
    props_.setProperty('BOX_SEQ', String(max));
    var sh = ss.getSheetByName('Boxes') || ss.insertSheet('Boxes');
    sh.clearContents();
    sh.getRange(1, 1, rows.length + 1, BOX_HEAD.length).setNumberFormat('@').setValues([BOX_HEAD].concat(rows.map(function (r) {
      return r.map(function (v) { return /^[=+\-@']/.test(v) ? "'" + v : v; });
    })));
    sh.getRange(1, 1, 1, BOX_HEAD.length).setFontWeight('bold');
    SpreadsheetApp.flush();
    bumpRecipes_();
  } finally {
    lock.releaseLock();
  }
  var all = recipesAll_();
  return { ok: true, boxes: all.boxes, boxesVer: all.boxesVer };
}

/**
 * setup: 모든 것을 코드로 연결 (여러 번 실행해도 안전).
 *   박스 ID · 위치 ID · 레시피 ID 줄 · 레시피 안의 재료/박스/위치 줄 E 열 코드 · Production Log 의 Place ID · 원재료 냉장고 주소.
 */
function ensureCodes_() {
  var ss = recipeBook_();
  ensureBoxIds_(ss);
  bumpRecipes_();
  var places = prodPlaces_(), all = recipesAll_(), ingMap = ingCodeMap_(), boxes = {};
  all.boxes.forEach(function (b) { boxes[b.name.toLowerCase()] = b.id; });
  var rByKey = {}, iByKey = {};
  all.recipes.forEach(function (r) { rByKey[ingKey_(r.name)] = r.code; });
  Object.keys(ingMap).forEach(function (c) { if (ingMap[c].active || !iByKey[ingKey_(ingMap[c].name)]) iByKey[ingKey_(ingMap[c].name)] = c; });
  var fixed = 0;
  recipeTabs_(ss).forEach(function (sh) {
    var vals = recipeValues_(sh), self = '';
    if (sh.getRange(1, 5).getValue() !== 'Code') sh.getRange(1, 5).setValue('Code').setFontWeight('bold');
    vals.forEach(function (r) { if (String(r[0]).trim().toUpperCase() === 'ID') self = String(r[1]).trim().toUpperCase(); });
    vals.forEach(function (r, i) {
      var k = String(r[0]).trim().toUpperCase(), b = String(r[1]).trim(), e = String(r[4] || '').trim(), code = '';
      if (e) return;
      if (k === 'ING' || k === 'BASE') {
        var key = ingKey_(b);
        code = rByKey[key] && rByKey[key] !== self ? rByKey[key] : iByKey[key] || '';
      } else if (k === 'BOX') code = boxes[b.toLowerCase()] || '';
      else if (k === 'PLACE') code = (prodPlace_(b) || {}).id || '';
      if (code) { sh.getRange(i + 1, 5).setValue(code); fixed++; }
    });
  });
  // Production Log: 위치 이름 → Place ID (빈 칸만)
  var log = prodSheet_(), last = log.getLastRow(), byLabel = {};
  places.forEach(function (p) { byLabel[p.label.toLowerCase()] = p.id; });
  if (last > 1) {
    var cells = log.getRange(2, 13, last - 1, 7).getValues();
    cells.forEach(function (c, i) {
      var id = byLabel[String(c[0]).trim().toLowerCase()];
      if (id && !String(c[6]).trim()) log.getRange(i + 2, 19).setValue(id);
    });
  }
  var moved = ingAddressesToIds_();
  bumpRecipes_();
  return { recipeLines: fixed, ingredientAddresses: moved };
}

/** 편집기에서 실행: 레시피 탭마다 읽은 결과와 문제(경고)를 실행 로그에. */
function checkRecipes() {
  bumpRecipes_();
  var all = recipesAll_();
  Logger.log('Boxes: ' + (all.boxes.map(function (b) { return b.name + (b.capacity ? ' (' + b.capacity + ')' : ''); }).join(', ') || 'none'));
  all.recipes.forEach(function (r) {
    Logger.log((r.warnings.length ? 'CHECK ' : 'OK    ') + r.name + ' · ' + r.mode + ' · ' + r.items.length + ' lines' +
               (r.warnings.length ? '\n      ' + r.warnings.join('\n      ') : ''));
  });
  return all.recipes.length;
}
