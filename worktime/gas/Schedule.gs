// Schedule — Supervisor 가 스프레드시트에서 직접 편집하는 주간 스케줄을 앱에서 읽기 전용으로 보여주고,
// 각 주의 스케줄을 "2주 전 화요일"에 읽고 동의했다는 확인을 받음.
//
// WorkTime Config 의 Schedules 탭 (setup 이 만듦):  Name | Spreadsheet | Team
//   Name        : 앱에 보이는 이름 (예: Kitchen). 같은 이름으로 여러 줄 = 여러 파일(분기마다 새 파일 등)을 합쳐서 보여줌
//   Spreadsheet : 스케줄 스프레드시트 URL (또는 ID). 웹 게시 필요 없음 — 이 스크립트 소유자 계정이 열 수 있으면 됨
//   Team        : 확인해야 하는 팀 (쉼표로 여러 개). 비우면 전체. Supervisor 는 확인 대상에서 제외(작성자이므로)
// 스프레드시트의 각 탭 = 한 달 (탭 순서 그대로 보여줌). 'Monday … Sunday' 가 있는 줄에서 한 주가 시작하고,
// 바로 다음 줄이 날짜. 날짜로 그 주의 월요일을 계산해 주를 구분함 (두 달에 걸친 주는 두 탭 어디서 확인해도 같은 주).
// 확인 기록: Announcement Records 의 Confirmations 탭에 'Schedule · Kitchen · 2026-11-16 · <지문>' 형태로.
//   지문 = 그 주 내용(글자·색)의 해시. 확인한 뒤 시트가 바뀌면 지문이 달라져 "다시 확인" 상태가 됨.
// 확인 요청: 주 시작(월요일) 13일 전 = 2주 전 화요일 09:00 부터, 확인할 때까지 매일 09:00 (주가 시작되면 끝).
// 변경: 30분마다 검사(checkScheduleChanges) -> 확인했던 사람에게 "바뀌었으니 다시 확인" 알림 (주가 끝날 때까지).
// 사람: Schedule Colors 탭 (Name | Color, Color 칸을 그 사람 색으로 칠함). 칸 색·글자 속 이름으로 누구 근무인지 알아냄
//   -> 앱의 My shifts / By day 화면, 그리고 "내 근무가 바뀐 사람에게만" 변경 알림.
// 직원의 변경 요청은 Request 로 (앱의 주마다 'Request a change' -> Supervisor 에게 바로 알림).

var SCHED_CONFIRM_DAYS = 13;
var SCHED_PUSH_TITLE = '📅 Schedule: please read and confirm';
var SCHED_CHANGED_TITLE = '📅 Schedule changed: please confirm again';
var SCHED_CACHE_SEC = 120; // 시트 수정이 앱에 보이기까지 최대 2분
var SCHED_MAX_ROWS = 400;
var SCHED_MAX_COLS = 26;
var SCHED_HEAD = ['Name', 'Spreadsheet', 'Team'];

var WEEKDAY_NAMES_ = [
  ['monday', 'lundi', '월요일', '월'], ['tuesday', 'mardi', '화요일', '화'], ['wednesday', 'mercredi', '수요일', '수'],
  ['thursday', 'jeudi', '목요일', '목'], ['friday', 'vendredi', '금요일', '금'], ['saturday', 'samedi', '토요일', '토'],
  ['sunday', 'dimanche', '일요일', '일'],
];
var MONTH_RE_ = [/^jan/, /^(f[eé]v|feb)/, /^(mar)/, /^(avr|apr)/, /^(mai|may)/, /^(juin|jun)/, /^(juil|jul)/,
                 /^(ao[uû]|aug)/, /^sep/, /^oct/, /^nov/, /^d[eé]c/];
var MONTH_LONG_ = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October',
                   'November', 'December'];
var MONTH_SHORT_ = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ------------------------------------------------------------------ setup / config

/** setup() 에서 호출: WorkTime Config 에 Schedules 탭 (없을 때만). */
function ensureScheduleConfig_(config) {
  if (!config.getSheetByName('Schedules')) {
    var sh = config.insertSheet('Schedules');
    sh.getRange(1, 1, 1, 3).setValues([SCHED_HEAD]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  if (!config.getSheetByName('Schedule Colors')) {
    var cs = config.insertSheet('Schedule Colors');
    cs.getRange(1, 1, 1, 2).setValues([['Name', 'Color']]).setFontWeight('bold');
    cs.setFrozenRows(1);
  }
}

/**
 * Schedule Colors 탭: Name | Color. Color 칸은 스케줄에서 쓰는 색으로 칸을 칠하면 됨 (또는 #6b1f45 처럼 글자로).
 * -> { byColor: { '#6b1f45': 'Chris' }, colors: { Chris: '#6b1f45' }, names: [...] }
 * Name 은 Employees 이름과 같아야 그 사람에게 변경 알림이 감 (다르면 화면에 이름만 표시).
 */
function schedPeople_() {
  var out = { byColor: {}, colors: {}, names: [] };
  var sh = SpreadsheetApp.openById(requiredProp_('CONFIG_SHEET_ID')).getSheetByName('Schedule Colors');
  if (!sh || sh.getLastRow() < 2) return out;
  var rng = sh.getRange(2, 1, sh.getLastRow() - 1, 2), text = rng.getDisplayValues(), bg = rng.getBackgrounds();
  var staff = activeEmployees_();
  text.forEach(function (r, i) {
    var name = String(r[0]).trim(), typed = String(r[1]).trim().toLowerCase(), color = '';
    if (!name) return;
    if (/^#?[0-9a-f]{6}$/.test(typed)) color = typed.charAt(0) === '#' ? typed : '#' + typed;
    else if (bg[i][1] && !/^#?f{6}$/i.test(bg[i][1])) color = String(bg[i][1]).toLowerCase();
    var emp = staff.filter(function (e) { return e.name.toLowerCase() === name.toLowerCase(); })[0];
    if (emp) name = emp.name;
    if (out.names.indexOf(name) < 0) out.names.push(name);
    if (color) { out.byColor[color] = name; out.colors[name] = color; }
  });
  return out;
}

/** 칸의 글자에 이 사람 이름이 있는지 ('Chris 23:00' -> Chris). 전체 이름 또는 첫 단어. */
function textHasName_(text, name) {
  var norm = function (x) { return ' ' + String(x).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim() + ' '; };
  var t = norm(text), n = norm(name);
  if (t.trim() === '' || n.trim() === '') return false;
  return t.indexOf(n) >= 0 || t.indexOf(' ' + n.trim().split(' ')[0] + ' ') >= 0;
}

/**
 * 한 주 블록 -> 근무 칸 목록 [{ d: 0~6, date, zone, role, start, end, text, names: [], color }].
 * 요일 열 = 첫 줄의 요일 이름 칸. 그 왼쪽 열 = 라벨 (첫 열: 시간대 'Morning Time zone 1', 마지막 열: 역할 P/F/W).
 * 사람 = 칸 색(Schedule Colors) 또는 칸 글자 속 이름. 라벨 열에 쓰인 색(예: 진한 회색 배경)은 디자인으로 보고 무시.
 * 시간 = 같은 시간대(라벨 블록) 안, 같은 열의 'HH:MM' 칸들 (첫 번째 = 시작, 두 번째 = 끝).
 */
function weekSlots_(rows, people, monday) {
  if (rows.length < 3) return [];
  var head = rows[0], first = -1, dayOf = head.map(function (c) { return c ? weekdayIndex_(c.t) : -1; });
  for (var j = 0; j < dayOf.length && first < 0; j++) if (dayOf[j] >= 0) first = j;
  if (first < 0) return [];
  var isTime = function (t) { return /^\s*\d{1,2}[:h.]\d{2}\s*$/.test(String(t || '')); };
  // 시간대의 시작·끝 시간 칸 (사람 색으로 칠한 칸은 근무 칸)
  var zoneTime = function (c) { return c && isTime(c.t) && !people.byColor[String(c.bg || '').toLowerCase()]; };
  var design = {};
  rows.forEach(function (r) {
    for (var k = 0; k < first; k++) if (r[k] && r[k].bg) design[r[k].bg.toLowerCase()] = 1;
  });
  // 줄마다 시간대(첫 열 라벨) 시작 줄
  var zoneAt = [], cur = 2;
  for (var r = 2; r < rows.length; r++) {
    if (first > 0 && rows[r][0] && rows[r][0].t) cur = r;
    zoneAt[r] = cur;
  }
  var zoneEnd = function (z) { for (var x = z + 1; x < rows.length; x++) if (zoneAt[x] !== z) return x - 1; return rows.length - 1; };
  var label = function (r, k) { return k >= 0 && rows[r][k] && rows[r][k].t ? String(rows[r][k].t).replace(/\s*\n\s*/g, ' ').trim() : ''; };
  var out = [];
  for (r = 2; r < rows.length; r++) {
    for (j = first; j < rows[r].length; j++) {
      var cell = rows[r][j];
      if (!cell || dayOf[j] < 0 || zoneTime(cell)) continue;
      var bg = String(cell.bg || '').toLowerCase(), names = [];
      if (people.byColor[bg]) names.push(people.byColor[bg]);
      if (cell.t) {
        people.names.forEach(function (n) { if (names.indexOf(n) < 0 && textHasName_(cell.t, n)) names.push(n); });
      }
      if (!names.length && (!bg || design[bg])) continue; // 빈 칸 / 배경색
      var z = zoneAt[r], times = [];
      for (var x = z; x <= zoneEnd(z); x++) if (zoneTime(rows[x][j])) times.push(String(rows[x][j].t).trim());
      for (var dj = j; dj < j + (cell.cs || 1) && dj < dayOf.length; dj++) {
        if (dayOf[dj] < 0) continue;
        out.push({ d: dayOf[dj], date: addDays_(monday, dayOf[dj]), zone: first > 0 ? label(z, 0) : '',
                   role: first > 1 ? label(r, first - 1) : '', start: times[0] || '', end: times[1] || '',
                   text: cell.t || '', names: names, color: bg });
      }
    }
  }
  return out;
}

function hash10_(s) { return bytesToHex_(sha256_(utf8_(s))).slice(0, 10).toLowerCase(); }

/** 스프레드시트 URL 또는 ID -> ID. */
function sheetIdOf_(s) {
  s = String(s || '').trim();
  var m = s.match(/\/d\/([\w-]{20,})/);
  if (m) return m[1];
  return /^[\w-]{20,}$/.test(s) ? s : '';
}

/** Schedules 탭 -> [{ name, files: [id…], teams: [] }] (시트 순서). */
function schedules_() {
  var sh = SpreadsheetApp.openById(requiredProp_('CONFIG_SHEET_ID')).getSheetByName('Schedules');
  if (!sh || sh.getLastRow() < 2) return [];
  var map = {}, order = [];
  sh.getRange(2, 1, sh.getLastRow() - 1, 3).getDisplayValues().forEach(function (r) {
    var id = sheetIdOf_(r[1]);
    if (!id) return;
    var name = String(r[0]).trim() || 'Schedule';
    if (!map[name]) { map[name] = { name: name, files: [], teams: [] }; order.push(name); }
    var s = map[name];
    if (s.files.indexOf(id) < 0) s.files.push(id);
    String(r[2]).split(',').forEach(function (t) {
      t = t.trim();
      if (t && s.teams.indexOf(t) < 0) s.teams.push(t);
    });
  });
  return order.map(function (n) { return map[n]; });
}

/** 확인해야 하는 사람: 재직 중, Supervisor 아님, (팀 지정 시) 그 팀. */
function schedRecipients_(s) {
  var teams = s.teams.map(function (t) { return t.toLowerCase(); });
  return activeEmployees_().filter(function (e) {
    return !e.supervisor && (!teams.length || (e.team && teams.indexOf(e.team.toLowerCase()) >= 0));
  });
}

function isSchedRecipient_(s, name) {
  return schedRecipients_(s).some(function (e) { return e.name === name; });
}

function schedKey_(sched, monday) { return 'Schedule · ' + sched + ' · ' + monday; }

// ------------------------------------------------------------------ dates (모두 'yyyy-MM-dd' 문자열)

function todayIso_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'); }

function addDays_(iso, n) {
  var p = iso.split('-');
  return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2] + n)).toISOString().slice(0, 10);
}

function dayLabel_(iso) {
  var p = iso.split('-');
  return +p[2] + ' ' + MONTH_SHORT_[+p[1] - 1];
}

function weekLabel_(monday) {
  return dayLabel_(monday) + ' – ' + dayLabel_(addDays_(monday, 6)) + ' ' + addDays_(monday, 6).slice(0, 4);
}

function weekdayLabel_(iso) {
  var p = iso.split('-');
  var wd = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])).getUTCDay();
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][wd] + ' ' + dayLabel_(iso);
}

/** 확인 요청 시작일 (= 마감 기준일): 월요일 13일 전 화요일. */
function schedDue_(monday) { return addDays_(monday, -SCHED_CONFIRM_DAYS); }

/** 오늘 확인을 요청하는 주들의 월요일: 확인 요청이 시작됐고(화요일 이후) 아직 시작 안 한 주. */
function windowMondays_(today) {
  var p = today.split('-');
  var wd = (new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])).getUTCDay() + 6) % 7; // 월=0
  var out = [];
  for (var m = addDays_(today, 7 - wd); schedDue_(m) <= today; m = addDays_(m, 7)) out.push(m);
  return out;
}

/** 셀 -> 'yyyy-MM-dd' (날짜 값이면 그대로, '1/10' 같은 글자면 오늘에 가장 가까운 해). */
function cellDate_(v, text) {
  var isDate = Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime());
  var m = String(text || '').match(/^\s*(\d{1,2})\s*[\/.\-]\s*(\d{1,2})(?:\s*[\/.\-]\s*(\d{2,4}))?\s*$/);
  if (!m || +m[1] < 1 || +m[1] > 31 || +m[2] < 1 || +m[2] > 12) {
    // 보이는 글자로 못 읽으면 날짜 값 그대로 (정오로 옮겨서 시트·스크립트 시간대 차이로 하루 밀리지 않게)
    return isDate ? Utilities.formatDate(new Date(v.getTime() + 12 * 3600000), TZ, 'yyyy-MM-dd') : null;
  }
  // 보이는 글자('1/10')가 기준 — 날짜 값은 시트 시간대(예: 한국)에 따라 파리 기준 하루 전으로 보일 수 있음
  var pad = function (n) { return ('0' + n).slice(-2); };
  var md = pad(+m[2]) + '-' + pad(+m[1]);
  if (m[3]) return (m[3].length === 2 ? '20' + m[3] : m[3]) + '-' + md;
  if (isDate) return Utilities.formatDate(new Date(v.getTime() + 12 * 3600000), TZ, 'yyyy') + '-' + md;
  var today = todayIso_(), y = +today.slice(0, 4), best = null;
  [y - 1, y, y + 1].forEach(function (yy) {
    var iso = yy + '-' + md, d = Math.abs(Date.parse(iso) - Date.parse(today));
    if (!best || d < best.d) best = { iso: iso, d: d };
  });
  return best.iso;
}

function weekdayIndex_(text) {
  var s = String(text || '').trim().toLowerCase();
  if (!s) return -1;
  for (var i = 0; i < 7; i++) if (WEEKDAY_NAMES_[i].indexOf(s) >= 0) return i;
  return -1;
}

/** 탭 이름 -> 달 (1~12) 또는 0. '10', '2026-10', 'Oct', 'Octobre', '10월' … */
function tabMonth_(name) {
  var s = String(name).trim().toLowerCase(), m;
  if ((m = s.match(/^\d{4}\s*[-\/. ]\s*(\d{1,2})$/))) return +m[1] <= 12 ? +m[1] : 0;
  if ((m = s.match(/^(\d{1,2})(\s*월)?(\s*[-\/. ]\s*\d{2,4})?$/))) return +m[1] >= 1 && +m[1] <= 12 ? +m[1] : 0;
  for (var i = 0; i < 12; i++) if (MONTH_RE_[i].test(s)) return i + 1;
  return 0;
}

// ------------------------------------------------------------------ 시트 읽기

function cacheGet_(key) {
  try {
    var v = CacheService.getScriptCache().get(key);
    return v ? JSON.parse(v) : null;
  } catch (err) { return null; }
}

function cachePut_(key, obj) {
  try { CacheService.getScriptCache().put(key, JSON.stringify(obj), SCHED_CACHE_SEC); } catch (err) { /* 너무 크면 캐시 안 함 */ }
}

/** 한 스케줄의 모든 달(탭): [{ file, tab, month, fileName }] (파일 순서, 탭 순서). 열 수 없는 파일은 errors 에. */
function schedTabs_(s) {
  var out = [], errors = [];
  s.files.forEach(function (id) {
    var hit = cacheGet_('schfile_' + id);
    if (!hit) {
      try {
        var ss = SpreadsheetApp.openById(id);
        hit = { name: ss.getName(), tabs: ss.getSheets().filter(function (sh) { return !sh.isSheetHidden(); })
          .map(function (sh) { return sh.getName(); }) };
        cachePut_('schfile_' + id, hit);
      } catch (err) {
        console.error(err);
        errors.push(id);
        return;
      }
    }
    hit.tabs.forEach(function (t) { out.push({ file: id, tab: t, month: tabMonth_(t), fileName: hit.name }); });
  });
  out.errors = errors;
  return out;
}

/**
 * 탭 하나를 주 단위로 읽음 (2분 캐시).
 * -> { cols: [폭px…], intro: block|null, weeks: [{ monday, label, rows, … }] }
 * 셀: { t: 글자, bg, fc, b: 굵게, i: 기울임, fs: 크기, al: 정렬, rs, cs } (기본값은 생략), 병합으로 가려진 칸은 null.
 */
function readTab_(fileId, tab) {
  var key = 'schtab_' + fileId + '_' + tab, hit = cacheGet_(key);
  if (hit) return hit;
  var sh = SpreadsheetApp.openById(fileId).getSheetByName(tab);
  if (!sh) fail_('This month was not found. Please reload.');
  var nr = Math.min(sh.getLastRow(), SCHED_MAX_ROWS), nc = Math.min(sh.getLastColumn(), SCHED_MAX_COLS);
  var out = { cols: [], intro: null, weeks: [], readAt: nowStamp_().slice(11, 16) };
  if (nr < 1 || nc < 1) return out;
  var rng = sh.getRange(1, 1, nr, nc);
  var text = rng.getDisplayValues(), vals = rng.getValues(), bg = rng.getBackgrounds(), fc = rng.getFontColors(),
      fw = rng.getFontWeights(), fst = rng.getFontStyles(), fs = rng.getFontSizes(), ha = rng.getHorizontalAlignments();
  var white = function (c) { return !c || /^#?f{6}$/i.test(c) || c === 'white'; };
  var blank = function (r, c) { return !String(text[r][c]).trim() && white(bg[r][c]); };

  // 보이는 열 (숨긴 열 제외, 양 끝의 빈 열 제외)
  var cols = [];
  for (var c = 0; c < nc; c++) if (!sh.isColumnHiddenByUser(c + 1)) cols.push(c);
  var emptyCol = function (c) { for (var r = 0; r < nr; r++) if (!blank(r, c)) return false; return true; };
  while (cols.length && emptyCol(cols[0])) cols.shift();
  while (cols.length && emptyCol(cols[cols.length - 1])) cols.pop();
  if (!cols.length) return out;
  out.cols = cols.map(function (c) { return sh.getColumnWidth(c + 1); });

  // 병합: 칸마다 속한 병합 범위. 블록(주) 경계에서 잘리면 블록 안 첫 줄이 새 왼쪽 위 칸이 됨.
  var mergeAt = {};
  rng.getMergedRanges().forEach(function (m) {
    var g = { r0: m.getRow() - 1, c0: m.getColumn() - 1 };
    g.r1 = Math.min(g.r0 + m.getNumRows(), nr) - 1;
    g.c1 = Math.min(g.c0 + m.getNumColumns(), nc) - 1;
    for (var r = g.r0; r <= g.r1; r++) for (var cc = g.c0; cc <= g.c1; cc++) mergeAt[r + ',' + cc] = g;
  });

  var emptyRow = function (r) { return cols.every(function (c) { return blank(r, c); }); };
  // 한 블록(행 a..b)을 셀 배열로
  var block = function (a, b) {
    while (b >= a && emptyRow(b)) b--;
    var rows = [];
    for (var r = a; r <= b; r++) {
      rows.push(cols.map(function (c) {
        var g = mergeAt[r + ',' + c], inMerge = [];
        if (g) {
          inMerge = cols.filter(function (x) { return x >= g.c0 && x <= g.c1; });
          if (r !== Math.max(g.r0, a) || c !== inMerge[0]) return null; // 병합으로 가려진 칸
        }
        // 병합된 칸의 글자·서식은 원래 왼쪽 위 칸에 있음
        var sr = g ? g.r0 : r, sc = g ? g.c0 : c;
        var cell = {}, t = String(text[sr][sc]);
        if (t) cell.t = t;
        if (!white(bg[sr][sc])) cell.bg = bg[sr][sc];
        if (fc[sr][sc] && !/^#?0{6}$/.test(fc[sr][sc])) cell.fc = fc[sr][sc];
        if (fw[sr][sc] === 'bold') cell.b = 1;
        if (fst[sr][sc] === 'italic') cell.i = 1;
        if (fs[sr][sc] && +fs[sr][sc] !== 10) cell.fs = +fs[sr][sc];
        var al = String(ha[sr][sc] || ''); // 'general…' = 자동(글자 왼쪽, 숫자 오른쪽) -> 생략
        if (/^(left|center|right)$/.test(al)) cell.al = al;
        if (g) {
          var rs = Math.min(g.r1, b) - r + 1;
          if (rs > 1) cell.rs = rs;
          if (inMerge.length > 1) cell.cs = inMerge.length;
        }
        return cell;
      }));
    }
    return rows;
  };

  // 'Monday … Sunday' 줄 = 주의 시작 (요일 이름이 3칸 이상)
  var heads = [];
  for (var r = 0; r < nr; r++) {
    var n = cols.filter(function (c) { return weekdayIndex_(text[r][c]) >= 0; }).length;
    if (n >= 3) heads.push(r);
  }
  if (!heads.length) {
    out.intro = { rows: block(0, nr - 1) };
    cachePut_(key, out);
    return out;
  }
  if (heads[0] > 0) {
    var intro = block(0, heads[0] - 1);
    if (intro.length) out.intro = { rows: intro };
  }
  heads.forEach(function (h, i) {
    var end = (i + 1 < heads.length ? heads[i + 1] : nr) - 1, monday = null;
    for (var j = 0; j < cols.length && !monday && h + 1 < nr; j++) {
      var wd = weekdayIndex_(text[h][cols[j]]);
      var d = wd >= 0 ? cellDate_(vals[h + 1][cols[j]], text[h + 1][cols[j]]) : null;
      if (d) monday = addDays_(d, -wd);
    }
    out.weeks.push({ monday: monday, label: monday ? weekLabel_(monday) : 'Week ' + (i + 1), rows: block(h, end) });
  });
  cachePut_(key, out);
  return out;
}

/**
 * 이 월요일의 주 -> { file, tab, week, fp, slots, fpOf(name) } (없으면 null). 그 주의 월·일요일 달 탭부터 찾고,
 * 거기 없으면 나머지 탭에서.
 * 두 달에 걸친 주는 두 탭의 내용을 합침 (slots 도 합쳐서 -> 월~일이 다 보임).
 * fp = 주 전체 내용(글자·색)의 지문. fpOf(이름) = 그 사람 근무(날짜·시간대·역할·시간·글자)만의 지문
 *   -> 다른 사람 칸이 바뀌어도 내 지문은 그대로. Schedule Colors 에 색이 없는 사람은 주 전체 지문.
 */
function findWeek_(s, monday, tabs, people) {
  tabs = tabs || schedTabs_(s);
  people = people || { byColor: {}, colors: {}, names: [] };
  var months = [+monday.slice(5, 7), +addDays_(monday, 6).slice(5, 7)];
  var named = tabs.filter(function (t) { return months.indexOf(t.month) >= 0; });
  var others = tabs.filter(function (t) { return named.indexOf(t) < 0; });
  var first = null, parts = [], slots = [], seen = {};
  var scan = function (t) {
    var data;
    try { data = readTab_(t.file, t.tab); } catch (err) { console.error(err); return; }
    data.weeks.forEach(function (w) {
      if (w.monday !== monday) return;
      if (!first) first = { file: t.file, tab: t.tab, week: w };
      parts.push(w.rows.map(function (r) {
        return r.map(function (c) { return c ? [c.t || '', c.bg || '', c.fc || ''].join('|') : '^'; }).join('\t');
      }).join('\n'));
      weekSlots_(w.rows, people, monday).forEach(function (x) {
        var k = slotKey_(x) + '|' + x.names.join(',') + '|' + x.color;
        if (!seen[k]) { seen[k] = 1; slots.push(x); }
      });
    });
  };
  // 그 주의 달 탭부터. 없으면 다른 탭에서 (예: 10월 탭 맨 아래에 11월 첫 주가 있고 11월 탭은 아직 없을 때)
  named.forEach(scan);
  if (!first) others.forEach(scan);
  if (!first) return null;
  first.fp = hash10_(parts.join('\n§\n'));
  first.slots = slots.sort(function (x, y) { return x.d - y.d; });
  first.fpOf = function (name) {
    if (!people.colors[name]) return first.fp;
    return hash10_(slots.filter(function (x) { return x.names.indexOf(name) >= 0; }).map(slotKey_).sort().join('\n'));
  };
  return first;
}

function slotKey_(x) { return [x.date, x.zone, x.role, x.start, x.end, x.text].join('|'); }

/** 확인 기록 ID = 'Schedule · Kitchen · 2026-11-16 · <지문>'. -> { '<스케줄·월요일 키>\n이름': { at, fp } } (가장 최근 확인). */
function schedConfs_(confs) {
  var out = {};
  Object.keys(confs).forEach(function (k) {
    if (k.indexOf('Schedule · ') !== 0) return;
    var nl = k.lastIndexOf('\n'), id = k.slice(0, nl), name = k.slice(nl + 1);
    var m = id.match(/^(.*) · ([0-9a-f]{10})$/);
    if (!m) return;
    var key = m[1] + '\n' + name, at = confs[k];
    if (!out[key] || out[key].at < at) out[key] = { at: at, fp: m[2] };
  });
  return out;
}

/**
 * 이 사람·이 주의 상태.
 *  confirmed: 지금 내용에 동의함 / changed: 동의한 뒤 시트가 바뀜 (다시 확인 필요, 주가 끝날 때까지)
 *  mustConfirm: 확인 버튼을 보여줄지 / pending: 지금 확인을 요청하는지 (배지·알림)
 */
function weekState_(sc, sched, monday, name, fp, today) {
  var c = sc[schedKey_(sched, monday) + '\n' + name] || null;
  var ended = addDays_(monday, 6) < today, started = monday <= today;
  var changed = !!(c && c.fp !== fp);
  var must = !ended && (changed || (!c && !started));
  return { c: c, changed: changed, confirmed: !!(c && !changed), mustConfirm: must,
           pending: must && (changed || schedDue_(monday) <= today) };
}

/** 이 사람이 지금 확인해야 하는 주: 확인 요청이 시작된 주 + 확인한 뒤 바뀐 주(끝나기 전). */
function pendingWeeks_(name, list, confs) {
  list = list || schedules_();
  var sc = schedConfs_(confs || confirmations_()), today = todayIso_(), out = [], people = null;
  list.forEach(function (s) {
    if (!isSchedRecipient_(s, name)) return;
    var mondays = windowMondays_(today);
    Object.keys(sc).forEach(function (k) { // 내가 확인했던, 아직 안 끝난 주
      var prefix = 'Schedule · ' + s.name + ' · ', nl = k.lastIndexOf('\n');
      if (k.indexOf(prefix) !== 0 || k.slice(nl + 1) !== name) return;
      var m = k.slice(prefix.length, nl);
      if (addDays_(m, 6) >= today && mondays.indexOf(m) < 0) mondays.push(m);
    });
    if (!mondays.length) return;
    var tabs = schedTabs_(s);
    people = people || schedPeople_();
    mondays.sort().forEach(function (m) {
      var f = findWeek_(s, m, tabs, people);
      if (!f) return;
      var fp = f.fpOf(name), st = weekState_(sc, s.name, m, name, fp, today);
      if (st.pending) {
        out.push({ sched: s.name, monday: m, file: f.file, tab: f.tab, fp: fp, label: weekLabel_(m),
                   due: schedDue_(m), changed: st.changed });
      }
    });
  });
  return out;
}

function schedulePendingCount_(name) {
  if (!props_.getProperty('ANN_SHEET_ID')) return 0;
  try {
    return pendingWeeks_(name).length;
  } catch (err) {
    console.error(err); // 스케줄 파일 문제가 메인 화면을 막지 않도록
    return 0;
  }
}

// ------------------------------------------------------------------ API

/**
 * 스케줄 화면: 스케줄 목록 + 달(탭) 목록 + 고른 달의 주들.
 * req.sched / req.file / req.tab 이 없으면: 확인할 주가 있는 스케줄·달 → 내 팀 스케줄 → 이번 달 → 첫 탭.
 */
function scheduleView_(req) {
  var name = whoAmI_(req.token), me = findEmployee_(name), admin = isAdmin_(name);
  var list = schedules_();
  if (!list.length) return { ok: true, schedules: [], admin: admin };
  var confs = confirmations_(), sc = schedConfs_(confs), pending = pendingWeeks_(name, list, confs);

  var s = list.filter(function (x) { return x.name === req.sched; })[0] ||
    (pending[0] && list.filter(function (x) { return x.name === pending[0].sched; })[0]) ||
    list.filter(function (x) { return me && me.team && x.teams.indexOf(me.team) >= 0; })[0] || list[0];
  var tabs = schedTabs_(s);
  var base = { ok: true, admin: admin, schedules: list.map(function (x) { return { name: x.name }; }), sched: s.name,
               tabs: [], weeks: [], pending: [] };
  if (!tabs.length) {
    return Object.assign(base, { error: 'The schedule spreadsheet could not be opened. Please tell your manager.' });
  }
  // 직원에게는 이번 달과 다음 달 탭만 (같은 달 탭이 여러 파일에 있으면 Schedules 탭에서 위쪽 줄 파일)
  var cur = +todayIso_().slice(5, 7), next = cur % 12 + 1, all = tabs;
  tabs = [cur, next].map(function (m) { return all.filter(function (t) { return t.month === m; })[0]; })
    .filter(Boolean);
  if (!tabs.length) return Object.assign(base, { error: 'The schedule for this month is not ready yet.' });
  var pick = tabs.filter(function (t) { return t.file === req.file && t.tab === req.tab; })[0];
  var mine = pending.filter(function (p) { return p.sched === s.name; })[0];
  if (!pick && mine) pick = tabs.filter(function (t) { return t.file === mine.file && t.tab === mine.tab; })[0];
  if (!pick) pick = tabs[0];
  var data = readTab_(pick.file, pick.tab), people = schedPeople_();
  var today = todayIso_(), recips = schedRecipients_(s), isRecip = recips.some(function (e) { return e.name === name; });

  return {
    ok: true, admin: admin, sched: s.name, file: pick.file, tab: pick.tab, readAt: data.readAt,
    schedules: list.map(function (x) { return { name: x.name }; }),
    tabs: tabs.map(function (t) { return { file: t.file, tab: t.tab, label: MONTH_LONG_[t.month - 1] }; }),
    cols: data.cols, intro: data.intro,
    people: people.names.map(function (n) { return { name: n, color: people.colors[n] || '' }; }),
    pending: pending.map(function (p) {
      return { sched: p.sched, monday: p.monday, label: p.label, file: p.file, tab: p.tab, changed: p.changed };
    }),
    weeks: data.weeks.map(function (w) {
      var out = { monday: w.monday, label: w.label, rows: w.rows };
      if (!w.monday || addDays_(w.monday, 6) < today && !admin && !isRecip) return out;
      var due = schedDue_(w.monday), f = findWeek_(s, w.monday, all, people);
      out.fp = f.fpOf(name);
      out.slots = f.slots;
      out.dueLabel = weekdayLabel_(due);
      out.state = addDays_(w.monday, 6) < today ? 'ended' : w.monday <= today ? 'started'
        : today < due ? 'early' : today === due ? 'due' : 'overdue';
      if (isRecip) {
        var st = weekState_(sc, s.name, w.monday, name, out.fp, today);
        out.confirmedAt = st.confirmed ? st.c.at : null;
        out.changed = st.changed;
        out.changedAfter = st.changed ? st.c.at : null;
        out.mustConfirm = st.mustConfirm;
      }
      if (admin) {
        var done = [], todo = [], again = [];
        recips.forEach(function (e) {
          var x = weekState_(sc, s.name, w.monday, e.name, f.fpOf(e.name), today);
          if (x.confirmed) done.push({ name: e.name, at: x.c.at });
          else if (x.changed) again.push(e.name);
          else todo.push(e.name);
        });
        if (w.monday > today || done.length || again.length) out.status = { confirmed: done, changed: again, pending: todo };
      }
      return out;
    }),
  };
}

/**
 * "이 주의 스케줄을 읽었고 동의합니다". 보고 있던 내용(fp)이 지금 시트와 같아야 함
 * (그 사이 바뀌었으면 code CHANGED -> 화면이 새로 읽음). 바뀐 뒤에는 같은 주를 다시 확인할 수 있음.
 */
function scheduleConfirm_(req) {
  var name = whoAmI_(req.token);
  if (req.agree !== true) fail_('Please tick the box first.');
  var s = schedules_().filter(function (x) { return x.name === req.sched; })[0];
  if (!s) fail_('Schedule not found. Please reload.');
  if (!isSchedRecipient_(s, name)) fail_('You do not need to confirm this schedule.');
  var monday = String(req.monday || '');
  if (!/^\d{4}-\d\d-\d\d$/.test(monday)) fail_('This week was not found. Please reload.');
  var f = findWeek_(s, monday, null, schedPeople_());
  if (!f) fail_('This week was not found. Please reload.');
  var fp = f.fpOf(name);
  if (String(req.fp || '') !== fp) fail_('The schedule was just changed. Please read it again.', 'CHANGED');
  var key = schedKey_(s.name, monday), at, already;
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var st = weekState_(schedConfs_(confirmations_()), s.name, monday, name, fp, todayIso_());
    already = st.confirmed;
    if (!already && !st.mustConfirm) fail_('This week has already started.');
    at = already ? st.c.at : nowStamp_();
    if (!already) {
      appendRecord_('Confirmations', [key + ' · ' + fp,
        'Schedule ' + s.name + ': ' + weekLabel_(monday) + (st.changed ? ' (changed)' : ''), name, at]);
    }
  } finally {
    lock.releaseLock();
  }
  return { ok: true, confirmedAt: at, already: already, schedulePending: schedulePendingCount_(name) };
}

// ------------------------------------------------------------------ 알림

/**
 * 매일 09:00 (morningRun): 확인할 주(2주 전 화요일부터 + 확인한 뒤 바뀐 주)가 남은 사람에게 푸시 + 메일 1번.
 * 확인을 요청하는 주가 아직 시트에 없으면 Supervisor 에게 알림.
 */
function notifySchedules_() {
  var list = schedules_();
  if (!list.length) return 0;
  var today = todayIso_(), confs = confirmations_(), missing = [], watch = schedWatch_(), sent = 0;
  list.forEach(function (s) {
    var tabs = schedTabs_(s);
    windowMondays_(today).forEach(function (m) {
      if (!findWeek_(s, m, tabs)) missing.push((list.length > 1 ? s.name + ': ' : '') + 'week of ' + weekLabel_(m));
    });
  });
  var url = schedUrl_();
  if (missing.length) {
    pushSupervisors_({ title: '📅 Schedule not in the sheet yet', body: missing.join('\n') +
      '\nStaff are asked to confirm it from today.', url: url, tag: 'schedule-missing-' + today });
  }
  activeEmployees_().forEach(function (e) {
    var weeks = pendingWeeks_(e.name, list, confs);
    if (!weeks.length) return;
    weeks.forEach(function (w) { if (w.changed) markSent_(watch, w, e.name); });
    notifySchedule_(e, weeks.map(function (w) { return schedNote_(w, list.length > 1, today); }), url);
    sent++;
  });
  saveWatch_(watch);
  return sent;
}

/**
 * 30분마다 (조용한 시간 제외): 확인한 뒤 내 근무가 바뀐 주 -> 그 사람에게만 "바뀌었으니 다시 확인" 알림.
 * (Schedule Colors 에 색이 있는 사람은 자기 칸·시간이 바뀔 때만, 없는 사람은 그 주의 어떤 변경이든)
 * Supervisor 가 고치는 도중에 여러 번 울리지 않도록, 바뀐 내용이 한 번 더 같게 보일 때(= 30분 이상 그대로) 보냄.
 * 같은 변경으로는 한 번만 (확인할 때까지는 09:00 리마인더가 이어짐).
 */
function checkScheduleChanges() {
  if (isQuiet_() || !props_.getProperty('ANN_SHEET_ID')) return 0;
  var list = schedules_();
  if (!list.length) return 0;
  var confs = confirmations_(), today = todayIso_(), watch = schedWatch_(), seen = {}, sent = 0;
  activeEmployees_().forEach(function (e) {
    var weeks = pendingWeeks_(e.name, list, confs).filter(function (w) { return w.changed; });
    var fresh = weeks.filter(function (w) {
      var k = watchKey_(w, e.name), x = watch[k];
      seen[k] = true;
      if (!x || x.fp !== w.fp) { watch[k] = { fp: w.fp, sent: false }; return false; } // 처음 본 변경: 다음 검사까지 기다림
      return !x.sent;
    });
    if (!fresh.length) return;
    fresh.forEach(function (w) { markSent_(watch, w, e.name); });
    notifySchedule_(e, fresh.map(function (w) { return schedNote_(w, list.length > 1, today); }), schedUrl_(), true);
    sent++;
  });
  Object.keys(watch).forEach(function (k) {
    if (!seen[k] && addDays_(k.split('\n')[0].slice(-10), 6) < today) delete watch[k]; // 끝난 주는 정리
  });
  saveWatch_(watch);
  return sent;
}

function schedWatch_() { return JSON.parse(props_.getProperty('SCHED_WATCH') || '{}'); }
function saveWatch_(w) { props_.setProperty('SCHED_WATCH', JSON.stringify(w)); }
/** 변경 알림 기록: 사람·주마다 { fp: 마지막으로 본 내 지문, sent: 그 지문으로 알림을 보냈는지 }. */
function watchKey_(w, name) { return w.sched + ' · ' + w.monday + '\n' + name; }
function markSent_(watch, w, name) { watch[watchKey_(w, name)] = { fp: w.fp, sent: true }; }

function schedUrl_() { return (props_.getProperty('APP_URL') || APP_URL_DEFAULT) + '?view=schedule'; }

function schedNote_(w, withName, today) {
  return { key: schedKey_(w.sched, w.monday), label: (withName ? w.sched + ' · ' : '') + w.label, changed: w.changed,
           note: w.changed ? 'Changed after you agreed — please read it again'
             : w.due === today ? 'Please confirm today (' + weekdayLabel_(w.due) + ')'
               : 'Not confirmed yet — was due ' + weekdayLabel_(w.due) };
}

/** 한 사람에게 푸시 + 메일 + Notifications 기록. changedOnly = 30분 변경 감지에서 보낸 것. */
function notifySchedule_(emp, weeks, url, changedOnly) {
  var anyChanged = weeks.some(function (w) { return w.changed; });
  var title = anyChanged ? SCHED_CHANGED_TITLE : SCHED_PUSH_TITLE;
  var body = weeks.length === 1 ? (weeks[0].changed ? 'Changed: week ' : 'Week ') + weeks[0].label
    : weeks.length + ' weeks: ' + weeks.map(function (w) { return w.label + (w.changed ? ' (changed)' : ''); }).join(', ');
  var results = [];
  var subs = pushSubscriptions_(emp.name);
  if (!subs.length) results.push(['push', 'no device registered']);
  subs.forEach(function (s) {
    var code;
    try {
      code = sendWebPush_(s.sub, { title: title, body: body, url: url, tag: 'schedule' });
    } catch (err) {
      code = 'error: ' + err.message;
    }
    if (code === 404 || code === 410) props_.deleteProperty(s.key);
    results.push(['push', String(code)]);
  });
  if (emp.email) {
    try {
      MailApp.sendEmail({ to: emp.email, subject: title, htmlBody: scheduleMail_(title, weeks, url), name: 'monsieur Kim' });
      results.push(['email', 'sent']);
    } catch (err2) {
      results.push(['email', 'error: ' + err2.message]);
    }
  } else {
    results.push(['email', 'no email address']);
  }
  var ids = weeks.map(function (w) { return w.key; }).join(', ');
  var kind = changedOnly ? 'changed schedule ' : 'reminder schedule ';
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    results.forEach(function (r) { appendRecord_('Notifications', [nowStamp_(), ids, emp.name, kind + r[0], r[1]]); });
  } finally {
    lock.releaseLock();
  }
  return results;
}

function scheduleMail_(title, weeks, url) {
  var button = '<p style="margin:16px 0"><a href="' + esc_(url) + '" style="display:inline-block;' +
    'background:#1f6f54;color:#fff;padding:14px 28px;border-radius:10px;text-decoration:none;' +
    'font-weight:700;font-size:16px">Go to Confirm</a></p>';
  var items = weeks.map(function (w) {
    return '<div style="border:1px solid ' + (w.changed ? '#c0392b' : '#dfe4e1') +
      ';border-radius:12px;padding:14px 16px;margin:10px 0">' +
      '<div style="font-weight:700;font-size:17px">Week ' + esc_(w.label) + '</div>' +
      '<div style="color:#66706b;font-size:13px">' + esc_(w.note) + '</div></div>';
  }).join('');
  var ref = weeks.map(function (w) { return w.key; }).join(', ') + ' · sent ' + nowStamp_() + ' · ' +
    Utilities.getUuid().slice(0, 8);
  return '<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px">' +
    '<h1 style="font-size:20px;margin:0 0 4px">' + esc_(title) + '</h1>' + button + items +
    '<p style="color:#66706b;font-size:13px">Open the Schedule in the app, read the week and tick ' +
    '"I have read and agree". To ask for a change, use "Request a change" under the week. ' +
    'You will get a reminder every day until you confirm.</p>' +
    '<p style="color:#9aa49f;font-size:11px">Ref ' + esc_(ref) + '</p></div>';
}

/**
 * 편집기에서 실행: 스케줄을 단계별로 읽어 보고 결과를 실행 로그(아래 "Journal d'exécution")에 씀.
 * 앱에서 Schedule 이 안 열릴 때 원인 찾기용. 아무것도 바꾸지 않음.
 */
function checkSchedule() {
  var step = function (label, fn) {
    try {
      var r = fn();
      Logger.log('OK   ' + label + (r !== undefined ? ' → ' + r : ''));
      return true;
    } catch (err) {
      Logger.log('FAIL ' + label + ' → ' + errDetail_(err));
      Logger.log(String(err && err.stack || ''));
      return false;
    }
  };
  var list, people, today = todayIso_();
  if (!step('Schedules 탭', function () {
    list = schedules_();
    return list.map(function (s) { return s.name + ' (' + s.files.length + ' file, team: ' + (s.teams.join(', ') || 'all') + ')'; }).join(' | ') || '(비어 있음)';
  })) return;
  step('Schedule Colors 탭', function () {
    people = schedPeople_();
    return people.names.map(function (n) { return n + ' ' + (people.colors[n] || '(색 없음)'); }).join(', ') || '(비어 있음)';
  });
  people = people || { byColor: {}, colors: {}, names: [] };
  list.forEach(function (s) {
    var tabs;
    if (!step(s.name + ': 파일 열기', function () {
      tabs = schedTabs_(s);
      if (tabs.errors.length) throw new Error('열 수 없는 파일: ' + tabs.errors.join(', '));
      return tabs.map(function (t) { return t.tab + '→' + (t.month || '?'); }).join(', ');
    })) return;
    var cur = +today.slice(5, 7);
    tabs.filter(function (t) { return t.month === cur || t.month === cur % 12 + 1; }).forEach(function (t) {
      var data;
      if (!step(s.name + ' / ' + t.tab + ': 읽기', function () {
        CacheService.getScriptCache().remove('schtab_' + t.file + '_' + t.tab);
        data = readTab_(t.file, t.tab);
        return data.weeks.length + '주: ' + data.weeks.map(function (w) { return w.monday || '?'; }).join(', ') +
          ' (캐시 ' + JSON.stringify(data).length + ' bytes)';
      })) return;
      data.weeks.forEach(function (w) {
        if (!w.monday) return;
        step(s.name + ' / ' + t.tab + ' / ' + w.monday + ': 근무 칸', function () {
          var f = findWeek_(s, w.monday, tabs, people);
          return f.slots.length + '칸, 예: ' + f.slots.slice(0, 3).map(function (x) {
            return x.date + ' ' + x.zone + ' ' + x.role + ' ' + x.start + '-' + x.end + ' ' + (x.names.join('+') || '색?');
          }).join(' / ');
        });
      });
    });
    schedRecipients_(s).forEach(function (e) {
      step(s.name + ': ' + e.name + ' 확인할 주', function () {
        return pendingWeeks_(e.name, list).map(function (p) { return p.monday + (p.changed ? '(changed)' : ''); }).join(', ') || '없음';
      });
    });
  });
  Logger.log('끝.');
}
