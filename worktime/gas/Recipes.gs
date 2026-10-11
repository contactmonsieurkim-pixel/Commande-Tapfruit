// Recipes — 레시피 조회(Kitchen 팀 + Supervisor) · 편집(Supervisor, 앱 또는 시트) · Production log
//
// "Recipes" 스프레드시트 (setup() 이 만듦, RECIPE_SHEET_ID):
//   레시피마다 탭 1개. 1행 = 머리글, 2행부터 A열 종류대로 위에서 아래로 화면에 그려짐:
//     A Kind | B Name / text | C Amount | D Unit / note
//     RECIPE   이름
//     MODE     Fixed (정량: C = g) / Percent (비율: C = 기준 재료 총중량 대비 %)
//     CATEGORY 분류 (목록의 칩)
//     ING      재료 이름 | 양(g 또는 %) | D 에 g/% 외의 글자 = 작은 메모
//     BASE     (Percent 전용) 기준 재료. 실제로 잰 무게를 앱에서 입력, 여러 개면 합계 = 100%
//     STEP     과정 설명
//     PHOTO    'Recipe Photos' 폴더의 파일 이름 | | D = 사진 설명
//     BOX      기본 보관 박스 이름 (Boxes 탭의 Name)
//     FILL     | 박스 하나에 들어가는 대략 g (예상 박스 수 계산용)
//     KEEP     보관 조건 | 보관 일수 (사용기한 = 만든 날 + 일수)
//     PLACE    기본 저장 위치 (아래 PROD_PLACES 의 이름, 예: 'Ground floor · Fridge 4')
//   'Boxes' 탭: Name | Capacity | Photo | Note  (박스 목록. 앱에서는 용량 + 작은 사진)
//   'How to' 탭과 이름이 _ 로 시작하는 탭, 숨긴 탭은 레시피가 아님 (앱에서 지운 레시피 = 숨긴 탭, 숨김 해제로 복구).
// "Production Log" 스프레드시트 (PROD_SHEET_ID) 'Log' 탭: 프렙 입고 기록. 보호하지 않음(손으로 고칠 수 있게).
// 보는 사람 = Employees F열 Team 이 RECIPE_TEAMS(스크립트 속성, 기본 'Kitchen', 쉼표로 여러 팀)인 직원 + Supervisor.
// 수정 = Supervisor 만. Made by 를 다른 사람으로 = Admin 또는 Supervisor.
// 저장 위치(Location): 층 → 냉장고/선반 → 자리. 기록할 때 고르고, 옮기면 누구나 바로 고침(prodMove, Moved at/by 기록).

var RECIPE_HEAD = ['Kind', 'Name / text', 'Amount', 'Unit / note'];
var BOX_HEAD = ['Name', 'Capacity', 'Photo', 'Note'];
var PROD_HEAD = ['ID', 'Date', 'Time', 'Recipe', 'Batch', 'Total (g)', 'Boxes', 'Box', 'Made by', 'Use by',
                 'Logged by', 'Recipe ID', 'Location', 'Moved at', 'Moved by'];
// 저장 위치: 층(floor) → 종류(type: Fridge = 냉장고·냉동고, Shelf = 상온 선반) → 자리(spot). 이름(label)이 기록에 들어감.
// 바꾸려면 여기만 고치면 됨 (이미 기록된 이름은 그대로 남음).
var PROD_PLACES = [
  ['Ground floor', 'Fridge', ['Fridge 1', 'Fridge 4', 'Fridge 6', 'Fridge 7', 'Fridge 8', 'Freezer 9']],
  ['Ground floor', 'Shelf', ['Pass', 'Behind kitchen']],
  ['Basement', 'Fridge', ['Fridge Left', 'Fridge Right', 'Freezer Grand Congelo']],
  ['Basement', 'Shelf', ['Fermentation shelf']],
];
var PROD_STOCK_DAYS = 14;        // 사용기한이 없는 기록은 만든 지 이 일수까지 'Storage' 화면에 보임
var RECIPE_SKIP_TAB = /^(boxes|how to|_.*)$/i;
var RECIPE_CACHE_SEC = 60;       // 시트에서 직접 고친 것은 최대 1분 뒤 앱에 보임 (앱에서 고친 것은 바로)
var RECIPE_MAX_ITEMS = 300;
var PROD_SCAN_ROWS = 1000;       // 최근 기록을 찾을 때 Log 탭 끝에서 읽는 줄 수

// ------------------------------------------------------------------ setup

function ensureRecipes_() {
  var ss = recipeBook_();
  if (!ss.getSheetByName('Boxes')) {
    var bx = ss.insertSheet('Boxes');
    bx.getRange(1, 1, 1, 4).setValues([BOX_HEAD]).setFontWeight('bold');
    bx.setFrozenRows(1);
  }
  if (!ss.getSheetByName('How to')) {
    var h = ss.insertSheet('How to');
    var lines = [
      ['One tab per recipe. Row 1 = header, then one line per row (A = kind). The app shows them top to bottom.'],
      ['RECIPE | name                          MODE | Fixed or Percent            CATEGORY | e.g. Sauce'],
      ['ING | ingredient | amount (g, or % in a Percent recipe) | optional note'],
      ['BASE | base ingredient (Percent only; weighed at prep time; several BASE rows = their total is 100%)'],
      ['STEP | what to do                    PHOTO | file name in the Recipe Photos folder | | caption'],
      ['BOX | box name from the Boxes tab    FILL | | grams per box    KEEP | storage | days'],
      ['Hidden tabs, this tab, the Boxes tab and tabs starting with _ are not recipes.'],
    ];
    h.getRange(1, 1, lines.length, 1).setValues(lines);
  }
  recipePhotoFolder_();
  prodSheet_();
  return ss;
}

function recipeBook_() {
  var id = props_.getProperty('RECIPE_SHEET_ID');
  if (id) return SpreadsheetApp.openById(id);
  var ss = SpreadsheetApp.create('Recipes');
  DriveApp.getFileById(ss.getId()).moveTo(folder_());
  props_.setProperty('RECIPE_SHEET_ID', ss.getId());
  ss.getSheets()[0].setName('Boxes').getRange(1, 1, 1, 4).setValues([BOX_HEAD]).setFontWeight('bold');
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

function prodSheet_() {
  var id = props_.getProperty('PROD_SHEET_ID'), ss;
  if (id) {
    ss = SpreadsheetApp.openById(id);
  } else {
    ss = SpreadsheetApp.create('Production Log');
    DriveApp.getFileById(ss.getId()).moveTo(folder_());
    ss.getSheets()[0].setName('Log');
    props_.setProperty('PROD_SHEET_ID', ss.getId());
  }
  var sh = ss.getSheetByName('Log') || ss.insertSheet('Log');
  if (!sh.getRange('A1').getValue()) {
    sh.getRange(1, 1, 1, PROD_HEAD.length).setValues([PROD_HEAD]).setFontWeight('bold');
    sh.setFrozenRows(1);
  } else if (!sh.getRange(1, PROD_HEAD.length).getValue()) {
    sh.getRange(1, 1, 1, PROD_HEAD.length).setValues([PROD_HEAD]).setFontWeight('bold'); // 나중에 추가된 열 (Location …)
  }
  return sh;
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
  var r = { name: '', mode: 'fixed', cat: '', items: [], box: '', fill: null, keepNote: '', keepDays: null, place: '', warnings: [] };
  var warn = function (i, msg) { r.warnings.push('Row ' + (i + 1) + ': ' + msg); };
  rows.forEach(function (row, i) {
    var k = String(row[0] == null ? '' : row[0]).trim().toUpperCase();
    var b = String(row[1] == null ? '' : row[1]).trim(), d = String(row[3] == null ? '' : row[3]).trim();
    if (!k || (i === 0 && k === 'KIND')) return;
    var n = recipeNum_(row[2]);
    if (k === 'RECIPE') r.name = b;
    else if (k === 'MODE') {
      if (!/^(fixed|percent|%)$/i.test(b)) warn(i, 'MODE must be Fixed or Percent.');
      r.mode = /^(p|%)/i.test(b) ? 'percent' : 'fixed';
    } else if (k === 'CATEGORY') r.cat = b;
    else if (k === 'ING' || k === 'BASE') {
      if (!b) { warn(i, k + ' without a name.'); return; }
      var it = { t: k === 'BASE' ? 'base' : 'ing', name: b };
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
    } else if (k === 'BOX') r.box = b;
    else if (k === 'FILL') {
      if (n === null || isNaN(n) || n <= 0) warn(i, 'FILL needs the grams per box in column C.');
      else r.fill = n;
    } else if (k === 'KEEP') {
      r.keepNote = b;
      if (n !== null && (isNaN(n) || n < 0)) warn(i, 'KEEP days must be a number.');
      else if (n !== null) r.keepDays = Math.round(n);
    } else if (k === 'PLACE') {
      if (prodPlace_(b)) r.place = prodPlace_(b).label;
      else if (b) warn(i, 'Unknown place “' + b + '”. Use a name from the app, e.g. “Ground floor · Fridge 4”.');
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
  return last ? sh.getRange(1, 1, last, 4).getValues().map(function (r) {
    return r.map(function (v) { return typeof v === 'number' ? v : String(v); });
  }) : [];
}

function recipeTabs_(ss) {
  return ss.getSheets().filter(function (sh) { return !RECIPE_SKIP_TAB.test(sh.getName().trim()) && !sh.isSheetHidden(); });
}

function readBoxes_(ss) {
  var sh = ss.getSheetByName('Boxes');
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, 4).getDisplayValues()
    .map(function (r) { return { name: String(r[0]).trim(), capacity: String(r[1]).trim(), photo: String(r[2]).trim(), note: String(r[3]).trim() }; })
    .filter(function (b) { return b.name; });
}

/** { recipes: [...], boxes: [...], boxesVer } — 캐시(앱에서 고치면 RCP_VER 이 바뀌어 바로 새로 읽음). */
function recipesAll_() {
  var key = 'rcp_all_' + (props_.getProperty('RCP_VER') || '0'), cache = CacheService.getScriptCache();
  var hit = cache.get(key);
  if (hit) return JSON.parse(hit);
  var ss = recipeBook_(), out = { recipes: [], boxes: readBoxes_(ss) };
  out.boxesVer = recipeVer_(out.boxes);
  recipeTabs_(ss).forEach(function (sh) {
    var values = recipeValues_(sh), r = parseRecipe_(sh.getName(), values);
    r.id = String(sh.getSheetId());
    r.ver = recipeVer_(values);
    out.recipes.push(r);
  });
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

function recipeById_(id) {
  return recipesAll_().recipes.filter(function (r) { return r.id === String(id); })[0] || null;
}

function bumpRecipes_() {
  props_.setProperty('RCP_VER', String(Number(props_.getProperty('RCP_VER') || 0) + 1));
}

// ------------------------------------------------------------------ API: 보기

function recipesView_(req) {
  var emp = recipeUser_(req), all = recipesAll_(), sup = !!emp.supervisor, admin = emp.admin || sup;
  var out = { ok: true, me: emp.name, canEdit: sup, canPickMaker: admin, boxes: all.boxes, today: todayStamp_(), places: prodPlaces_(),
              recipes: all.recipes.map(function (r) {
                var x = JSON.parse(JSON.stringify(r));
                if (!sup) delete x.warnings;
                return x;
              }) };
  if (sup) out.boxesVer = all.boxesVer;
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

/** 화면에서 받은 레시피 → 시트 행 (검사 포함). */
function recipeRows_(r) {
  var name = rcpText_(r.name, 100, 'The name').replace(/\s+/g, ' ');
  if (!name) fail_('Please enter the recipe name.');
  var mode = r.mode === 'percent' ? 'percent' : 'fixed';
  var items = Array.isArray(r.items) ? r.items : [];
  if (items.length > RECIPE_MAX_ITEMS) fail_('Too many lines (max ' + RECIPE_MAX_ITEMS + ').');
  var rows = [RECIPE_HEAD, ['RECIPE', name, '', ''], ['MODE', mode === 'percent' ? 'Percent' : 'Fixed', '', '']];
  var cat = rcpText_(r.cat, 60, 'The category');
  if (cat) rows.push(['CATEGORY', cat, '', '']);
  var ings = 0, bases = 0;
  items.forEach(function (it, i) {
    var line = 'Line ' + (i + 1) + ': ';
    if (it.t === 'ing' || it.t === 'base') {
      var nm = rcpText_(it.name, 120, line + 'the ingredient');
      if (!nm) fail_(line + 'please enter the ingredient name.');
      var note = rcpText_(it.note, 80, line + 'the note');
      if (it.t === 'base') {
        if (mode !== 'percent') fail_(line + 'a base ingredient only works in a Percent recipe.');
        bases++;
        rows.push(['BASE', nm, '', note || 'g']);
        return;
      }
      var q = recipeNum_(it.q);
      if (q === null || isNaN(q) || q < 0 || q > 1000000) fail_(line + 'please enter the amount of “' + nm + '”.');
      ings++;
      rows.push(['ING', nm, String(q), note || (mode === 'percent' ? '%' : 'g')]);
    } else if (it.t === 'step') {
      var text = rcpText_(it.text, 2000, line + 'the step');
      if (text) rows.push(['STEP', text, '', '']);
    } else if (it.t === 'photo') {
      var file = rcpText_(it.file, 200, line + 'the photo name');
      if (!file) fail_(line + 'the photo has no file. Choose a photo or delete the line.');
      rows.push(['PHOTO', file, '', rcpText_(it.cap, 200, line + 'the caption')]);
    } else {
      fail_(line + 'unknown line.');
    }
  });
  if (!ings && !bases) fail_('Please add at least one ingredient.');
  if (mode === 'percent' && !bases) fail_('A Percent recipe needs a base ingredient (the one you weigh).');
  var box = rcpText_(r.box, 100, 'The box');
  if (box) rows.push(['BOX', box, '', '']);
  if (r.fill !== '' && r.fill != null) {
    var fill = recipeNum_(r.fill);
    if (fill === null || isNaN(fill) || fill <= 0) fail_('Grams per box must be a number.');
    rows.push(['FILL', 'Per box', String(fill), 'g']);
  }
  var keepNote = rcpText_(r.keepNote, 120, 'The storage note'), days = r.keepDays;
  if (days !== '' && days != null) {
    days = recipeNum_(days);
    if (days === null || isNaN(days) || days < 0 || days > 3650) fail_('Keep days must be a number of days.');
    days = String(Math.round(days));
  } else days = '';
  if (keepNote || days) rows.push(['KEEP', keepNote, days, days ? 'days' : '']);
  if (r.place) {
    if (!prodPlace_(r.place)) fail_('Unknown place: ' + r.place);
    rows.push(['PLACE', prodPlace_(r.place).label, '', '']);
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

/** 새 레시피(id 없음) 또는 수정(id + ver: 연 뒤에 시트에서 바뀌었으면 CHANGED). */
function recipeSave_(req) {
  recipeEditor_(req);
  var built = recipeRows_(req.recipe || {});
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  var sh;
  try {
    var ss = recipeBook_();
    if (req.id) {
      sh = recipeSheetById_(ss, req.id);
      if (!sh) fail_('This recipe was deleted. Please go back to the list.', 'CHANGED');
      if (String(req.ver || '') !== recipeVer_(recipeValues_(sh))) {
        fail_('This recipe was changed (maybe in the sheet) after you opened it. Please open it again.', 'CHANGED');
      }
      if (sh.getName() !== built.name) sh.setName(recipeTabName_(ss, built.name, sh));
      sh.clearContents();
    } else {
      sh = ss.insertSheet(recipeTabName_(ss, built.name, null));
    }
    sh.getRange(1, 1, built.rows.length, 4).setNumberFormat('@').setValues(built.rows.map(function (r) {
      return r.map(function (v) { return /^[=+\-@']/.test(v) ? "'" + v : v; });
    }));
    sh.getRange(1, 1, 1, 4).setFontWeight('bold');
    sh.setFrozenRows(1);
    SpreadsheetApp.flush();
    bumpRecipes_();
  } finally {
    lock.releaseLock();
  }
  return { ok: true, recipe: recipeById_(sh.getSheetId()) };
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
            rcpText_(b.note, 120, name + ' note')];
  });
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var ss = recipeBook_();
    if (String(req.ver || '') !== recipeVer_(readBoxes_(ss))) {
      fail_('The box list was changed (maybe in the sheet) after you opened it. Please open it again.', 'CHANGED');
    }
    var sh = ss.getSheetByName('Boxes') || ss.insertSheet('Boxes');
    sh.clearContents();
    sh.getRange(1, 1, rows.length + 1, 4).setNumberFormat('@').setValues([BOX_HEAD].concat(rows.map(function (r) {
      return r.map(function (v) { return /^[=+\-@']/.test(v) ? "'" + v : v; });
    })));
    sh.getRange(1, 1, 1, 4).setFontWeight('bold');
    SpreadsheetApp.flush();
    bumpRecipes_();
  } finally {
    lock.releaseLock();
  }
  var all = recipesAll_();
  return { ok: true, boxes: all.boxes, boxesVer: all.boxesVer };
}

// ------------------------------------------------------------------ Production log

function fmtGrams_(g) {
  var v = g < 10 ? Math.round(g * 10) / 10 : Math.round(g);
  return String(v);
}

function addDaysIso_(iso, days) {
  var p = iso.split('-');
  return Utilities.formatDate(new Date(Date.UTC(+p[0], +p[1] - 1, +p[2] + days, 12)), 'UTC', 'yyyy-MM-dd');
}

/** [{ floor, type, spot, label }] — 화면의 위치 고르기와 검사에 씀. */
function prodPlaces_() {
  var out = [];
  PROD_PLACES.forEach(function (g) {
    g[2].forEach(function (spot) {
      var label = g[0] + ' · ' + (g[1] === 'Shelf' && !/shelf/i.test(spot) ? 'Shelf · ' : '') + spot;
      out.push({ floor: g[0], type: g[1], spot: spot, label: label });
    });
  });
  return out;
}

function prodPlace_(label) {
  var want = String(label || '').trim().toLowerCase();
  return want ? prodPlaces_().filter(function (p) { return p.label.toLowerCase() === want; })[0] || null : null;
}

/** 이번 배치: 정량 = 배수(mult), 비율 = 기준 재료 무게(bases). → { batch: 글자, total: g }. */
function prodBatch_(r, req) {
  var ings = r.items.filter(function (x) { return x.t === 'ing'; });
  var sum = ings.reduce(function (n, x) { return n + x.q; }, 0);
  if (r.mode === 'percent') {
    var want = r.items.filter(function (x) { return x.t === 'base'; }).length;
    var bases = Array.isArray(req.bases) ? req.bases.map(recipeNum_) : [];
    if (!want || bases.length !== want || bases.some(function (b) { return b === null || isNaN(b) || b < 0 || b > 1000000; })) {
      fail_('Please enter the weight of the base ingredient.');
    }
    var baseTotal = bases.reduce(function (n, b) { return n + b; }, 0);
    if (!(baseTotal > 0)) fail_('Please enter the weight of the base ingredient.');
    return { batch: 'base ' + fmtGrams_(baseTotal) + ' g', total: Math.round(baseTotal + baseTotal * sum / 100) };
  }
  var mult = recipeNum_(req.mult);
  if (mult === null || isNaN(mult) || mult <= 0 || mult > 100) fail_('Please choose the batch size.');
  mult = Math.round(mult * 1000) / 1000;
  return { batch: '×' + mult, total: Math.round(sum * mult) };
}

function prodLog_(req) {
  var emp = recipeUser_(req), all = recipesAll_();
  var r = all.recipes.filter(function (x) { return x.id === String(req.id); })[0];
  if (!r) fail_('This recipe is not in the list any more.');
  var boxes = recipeNum_(req.boxes);
  if (boxes === null || isNaN(boxes) || boxes <= 0 || boxes > 999) fail_('Please enter how many boxes.');
  if (Math.abs(boxes * 10 - Math.round(boxes * 10)) > 1e-6) fail_('Boxes: one decimal at most (e.g. 2.5).');
  boxes = Math.round(boxes * 10) / 10;
  var box = String(req.box || r.box || '').trim();
  if (!box) fail_('Please choose the box.');
  var known = all.boxes.some(function (b) { return b.name === box; }) || box === r.box;
  if (!known) fail_('Unknown box: ' + box);
  var maker = emp.name;
  if (req.madeBy && String(req.madeBy).trim().toLowerCase() !== emp.name.toLowerCase()) {
    if (!(emp.admin || emp.supervisor)) fail_('Only managers can log for someone else.');
    var other = findEmployee_(req.madeBy);
    if (!other) fail_('Unknown person: ' + req.madeBy);
    maker = other.name;
  }
  var place = prodPlace_(req.place);
  if (!place) fail_(req.place ? 'Unknown place: ' + req.place : 'Please choose where it is stored.');
  var b = prodBatch_(r, req);
  var now = new Date(), date = Utilities.formatDate(now, TZ, 'yyyy-MM-dd'), time = Utilities.formatDate(now, TZ, 'HH:mm');
  var useBy = r.keepDays != null ? addDaysIso_(date, r.keepDays) : '';
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  var entry;
  try {
    var seq = Number(props_.getProperty('PROD_SEQ') || 0) + 1;
    var id = 'P' + ('00000' + seq).slice(-6);
    var sh = prodSheet_(), row = sh.getLastRow() + 1;
    var cells = [id, date, time, r.name, b.batch, b.total, boxes, box, maker, useBy, emp.name, r.id, place.label, '', ''];
    sh.getRange(row, 1, 1, 5).setNumberFormat('@'); // Total, Boxes(F·G) 는 숫자로 둠 (시트에서 합계 가능)
    sh.getRange(row, 8, 1, 8).setNumberFormat('@');
    sh.getRange(row, 1, 1, cells.length).setValues([cells.map(function (v) {
      return typeof v === 'string' && /^[=+\-@']/.test(v) ? "'" + v : v;
    })]);
    props_.setProperty('PROD_SEQ', String(seq));
    entry = prodEntry_(cells, emp);
  } finally {
    lock.releaseLock();
  }
  return { ok: true, entry: entry };
}

function prodEntry_(c, emp) {
  var today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  return { id: String(c[0]), date: String(c[1]), time: String(c[2]), recipe: String(c[3]), batch: String(c[4]),
           total: Number(c[5]) || 0, boxes: Number(c[6]) || 0, box: String(c[7]), madeBy: String(c[8]),
           useBy: String(c[9]), loggedBy: String(c[10]), recipeId: String(c[11]),
           place: String(c[12] || ''), movedAt: String(c[13] || ''), movedBy: String(c[14] || ''),
           canDelete: !!emp.supervisor || (String(c[10]) === emp.name && String(c[1]) === today) };
}

function prodRecent_() {
  var sh = prodSheet_(), last = sh.getLastRow(), n = Math.min(last - 1, PROD_SCAN_ROWS);
  if (n < 1) return { sh: sh, first: 2, rows: [] };
  return { sh: sh, first: last - n + 1, rows: sh.getRange(last - n + 1, 1, n, PROD_HEAD.length).getValues() };
}

/** 이 레시피의 최근 기록 10개 (최신이 위). 내가 오늘 적은 것은 지울 수 있음 (Supervisor 는 모두). */
function prodList_(req) {
  var emp = recipeUser_(req), id = String(req.id || '');
  var rows = prodRecent_().rows.filter(function (c) { return String(c[11]) === id; });
  return { ok: true, entries: rows.slice(-10).reverse().map(function (c) { return prodEntry_(c, emp); }) };
}

function prodDelete_(req) {
  var emp = recipeUser_(req), id = String(req.entry || '');
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var rec = prodRecent_(), i = -1;
    for (var j = rec.rows.length - 1; j >= 0; j--) if (String(rec.rows[j][0]) === id) { i = j; break; }
    if (!id || i < 0) fail_('This entry is not in the log any more.');
    if (!prodEntry_(rec.rows[i], emp).canDelete) fail_('You can only delete what you logged today.');
    rec.sh.deleteRow(rec.first + i);
  } finally {
    lock.releaseLock();
  }
  return { ok: true, entry: id };
}

/** 위치 옮기기: 누구나 (레시피를 볼 수 있는 사람). Location 을 바꾸고 Moved at / Moved by 를 남김. */
function prodMove_(req) {
  var emp = recipeUser_(req), id = String(req.entry || ''), place = prodPlace_(req.place);
  if (!place) fail_('Please choose the new place.');
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  var entry;
  try {
    var rec = prodRecent_(), i = -1;
    for (var j = rec.rows.length - 1; j >= 0; j--) if (String(rec.rows[j][0]) === id) { i = j; break; }
    if (!id || i < 0) fail_('This entry is not in the log any more.');
    var row = rec.rows[i].slice(), at = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm');
    row[12] = place.label; row[13] = at; row[14] = emp.name;
    rec.sh.getRange(rec.first + i, 13, 1, 3).setNumberFormat('@').setValues([[place.label, at, emp.name]]);
    entry = prodEntry_(row, emp);
  } finally {
    lock.releaseLock();
  }
  return { ok: true, entry: entry };
}

/** 'Storage' 화면: 아직 쓸 수 있는 것(사용기한이 오늘 이후, 기한이 없으면 만든 지 PROD_STOCK_DAYS 일 안), 최신이 위. */
function prodStock_(req) {
  var emp = recipeUser_(req), today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  var since = addDaysIso_(today, -PROD_STOCK_DAYS);
  var rows = prodRecent_().rows.filter(function (c) {
    var useBy = String(c[9] || ''), date = String(c[1] || '');
    return /^P\d+$/.test(String(c[0])) && (useBy ? useBy >= today : date >= since);
  });
  return { ok: true, today: today, entries: rows.reverse().slice(0, 300).map(function (c) { return prodEntry_(c, emp); }) };
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
