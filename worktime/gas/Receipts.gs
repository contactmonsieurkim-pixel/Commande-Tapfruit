// 교통카드 정기권(TCL) 결제 영수증 — 직원이 매월 올리고, Supervisor 가 회계사에게 메일로 보냄
//   (정기권 비용의 50% 가 월급에 포함되어 지원됨. 안 올리면 본인 손해일 뿐이라 알림은 가볍게.)
//
//   - 대상: Employees 탭 H열(Transport receipt)이 FALSE 가 아닌 직원 (빈칸 = 대상)
//   - 기간: 그달 1일 ~ RECEIPT_DUE_DAY 일 (파리), 그달 정기권 영수증. 그 뒤에 올려도 그대로 받음
//     ('late' 로 기록 + 노란 안내 '다음엔 5일까지'. 5일 마감은 사람을 움직이게 하려는 것일 뿐, 늦은 것도 다음 발송 때 같이 감)
//   - 알림: 1일 09:00 메일 1통만. 1~5일 아직 안 올렸으면 메인 화면 버튼에 파란 색 (출근 도장 화면·푸시 없음)
//   - 파일: Drive 'Transport Receipts' 폴더에 '이름 yyyy-MM.jpg' (두 번째부터 ' (2)')
//   - 회계사 메일: Supervisor 가 화면에서 주소·내용을 확인하고 Confirm → 제출 여부 표(본문) + 첨부.
//     보내는 주소는 누가 눌러도 항상 SENDER_EMAIL (Apps Script 소유자 계정이어야 함).
//     보낸 파일은 Gmail '보낸편지함'에 남으므로 Drive 에서는 휴지통으로 옮김.
//
// 기록 ("Announcement Records", 해시 체인):
//   Receipts      : Saved at | Name | Month | File name | File ID | Status(on time / late / deleted) | Hash
//   Receipt Mails : Sent at | Month | Sent by | To | Summary | File IDs | Hash

var RECEIPT_DUE_DAY = 5;
var RECEIPT_MAX_FILES = 6;              // 한 번에 올릴 수 있는 파일 수
var RECEIPT_MAX_PER_MONTH = 12;         // 한 사람이 한 달에 올려 둘 수 있는 파일 수
var RECEIPT_MAX_BYTES = 10 * 1024 * 1024;  // 파일 하나 (PDF 포함)
var RECEIPT_MAIL_MAX_BYTES = 23 * 1024 * 1024; // Gmail 첨부 한도(25MB) 아래로
var RECEIPT_MAIL_TITLE = '🧾 Upload your TCL pass receipt';
var SENDER_EMAIL = 'contact.monsieurkim@gmail.com'; // 회계사 메일의 보내는 사람 (항상)

function receiptFolder_() {
  var id = props_.getProperty('RECEIPT_FOLDER_ID');
  if (id) return DriveApp.getFolderById(id);
  var f = folder_().createFolder('Transport Receipts');
  props_.setProperty('RECEIPT_FOLDER_ID', f.getId());
  return f;
}

/** 지금(파리) 영수증 달 'yyyy-MM' 과 날짜. */
function receiptNow_() {
  var now = new Date();
  return { month: Utilities.formatDate(now, TZ, 'yyyy-MM'), day: Number(Utilities.formatDate(now, TZ, 'dd')),
           at: nowStamp_() };
}

function monthLabel_(month) {
  return MONTH_LONG_[Number(month.slice(5, 7)) - 1] + ' ' + month.slice(0, 4);
}

function receiptDeadline_(month) {
  return RECEIPT_DUE_DAY + ' ' + MONTH_LONG_[Number(month.slice(5, 7)) - 1];
}

function prevMonth_(month, n) {
  var y = Number(month.slice(0, 4)), m = Number(month.slice(5, 7)) - (n || 1);
  while (m < 1) { m += 12; y--; }
  return y + '-' + ('0' + m).slice(-2);
}

/**
 * 그달의 영수증 상태: files[id] = { id, name, fileName, at, late, sentAt }, mails[].
 * 올린 기록 → 지운 기록 → 보낸 기록 순서로 다시 계산.
 */
function receiptState_(month) {
  var files = {}, order = [];
  readRecords_('Receipts').forEach(function (r) {
    if (r[2] !== month) return;
    if (r[5] === 'deleted') { delete files[r[4]]; return; }
    files[r[4]] = { id: r[4], name: r[1], fileName: r[3], at: r[0], late: r[5] === 'late', sentAt: '' };
    order.push(r[4]);
  });
  var mails = readRecords_('Receipt Mails').filter(function (r) { return r[1] === month; }).map(function (r) {
    var ids = r[5] ? r[5].split('\n') : [];
    ids.forEach(function (id) { if (files[id]) files[id].sentAt = r[0]; });
    return { at: r[0], by: r[2], to: r[3], summary: r[4], count: ids.length };
  });
  var list = order.filter(function (id, i) { return files[id] && order.indexOf(id) === i; })
    .map(function (id) { return files[id]; });
  return { files: list, mails: mails };
}

function filesOf_(state, name) {
  return state.files.filter(function (f) { return f.name === name; });
}

/**
 * 메인 화면 버튼 색: 1~5일이고, 대상이고, 이번 달에 아직 안 올렸으면 알림 정보. 아니면 null.
 */
function receiptDue_(name) {
  if (!props_.getProperty('ANN_SHEET_ID')) return null;
  var now = receiptNow_();
  if (now.day > RECEIPT_DUE_DAY) return null;
  var me = findEmployee_(name);
  if (!me || !me.transport) return null;
  if (filesOf_(receiptState_(now.month), me.name).length) return null;
  return { month: now.month, label: monthLabel_(now.month), deadline: receiptDeadline_(now.month),
           daysLeft: RECEIPT_DUE_DAY - now.day };
}

// ------------------------------------------------------------------ 직원

function receiptMineFor_(name) {
  var now = receiptNow_(), me = findEmployee_(name), state = receiptState_(now.month);
  return {
    ok: true, month: now.month, label: monthLabel_(now.month), deadline: receiptDeadline_(now.month),
    day: now.day, late: now.day > RECEIPT_DUE_DAY, required: !!(me && me.transport),
    files: filesOf_(state, name).map(function (f) {
      return { id: f.id, fileName: f.fileName, at: f.at, late: f.late, sent: !!f.sentAt };
    }),
  };
}

function receiptMine_(req) {
  return receiptMineFor_(whoAmI_(req.token));
}

function parseReceiptFiles_(list) {
  if (!list || !list.length) fail_('Please choose a photo or a file.');
  if (list.length > RECEIPT_MAX_FILES) fail_('Up to ' + RECEIPT_MAX_FILES + ' files at a time.');
  return list.map(function (p, i) {
    var m = String(p || '').match(/^data:(image\/(?:jpeg|png|webp|gif)|application\/pdf);base64,([A-Za-z0-9+\/=]+)$/);
    if (!m) fail_('File ' + (i + 1) + ' is not a photo or a PDF.');
    if (m[2].length * 3 / 4 > RECEIPT_MAX_BYTES) fail_('File ' + (i + 1) + ' is too large (max 10 MB).');
    var ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
                'application/pdf': 'pdf' }[m[1]];
    return { type: m[1], data: m[2], ext: ext };
  });
}

function receiptUpload_(req) {
  var name = whoAmI_(req.token);
  var files = parseReceiptFiles_(req.files);
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var now = receiptNow_(), late = now.day > RECEIPT_DUE_DAY;
    var mine = filesOf_(receiptState_(now.month), name);
    if (mine.length + files.length > RECEIPT_MAX_PER_MONTH) {
      fail_('Too many files for this month. Please delete some first.');
    }
    var used = mine.map(function (f) { return f.fileName.replace(/\.\w+$/, ''); });
    var folder = receiptFolder_(), n = 1;
    files.forEach(function (f) {
      var base;
      do { base = name + ' ' + now.month + (n > 1 ? ' (' + n + ')' : ''); n++; } while (used.indexOf(base) >= 0);
      used.push(base);
      var fileName = base + '.' + f.ext;
      var file = folder.createFile(Utilities.newBlob(Utilities.base64Decode(f.data), f.type, fileName));
      appendRecord_('Receipts', [nowStamp_(), name, now.month, fileName, file.getId(), late ? 'late' : 'on time']);
    });
  } finally {
    lock.releaseLock();
  }
  var out = receiptMineFor_(name);
  out.uploaded = files.length;
  return out;
}

/** 내 파일 지우기 (회계사에게 보내기 전까지만). */
function receiptDelete_(req) {
  var name = whoAmI_(req.token);
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var now = receiptNow_();
    var f = filesOf_(receiptState_(now.month), name).filter(function (x) { return x.id === req.id; })[0];
    if (!f) fail_('File not found.');
    if (f.sentAt) fail_('This file was already sent to the accountant.');
    try { DriveApp.getFileById(f.id).setTrashed(true); } catch (err) { console.error(err); }
    appendRecord_('Receipts', [nowStamp_(), name, now.month, f.fileName, f.id, 'deleted']);
  } finally {
    lock.releaseLock();
  }
  return receiptMineFor_(name);
}

/** 파일 보기: 올린 본인 또는 Supervisor. 보낸 파일은 Drive 에서 지워져 볼 수 없음. */
function receiptFile_(req) {
  var name = whoAmI_(req.token), me = findEmployee_(name);
  var month = /^\d{4}-\d\d$/.test(String(req.month || '')) ? req.month : receiptNow_().month;
  var f = receiptState_(month).files.filter(function (x) { return x.id === req.id; })[0];
  if (!f || (f.name !== name && !(me && me.supervisor))) fail_('Not found.');
  if (f.sentAt) fail_('Already sent to the accountant (see Gmail).');
  var blob = DriveApp.getFileById(f.id).getBlob();
  return { ok: true, fileName: f.fileName,
           dataUrl: 'data:' + blob.getContentType() + ';base64,' + Utilities.base64Encode(blob.getBytes()) };
}

// ------------------------------------------------------------------ Supervisor

function requireSupervisor_(req) {
  var me = findEmployee_(whoAmI_(req.token));
  if (!me || !me.supervisor) fail_('Only the supervisor can see this.');
  return me;
}

/** 현황: 사람마다 파일·상태. 대상이 아닌 사람은 올린 게 있을 때만 보임. */
function receiptPeople_(state) {
  var staff = activeEmployees_(), names = staff.map(function (e) { return e.name; });
  var people = staff.filter(function (e) { return e.transport || filesOf_(state, e.name).length; })
    .map(function (e) { return { name: e.name, team: e.team, required: e.transport }; });
  // 퇴사(비활성) 처리됐지만 이번 달 파일이 있는 사람
  state.files.forEach(function (f) {
    if (names.indexOf(f.name) < 0 && !people.some(function (p) { return p.name === f.name; })) {
      people.push({ name: f.name, team: '', required: false });
    }
  });
  people.forEach(function (p) {
    p.files = filesOf_(state, p.name).map(function (f) {
      return { id: f.id, fileName: f.fileName, at: f.at, late: f.late, sentAt: f.sentAt };
    });
  });
  return people.sort(function (a, b) { return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1; });
}

function receiptStatus_(req) {
  requireSupervisor_(req);
  var now = receiptNow_();
  var month = /^\d{4}-\d\d$/.test(String(req.month || '')) ? req.month : now.month;
  var state = receiptState_(month);
  return {
    ok: true, month: month, label: monthLabel_(month), deadline: receiptDeadline_(month),
    current: now.month, open: month === now.month && now.day <= RECEIPT_DUE_DAY,
    months: [now.month, prevMonth_(now.month, 1), prevMonth_(now.month, 2)].map(function (m) {
      return { month: m, label: monthLabel_(m) };
    }),
    accountant: props_.getProperty('ACCOUNTANT_EMAIL') || '',
    people: receiptPeople_(state), mails: state.mails.reverse(),
  };
}

/** 이번에 보낼 파일 + 메일 본문(사람마다 제출 여부만). 미리보기와 실제 발송이 같은 함수를 씀. */
function receiptMail_(month) {
  var state = receiptState_(month), people = receiptPeople_(state);
  var attach = [], rows = [], yes = 0;
  people.forEach(function (p) {
    var send = p.files.filter(function (f) { return !f.sentAt; }); // 늦게 올린 것도 포함
    var submitted = send.length > 0 || p.files.some(function (f) { return f.sentAt; });
    if (submitted) yes++;
    send.forEach(function (f) { attach.push(f); });
    var td = 'padding:6px 14px;border:1px solid #dfe4e1';
    rows.push('<tr><td style="' + td + '">' + esc_(p.name) + '</td>' +
      '<td style="' + td + ';font-weight:600;color:' + (submitted ? '#1f8a4c' : '#c0392b') + '">' +
      (submitted ? 'Yes' : 'No') + '</td></tr>');
  });
  var summary = yes + ' of ' + people.length + ' submitted · ' + attach.length + ' file' +
    (attach.length === 1 ? '' : 's') + ' attached';
  var th = function (t) { return '<th style="padding:6px 14px;border:1px solid #dfe4e1;background:#f3f5f4;text-align:left">' + t + '</th>'; };
  var html = '<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:640px;color:#1d2420">' +
    '<p>Hello,</p><p>Please find attached the transport pass (TCL) receipts of our staff for <b>' +
    esc_(monthLabel_(month)) + '</b>.</p>' +
    '<table style="border-collapse:collapse;font-size:14px"><tr>' + th('Name') + th('Receipt submitted') + '</tr>' +
    rows.join('') + '</table>' +
    '<p>Best regards,<br>monsieur Kim</p></div>';
  return { attach: attach, html: html, summary: summary,
           subject: 'Transport pass receipts · ' + monthLabel_(month) + ' · monsieur Kim' };
}

/** 메일은 Apps Script 소유자 계정으로 나감 → 그 계정이 SENDER_EMAIL 이 아니면 보내지 않음. */
function checkSender_() {
  var me = String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
  if (me !== SENDER_EMAIL.toLowerCase()) {
    fail_('Emails must be sent from ' + SENDER_EMAIL + ', but the system runs as ' + (me || 'an unknown account') +
      '. Please deploy the Apps Script with ' + SENDER_EMAIL + '.');
  }
}

/**
 * 회계사에게 보내기. confirm 없이 부르면 미리보기(받는 사람·제목·본문·첨부 목록)만 돌려줌.
 * confirm 때는 미리보기에서 본 파일 목록(expect)과 같을 때만 보냄 (그 사이 누가 올리거나 지웠으면 다시 확인).
 */
function receiptSend_(req) {
  var me = requireSupervisor_(req);
  var month = String(req.month || '');
  if (!/^\d{4}-\d\d$/.test(month)) fail_('Please choose a month.');
  var to = String(req.to || '').trim();
  if (!/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(to)) fail_('Please enter the accountant\'s email address.');
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    checkSender_();
    var mail = receiptMail_(month);
    if (!mail.attach.length) fail_('There is no new receipt to send for ' + monthLabel_(month) + '.');
    var ids = mail.attach.map(function (f) { return f.id; });
    if (!req.confirm) {
      return { ok: true, preview: true, from: SENDER_EMAIL, to: to, subject: mail.subject, html: mail.html, summary: mail.summary,
               files: mail.attach.map(function (f) { return f.fileName; }), expect: ids };
    }
    if ((req.expect || []).slice().sort().join() !== ids.slice().sort().join()) {
      fail_('Something changed since you checked. Please review again.', 'CHANGED');
    }
    var total = 0, blobs = mail.attach.map(function (f) {
      var b = DriveApp.getFileById(f.id).getBlob().setName(f.fileName);
      total += b.getBytes().length;
      return b;
    });
    if (total > RECEIPT_MAIL_MAX_BYTES) fail_('The files are too large for one email (over 23 MB).');
    var msg = { to: to, subject: mail.subject, htmlBody: mail.html, attachments: blobs, name: 'monsieur Kim' };
    msg.replyTo = SENDER_EMAIL;
    MailApp.sendEmail(msg);
    var at = nowStamp_();
    appendRecord_('Receipt Mails', [at, month, me.name, to, mail.summary, ids.join('\n')]);
    props_.setProperty('ACCOUNTANT_EMAIL', to);
    // 보낸 파일은 Gmail 보낸편지함에 남으므로 Drive 에서는 휴지통으로
    ids.forEach(function (id) {
      try { DriveApp.getFileById(id).setTrashed(true); } catch (err) { console.error(err); }
    });
    return { ok: true, sent: ids.length, sentAt: at, to: to, summary: mail.summary };
  } finally {
    lock.releaseLock();
  }
}

// ------------------------------------------------------------------ 1일 09:00 알림 (morningRun 에서)

/** 매월 1일: 대상자 중 아직 안 올린 사람에게 메일 1통 (푸시 없음). 다른 날은 아무것도 안 함. */
function notifyReceipts_() {
  if (!props_.getProperty('ANN_SHEET_ID')) return 0;
  var now = receiptNow_();
  if (now.day !== 1) return 0;
  var key = 'RECEIPT_NOTIFIED';
  if (props_.getProperty(key) === now.month) return 0; // 같은 날 두 번 실행돼도 한 번만
  props_.setProperty(key, now.month);
  var state = receiptState_(now.month), n = 0;
  var url = (props_.getProperty('APP_URL') || APP_URL_DEFAULT) + '?view=receipt';
  var label = monthLabel_(now.month), deadline = receiptDeadline_(now.month);
  activeEmployees_().forEach(function (e) {
    if (!e.transport || !e.email || filesOf_(state, e.name).length) return;
    var result;
    try {
      MailApp.sendEmail({ to: e.email, subject: RECEIPT_MAIL_TITLE + ' (' + label + ')', name: 'monsieur Kim',
        htmlBody: '<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px">' +
          '<h1 style="font-size:20px;margin:0 0 8px">Transport pass receipt · ' + esc_(label) + '</h1>' +
          '<p>50% of your monthly transport pass (TCL) is paid back with your salary. To get it, upload the ' +
          'payment receipt of your <b>' + esc_(label) + '</b> pass in the app between the 1st and <b>' +
          esc_(deadline) + '</b>.</p>' +
          '<p style="margin:16px 0"><a href="' + esc_(url) + '" style="display:inline-block;background:#2b6cb0;' +
          'color:#fff;padding:14px 28px;border-radius:10px;text-decoration:none;font-weight:700;font-size:16px">' +
          'Upload receipt</a></p>' +
          '</div>' });
      result = 'sent';
    } catch (err) { result = 'error: ' + err.message; }
    var lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      appendRecord_('Notifications', [nowStamp_(), 'Receipt ' + now.month, e.name, 'receipt email', result]);
    } finally {
      lock.releaseLock();
    }
    n++;
  });
  return n;
}
