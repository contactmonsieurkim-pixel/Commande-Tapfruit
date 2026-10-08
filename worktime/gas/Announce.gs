// 공지사항 — 게시, 읽음 확인, 알림(웹 푸시 + 메일), 매일 리마인더, 위·변조 감지 기록
//
// "Announcement Records" 스프레드시트 (setup() 이 생성, 모든 시트 보호):
//   Announcements : ID | Posted at | Posted by | Title | Content | Photos | Recipients | Type | Hash
//                   (Type: Rule = 출근 도장 화면에 팁으로 랜덤 표시, Notice = 일반 공지.
//                    대상을 좁힌 경우 'Rule · Teams: Kitchen · People: Yuna' 처럼 대상이 이어서 기록됨)
//   Confirmations : Announcement ID | Title | Name | Confirmed at | Hash
//   Notifications : Sent at | Announcement IDs | Name | Channel | Result | Hash
// 각 행의 Hash 는 직전 행 Hash + 내용으로 만든 HMAC 체인 -> verifyRecords() 로 수정 여부 검사.

var APP_URL_DEFAULT = 'https://contactmonsieurkim-pixel.github.io/Commande-Tapfruit/worktime/';
var REMINDER_HOUR = 10;          // 매일 리마인더 시각 (파리 시간)
var PUSH_TITLE = 'I have an unread announcement !';
var MAX_PHOTOS = 6;

var REC_SHEETS = {
  Announcements: ['ID', 'Posted at', 'Posted by', 'Title', 'Content', 'Photos', 'Recipients', 'Type', 'Hash'],
  Confirmations: ['Announcement ID', 'Title', 'Name', 'Confirmed at', 'Hash'],
  Notifications: ['Sent at', 'Announcement IDs', 'Name', 'Channel', 'Result', 'Hash'],
};

// ------------------------------------------------------------------ setup helpers

function ensureRecords_() {
  if (!props_.getProperty('LOG_KEY')) props_.setProperty('LOG_KEY', b64u_(randomBytes_(32)));
  var id = props_.getProperty('ANN_SHEET_ID');
  if (id) return SpreadsheetApp.openById(id);
  var ss = SpreadsheetApp.create('Announcement Records');
  DriveApp.getFileById(ss.getId()).moveTo(folder_());
  var first = ss.getSheets()[0];
  Object.keys(REC_SHEETS).forEach(function (name, i) {
    var sh = i === 0 ? first.setName(name) : ss.insertSheet(name);
    var head = REC_SHEETS[name];
    sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold');
    sh.getRange(1, 1, sh.getMaxRows(), head.length).setNumberFormat('@').setVerticalAlignment('top');
    sh.setFrozenRows(1);
    var p = sh.protect().setDescription('System records: written only by the Work Time system');
    p.removeEditors(p.getEditors());
    if (p.canDomainEdit()) p.setDomainEdit(false);
  });
  props_.setProperty('ANN_SHEET_ID', ss.getId());
  return ss;
}

function photoFolder_() {
  var id = props_.getProperty('PHOTO_FOLDER_ID');
  if (id) return DriveApp.getFolderById(id);
  var f = folder_().createFolder('Announcement Photos');
  props_.setProperty('PHOTO_FOLDER_ID', f.getId());
  return f;
}

function installTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'dailyReminder') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('dailyReminder').timeBased().everyDays(1).atHour(REMINDER_HOUR)
    .inTimezone(TZ).create();
}

// ------------------------------------------------------------------ records (hash chain)

function recSheet_(name) {
  return SpreadsheetApp.openById(requiredProp_('ANN_SHEET_ID')).getSheetByName(name);
}

function rowHash_(prev, values) {
  return bytesToHex_(hmac_(unb64u_(requiredProp_('LOG_KEY')), utf8_(prev + '␞' + values.join('␟'))));
}

/** 기록 시트에 한 줄 추가 (호출 측에서 script lock 을 잡고 있어야 함). */
function appendRecord_(name, values) {
  values = values.map(String);
  var key = 'chain_' + name, prev = props_.getProperty(key) || '';
  var hash = rowHash_(prev, values);
  var sh = recSheet_(name), row = sh.getLastRow() + 1;
  var cells = values.map(function (v) { return /^[=+\-@']/.test(v) ? "'" + v : v; }).concat([hash]);
  sh.getRange(row, 1, 1, cells.length).setNumberFormat('@').setValues([cells]);
  props_.setProperty(key, hash);
  return row;
}

function readRecords_(name) {
  var sh = recSheet_(name), n = sh.getLastRow() - 1;
  if (n < 1) return [];
  return sh.getRange(2, 1, n, REC_SHEETS[name].length).getValues().map(function (r) {
    return r.map(String);
  });
}

/** 편집기에서 실행: 기록 시트가 시스템 밖에서 수정·삭제되었는지 검사. */
function verifyRecords() {
  var report = Object.keys(REC_SHEETS).map(function (name) {
    var rows = readRecords_(name), prev = '';
    for (var i = 0; i < rows.length; i++) {
      var vals = rows[i].slice(0, -1), hash = rows[i][rows[i].length - 1];
      if (rowHash_(prev, vals) !== hash) return { sheet: name, ok: false, row: i + 2 };
      prev = hash;
    }
    var last = props_.getProperty('chain_' + name) || '';
    if (prev !== last) return { sheet: name, ok: false, row: rows.length + 1, note: 'rows deleted at the end' };
    return { sheet: name, ok: true, rows: rows.length };
  });
  Logger.log(JSON.stringify(report));
  return report;
}

// ------------------------------------------------------------------ data access

function announcements_() {
  return readRecords_('Announcements').map(function (r) {
    return {
      id: r[0], posted: r[1], by: r[2], title: r[3], content: r[4],
      photos: (r[5].match(/\/d\/[\w-]+/g) || []).map(function (s) { return s.slice(3); }),
      recipients: r[6] ? r[6].split(', ') : [],
      rule: r[7].split(' · ')[0] === 'Rule',
      audience: parseAudience_(r[7]),
    };
  });
}

function confirmations_() {
  var map = {};
  readRecords_('Confirmations').forEach(function (r) { map[r[0] + '\n' + r[2]] = r[3]; });
  return map;
}

function unreadFor_(name, anns, confs) {
  anns = anns || announcements_();
  confs = confs || confirmations_();
  return anns.filter(function (a) {
    return a.recipients.indexOf(name) >= 0 && !confs[a.id + '\n' + name];
  });
}

// ------------------------------------------------------------------ audience (전체 / 팀 / 개인)

/** Type 셀의 대상 부분 해석. 대상 표기가 없으면 전체(null). */
function parseAudience_(typeCell) {
  var parts = String(typeCell).split(' · ').slice(1);
  if (!parts.length) return null;
  var aud = { teams: [], people: [] };
  parts.forEach(function (p) {
    var m = p.match(/^(Teams|People): (.*)$/);
    if (m) aud[m[1] === 'Teams' ? 'teams' : 'people'] = m[2].split(', ');
  });
  return aud;
}

function audienceLabel_(aud) {
  if (!aud) return '';
  var out = [];
  if (aud.teams.length) out.push('Teams: ' + aud.teams.join(', '));
  if (aud.people.length) out.push('People: ' + aud.people.join(', '));
  return out.join(' · ');
}

/** 요청의 대상 → 정규화된 대상(전체면 null) + 수신자 이름 목록. */
function resolveAudience_(req) {
  var staff = activeEmployees_();
  var a = req.audience;
  if (!a || a === 'all') return { audience: null, recipients: staff.map(function (e) { return e.name; }) };
  var teams = [], people = [];
  (a.teams || []).forEach(function (t) {
    var ok = staff.some(function (e) { return e.team && e.team.toLowerCase() === String(t).toLowerCase(); });
    if (!ok) fail_('Unknown team: ' + t);
    var canon = staff.filter(function (e) { return e.team.toLowerCase() === String(t).toLowerCase(); })[0].team;
    if (teams.indexOf(canon) < 0) teams.push(canon);
  });
  (a.people || []).forEach(function (n) {
    var e = findEmployee_(n);
    if (!e) fail_('Unknown or inactive employee: ' + n);
    if (people.indexOf(e.name) < 0) people.push(e.name);
  });
  var recipients = staff.filter(function (e) {
    return teams.indexOf(e.team) >= 0 || people.indexOf(e.name) >= 0;
  }).map(function (e) { return e.name; });
  if (!recipients.length) fail_('Please choose at least one recipient.');
  return { audience: { teams: teams, people: people }, recipients: recipients };
}

function staff_(req) {
  if (!isAdmin_(whoAmI_(req.token))) fail_('Only managers can see this.');
  return { ok: true, staff: activeEmployees_().map(function (e) { return { name: e.name, team: e.team }; }) };
}

/**
 * 출근 도장 화면에 랜덤으로 보여줄 규칙 목록 (Type = Rule).
 * 전체 대상 규칙은 모두에게, 팀 대상 규칙은 지금 그 팀 사람(신규 입사자 포함)에게, 개인 대상은 그 사람에게.
 */
function tips_(name) {
  if (!props_.getProperty('ANN_SHEET_ID')) return [];
  var me = name ? findEmployee_(name) : null;
  return announcements_().filter(function (a) {
    if (!a.rule) return false;
    if (!a.audience || !me) return true;
    return a.recipients.indexOf(me.name) >= 0 || a.audience.people.indexOf(me.name) >= 0 ||
      (me.team && a.audience.teams.indexOf(me.team) >= 0);
  })
    .map(function (a) { return { id: a.id, title: a.title, content: a.content }; });
}

function nowStamp_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss'); }

// ------------------------------------------------------------------ API actions

function pushKey_() {
  return { ok: true, publicKey: vapidKeys_().pub };
}

function subscribe_(req) {
  var name = whoAmI_(req.token), sub = req.sub || {};
  if (!/^https:\/\//.test(String(sub.endpoint)) || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
    fail_('Invalid push subscription.');
  }
  var id = 'push_' + bytesToHex_(sha256_(utf8_(sub.endpoint))).slice(0, 32);
  props_.setProperty(id, JSON.stringify({ name: name, endpoint: sub.endpoint, keys: sub.keys }));
  return { ok: true };
}

function annList_(req) {
  var name = whoAmI_(req.token), confs = confirmations_();
  var list = announcements_().filter(function (a) { return a.recipients.indexOf(name) >= 0; })
    .map(function (a) {
      return { id: a.id, posted: a.posted, by: a.by, title: a.title, content: a.content, rule: a.rule,
               photos: a.photos.length, confirmedAt: confs[a.id + '\n' + name] || null };
    }).reverse();
  return { ok: true, announcements: list };
}

function annPhoto_(req) {
  var name = whoAmI_(req.token);
  var a = announcements_().filter(function (x) { return x.id === req.id; })[0];
  if (!a || (a.recipients.indexOf(name) < 0 && !isAdmin_(name))) fail_('Not found.');
  var fileId = a.photos[Number(req.index)];
  if (!fileId) fail_('Not found.');
  var blob = DriveApp.getFileById(fileId).getBlob();
  return { ok: true, dataUrl: 'data:' + blob.getContentType() + ';base64,' + Utilities.base64Encode(blob.getBytes()) };
}

function confirm_(req) {
  var name = whoAmI_(req.token);
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var a = announcements_().filter(function (x) { return x.id === req.id; })[0];
    if (!a || a.recipients.indexOf(name) < 0) fail_('Announcement not found.');
    var confs = confirmations_(), at = confs[a.id + '\n' + name];
    if (!at) {
      at = nowStamp_();
      appendRecord_('Confirmations', [a.id, a.title, name, at]);
    }
    return { ok: true, confirmedAt: at, unread: unreadFor_(name, null, null).length };
  } finally {
    lock.releaseLock();
  }
}

function post_(req) {
  var name = whoAmI_(req.token);
  if (!isAdmin_(name)) fail_('Only managers can post announcements.');
  var title = String(req.title || '').trim().replace(/\s+/g, ' ');
  var content = String(req.content || '').replace(/\r\n?/g, '\n').trim();
  if (!title || !content) fail_('Please enter a title and the content.');
  var photos = (req.photos || []).map(function (p, i) {
    var m = String(p || '').match(/^data:(image\/[\w.+-]+);base64,(.+)$/);
    if (!m) fail_('Photo ' + (i + 1) + ' is not an image.');
    return { type: m[1], data: m[2] };
  });
  if (photos.length > MAX_PHOTOS) fail_('Up to ' + MAX_PHOTOS + ' photos.');

  var target = resolveAudience_(req), recipients = target.recipients;
  var type = (req.rule ? 'Rule' : 'Notice') + (target.audience ? ' · ' + audienceLabel_(target.audience) : '');
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  var ann;
  try {
    var seq = Number(props_.getProperty('ANN_SEQ') || 0) + 1;
    var id = 'A' + ('000' + seq).slice(-4);
    var folder = photoFolder_();
    var links = photos.map(function (p, i) {
      var file = folder.createFile(Utilities.newBlob(Utilities.base64Decode(p.data), p.type, id + '-' + (i + 1) + '.jpg'));
      return 'https://drive.google.com/file/d/' + file.getId() + '/view';
    });
    var posted = nowStamp_();
    appendRecord_('Announcements', [id, posted, name, title, content, links.join('\n'), recipients.join(', '), type]);
    props_.setProperty('ANN_SEQ', String(seq));
    ann = announcements_().filter(function (x) { return x.id === id; })[0];
  } finally {
    lock.releaseLock();
  }

  var sent = activeEmployees_().filter(function (e) { return recipients.indexOf(e.name) >= 0; })
    .map(function (e) { return notify_(e, [ann], true); });
  return { ok: true, id: ann.id, notified: sent.length };
}

function annStatus_(req) {
  var name = whoAmI_(req.token);
  if (!isAdmin_(name)) fail_('Only managers can see this.');
  var confs = confirmations_();
  var list = announcements_().map(function (a) {
    var done = [], pending = [];
    a.recipients.forEach(function (r) {
      var at = confs[a.id + '\n' + r];
      if (at) done.push({ name: r, at: at }); else pending.push(r);
    });
    return { id: a.id, posted: a.posted, title: a.title, rule: a.rule, audience: audienceLabel_(a.audience) || 'Everyone',
             confirmed: done, pending: pending };
  }).reverse();
  var integrity = verifyRecords().every(function (x) { return x.ok; });
  return { ok: true, announcements: list, integrity: integrity };
}

// ------------------------------------------------------------------ notifications

/** 직원 한 명에게 웹 푸시 + 메일 (읽지 않은 공지 목록). */
function notify_(emp, anns, isNew) {
  var ids = anns.map(function (a) { return a.id; }).join(', ');
  var appUrl = (props_.getProperty('APP_URL') || APP_URL_DEFAULT) + '?view=ann';
  var body = anns.length === 1 ? anns[0].title : anns.length + ' announcements: ' +
    anns.map(function (a) { return a.title; }).join(', ');
  var results = [];

  var subs = pushSubscriptions_(emp.name);
  if (!subs.length) results.push(['push', 'no device registered']);
  subs.forEach(function (s) {
    var code;
    try {
      code = sendWebPush_(s.sub, { title: PUSH_TITLE, body: body, url: appUrl });
    } catch (err) {
      code = 'error: ' + err.message;
    }
    if (code === 404 || code === 410) props_.deleteProperty(s.key);
    results.push(['push', String(code)]);
  });

  if (emp.email) {
    try {
      var mail = buildMail_(anns, appUrl, isNew);
      MailApp.sendEmail({ to: emp.email, subject: PUSH_TITLE, htmlBody: mail.html,
                          inlineImages: mail.images, name: 'Work Time' });
      results.push(['email', 'sent']);
    } catch (err2) {
      results.push(['email', 'error: ' + err2.message]);
    }
  } else {
    results.push(['email', 'no email address']);
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    results.forEach(function (r) {
      appendRecord_('Notifications', [nowStamp_(), ids, emp.name, (isNew ? 'new ' : 'reminder ') + r[0], r[1]]);
    });
  } finally {
    lock.releaseLock();
  }
  return results;
}

function pushSubscriptions_(name) {
  var all = props_.getProperties(), out = [];
  Object.keys(all).forEach(function (k) {
    if (k.indexOf('push_') !== 0) return;
    var s = JSON.parse(all[k]);
    if (s.name === name) out.push({ key: k, sub: s });
  });
  return out;
}

function esc_(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildMail_(anns, appUrl, withPhotos) {
  var images = {}, parts = anns.map(function (a) {
    var imgs = '';
    if (withPhotos) {
      a.photos.forEach(function (fid, i) {
        var key = 'p' + a.id + '_' + i;
        images[key] = DriveApp.getFileById(fid).getBlob();
        imgs += '<p><img src="cid:' + key + '" style="max-width:100%;border-radius:8px"></p>';
      });
    }
    return '<div style="border:1px solid #dfe4e1;border-radius:12px;padding:16px;margin:12px 0">' +
      '<div style="color:#66706b;font-size:13px">' + esc_(a.posted) + ' · ' + esc_(a.by) + '</div>' +
      '<h2 style="margin:4px 0 8px;font-size:18px">' + esc_(a.title) + '</h2>' +
      '<div style="white-space:pre-wrap">' + esc_(a.content) + '</div>' + imgs + '</div>';
  });
  var html = '<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px">' +
    '<h1 style="font-size:20px">' + PUSH_TITLE + '</h1>' + parts.join('') +
    '<p><a href="' + esc_(appUrl) + '" style="display:inline-block;background:#1f6f54;color:#fff;' +
    'padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:600">' +
    'Open Work Time and confirm</a></p>' +
    '<p style="color:#66706b;font-size:13px">Please confirm in the Work Time app. ' +
    'You will get a reminder every day until you confirm.</p></div>';
  return { html: html, images: images };
}

/** 매일 트리거: 어제까지 게시된 공지 중 확인 안 한 직원에게 하루 한 번 알림. */
function dailyReminder() {
  var today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  var anns = announcements_().filter(function (a) { return a.posted.slice(0, 10) < today; });
  var confs = confirmations_();
  activeEmployees_().forEach(function (e) {
    var unread = unreadFor_(e.name, anns, confs);
    if (unread.length) notify_(e, unread, false);
  });
}
