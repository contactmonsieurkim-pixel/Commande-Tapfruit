// Work Time Log with NFC — Apps Script 백엔드 (API 전용)
//
// 스크립트 속성 (프로젝트 설정 > 스크립트 속성):
//   SDM_META_KEY  : ntag424_setup.py genkeys 가 출력한 값 (32 hex)
//   SDM_FILE_KEY  : ntag424_setup.py genkeys 가 출력한 값 (32 hex)
//   FOLDER_ID     : (선택) 기록 폴더 ID. 없으면 아래 기본값 사용
//   CONFIG_SHEET_ID : setup() 실행 시 자동 저장됨
//
// 시트 구조: <폴더>/<yyyy-MM> 스프레드시트 / <직원 이름> 시트 / DATE | TIME | Info | Modify

var DEFAULT_FOLDER_ID = '1YmCPvxaWF6sv61p94Iyt0B3VLzlZDGUJ'; // "Work Time Log with NFC"
var TZ = 'Europe/Paris';
var HEADER = ['DATE', 'TIME', 'Info', 'Modify'];
var EDIT_WINDOW_SEC = 60 * 60; // 태그 후 1시간 동안 시간 변경 요청 가능

var props_ = PropertiesService.getScriptProperties();

/** 최초 1회 편집기에서 실행: 직원 명단(Employees) 시트를 폴더에 생성. */
function setup() {
  if (props_.getProperty('CONFIG_SHEET_ID')) {
    Logger.log('이미 설정됨: ' + SpreadsheetApp.openById(props_.getProperty('CONFIG_SHEET_ID')).getUrl());
    return;
  }
  var ss = SpreadsheetApp.create('WorkTime Config');
  DriveApp.getFileById(ss.getId()).moveTo(folder_());
  var sh = ss.getSheets()[0].setName('Employees');
  sh.getRange(1, 1, 2, 3).setNumberFormat('@')
    .setValues([['Name', 'PIN', 'Active'], ['Example Name', '1234', 'TRUE']]);
  sh.setFrozenRows(1);
  props_.setProperty('CONFIG_SHEET_ID', ss.getId());
  Logger.log('직원 명단 시트: ' + ss.getUrl());
}

function doGet() {
  return json_({ ok: true, service: 'worktime' });
}

function doPost(e) {
  var req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'Bad request.' });
  }
  try {
    var handlers = { login: login_, tap: tap_, modify: modify_, me: me_ };
    var fn = handlers[req.action];
    if (!fn) return json_({ ok: false, error: 'Unknown action.' });
    return json_(fn(req));
  } catch (err) {
    if (err && err.userMessage) return json_({ ok: false, error: err.userMessage, code: err.code });
    console.error(err);
    return json_({ ok: false, error: 'Server error. Please tell your manager.' });
  }
}

// ------------------------------------------------------------------ actions

function login_(req) {
  var name = String(req.name || '').trim(), pin = String(req.pin || '').trim();
  var emp = findEmployee_(name);
  if (!emp || emp.pin !== pin) fail_('Wrong name or PIN.');
  var token = Utilities.getUuid();
  props_.setProperty('tok_' + token, emp.name);
  return { ok: true, token: token, name: emp.name };
}

function me_(req) {
  return { ok: true, name: whoAmI_(req.token) };
}

function tap_(req) {
  var name = whoAmI_(req.token);
  var a = String(req.a || ''), p = String(req.p || ''), c = String(req.c || '');
  if (!/^(START|END)$/.test(a) || !/^[0-9A-Fa-f]{32}$/.test(p) || !/^[0-9A-Fa-f]{16}$/.test(c)) {
    fail_('Invalid tag link. Please tap the tag again.');
  }
  var sun = verifySun_(requiredProp_('SDM_META_KEY'), requiredProp_('SDM_FILE_KEY'), a, p, c);
  if (!sun) fail_('This is not a valid company tag.');

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    // 같은 태그의 카운터는 매번 증가해야 함 -> 복사한 링크 재사용 차단
    var key = 'ctr_' + sun.uid;
    var last = Number(props_.getProperty(key) || -1);
    if (sun.counter <= last) fail_('This link was already used. Please tap the tag again.', 'REPLAY');
    props_.setProperty(key, String(sun.counter));

    var now = new Date();
    var month = Utilities.formatDate(now, TZ, 'yyyy-MM');
    var date = Utilities.formatDate(now, TZ, 'MM-dd');
    var time = Utilities.formatDate(now, TZ, 'HH:mm');
    var ss = monthSpreadsheet_(month);
    var sheet = employeeSheet_(ss, name);
    var row = sheet.getLastRow() + 1;
    sheet.getRange(row, 1, 1, 4).setNumberFormat('@').setValues([[date, time, a, '']]);
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }

  var editToken = Utilities.getUuid();
  CacheService.getScriptCache().put('edit_' + editToken,
    JSON.stringify({ ssId: ss.getId(), sheet: name, row: row, name: name }), EDIT_WINDOW_SEC);
  return { ok: true, name: name, date: date, time: time, info: a, editToken: editToken };
}

function modify_(req) {
  var name = whoAmI_(req.token);
  var time = String(req.time || '');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) fail_('Please enter a valid time (HH:MM).');
  var raw = CacheService.getScriptCache().get('edit_' + String(req.editToken || ''));
  if (!raw) fail_('The time change window has expired. Please tell your manager.');
  var edit = JSON.parse(raw);
  if (edit.name !== name) fail_('You can only change your own record.');
  var sheet = SpreadsheetApp.openById(edit.ssId).getSheetByName(edit.sheet);
  sheet.getRange(edit.row, 4).setNumberFormat('@').setValue(time).setBackground('#fff3cd');
  return { ok: true, time: time };
}

// ------------------------------------------------------------------ helpers

function whoAmI_(token) {
  var name = token ? props_.getProperty('tok_' + token) : null;
  if (!name) fail_('Please log in again.', 'AUTH');
  var emp = findEmployee_(name);
  if (!emp) {
    props_.deleteProperty('tok_' + token);
    fail_('Your account is not active. Please tell your manager.', 'AUTH');
  }
  return emp.name;
}

function findEmployee_(name) {
  var id = requiredProp_('CONFIG_SHEET_ID');
  var rows = SpreadsheetApp.openById(id).getSheetByName('Employees').getDataRange().getDisplayValues();
  var wanted = String(name).trim().toLowerCase();
  for (var i = 1; i < rows.length; i++) {
    var n = String(rows[i][0]).trim();
    var active = String(rows[i][2]).trim().toUpperCase() !== 'FALSE';
    if (n && active && n.toLowerCase() === wanted) return { name: n, pin: String(rows[i][1]).trim() };
  }
  return null;
}

function folder_() {
  return DriveApp.getFolderById(props_.getProperty('FOLDER_ID') || DEFAULT_FOLDER_ID);
}

function monthSpreadsheet_(month) {
  var folder = folder_();
  var files = folder.getFilesByName(month);
  while (files.hasNext()) {
    var f = files.next();
    if (f.getMimeType() === MimeType.GOOGLE_SHEETS) return SpreadsheetApp.open(f);
  }
  var ss = SpreadsheetApp.create(month);
  DriveApp.getFileById(ss.getId()).moveTo(folder);
  return ss;
}

function employeeSheet_(ss, name) {
  var sheet = ss.getSheetByName(name);
  if (sheet) return sheet;
  var sheets = ss.getSheets();
  // 새로 만든 파일의 빈 기본 시트는 재사용
  if (sheets.length === 1 && sheets[0].getLastRow() === 0 &&
      /^(Sheet|Feuille|시트)\s?1$/.test(sheets[0].getName())) {
    sheet = sheets[0].setName(name);
  } else {
    sheet = ss.insertSheet(name);
  }
  sheet.getRange(1, 1, 1, 4).setValues([HEADER]).setFontWeight('bold');
  sheet.getRange('A:D').setNumberFormat('@');
  sheet.setFrozenRows(1);
  return sheet;
}

function requiredProp_(key) {
  var v = props_.getProperty(key);
  if (!v) throw new Error('Script property missing: ' + key);
  return v;
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
