// Stock — Production log(배치) · 저장 위치 · 재고 · 저녁 재고 조사(Count) · 일요일 조사(Sunday) · 소비량
//
// "Recipes" 스프레드시트 'Places' 탭 (시트에서 언제든 수정):
//   Floor | Type | Spot | Short | Count
//   Type: Fridge / Freezer / Shelf.  Short: 화면에 쓰는 짧은 주소(F4, B·L …).  Count: Daily (매일 저녁) / Sunday (일요일 조사)
//   기록에 들어가는 이름 = 'Floor · Spot' (선반은 'Floor · Shelf · Spot', 이름에 shelf 가 있으면 그대로) — 예: 'Ground floor · Fridge 4'
//
// "Production Log" 스프레드시트 (PROD_SHEET_ID, 보호하지 않음 = 손으로 고칠 수 있음):
//   Log         : 배치(만든 것) 한 줄 = 한 배치. Left = 지금 남은 박스 (빈칸 = Boxes 그대로). 0 이 되면 재고에서 빠짐.
//   Stock moves : 재고가 바뀐 모든 일 — PRODUCE 만듦 · MOVE 옮김 · CORRECT 정정(Admin) · COUNT 조사로 줄어듦 · WASTE 버림 · DELETE
//   Use         : 조사할 때마다 레시피별 한 줄 — Before(앱 재고) · Counted(센 양) · Used(소비) · Wasted(버림) · Corrected(앱보다 많음)
// 소비량은 조사(COUNT)에서만 생김. 늦게 적은 생산, 이동, 정정은 소비량에 들어가지 않음.
// 조사: Daily = Count 가 Daily 인 위치(냉장고)에 있는 Daily 레시피. Sunday = 나머지 전부(선반·냉동고 + COUNT Sunday 레시피).
// 권한: 보기·기록·옮기기 = 레시피를 볼 수 있는 사람. 조사·정정·빠진 배치 추가·날짜 지정 = Admin(E열) 또는 Supervisor.

var PROD_HEAD = ['ID', 'Date', 'Time', 'Recipe', 'Batch', 'Total (g)', 'Boxes', 'Box', 'Made by', 'Use by',
                 'Logged by', 'Recipe ID', 'Location', 'Moved at', 'Moved by', 'Split from', 'Left', 'Note'];
var MOVES_HEAD = ['At', 'Type', 'Lot', 'Recipe', 'Recipe ID', 'Change', 'Left after', 'Location', 'By', 'Note'];
var USE_HEAD = ['Date', 'Count', 'Recipe', 'Recipe ID', 'Days', 'Before', 'Counted', 'Used', 'Wasted', 'Corrected', 'By'];
var PLACES_HEAD = ['Floor', 'Type', 'Spot', 'Short', 'Count'];
var PLACES_DEFAULT = [
  ['Ground floor', 'Fridge', 'Fridge 1', 'F1', 'Daily'], ['Ground floor', 'Fridge', 'Fridge 4', 'F4', 'Daily'],
  ['Ground floor', 'Fridge', 'Fridge 6', 'F6', 'Daily'], ['Ground floor', 'Fridge', 'Fridge 7', 'F7', 'Daily'],
  ['Ground floor', 'Fridge', 'Fridge 8', 'F8', 'Daily'], ['Ground floor', 'Freezer', 'Freezer 9', 'Z9', 'Sunday'],
  ['Ground floor', 'Shelf', 'Pass', 'Pass', 'Sunday'], ['Ground floor', 'Shelf', 'Behind kitchen', 'Back', 'Sunday'],
  ['Basement', 'Fridge', 'Fridge Left', 'B·L', 'Daily'], ['Basement', 'Fridge', 'Fridge Right', 'B·R', 'Daily'],
  ['Basement', 'Freezer', 'Freezer Grand Congelo', 'B·GC', 'Sunday'], ['Basement', 'Shelf', 'Fermentation shelf', 'B·Ferm', 'Sunday'],
];
var PROD_SCAN_ROWS = 3000;       // 재고·기록을 찾을 때 Log 탭 끝에서 읽는 줄 수
var USE_WINDOW_DAYS = 28;        // 하루 평균 소비량 = 최근 이 일수 안의 조사 기록으로
var LATE_MAX_DAYS = 60;          // 'Made on' 으로 지정할 수 있는 가장 오래된 날

// ------------------------------------------------------------------ 시트

function ensurePlaces_(ss) {
  if (ss.getSheetByName('Places')) return;
  var sh = ss.insertSheet('Places');
  sh.getRange(1, 1, PLACES_DEFAULT.length + 1, 5).setValues([PLACES_HEAD].concat(PLACES_DEFAULT));
  sh.getRange(1, 1, 1, 5).setFontWeight('bold');
  sh.setFrozenRows(1);
}

function prodBook_() {
  var id = props_.getProperty('PROD_SHEET_ID');
  if (id) return SpreadsheetApp.openById(id);
  var ss = SpreadsheetApp.create('Production Log');
  DriveApp.getFileById(ss.getId()).moveTo(folder_());
  ss.getSheets()[0].setName('Log');
  props_.setProperty('PROD_SHEET_ID', ss.getId());
  return ss;
}

/** 탭이 없으면 만들고, 머리글이 짧으면(나중에 추가된 열) 채움. */
function prodTab_(name, head) {
  var ss = prodBook_(), sh = ss.getSheetByName(name) || ss.insertSheet(name);
  if (!sh.getRange('A1').getValue() || !sh.getRange(1, head.length).getValue()) {
    sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function prodSheet_() {
  var sh = prodTab_('Log', PROD_HEAD);
  prodTab_('Stock moves', MOVES_HEAD);
  prodTab_('Use', USE_HEAD);
  return sh;
}

function safeCell_(v) { return typeof v === 'string' && /^[=+\-@']/.test(v) ? "'" + v : v; }

function appendRows_(sh, rows, textCols) {
  if (!rows.length) return;
  var r = sh.getLastRow() + 1;
  (textCols || []).forEach(function (c) { sh.getRange(r, c[0], rows.length, c[1]).setNumberFormat('@'); });
  sh.getRange(r, 1, rows.length, rows[0].length).setValues(rows.map(function (x) { return x.map(safeCell_); }));
}

// ------------------------------------------------------------------ 위치 (Places 탭)

var placesMemo_ = null;

/** [{ floor, type, spot, short, count: 'daily'|'sunday', group: 'Fridge'|'Shelf', label }] — Places 탭 순서. */
function prodPlaces_() {
  if (placesMemo_ && placesMemo_.ver === props_.getProperty('RCP_VER')) return placesMemo_.list;
  var key = 'places_' + (props_.getProperty('RCP_VER') || '0'), cache = CacheService.getScriptCache(), hit = cache.get(key), list;
  if (hit) {
    list = JSON.parse(hit);
  } else {
    var ss = recipeBook_();
    ensurePlaces_(ss);
    var sh = ss.getSheetByName('Places'), n = sh.getLastRow() - 1;
    var rows = n > 0 ? sh.getRange(2, 1, n, 5).getDisplayValues() : [];
    list = rows.map(function (r) { return r.map(function (v) { return String(v).trim(); }); })
      .filter(function (r) { return r[0] && r[2]; })
      .map(function (r) {
        var type = /^sh/i.test(r[1]) ? 'Shelf' : /^fr(ee|ig)?z/i.test(r[1]) || /^freezer/i.test(r[1]) ? 'Freezer' : 'Fridge';
        return { floor: r[0], type: type, spot: r[2], short: r[3] || r[2],
                 count: /^d/i.test(r[4]) ? 'daily' : /^s|^w/i.test(r[4]) ? 'sunday' : (type === 'Fridge' ? 'daily' : 'sunday'),
                 group: type === 'Shelf' ? 'Shelf' : 'Fridge',
                 label: r[0] + ' · ' + (type === 'Shelf' && !/shelf/i.test(r[2]) ? 'Shelf · ' : '') + r[2] };
      });
    cache.put(key, JSON.stringify(list), RECIPE_CACHE_SEC);
  }
  placesMemo_ = { ver: props_.getProperty('RCP_VER'), list: list };
  return list;
}

function prodPlace_(label) {
  var want = String(label || '').trim().toLowerCase();
  return want ? prodPlaces_().filter(function (p) { return p.label.toLowerCase() === want; })[0] || null : null;
}

// ------------------------------------------------------------------ 배치 (Log 탭의 한 줄)

function fmtGrams_(g) {
  var v = g < 10 ? Math.round(g * 10) / 10 : Math.round(g);
  return String(v);
}

function addDaysIso_(iso, days) {
  var p = iso.split('-');
  return Utilities.formatDate(new Date(Date.UTC(+p[0], +p[1] - 1, +p[2] + days, 12)), 'UTC', 'yyyy-MM-dd');
}

function daysBetween_(a, b) {
  var pa = a.split('-'), pb = b.split('-');
  return Math.round((Date.UTC(+pb[0], +pb[1] - 1, +pb[2]) - Date.UTC(+pa[0], +pa[1] - 1, +pa[2])) / 86400000);
}

function todayIsoParis_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'); }
function nowMinParis_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm'); }

function round1_(n) { return Math.round(n * 10) / 10; }

/** 박스 수 검사 (0 < n ≤ max, 소수 1자리). allowZero = 재고 조사·정정. */
function boxesNum_(v, label, allowZero, max) {
  var n = recipeNum_(v);
  if (n === null || isNaN(n) || n < 0 || (!allowZero && n === 0) || n > (max || 999)) fail_(label + ': please enter a number of boxes.');
  if (Math.abs(n * 10 - Math.round(n * 10)) > 1e-6) fail_(label + ': one decimal at most (e.g. 2.5).');
  return round1_(n);
}

function lotLeft_(c) {
  var v = c[16];
  return v === '' || v == null ? Number(c[6]) || 0 : Number(v) || 0;
}

function prodEntry_(c, emp) {
  var today = todayIsoParis_();
  return { id: String(c[0]), date: String(c[1]), time: String(c[2]), recipe: String(c[3]), batch: String(c[4]),
           total: Number(c[5]) || 0, boxes: Number(c[6]) || 0, box: String(c[7]), madeBy: String(c[8]),
           useBy: String(c[9]), loggedBy: String(c[10]), recipeId: String(c[11]),
           place: String(c[12] || ''), movedAt: String(c[13] || ''), movedBy: String(c[14] || ''), splitFrom: String(c[15] || ''),
           left: lotLeft_(c), note: String(c[17] || ''), expired: !!c[9] && String(c[9]) < today,
           canDelete: !!emp.supervisor || (String(c[10]) === emp.name && String(c[1]) === today && !c[15]) };
}

function prodRecent_() {
  var sh = prodSheet_(), last = sh.getLastRow(), n = Math.min(last - 1, PROD_SCAN_ROWS);
  if (n < 1) return { sh: sh, first: 2, rows: [] };
  return { sh: sh, first: last - n + 1, rows: sh.getRange(last - n + 1, 1, n, PROD_HEAD.length).getValues() };
}

function findLot_(rec, id) {
  for (var j = rec.rows.length - 1; j >= 0; j--) if (String(rec.rows[j][0]) === id) return j;
  return -1;
}

function nextLotId_() {
  var seq = Number(props_.getProperty('PROD_SEQ') || 0) + 1;
  props_.setProperty('PROD_SEQ', String(seq));
  return 'P' + ('00000' + seq).slice(-6);
}

function moveRow_(type, c, change, leftAfter, place, by, note) {
  return [nowMinParis_(), type, String(c[0]), String(c[3]), String(c[11]), change, leftAfter, place, by, note || ''];
}

function setLeft_(rec, i, left) {
  rec.rows[i][16] = left;
  rec.sh.getRange(rec.first + i, 17).setValue(left);
}

// ------------------------------------------------------------------ 만들기 (Log production)

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
    return { batch: 'base ' + fmtGrams_(baseTotal) + ' g', total: Math.round((baseTotal + baseTotal * sum / 100) * yieldOf_(r)) };
  }
  var mult = recipeNum_(req.mult);
  if (mult === null || isNaN(mult) || mult <= 0 || mult > 100) fail_('Please choose the batch size.');
  mult = Math.round(mult * 1000) / 1000;
  return { batch: '×' + mult, total: Math.round(sum * mult * yieldOf_(r)) };
}

/** 완성 무게 비율 (YIELD 줄, 없으면 1). Total (g) = 재료 총무게 × 이 비율 = 박스에 들어가는 양. */
function yieldOf_(r) {
  return r.yieldPct ? r.yieldPct / 100 : 1;
}

/** 'Made on' (Admin): 오늘(기본) 또는 지난 LATE_MAX_DAYS 일 안의 날. */
function madeOn_(emp, v) {
  var today = todayIsoParis_(), d = String(v || '').trim();
  if (!d || d === today) return today;
  if (!(emp.admin || emp.supervisor)) fail_('Only managers can log for another day.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || d > today || daysBetween_(d, today) > LATE_MAX_DAYS) fail_('Made on: please choose a date in the last ' + LATE_MAX_DAYS + ' days.');
  return d;
}

/**
 * 배치 한 줄을 씀 (lock 안에서). opts: { emp, r, boxes, box, maker, place, date, batch, total, note }.
 * → cells (Log 의 한 줄)
 */
function writeLot_(o) {
  var id = nextLotId_(), today = todayIsoParis_();
  var time = o.date === today ? Utilities.formatDate(new Date(), TZ, 'HH:mm') : '';
  var useBy = o.r.keepDays != null ? addDaysIso_(o.date, o.r.keepDays) : '';
  var cells = [id, o.date, time, o.r.name, o.batch, o.total, o.boxes, o.box, o.maker, useBy, o.emp.name, o.r.id,
               o.place.label, '', '', '', o.boxes, o.note || ''];
  appendRows_(prodSheet_(), [cells], [[1, 5], [8, 10]]); // Total, Boxes(F·G) 는 숫자 (시트에서 합계 가능)
  appendRows_(prodTab_('Stock moves', MOVES_HEAD), [moveRow_('PRODUCE', cells, o.boxes, o.boxes, o.place.label, o.emp.name, o.note)]);
  return cells;
}

function prodMaker_(emp, v) {
  if (!v || String(v).trim().toLowerCase() === emp.name.toLowerCase()) return emp.name;
  if (!(emp.admin || emp.supervisor)) fail_('Only managers can log for someone else.');
  var other = findEmployee_(v);
  if (!other) fail_('Unknown person: ' + v);
  return other.name;
}

function prodRecipe_(id) {
  var r = recipesAll_().recipes.filter(function (x) { return x.id === String(id); })[0];
  if (!r) fail_('This recipe is not in the list any more.');
  return r;
}

/**
 * Log production. Admin 이상: madeOn(늦게 적기, 사용기한도 그 날로), missing:true(빠진 배치 — 배치 크기 없이 박스 수만).
 */
function prodLog_(req) {
  var emp = recipeUser_(req), all = recipesAll_(), r = prodRecipe_(req.id), admin = emp.admin || emp.supervisor;
  if (r.count === 'none') fail_('This recipe is not stored, so there is nothing to log.');
  var boxes = boxesNum_(req.boxes, 'Boxes');
  var box = String(req.box || r.box || '').trim();
  if (!box) fail_('Please choose the box.');
  if (!(all.boxes.some(function (b) { return b.name === box; }) || box === r.box)) fail_('Unknown box: ' + box);
  var maker = prodMaker_(emp, req.madeBy);
  var place = prodPlace_(req.place);
  if (!place) fail_(req.place ? 'Unknown place: ' + req.place : 'Please choose where it is stored.');
  var date = madeOn_(emp, req.madeOn), b, note = '';
  if (req.missing) {
    if (!admin) fail_('Only managers can add a missing batch.');
    b = { batch: 'added later', total: '' };
    note = 'Missing batch added ' + nowMinParis_() + ' by ' + emp.name;
  } else {
    b = prodBatch_(r, req);
    if (date !== todayIsoParis_()) note = 'Logged late ' + nowMinParis_() + ' by ' + emp.name;
  }
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  var cells;
  try {
    cells = writeLot_({ emp: emp, r: r, boxes: boxes, box: box, maker: maker, place: place, date: date,
                        batch: b.batch, total: b.total, note: note });
  } finally {
    lock.releaseLock();
  }
  return { ok: true, entry: prodEntry_(cells, emp) };
}

/** 이 레시피의 최근 기록 10개 (최신이 위). */
function prodList_(req) {
  var emp = recipeUser_(req), id = String(req.id || '');
  var rows = prodRecent_().rows.filter(function (c) { return String(c[11]) === id; });
  return { ok: true, entries: rows.slice(-10).reverse().map(function (c) { return prodEntry_(c, emp); }) };
}

/** 지우기: 내가 오늘 적은 것(나눈 줄 제외), Supervisor 는 모두. 행을 지우고 Stock moves 에 DELETE. */
function prodDelete_(req) {
  var emp = recipeUser_(req), id = String(req.entry || '');
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var rec = prodRecent_(), i = findLot_(rec, id);
    if (!id || i < 0) fail_('This entry is not in the log any more.');
    if (!prodEntry_(rec.rows[i], emp).canDelete) fail_('You can only delete what you logged today.');
    var c = rec.rows[i];
    appendRows_(prodTab_('Stock moves', MOVES_HEAD), [moveRow_('DELETE', c, -lotLeft_(c), 0, String(c[12]), emp.name)]);
    rec.sh.deleteRow(rec.first + i);
  } finally {
    lock.releaseLock();
  }
  return { ok: true, entry: id };
}

// ------------------------------------------------------------------ 옮기기 (누구나)

/**
 * 배치 i 에서 n 박스를 place 로 (lock 안에서). n = 남은 전부면 줄의 위치만 바꿈.
 * 일부면 나눔: 원래 줄 Boxes·Left·Total 을 줄이고, 옮긴 만큼은 새 줄(Split from = 원래 ID). 합계는 그대로.
 * → { entry: 원래 줄, moved: 새 줄 또는 null }
 */
function moveLot_(rec, i, n, place, emp, note) {
  var row = rec.rows[i], at = nowMinParis_(), left = lotLeft_(row), moves = prodTab_('Stock moves', MOVES_HEAD);
  if (n >= left - 1e-9) {
    var from = String(row[12]);
    row[12] = place.label; row[13] = at; row[14] = emp.name;
    rec.sh.getRange(rec.first + i, 13, 1, 3).setNumberFormat('@').setValues([[place.label, at, emp.name]]);
    appendRows_(moves, [moveRow_('MOVE', row, 0, left, place.label, emp.name, 'from ' + from + (note ? ' · ' + note : ''))]);
    return { entry: row, moved: null };
  }
  if (place.label === String(row[12])) fail_('It is already there. Choose another place.');
  var boxes = Number(row[6]) || 0, total = Number(row[5]) || 0, keepBoxes = round1_(boxes - n), keepLeft = round1_(left - n);
  var keepTotal = row[5] === '' ? '' : Math.round(total * keepBoxes / boxes);
  var cells = [nextLotId_()].concat(row.slice(1, 5).map(String),
    [row[5] === '' ? '' : total - keepTotal, n], row.slice(7, 12).map(String), [place.label, at, emp.name, String(row[0]), n, String(row[17] || '')]);
  row[5] = keepTotal; row[6] = keepBoxes; row[16] = keepLeft;
  rec.sh.getRange(rec.first + i, 6, 1, 2).setValues([[keepTotal, keepBoxes]]);
  rec.sh.getRange(rec.first + i, 17).setValue(keepLeft);
  appendRows_(rec.sh, [cells], [[1, 5], [8, 10]]);
  appendRows_(moves, [moveRow_('MOVE', cells, 0, n, place.label, emp.name, 'from ' + row[12] + ' (' + row[0] + ')' + (note ? ' · ' + note : ''))]);
  return { entry: row, moved: cells };
}

function prodMove_(req) {
  var emp = recipeUser_(req), id = String(req.entry || ''), place = prodPlace_(req.place);
  if (!place) fail_('Please choose the new place.');
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  var out;
  try {
    var rec = prodRecent_(), i = findLot_(rec, id);
    if (!id || i < 0) fail_('This entry is not in the log any more.');
    var left = lotLeft_(rec.rows[i]);
    if (!(left > 0)) fail_('This batch is used up.');
    var n = req.boxes == null || req.boxes === '' ? left : boxesNum_(req.boxes, 'Boxes to move');
    if (n > left + 1e-9) fail_('Boxes to move: between 0.1 and ' + left + '.');
    out = moveLot_(rec, i, n, place, emp);
  } finally {
    lock.releaseLock();
  }
  return { ok: true, entry: prodEntry_(out.entry, emp), moved: out.moved ? prodEntry_(out.moved, emp) : null };
}

// ------------------------------------------------------------------ 정정 (Admin)

function stockAdmin_(req) {
  var emp = recipeUser_(req);
  if (!(emp.admin || emp.supervisor)) fail_('Only managers can do this.');
  return emp;
}

/** 배치의 남은 박스를 바로잡음. 소비량이 아니라 CORRECT 로 기록. */
function prodCorrect_(req) {
  var emp = stockAdmin_(req), id = String(req.entry || ''), left = boxesNum_(req.left, 'Boxes left', true);
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  var c;
  try {
    var rec = prodRecent_(), i = findLot_(rec, id);
    if (!id || i < 0) fail_('This entry is not in the log any more.');
    c = rec.rows[i];
    var before = lotLeft_(c);
    if (Math.abs(before - left) < 1e-9) return { ok: true, entry: prodEntry_(c, emp) };
    setLeft_(rec, i, left);
    appendRows_(prodTab_('Stock moves', MOVES_HEAD),
      [moveRow_('CORRECT', c, round1_(left - before), left, String(c[12]), emp.name, String(req.note || '').slice(0, 200))]);
  } finally {
    lock.releaseLock();
  }
  return { ok: true, entry: prodEntry_(c, emp) };
}

// ------------------------------------------------------------------ 재고 (Stock)

/** 남은 배치들 (Left > 0). */
function liveLots_(rec) {
  var out = [];
  rec.rows.forEach(function (c, i) { if (/^P\d+$/.test(String(c[0])) && lotLeft_(c) > 0) out.push(i); });
  return out;
}

/** 레시피별 하루 평균 소비량 (Use 탭, 최근 USE_WINDOW_DAYS 일). { recipeId: avg } */
function useAverages_() {
  var sh = prodTab_('Use', USE_HEAD), last = sh.getLastRow(), n = Math.min(last - 1, 2000), today = todayIsoParis_(), by = {};
  if (n < 1) return {};
  var since = addDaysIso_(today, -USE_WINDOW_DAYS);
  sh.getRange(last - n + 1, 1, n, USE_HEAD.length).getValues().forEach(function (r) {
    var date = String(r[0]).slice(0, 10), id = String(r[3]);
    if (!id || date < since) return;
    var x = by[id] || (by[id] = { used: 0, start: date });
    x.used += Number(r[7]) || 0;
    var from = addDaysIso_(date, -(Number(r[4]) || 1));
    if (from < x.start) x.start = from;
  });
  var out = {};
  Object.keys(by).forEach(function (id) {
    var span = Math.max(1, daysBetween_(by[id].start, today));
    out[id] = Math.round(by[id].used / span * 100) / 100;
  });
  return out;
}

/** 종합본: 레시피마다 합계, 위치별 분량, 배치들, 하루 평균, 남은 일수. */
function stockView_(req) {
  var emp = recipeUser_(req), rec = prodRecent_(), avg = useAverages_(), places = prodPlaces_(), items = {};
  var order = places.map(function (p) { return p.label; });
  liveLots_(rec).forEach(function (i) {
    var c = rec.rows[i], id = String(c[11]), e = prodEntry_(c, emp);
    var it = items[id] || (items[id] = { recipeId: id, recipe: e.recipe, total: 0, where: {}, lots: [], expired: false });
    it.total = round1_(it.total + e.left);
    var wk = e.place + '\n' + e.box;
    it.where[wk] = round1_((it.where[wk] || 0) + e.left);
    it.lots.push(e);
    if (e.expired) it.expired = true;
  });
  var list = Object.keys(items).map(function (id) {
    var it = items[id], a = id in avg ? avg[id] : null; // null = 아직 조사 기록 없음, 0 = 조사했지만 소비 없음
    it.places = Object.keys(it.where).map(function (k) { var a = k.split('\n'); return { place: a[0], box: a[1], left: it.where[k] }; })
      .sort(function (x, y) { return (order.indexOf(x.place) + 1 || 999) - (order.indexOf(y.place) + 1 || 999); });
    delete it.where;
    it.avg = a;
    it.daysLeft = a > 0 ? Math.round(it.total / a * 10) / 10 : null;
    return it;
  }).sort(function (x, y) {
    var dx = x.daysLeft == null ? 1e9 : x.daysLeft, dy = y.daysLeft == null ? 1e9 : y.daysLeft;
    return dx - dy || (x.recipe < y.recipe ? -1 : 1);
  });
  return { ok: true, today: todayIsoParis_(), items: list,
           lastCount: { daily: props_.getProperty('COUNT_LAST_daily') || '', sunday: props_.getProperty('COUNT_LAST_sunday') || '' } };
}

// ------------------------------------------------------------------ 재고 조사 (Count / Sunday, Admin)

function countKind_(v) { return v === 'sunday' ? 'sunday' : 'daily'; }

/** 이 조사에서 셀 (위치, 레시피)인지. Daily = Daily 위치의 Daily 레시피, Sunday = 나머지 전부. */
function inCount_(kind, place, recipe) {
  if (recipe && recipe.count === 'none') return false; // 재고로 두지 않는 레시피는 조사하지 않음
  var daily = !!place && place.count === 'daily' && (!recipe || recipe.count !== 'sunday');
  return kind === 'daily' ? daily : !daily;
}

/** 조사 화면: 이 조사에 해당하는 위치들(Places 순서)과 그 안의 레시피별 남은 양. 빈 위치도 (빠진 것 추가용). */
function countView_(req) {
  var emp = stockAdmin_(req), kind = countKind_(req.kind), rec = prodRecent_(), recipes = {}, out = [];
  recipesAll_().recipes.forEach(function (r) { recipes[r.id] = r; });
  var places = prodPlaces_().filter(function (p) { return kind === 'sunday' || p.count === 'daily'; });
  var at = {};
  liveLots_(rec).forEach(function (i) {
    var e = prodEntry_(rec.rows[i], emp), p = prodPlace_(e.place);
    if (!inCount_(kind, p, recipes[e.recipeId])) return;
    var key = (p ? p.label : e.place) + '\n' + e.recipeId;
    var x = at[key] || (at[key] = { place: p ? p.label : e.place, recipeId: e.recipeId, recipe: e.recipe, left: 0, expired: false, box: e.box });
    x.left = round1_(x.left + e.left);
    if (x.box !== e.box) x.box = 'mixed';
    if (e.expired) x.expired = true;
  });
  places.forEach(function (p) {
    out.push({ place: p.label, short: p.short, floor: p.floor, items: Object.keys(at).map(function (k) { return at[k]; })
      .filter(function (x) { return x.place === p.label; }).sort(function (a, b) { return a.recipe < b.recipe ? -1 : 1; }) });
  });
  // Places 탭에 없는 옛 위치에 남은 것 (위치 이름을 바꾼 경우)
  Object.keys(at).forEach(function (k) {
    var x = at[k];
    if (prodPlace_(x.place)) return;
    var g = out.filter(function (o) { return o.place === x.place; })[0];
    if (!g) out.push(g = { place: x.place || 'No place', short: x.place || '?', floor: '', items: [] });
    g.items.push(x);
  });
  return { ok: true, kind: kind, places: out, last: props_.getProperty('COUNT_LAST_' + kind) || '',
           recipes: recipesAll_().recipes.map(function (r) { return { id: r.id, name: r.name, box: r.box }; }) };
}

/** 레시피의 배치들(이 위치) — 오래된 것부터 (사용기한, 만든 날). */
function lotsAt_(rec, recipeId, placeLabel) {
  return liveLots_(rec).filter(function (i) { return String(rec.rows[i][11]) === recipeId && String(rec.rows[i][12]) === placeLabel; })
    .sort(function (a, b) {
      var x = rec.rows[a], y = rec.rows[b];
      return String(x[9] || '9999') < String(y[9] || '9999') ? -1 : String(x[9] || '9999') > String(y[9] || '9999') ? 1
        : String(x[1]) < String(y[1]) ? -1 : 1;
    });
}

/**
 * 조사 저장 (Admin). 순서: added(빠진 배치) → moves(조사 중 찾은 이동) → counts.
 *   added: [{ place, recipeId, boxes, madeOn }]          → 늦게 적은 생산 (소비량 아님)
 *   moves: [{ recipeId, from, to, boxes }]                → 이동 (소비량 아님)
 *   counts: [{ place, recipeId, boxes, waste }]           → 화면에 나온 모든 줄 (안 바꾼 줄도 = 그대로 확인)
 *     waste: 사용기한이 지난 배치를 버림 → WASTE.  센 양 < 앱 = 오래된 배치부터 줄임(COUNT, 소비).  센 양 > 앱 = CORRECT(+).
 * Use 탭에 레시피별 한 줄. → { used: [{ recipe, used, wasted, corrected }] }
 */
function countSave_(req) {
  var emp = stockAdmin_(req), kind = countKind_(req.kind), today = todayIsoParis_();
  var added = Array.isArray(req.added) ? req.added : [], moves = Array.isArray(req.moves) ? req.moves : [];
  var counts = Array.isArray(req.counts) ? req.counts : [];
  if (added.length + moves.length + counts.length > 2000) fail_('Too many lines.');
  var place = function (label) { var p = prodPlace_(label); if (!p) fail_('Unknown place: ' + label); return p; };
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  var summary = {}, sum = function (id, name) {
    return summary[id] || (summary[id] = { recipeId: id, recipe: name, before: 0, counted: 0, used: 0, wasted: 0, corrected: 0 });
  };
  try {
    var all = recipesAll_();
    added.forEach(function (a) {
      var r = prodRecipe_(a.recipeId), p = place(a.place);
      writeLot_({ emp: emp, r: r, boxes: boxesNum_(a.boxes, r.name), box: r.box || (all.boxes[0] && all.boxes[0].name) || '',
                  maker: emp.name, place: p, date: madeOn_(emp, a.madeOn), batch: 'added at count', total: '',
                  note: 'Found at ' + kind + ' count ' + nowMinParis_() + ' by ' + emp.name });
    });
    var rec = prodRecent_();
    moves.forEach(function (m) {
      var from = place(m.from), to = place(m.to), n = boxesNum_(m.boxes, 'Move');
      lotsAt_(rec, String(m.recipeId), from.label).forEach(function (i) {
        if (n <= 1e-9) return;
        var take = Math.min(n, lotLeft_(rec.rows[i]));
        moveLot_(rec, i, take, to, emp, 'found at ' + kind + ' count');
        n = round1_(n - take);
      });
      rec = prodRecent_(); // 나눈 줄이 생겼을 수 있음
    });
    var moveRows = [];
    counts.forEach(function (x) {
      var p = place(x.place), id = String(x.recipeId), lots = lotsAt_(rec, id, p.label);
      var counted = boxesNum_(x.boxes, 'Count', true);
      var name = lots.length ? String(rec.rows[lots[0]][3]) : ((all.recipes.filter(function (r) { return r.id === id; })[0] || {}).name || id);
      var s = sum(id, name), before = lots.reduce(function (n, i) { return n + lotLeft_(rec.rows[i]); }, 0);
      s.before = round1_(s.before + before);
      s.counted = round1_(s.counted + counted);
      if (x.waste) {
        lots = lots.filter(function (i) {
          var c = rec.rows[i];
          if (!(c[9] && String(c[9]) < today)) return true;
          var l = lotLeft_(c);
          s.wasted = round1_(s.wasted + l);
          setLeft_(rec, i, 0);
          moveRows.push(moveRow_('WASTE', c, -l, 0, p.label, emp.name, 'past use-by, ' + kind + ' count'));
          return false;
        });
      }
      var have = lots.reduce(function (n, i) { return n + lotLeft_(rec.rows[i]); }, 0), diff = round1_(have - counted);
      if (diff > 0) {
        s.used = round1_(s.used + diff);
        lots.forEach(function (i) {
          if (diff <= 1e-9) return;
          var c = rec.rows[i], l = lotLeft_(c), take = Math.min(diff, l);
          setLeft_(rec, i, round1_(l - take));
          moveRows.push(moveRow_('COUNT', c, -round1_(take), round1_(l - take), p.label, emp.name, kind + ' count'));
          diff = round1_(diff - take);
        });
      } else if (diff < 0) {
        if (!lots.length) fail_(name + ' at ' + p.short + ': not in the app here. Add it with “Not in the list”.');
        var i = lots[lots.length - 1], c = rec.rows[i], l = lotLeft_(c);
        s.corrected = round1_(s.corrected - diff);
        setLeft_(rec, i, round1_(l - diff));
        moveRows.push(moveRow_('CORRECT', c, -diff, round1_(l - diff), p.label, emp.name, 'more than the app at ' + kind + ' count'));
      }
    });
    appendRows_(prodTab_('Stock moves', MOVES_HEAD), moveRows);
    // Use 탭: 레시피마다 한 줄. Days = 이 레시피의 지난 조사부터 (없으면 Daily 1일, Sunday 7일)
    var use = prodTab_('Use', USE_HEAD), lastUse = {}, ul = use.getLastRow();
    if (ul > 1) {
      use.getRange(Math.max(2, ul - 1999), 1, Math.min(ul - 1, 2000), 4).getValues().forEach(function (r) {
        if (String(r[3])) lastUse[String(r[3])] = String(r[0]).slice(0, 10);
      });
    }
    var useRows = Object.keys(summary).map(function (id) {
      var s = summary[id], prev = lastUse[id], days = prev ? Math.max(1, daysBetween_(prev, today)) : (kind === 'sunday' ? 7 : 1);
      return [nowMinParis_(), kind === 'sunday' ? 'Sunday' : 'Daily', s.recipe, id, days, s.before, s.counted, s.used, s.wasted, s.corrected, emp.name];
    });
    appendRows_(use, useRows, [[1, 4]]);
    props_.setProperty('COUNT_LAST_' + kind, nowMinParis_() + ' · ' + emp.name);
  } finally {
    lock.releaseLock();
  }
  return { ok: true, kind: kind, used: Object.keys(summary).map(function (id) { return summary[id]; }) };
}

/** 편집기에서 실행: 위치 목록과 지금 재고를 실행 로그에. */
function checkStock() {
  bumpRecipes_();
  prodPlaces_().forEach(function (p) {
    Logger.log(p.short + '  ' + p.label + '  (' + p.type + ', count ' + p.count + ')');
  });
  var rec = prodRecent_(), lots = liveLots_(rec);
  Logger.log(lots.length + ' batches in stock');
  return lots.length;
}
