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
//     PLACE    기본 저장 위치 (Places 탭의 이름, 예: 'Ground floor · Fridge 4')
//     COUNT    재고 조사: Daily (매일 저녁, 기본) / Sunday (일요일 조사만)
//   'Boxes' 탭: Name | Capacity | Photo | Note  (박스 목록. 앱에서는 용량 + 작은 사진)
//   'Places' 탭: 저장 위치 목록 (Stock.gs 참고)
//   'Ingredients' 탭: 재료 이름 목록 (Name | Note | Added | First recipe). 편집기의 재료 칸 자동완성 = 이 목록.
//     레시피를 저장할 때 대소문자·띄어쓰기·악센트만 다른 이름은 목록의 이름으로 맞추고(Soy Sauce → Soy sauce),
//     목록에 없는 새 이름은 자동으로 추가됨. 나중에 주문 시스템이 같은 이름을 쓰도록. 시트에서 고치거나 지워도 됨.
//   'How to' 탭과 이름이 _ 로 시작하는 탭, 숨긴 탭은 레시피가 아님 (앱에서 지운 레시피 = 숨긴 탭, 숨김 해제로 복구).
// "Production Log" 스프레드시트 (PROD_SHEET_ID): 프렙 입고 기록·재고·재고 조사 — Stock.gs.
// 보는 사람 = Employees F열 Team 이 RECIPE_TEAMS(스크립트 속성, 기본 'Kitchen', 쉼표로 여러 팀)인 직원 + Supervisor.
// 수정 = Supervisor 만. Made by 를 다른 사람으로 = Admin 또는 Supervisor.

var RECIPE_HEAD = ['Kind', 'Name / text', 'Amount', 'Unit / note'];
var BOX_HEAD = ['Name', 'Capacity', 'Photo', 'Note'];
var RECIPE_SKIP_TAB = /^(boxes|places|ingredients|how to|_.*)$/i;
var INGREDIENT_HEAD = ['Name', 'Note', 'Added', 'First recipe'];
var RECIPE_CACHE_SEC = 60;       // 시트에서 직접 고친 것은 최대 1분 뒤 앱에 보임 (앱에서 고친 것은 바로)
var RECIPE_MAX_ITEMS = 300;

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
      ['PLACE | usual place (name from the Places tab)    COUNT | Daily (default) or Sunday'],
      ['Hidden tabs, this tab, the Boxes and Places tabs and tabs starting with _ are not recipes.'],
    ];
    h.getRange(1, 1, lines.length, 1).setValues(lines);
  }
  recipePhotoFolder_();
  ensurePlaces_(ss);
  ensureIngredients_(ss);
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
  var r = { name: '', mode: 'fixed', cat: '', items: [], box: '', fill: null, keepNote: '', keepDays: null, place: '', count: 'daily',
           warnings: [] };
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
    } else if (k === 'COUNT') {
      if (!/^(daily|sunday|weekly)$/i.test(b)) warn(i, 'COUNT must be Daily or Sunday.');
      r.count = /^(sunday|weekly)$/i.test(b) ? 'sunday' : 'daily';
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

/** 재료 이름 비교용: 대소문자·앞뒤/겹친 띄어쓰기·악센트 무시 (Crème = creme). */
function ingKey_(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** 처음 한 번: Ingredients 탭을 만들고 지금 레시피들에 쓰인 재료로 채움. */
function ensureIngredients_(ss) {
  if (ss.getSheetByName('Ingredients')) return;
  var sh = ss.insertSheet('Ingredients'), seen = {}, rows = [], today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  recipeTabs_(ss).forEach(function (t) {
    var r = parseRecipe_(t.getName(), recipeValues_(t));
    r.items.forEach(function (it) {
      if ((it.t === 'ing' || it.t === 'base') && !seen[ingKey_(it.name)]) {
        seen[ingKey_(it.name)] = true;
        rows.push([it.name, '', today, r.name]);
      }
    });
  });
  sh.getRange(1, 1, rows.length + 1, 4).setNumberFormat('@').setValues([INGREDIENT_HEAD].concat(rows));
  sh.getRange(1, 1, 1, 4).setFontWeight('bold');
  sh.setFrozenRows(1);
}

/** Ingredients 탭의 이름들 (시트 순서, 같은 이름은 처음 것만). */
function readIngredients_(ss) {
  var sh = ss.getSheetByName('Ingredients');
  if (!sh || sh.getLastRow() < 2) return [];
  var seen = {};
  return sh.getRange(2, 1, sh.getLastRow() - 1, 1).getDisplayValues().map(function (r) { return String(r[0]).replace(/\s+/g, ' ').trim(); })
    .filter(function (n) { var k = ingKey_(n); if (!n || seen[k]) return false; seen[k] = true; return true; });
}

/** { recipes: [...], boxes: [...], boxesVer } — 캐시(앱에서 고치면 RCP_VER 이 바뀌어 바로 새로 읽음). */
function recipesAll_() {
  var key = 'rcp_all_' + (props_.getProperty('RCP_VER') || '0'), cache = CacheService.getScriptCache();
  var hit = cache.get(key);
  if (hit) return JSON.parse(hit);
  var ss = recipeBook_(), out = { recipes: [], boxes: readBoxes_(ss), ingredients: readIngredients_(ss) };
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
  var out = { ok: true, me: emp.name, canEdit: sup, canPickMaker: admin, canCount: admin, boxes: all.boxes, today: todayStamp_(),
              places: prodPlaces_(),
              recipes: all.recipes.map(function (r) {
                var x = JSON.parse(JSON.stringify(r));
                if (!sup) delete x.warnings;
                return x;
              }) };
  if (sup) {
    out.boxesVer = all.boxesVer;
    // 재료 자동완성: Ingredients 탭 + 레시피에 쓰였지만 탭에 없는 이름 (시트에서 직접 쓴 것)
    var seen = {}, ings = [], add = function (n) { var k = ingKey_(n); if (n && !seen[k]) { seen[k] = true; ings.push(n); } };
    (all.ingredients || []).forEach(add);
    all.recipes.forEach(function (r) {
      r.items.forEach(function (it) { if (it.t === 'ing' || it.t === 'base') add(it.name); });
    });
    out.ingredients = ings;
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

/** 화면에서 받은 레시피 → 시트 행 (검사 포함). */
function recipeRows_(r, canon) {
  canon = canon || function (n) { return n; };
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
      var nm = canon(rcpText_(it.name, 120, line + 'the ingredient').replace(/\s+/g, ' '));
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
  if (r.count === 'sunday') rows.push(['COUNT', 'Sunday', '', '']);
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
  var ss = recipeBook_();
  ensureIngredients_(ss);
  var known = {}, fresh = [];
  readIngredients_(ss).forEach(function (n) { known[ingKey_(n)] = n; });
  // 목록에 있는 이름은 목록의 표기로, 없는 이름은 새 재료로 (같은 레시피 안에서 두 번 써도 한 번만)
  var built = recipeRows_(req.recipe || {}, function (n) {
    var k = ingKey_(n);
    if (!k) return n;
    if (!known[k]) { known[k] = n; fresh.push(n); }
    return known[k];
  });
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  var sh;
  try {
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
    if (fresh.length) {
      var ing = ss.getSheetByName('Ingredients'), today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
      ing.getRange(ing.getLastRow() + 1, 1, fresh.length, 4).setNumberFormat('@').setValues(fresh.map(function (n) {
        return [/^[=+\-@']/.test(n) ? "'" + n : n, '', today, built.name];
      }));
    }
    SpreadsheetApp.flush();
    bumpRecipes_();
  } finally {
    lock.releaseLock();
  }
  return { ok: true, recipe: recipeById_(sh.getSheetId()), newIngredients: fresh };
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
