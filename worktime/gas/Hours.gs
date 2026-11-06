// My hours · NFC 태그 원본 기록(Tag Log) · 시간 변경 요청(Time changes) · 계약(Contracts) · 초과근무 원장(Overtime ledger)
//
// 기록은 세 겹 (사장님 지시 2026-11-06: "변경 요청은 하나의 방식으로만, 원본 증거는 따로, 변경은 로그로"):
//  1) NFC Tag Log (별도 스프레드시트, 사람마다 탭 하나, 월로 나누지 않음): 태그를 찍을 때마다 한 줄. 시스템만 추가, 아무도 고치지 않음.
//     Date | Time(초까지) | Tag | Tag UID | Tag counter
//  2) Work time log (yyyy-MM 월별 파일 → 직원 탭): DATE | TIME | Info | Change   ← 월급·My hours 의 기준, 늘 '최종 시간'만.
//     승인되면 TIME 을 바로 고치고 Change 칸에 'TC-0003 · was 09:00'(추가된 줄은 'TC-0004 · added'). 대기 중·거절은 이 시트에 아무것도 안 남김.
//  3) Time Changes (Announcement Records, 보호 + HMAC 체인): 요청·승인·거절 한 줄씩 (요청 하나에 시작·끝 두 개면 두 줄)
//     ID | Logged at | Action(REQUEST/ACCEPTED/DENIED) | By | Employee | Day | Tag | Original time | Requested time | Work time log | Reason | Ref
//     Work time log 칸 = 'Not changed yet (waiting)' / 'Changed 09:00 → 08:55' / 'Added 22:15' / 'Not changed (stays 09:00)'.
//     대기 중·거절·누가 고쳤는지는 모두 이 로그에서 읽음.
//
// WorkTime Config (setup 이 탭을 만듦, 시트에서만 입력):
//   Contracts        : Name | From | To | Weekly hours | Settlement | Note
//                      From = 계약 시작일(필수, 2026-09-01 또는 01/09/2026), To = 끝(빈칸 = 계속)
//                      Settlement = Weekly(빈칸도 Weekly) 또는 Quarterly. 계약이 바뀌면 줄을 새로 추가(옛 줄 To 를 채움).
//   Time Adjustments : Name | Date | Hours | Reason
//                      + = 일한 것으로 셈(유급휴가, 공휴일, 교육…), − = 차감. 그 날짜가 든 주에 원장 한 줄로 들어감.
//
// 초과근무 원장(복식부기 표기): 직원의 'Overtime account' = 회사가 직원에게 갚을 시간(부채 계정).
//   주마다 실제 근무 − 계약 시간: 많으면 Credit(+), 적으면 Debit(−). 조정(Time Adjustments)은 별도 줄.
//   결산: Weekly = 그 주 끝에 바로 정산(잔액 0), Quarterly = 분기의 마지막 주가 끝나면 잔액을 반대쪽에 적어 0 으로 마감.
//   주 = 월~일, 분기 소속 = 그 주의 목요일이 속한 분기(ISO 주 번호와 같은 규칙). 근무는 시작한 날의 주에 들어감.
//   부분 주(계약 시작·끝이 주 중간)는 계약 시간을 7일 중 계약 일수만큼 비례.

var CLOCK_HEAD = ['DATE', 'TIME', 'Info', 'Change'];
var TAG_LOG_HEAD = ['Date', 'Time', 'Tag', 'Tag UID', 'Tag counter'];
var MAX_SHIFT_MIN = 16 * 60; // START 뒤 이 안의 END 만 같은 근무로 봄 (화면의 LATE_HOURS 와 같음)
var CONTRACT_HEAD = ['Name', 'From', 'To', 'Weekly hours', 'Settlement', 'Note'];
var ADJUST_HEAD = ['Name', 'Date', 'Hours', 'Reason'];
var TC_CHANGED_BG = '#d4edda';

function ensureHoursConfig_(config) {
  [['Contracts', CONTRACT_HEAD], ['Time Adjustments', ADJUST_HEAD]].forEach(function (t) {
    if (config.getSheetByName(t[0])) return;
    var sh = config.insertSheet(t[0]);
    sh.getRange(1, 1, 1, t[1].length).setValues([t[1]]).setFontWeight('bold');
    sh.getRange(1, 1, sh.getMaxRows(), t[1].length).setNumberFormat('@'); // 날짜를 글자 그대로(2026-09-01)
    sh.setFrozenRows(1);
  });
  tagLogBook_();
}

// ------------------------------------------------------------------ NFC Tag Log (원본 증거)

/** NFC Tag Log 스프레드시트 (없으면 만듦). 첫 탭 = 읽는 법. */
function tagLogBook_() {
  var id = props_.getProperty('TAGLOG_SHEET_ID');
  if (id) return SpreadsheetApp.openById(id);
  var ss = SpreadsheetApp.create('NFC Tag Log');
  DriveApp.getFileById(ss.getId()).moveTo(folder_());
  var about = ss.getSheets()[0].setName('About');
  about.getRange(1, 1, 4, 1).setValues([
    ['NFC Tag Log — every tag tap, exactly as the tag sent it. Written only by the Work Time system, never edited.'],
    ['One tab per person (all months together). Time is Paris time, to the second.'],
    ['Tag UID + Tag counter come from the tag itself (the counter goes up by one at every tap of that tag).'],
    ['Corrections are made in the monthly Work time log; each one is listed in Announcement Records → Time Changes.'],
  ]);
  lockSheet_(about, 'NFC Tag Log');
  props_.setProperty('TAGLOG_SHEET_ID', ss.getId());
  return ss;
}

/** 시트 보호: 시스템(스크립트를 배포한 계정) 말고는 아무도 편집 못 함. */
function lockSheet_(sh, what) {
  var p = sh.protect().setDescription(what + ': written only by the Work Time system');
  p.removeEditors(p.getEditors());
  if (p.canDomainEdit()) p.setDomainEdit(false);
  return sh;
}

/** 태그 한 번 = 한 줄 (호출 측에서 script lock). 실패하면 출퇴근도 저장하지 않음(증거 없는 기록 방지). */
function appendTagLog_(name, a, sun, when) {
  var ss = tagLogBook_(), sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, TAG_LOG_HEAD.length).setValues([TAG_LOG_HEAD]).setFontWeight('bold');
    sh.setFrozenRows(1);
    lockSheet_(sh, 'NFC Tag Log');
  }
  sh.getRange(sh.getLastRow() + 1, 1, 1, 5).setNumberFormat('@').setValues([[
    Utilities.formatDate(when, TZ, 'yyyy-MM-dd'), Utilities.formatDate(when, TZ, 'HH:mm:ss'), a,
    String(sun.uid), String(sun.counter)]]);
}

// ------------------------------------------------------------------ Work time log 한 줄 읽기

function normTime_(v) {
  var m = String(v || '').trim().match(/^(\d{1,2})[:h](\d{2})$/);
  return m && +m[1] < 24 && +m[2] < 60 ? (m[1].length < 2 ? '0' : '') + m[1] + ':' + m[2] : '';
}

/** 월별 탭의 한 줄 → { r, date, info, time, rec } 또는 null(메모 줄). rec = 화면용(승인된 수정이면 원래 시간으로 바뀜). */
function clockRow_(r, month, rowNo) {
  var info = String(r[2]).trim().toUpperCase(), md = String(r[0]).trim(), time = normTime_(r[1]);
  if ((info !== 'START' && info !== 'END') || !/^\d{2}-\d{2}$/.test(md) || !time) return null;
  return { r: rowNo, date: month.slice(0, 4) + '-' + md, info: info, time: time, rec: time, req: '', status: '', id: '' };
}

/** 한 달 기록 파일의 내 탭 → clockRow_ 목록 (시트 순서). */
function monthClockRows_(name, month) {
  var ss = findMonthSpreadsheet_(month);
  var sheet = ss && ss.getSheetByName(name);
  var last = sheet ? sheet.getLastRow() : 0;
  if (last < 2) return [];
  var out = [];
  sheet.getRange(2, 1, last - 1, 4).getDisplayValues().forEach(function (r, i) {
    var c = clockRow_(r, month, i + 2);
    if (c) out.push(c);
  });
  return out;
}

var stampOf_ = function (c) { return c.date + ' ' + c.time; };
function minOf_(date, time) {
  var p = date.split('-'), t = String(time || '00:00').split(':');
  return Date.UTC(+p[0], +p[1] - 1, +p[2], +t[0], +t[1]) / 60000;
}
function dayNum_(s) { var p = s.split('-'); return Date.UTC(+p[0], +p[1] - 1, +p[2]) / 86400000; }
function dayStr_(n) { return new Date(n * 86400000).toISOString().slice(0, 10); }

function shiftMonth_(month, delta) {
  var y = +month.slice(0, 4), m = +month.slice(5, 7) - 1 + delta;
  y += Math.floor(m / 12);
  m = ((m % 12) + 12) % 12 + 1;
  return y + '-' + (m < 10 ? '0' : '') + m;
}

/** 시간이 있는 줄만 시간순. */
function timedEvents_(rows) {
  return rows.filter(function (c) { return c.time; })
    .sort(function (a, b) { return stampOf_(a) < stampOf_(b) ? -1 : stampOf_(a) > stampOf_(b) ? 1 : 0; });
}

/** START→END(16시간 안) 짝짓기. { shifts:[{start,end,min}], missing:[{date,kind:'out'|'in'}], live } */
function pairShifts_(events, now) {
  var out = { shifts: [], missing: [], live: null }, open = null;
  events.forEach(function (c) {
    if (c.info === 'START') {
      if (open) out.missing.push({ date: open.date, kind: 'out' });
      open = c;
      return;
    }
    var gap = open ? minOf_(c.date, c.time) - minOf_(open.date, open.time) : -1;
    if (open && gap >= 0 && gap <= MAX_SHIFT_MIN) out.shifts.push({ start: open, end: c, min: gap });
    else {
      if (open) out.missing.push({ date: open.date, kind: 'out' });
      out.missing.push({ date: c.date, kind: 'in' });
    }
    open = null;
  });
  if (open) {
    var g = minOf_(now.slice(0, 10), now.slice(11, 16)) - minOf_(open.date, open.time);
    if (g >= 0 && g < MAX_SHIFT_MIN) out.live = open;
    else out.missing.push({ date: open.date, kind: 'out' });
  }
  return out;
}

// ------------------------------------------------------------------ My hours (한 달, 본인 것만)
// 이름은 로그인 토큰에서만 정함(요청에 이름을 받지 않음) → Supervisor 도 여기서는 자기 기록만.
// 자정을 넘긴 근무가 달을 건너면: 처음이 END 면 지난달 마지막 기록, 마지막이 START 면 다음 달 첫 기록도 줌.
// 줄마다 Time Changes 로그의 상태를 붙임: 대기(pending, req = 요청 시간) · 승인(accepted, rec = 원래 시간) · 거절(denied).
// 대기·거절된 '빠진 태그 추가' 요청은 시트에 줄이 없으므로 r = 0 인 줄로 덧붙임.
function myTime_(req) {
  var name = whoAmI_(req.token);
  var cur = Utilities.formatDate(new Date(), TZ, 'yyyy-MM');
  var month = String(req.month || cur);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || month > cur) fail_('Invalid month.');
  var rows = annotateRows_(monthClockRows_(name, month), myChangeOps_(name), month);
  var ev = timedEvents_(rows), before = null, after = null;
  if (ev.length && ev[0].info === 'END') {
    var prev = timedEvents_(monthClockRows_(name, shiftMonth_(month, -1)));
    before = prev.length ? prev[prev.length - 1] : null;
  }
  if (ev.length && ev[ev.length - 1].info === 'START' && month < cur) {
    after = timedEvents_(monthClockRows_(name, shiftMonth_(month, 1)))[0] || null;
  }
  return { ok: true, month: month, current: cur, today: todayStamp_(), rows: rows, before: before, after: after };
}

/** 이 사람의 요청 op 들(오래된 것부터) + 상태(pending/accepted/denied). */
function myChangeOps_(name) {
  var out = [];
  timeChangeBook_().forEach(function (x) {
    if (x.name !== name) return;
    x.ops.forEach(function (op) { out.push({ op: op, status: x.decision || 'pending', id: x.id }); });
  });
  return out;
}

function annotateRows_(rows, ops, month) {
  var find = function (date, info, time) {
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].r && rows[i].date === date && rows[i].info === info && rows[i].time === time) return rows[i];
    }
    return null;
  };
  ops.forEach(function (o) {
    var op = o.op;
    if (op.date.slice(0, 7) !== month) return;
    if (op.op === 'change') {
      var row = find(op.date, op.info, o.status === 'accepted' ? op.to : op.from);
      if (!row) return;
      row.status = o.status;
      row.id = o.id;
      row.req = o.status === 'accepted' ? '' : op.to;
      if (o.status === 'accepted') row.rec = op.from;
    } else if (o.status === 'accepted') {
      var added = find(op.date, op.info, op.to);
      if (added) { added.status = 'accepted'; added.id = o.id; added.rec = ''; }
    } else {
      rows.push({ r: 0, date: op.date, info: op.info, time: '', rec: '', req: op.to, status: o.status, id: o.id });
    }
  });
  return rows;
}

// ------------------------------------------------------------------ 시간 변경 요청 (직원 → Supervisor)
// ops (1~2개, 한 근무의 시작·끝):
//   { op: 'change', month, row, info, date, time(지금 시간 = 확인용), to }
//   { op: 'add', info, date, to }   ← 빠진 태그
// 요청은 로그에만 적음(Work time log 는 승인될 때 바뀜).
function timeRequest_(req) {
  var name = whoAmI_(req.token);
  var reason = String(req.reason || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  var items = Array.isArray(req.ops) ? req.ops : [];
  if (!items.length || items.length > 2) fail_('Nothing to change.');
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  var id, ops;
  try {
    var now = todayStamp_(), mine = myChangeOps_(name);
    ops = items.map(function (it) { return resolveOp_(name, it, now, mine); });
    id = submitTimeChange_(name, ops, reason);
  } finally {
    lock.releaseLock();
  }
  return { ok: true, id: id };
}

function resolveOp_(name, it, now, mine) {
  var to = normTime_(it && it.to), info = String((it && it.info) || '');
  if (!to) fail_('Please enter a valid time (HH:MM).');
  if (!/^(START|END)$/.test(info)) fail_('Bad request.');
  var waiting = function (date, from) {
    return mine.some(function (o) {
      return o.status === 'pending' && o.op.date === date && o.op.info === info && (o.op.from || '') === from;
    });
  };
  if (it.op === 'add') {
    var date = String(it.date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail_('Bad request.');
    if (date + ' ' + to > now) fail_('That time is in the future.');
    if (waiting(date, '')) fail_('A missing ' + (info === 'START' ? 'clock-in' : 'clock-out') + ' for this day is already waiting for the supervisor.');
    return { op: 'add', month: date.slice(0, 7), info: info, date: date, from: '', to: to };
  }
  if (it.op !== 'change') fail_('Bad request.');
  var month = String(it.month || ''), row = Number(it.row);
  if (!/^\d{4}-\d{2}$/.test(month) || !(row >= 2)) fail_('Bad request.');
  var ss = findMonthSpreadsheet_(month), sheet = ss && ss.getSheetByName(name);
  if (!sheet) fail_('Your records changed. Please reload.', 'CHANGED');
  var c = clockRow_(sheet.getRange(row, 1, 1, 4).getDisplayValues()[0], month, row);
  if (!c || c.info !== info || c.date !== it.date || c.time !== it.time) fail_('Your records changed. Please reload.', 'CHANGED');
  if (waiting(c.date, c.time)) fail_('A change for this time is already waiting for the supervisor.');
  if (c.time === to) fail_('That is already the time on record.');
  if (c.date + ' ' + to > now) fail_('That time is in the future.');
  return { op: 'change', month: month, row: row, info: info, date: c.date, from: c.time, to: to };
}

/** 요청을 로그에 (op 마다 한 줄) + Supervisor 알림. 호출 측에서 script lock. */
function submitTimeChange_(name, ops, reason) {
  var seq = Number(props_.getProperty('TC_SEQ') || 0) + 1;
  props_.setProperty('TC_SEQ', String(seq));
  var id = 'TC-' + ('000' + seq).slice(-4), at = nowStamp_();
  ops.forEach(function (op) {
    appendRecord_('Time Changes', [id, at, 'REQUEST', name, name, op.date, op.info, op.from || '— (missing)', op.to,
                                   'Not changed yet (waiting)', reason, JSON.stringify(op)]);
  });
  CacheService.getScriptCache().remove('tc_pending');
  try {
    pushSupervisors_({ title: '🕒 Time change · ' + name,
                       body: opsText_(ops) + (reason ? ' — ' + reason : ''),
                       url: (props_.getProperty('APP_URL') || APP_URL_DEFAULT) + '?view=requests',
                       tag: 'timechange-' + id });
  } catch (err) { console.error(err); }
  return id;
}

function opsText_(ops) {
  return ops.map(function (op) {
    var d = new Date(dayNum_(op.date) * 86400000);
    var day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()] + ' ' + d.getUTCDate() + '/' + (d.getUTCMonth() + 1);
    var what = op.info === 'START' ? 'clock-in' : 'clock-out';
    return day + ' · ' + (op.op === 'add' ? 'add ' + what + ' ' + op.to : what + ' ' + op.from + ' → ' + op.to);
  }).join(' · ');
}

// ------------------------------------------------------------------ Supervisor: 요청 목록 · 승인/거절

/** Time Changes 로그 → 요청 목록 [{ id, at, name, ops, reason, decision, by, decidedAt }] (오래된 것부터). */
function timeChangeBook_() {
  var reqs = {}, order = [];
  if (!props_.getProperty('ANN_SHEET_ID')) return [];
  readRecords_('Time Changes').forEach(function (r) {
    var id = r[0], action = r[2];
    if (action === 'REQUEST') {
      if (!reqs[id]) { reqs[id] = { id: id, at: r[1], name: r[4], ops: [], reason: r[10] }; order.push(id); }
      reqs[id].ops.push(JSON.parse(r[11] || '{}'));
    } else if (reqs[id] && (!reqs[id].decision || reqs[id].decidedAt === r[1])) {
      reqs[id].decision = action === 'ACCEPTED' ? 'accepted' : 'denied';
      reqs[id].by = r[3];
      reqs[id].decidedAt = r[1];
    }
  });
  return order.map(function (id) { return reqs[id]; });
}

function hoursSupervisor_(token) {
  var me = findEmployee_(whoAmI_(token));
  if (!me || !me.supervisor) fail_('Only the supervisor can do this.');
  return me;
}

function timeChanges_(req) {
  hoursSupervisor_(req.token);
  var all = timeChangeBook_();
  var pending = all.filter(function (x) { return !x.decision; });
  var done = all.filter(function (x) { return x.decision; })
    .sort(function (a, b) { return a.decidedAt < b.decidedAt ? 1 : -1; }).slice(0, 30);
  return { ok: true, pending: pending, recent: done };
}

/** 홈 화면 Requests inbox 배지 (Supervisor). */
function pendingTimeCount_() {
  var cache = CacheService.getScriptCache(), hit = cache.get('tc_pending');
  if (hit != null) return Number(hit);
  var n = timeChangeBook_().filter(function (x) { return !x.decision; }).length;
  cache.put('tc_pending', String(n), 300);
  return n;
}

function safePendingTime_(emp) {
  if (!emp || !emp.supervisor) return 0;
  try {
    return pendingTimeCount_();
  } catch (err) {
    console.error(err);
    return 0;
  }
}

/**
 * Accept = Work time log 의 시간을 바로 고침(빠진 태그는 시간 순서 자리에 줄 추가) + 로그에 'Changed …'.
 * Deny = 시트는 그대로 + 로그에 'Not changed …'.
 */
function timeDecide_(req) {
  var me = hoursSupervisor_(req.token);
  var id = String(req.id || ''), accept = req.decision === 'accept';
  if (!accept && req.decision !== 'deny') fail_('Bad request.');
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  var item;
  try {
    item = timeChangeBook_().filter(function (x) { return x.id === id; })[0];
    if (!item) fail_('Request not found.');
    if (item.decision) fail_('Already ' + item.decision + ' by ' + item.by + '.', 'DONE');
    var results = item.ops.map(function (op) {
      if (!accept) return 'Not changed (' + (op.op === 'add' ? 'still missing' : 'stays ' + op.from) + ')';
      var sheet = employeeSheet_(monthSpreadsheet_(op.month), item.name);
      if (op.op === 'add') {
        insertClockRow_(sheet, [op.date.slice(5), op.to, op.info, id + ' · added']);
        return 'Added ' + op.to;
      }
      var row = findClockRow_(sheet, op);
      if (!row) fail_('This record was changed in the sheet (' + op.month + ', ' + item.name + ', ' + op.date + ' ' + op.from + '). Please check it there.');
      sheet.getRange(row, 2).setNumberFormat('@').setValue(op.to);
      sheet.getRange(row, 4).setNumberFormat('@').setValue(id + ' · was ' + op.from);
      sheet.getRange(row, 2).setBackground(TC_CHANGED_BG);
      return 'Changed ' + op.from + ' → ' + op.to;
    });
    SpreadsheetApp.flush();
    var at = nowStamp_();
    item.ops.forEach(function (op, i) {
      appendRecord_('Time Changes', [id, at, accept ? 'ACCEPTED' : 'DENIED', me.name, item.name, op.date, op.info,
                                     op.from || '— (missing)', op.to, results[i], '', JSON.stringify(op)]);
    });
  } finally {
    lock.releaseLock();
  }
  CacheService.getScriptCache().remove('tc_pending');
  try { putClock_(item.name, readClock_(item.name, clockBooks_())); } catch (e0) { console.error(e0); }
  try {
    notifyPerson_(item.name, { title: accept ? '✓ Time change accepted' : '✗ Time change not accepted',
                               body: opsText_(item.ops),
                               url: (props_.getProperty('APP_URL') || APP_URL_DEFAULT) + '?view=mytime',
                               tag: 'timechange-' + id });
  } catch (err) { console.error(err); }
  return { ok: true, id: id, decision: accept ? 'accepted' : 'denied' };
}

/** 고칠 줄: 적어 둔 줄 번호가 같은 기록(날짜·종류·시간)이면 그 줄, 아니면 탭에서 찾음. */
function findClockRow_(sheet, op) {
  var match = function (r) {
    return String(r[0]).trim() === op.date.slice(5) && normTime_(r[1]) === op.from && String(r[2]).trim().toUpperCase() === op.info;
  };
  if (op.row >= 2 && match(sheet.getRange(op.row, 1, 1, 3).getDisplayValues()[0])) return op.row;
  var last = sheet.getLastRow();
  if (last < 2) return 0;
  var rows = sheet.getRange(2, 1, last - 1, 3).getDisplayValues();
  for (var i = 0; i < rows.length; i++) if (match(rows[i])) return i + 2;
  return 0;
}

/** 시간 순서 자리에 한 줄 넣기 (그보다 늦은 첫 기록 앞, 없으면 맨 끝). */
function insertClockRow_(sheet, values) {
  var last = sheet.getLastRow(), at = last + 1, key = values[0] + ' ' + values[1];
  if (last >= 2) {
    var rows = sheet.getRange(2, 1, last - 1, 3).getDisplayValues();
    for (var i = 0; i < rows.length; i++) {
      var t = normTime_(rows[i][1]), md = String(rows[i][0]).trim();
      if (t && /^\d{2}-\d{2}$/.test(md) && md + ' ' + t > key) { at = i + 2; break; }
    }
  }
  if (at <= last) sheet.insertRowBefore(at);
  sheet.getRange(at, 1, 1, 4).setNumberFormat('@').setValues([values]);
  sheet.getRange(at, 2).setBackground(TC_CHANGED_BG);
  return at;
}

/** 직원 한 명에게 푸시. 조용한 시간(23~9시)에는 모아 두었다가 09:00 에. */
function notifyPerson_(name, message) {
  if (isQuiet_()) {
    var q = JSON.parse(props_.getProperty('PERSON_QUEUE') || '[]');
    q.push({ name: name, message: message });
    props_.setProperty('PERSON_QUEUE', JSON.stringify(q.slice(-60)));
    return 0;
  }
  var sent = 0;
  pushSubscriptions_(name).forEach(function (s) {
    var code;
    try { code = sendWebPush_(s.sub, message); } catch (err) { console.error(err); return; }
    if (code === 404 || code === 410) props_.deleteProperty(s.key);
    else if (code >= 200 && code < 300) sent++;
  });
  return sent;
}

function flushPersonQueue_() {
  var q = JSON.parse(props_.getProperty('PERSON_QUEUE') || '[]');
  props_.deleteProperty('PERSON_QUEUE');
  q.forEach(function (x) { notifyPerson_(x.name, x.message); });
  return q.length;
}

// ------------------------------------------------------------------ 계약 · 조정

function configTabRows_(tab, width) {
  var sh = SpreadsheetApp.openById(requiredProp_('CONFIG_SHEET_ID')).getSheetByName(tab);
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, width).getDisplayValues();
}

/** '2026-09-01', '01/09/2026', '1.9.2026' → 'yyyy-MM-dd' 또는 ''. */
function parseDay_(s) {
  s = String(s || '').trim();
  var m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/), y, mo, d;
  if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; } else {
    m = s.match(/^(\d{1,2})[\/.](\d{1,2})[\/.](\d{4})$/);
    if (!m) return '';
    d = +m[1]; mo = +m[2]; y = +m[3];
  }
  var t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return '';
  return t.toISOString().slice(0, 10);
}

/** '35', '35,5', '37.5', '35:30', '35h30', '-7', '−3:30' → 분(정수) 또는 NaN. */
function parseHoursMin_(s) {
  s = String(s || '').trim().replace(/\s/g, '').replace('−', '-');
  var m = s.match(/^(-?)(\d+)(?:[:h](\d{1,2}))?h?$/);
  if (m) return (m[1] ? -1 : 1) * (+m[2] * 60 + (+m[3] || 0));
  if (/^-?\d+(?:[.,]\d+)?$/.test(s)) return Math.round(parseFloat(s.replace(',', '.')) * 60);
  return NaN;
}

function contractsFor_(name) {
  var key = name.toLowerCase(), list = [], problems = [];
  configTabRows_('Contracts', 6).forEach(function (r, i) {
    if (String(r[0]).trim().toLowerCase() !== key) return;
    var from = parseDay_(r[1]), to = String(r[2]).trim() ? parseDay_(r[2]) : '', weekly = parseHoursMin_(r[3]);
    if (!from || (String(r[2]).trim() && !to) || !(weekly > 0)) { problems.push('Contracts row ' + (i + 2)); return; }
    list.push({ from: from, to: to, weeklyMin: weekly,
                settlement: /^q/i.test(String(r[4]).trim()) ? 'quarterly' : 'weekly', note: String(r[5]).trim() });
  });
  list.sort(function (a, b) { return a.from < b.from ? -1 : 1; });
  return { list: list, problems: problems };
}

function adjustmentsFor_(name) {
  var key = name.toLowerCase(), out = [];
  configTabRows_('Time Adjustments', 4).forEach(function (r) {
    if (String(r[0]).trim().toLowerCase() !== key) return;
    var date = parseDay_(r[1]), min = parseHoursMin_(r[2]);
    if (date && min) out.push({ date: date, min: min, reason: String(r[3]).trim() });
  });
  return out;
}

function contractOn_(list, day) {
  for (var i = list.length - 1; i >= 0; i--) {
    if (list[i].from <= day && (!list[i].to || day <= list[i].to)) return list[i];
  }
  return null;
}

// ------------------------------------------------------------------ 초과근무 원장 (분기 단위, 본인 것만)

function quarterOf_(day) { return day.slice(0, 4) + '-Q' + (Math.floor((+day.slice(5, 7) - 1) / 3) + 1); }

/** 그 분기의 주(월요일 날짜 번호) — 목요일이 분기 안에 있는 주. */
function quarterWeeks_(q) {
  var y = +q.slice(0, 4), sm = (+q.slice(6) - 1) * 3;
  var first = Date.UTC(y, sm, 1) / 86400000, last = Date.UTC(y, sm + 3, 0) / 86400000;
  var thu = first;
  while (new Date(thu * 86400000).getUTCDay() !== 4) thu++;
  var out = [];
  for (; thu <= last; thu += 7) out.push(thu - 3);
  return out;
}

function isoWeek_(monday) {
  var thu = new Date((monday + 3) * 86400000), y = thu.getUTCFullYear();
  return 'W' + (Math.floor((monday + 3 - Date.UTC(y, 0, 1) / 86400000) / 7) + 1);
}

function overtimeView_(req) {
  var name = whoAmI_(req.token);
  var now = todayStamp_(), curQ = quarterOf_(now.slice(0, 10));
  var q = String(req.quarter || curQ);
  if (!/^\d{4}-Q[1-4]$/.test(q) || q > curQ) fail_('Invalid quarter.');
  var c = contractsFor_(name);
  var out = overtimeLedger_(name, q, c.list, adjustmentsFor_(name), now);
  out.ok = true;
  out.quarter = q;
  out.current = curQ;
  out.problems = c.problems;
  return out;
}

/**
 * 분기 원장. entries = 주(week)·조정(adj)·결산(settle) 줄을 날짜순으로, 각 줄 debit/credit(분) + 잔액(balance).
 * week 줄: from, to, worked, contract, days[{date,min}], flags { missing, pending }.
 * thisWeek = 아직 끝나지 않은 주(가계산, 원장에 넣지 않음).
 */
function overtimeLedger_(name, q, contracts, adjs, now) {
  var today = dayNum_(now.slice(0, 10));
  var mondays = quarterWeeks_(q);
  var qFrom = dayStr_(mondays[0]), qTo = dayStr_(mondays[mondays.length - 1] + 6);
  var shown = contracts.filter(function (k) { return k.from <= qTo && (!k.to || k.to >= qFrom); });
  var res = { contracts: shown, entries: [], thisWeek: null, totals: { debit: 0, credit: 0 }, balance: 0, closed: false };
  if (!shown.length) return res;

  // 주 범위 앞뒤 하루까지의 기록 (자정 넘긴 근무)
  var loadTo = Math.min(mondays[mondays.length - 1] + 7, today);
  var months = [], m = dayStr_(mondays[0] - 1).slice(0, 7), endM = dayStr_(loadTo).slice(0, 7);
  for (; m <= endM; m = shiftMonth_(m, 1)) months.push(m);
  var rows = [];
  months.forEach(function (mm) { rows = rows.concat(monthClockRows_(name, mm)); });
  var pairs = pairShifts_(timedEvents_(rows), now);
  var pendingOps = myChangeOps_(name).filter(function (o) { return o.status === 'pending'; });

  var bal = 0, debit = 0, credit = 0, lastSettle = 'weekly';
  var post = function (e) {
    bal += (e.credit || 0) - (e.debit || 0);
    debit += e.debit || 0;
    credit += e.credit || 0;
    e.balance = bal;
    res.entries.push(e);
  };
  mondays.forEach(function (mon) {
    var sun = mon + 6, from = dayStr_(mon), to = dayStr_(sun);
    if (mon > today) return;
    var contractMin = 0, settle = null;
    for (var d = mon; d <= sun; d++) {
      var k = contractOn_(contracts, dayStr_(d));
      if (k) { contractMin += k.weeklyMin / 7; settle = k.settlement; }
    }
    if (!settle) return; // 이 주에는 계약 없음
    contractMin = Math.round(contractMin);
    var inWeek = function (date) { return date >= from && date <= to; };
    var days = {}, worked = 0;
    pairs.shifts.forEach(function (s) {
      if (!inWeek(s.start.date)) return;
      worked += s.min;
      days[s.start.date] = (days[s.start.date] || 0) + s.min;
    });
    var flags = {
      missing: pairs.missing.filter(function (x) { return inWeek(x.date); }).length,
      pending: pendingOps.filter(function (o) { return inWeek(o.op.date); }).length,
      live: !!(pairs.live && inWeek(pairs.live.date)),
    };
    var week = { type: 'week', week: isoWeek_(mon), from: from, to: to, worked: worked, contract: contractMin,
                 days: Object.keys(days).sort().map(function (k2) { return { date: k2, min: days[k2] }; }), flags: flags };
    var weekAdj = adjs.filter(function (a) { return inWeek(a.date); })
      .sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    if (sun >= today) { // 진행 중인 주: 가계산만
      week.adjust = weekAdj.reduce(function (s2, a) { return s2 + a.min; }, 0);
      res.thisWeek = week;
      return;
    }
    var diff = worked - contractMin;
    week.debit = diff < 0 ? -diff : 0;
    week.credit = diff > 0 ? diff : 0;
    post(week);
    weekAdj.forEach(function (a) {
      post({ type: 'adj', date: a.date, reason: a.reason, debit: a.min < 0 ? -a.min : 0, credit: a.min > 0 ? a.min : 0 });
    });
    lastSettle = settle;
    if (settle === 'weekly' && bal !== 0) {
      post({ type: 'settle', period: isoWeek_(mon), date: to, debit: bal > 0 ? bal : 0, credit: bal < 0 ? -bal : 0 });
    }
  });
  var lastSun = mondays[mondays.length - 1] + 6;
  res.closed = lastSun < today;
  if (res.closed && bal !== 0) {
    post({ type: 'settle', period: q, date: dayStr_(lastSun), debit: bal > 0 ? bal : 0, credit: bal < 0 ? -bal : 0 });
  }
  res.totals = { debit: debit, credit: credit };
  res.balance = bal;
  res.settlement = lastSettle;
  return res;
}

/** 편집기에서 실행: 직원마다 계약과 이번 분기 잔액을 로그로 (시트 입력 확인용). */
function checkHours() {
  employeesMemo_ = null;
  var now = todayStamp_(), q = quarterOf_(now.slice(0, 10));
  employees_().forEach(function (e) {
    var c = contractsFor_(e.name);
    if (!c.list.length) { Logger.log(e.name + ': no contract' + (c.problems.length ? ' (check ' + c.problems.join(', ') + ')' : '')); return; }
    var l = overtimeLedger_(e.name, q, c.list, adjustmentsFor_(e.name), now);
    Logger.log(e.name + ': ' + c.list.map(function (k) {
      return k.from + '~' + (k.to || '') + ' ' + (k.weeklyMin / 60) + 'h ' + k.settlement;
    }).join(' / ') + ' · ' + q + ' balance ' + l.balance + ' min' + (c.problems.length ? ' · check ' + c.problems.join(', ') : ''));
  });
}
