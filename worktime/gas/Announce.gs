// 공지사항 — 게시, 읽음 확인, 알림(웹 푸시 + 메일), 매일 리마인더, 위·변조 감지 기록
//
// "Announcement Records" 스프레드시트 (setup() 이 생성, 모든 시트 보호):
//   Announcements : ID | Posted at | Posted by | Title | Content | Photos | Recipients | Type | Hash
//                   (Type: Rule = 출근 도장 화면에 팁으로 랜덤 표시, Notice = 일반 공지.
//                    대상을 좁힌 경우 'Rule · Teams: Kitchen · People: Yuna' 처럼 대상이 이어서 기록됨)
//   Confirmations : Announcement ID | Title | Name | Confirmed at | Hash
//   Notifications : Sent at | Announcement IDs | Name | Channel | Result | Hash
//   Our Rules     : Rule ID | Version | Saved at | Saved by | Title | Content | Photos | Recipients | Audience | Legacy ID | Hash
//                   (수정할 때마다 새 버전 행 추가. 확인 기록은 Confirmations 에 'Rule-001 v2' 로)
//   Requests      : Sent at | From | Message | Hash   (직원 → Supervisor)
// 각 행의 Hash 는 직전 행 Hash + 내용으로 만든 HMAC 체인 -> verifyRecords() 로 수정 여부 검사.

var APP_URL_DEFAULT = 'https://contactmonsieurkim-pixel.github.io/Commande-Tapfruit/worktime/';
// 조용한 시간 (파리 시간): QUIET_START 시부터 다음날 QUIET_END 시까지는 알림·메일을 보내지 않고
// QUIET_END 시 정각에 모아서 보냄. 확인 안 한 공지 리마인더도 매일 QUIET_END 시 정각.
var QUIET_START = 23;
var QUIET_END = 9;
var PUSH_TITLE = 'I have an unread announcement !';
var RULE_PUSH_TITLE = 'Our Rules: please read and confirm';
var MAX_PHOTOS = 6;

var REC_SHEETS = {
  Announcements: ['ID', 'Posted at', 'Posted by', 'Title', 'Content', 'Photos', 'Recipients', 'Type', 'Hash'],
  Confirmations: ['Announcement ID', 'Title', 'Name', 'Confirmed at', 'Hash'],
  Notifications: ['Sent at', 'Announcement IDs', 'Name', 'Channel', 'Result', 'Hash'],
  Logins: ['Logged in at', 'Name', 'Device', 'Devices so far', 'Hash'],
  'Our Rules': ['Rule ID', 'Version', 'Saved at', 'Saved by', 'Title', 'Content', 'Photos', 'Recipients', 'Audience',
                'Legacy ID', 'Hash'],
  Requests: ['Sent at', 'From', 'Message', 'Hash'],
};

// ------------------------------------------------------------------ setup helpers

function ensureRecords_() {
  if (!props_.getProperty('LOG_KEY')) props_.setProperty('LOG_KEY', b64u_(randomBytes_(32)));
  var id = props_.getProperty('ANN_SHEET_ID'), ss;
  if (id) {
    ss = SpreadsheetApp.openById(id);
  } else {
    ss = SpreadsheetApp.create('Announcement Records');
    DriveApp.getFileById(ss.getId()).moveTo(folder_());
    initRecSheet_(ss.getSheets()[0].setName('Announcements'), 'Announcements');
    props_.setProperty('ANN_SHEET_ID', ss.getId());
  }
  // 나중에 추가된 기록 시트(예: Logins)도 기존 파일에 만들어 줌
  Object.keys(REC_SHEETS).forEach(function (name) {
    if (!ss.getSheetByName(name)) initRecSheet_(ss.insertSheet(name), name);
  });
  return ss;
}

function initRecSheet_(sh, name) {
  var head = REC_SHEETS[name];
  sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold');
  sh.getRange(1, 1, sh.getMaxRows(), head.length).setNumberFormat('@').setVerticalAlignment('top');
  sh.setFrozenRows(1);
  var p = sh.protect().setDescription('System records: written only by the Work Time system');
  p.removeEditors(p.getEditors());
  if (p.canDomainEdit()) p.setDomainEdit(false);
  return sh;
}

function photoFolder_() {
  var id = props_.getProperty('PHOTO_FOLDER_ID');
  if (id) return DriveApp.getFolderById(id);
  var f = folder_().createFolder('Announcement Photos');
  props_.setProperty('PHOTO_FOLDER_ID', f.getId());
  return f;
}

// ------------------------------------------------------------------ 조용한 시간 / 아침 9시 발송

function parisHour_() { return Number(Utilities.formatDate(new Date(), TZ, 'HH')); }

function isQuiet_() {
  var h = parisHour_();
  return h >= QUIET_START || h < QUIET_END;
}

/** 오늘(파리) h:00 의 Date. */
function parisTodayAt_(h) {
  var now = new Date();
  var day = Utilities.formatDate(now, TZ, 'yyyy-MM-dd');
  var off = Utilities.formatDate(now, TZ, 'Z'); // +0200
  return new Date(day + 'T' + ('0' + h).slice(-2) + ':00:00' + off.slice(0, 3) + ':' + off.slice(3));
}

/**
 * 시간 기반 트리거는 "그 시각부터 1시간 안 아무 때나" 실행되므로,
 * 매일 07시대에 scheduleMorning 이 그날 09:00 정각용 1회 트리거(morningRun)를 예약함.
 */
function installTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (['dailyReminder', 'scheduleMorning', 'morningRun'].indexOf(t.getHandlerFunction()) >= 0) {
      ScriptApp.deleteTrigger(t);
    }
  });
  ScriptApp.newTrigger('scheduleMorning').timeBased().everyDays(1).atHour(7).inTimezone(TZ).create();
  scheduleMorning();
}

function scheduleMorning() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'morningRun') ScriptApp.deleteTrigger(t);
  });
  if (parisHour_() < QUIET_END) {
    ScriptApp.newTrigger('morningRun').timeBased().at(parisTodayAt_(QUIET_END)).create();
  }
}

/** 조용한 시간에 만든 공지/룰 -> 09:00 발송 대기 (공지 'A0001', 룰 'Rule-001 v2'). */
function queueAnnouncement_(id) {
  var q = JSON.parse(props_.getProperty('NOTIFY_QUEUE') || '[]');
  q.push(id);
  props_.setProperty('NOTIFY_QUEUE', JSON.stringify(q));
}

// ------------------------------------------------------------------ records (hash chain)

function recSheet_(name) {
  var ss = SpreadsheetApp.openById(requiredProp_('ANN_SHEET_ID'));
  return ss.getSheetByName(name) || initRecSheet_(ss.insertSheet(name), name);
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
      kind: 'ann', key: r[0],
    };
  });
}

/** 일반 공지만 (예전에 공지로 올린 Rule 은 Our Rules 로 옮겨졌으므로 제외). */
function notices_() {
  return announcements_().filter(function (a) { return !a.rule; });
}

/** 확인 일시 (없으면 null). 룰 v1 은 이관 전 공지(Legacy ID)에서 확인한 것도 인정. */
function confirmedAt_(item, name, confs) {
  return confs[item.key + '\n' + name] || (item.legacy && confs[item.legacy + '\n' + name]) || null;
}

function confirmations_() {
  var map = {};
  readRecords_('Confirmations').forEach(function (r) { map[r[0] + '\n' + r[2]] = r[3]; });
  return map;
}

function unreadFor_(name, anns, confs) {
  anns = anns || notices_();
  confs = confs || confirmations_();
  return anns.filter(function (a) {
    return a.recipients.indexOf(name) >= 0 && !confirmedAt_(a, name, confs);
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

/** 출근 도장 화면에 랜덤으로 보여줄 규칙 = 이 사람에게 해당하는 Our Rules (최신 버전). */
function tips_(name) {
  if (!props_.getProperty('ANN_SHEET_ID')) return [];
  return visibleRules_(name).map(function (r) {
    var c = ruleItem_(r);
    return { id: c.id, title: c.title, content: c.content };
  });
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
  var list = notices_().filter(function (a) { return a.recipients.indexOf(name) >= 0; })
    .map(function (a) {
      return { id: a.id, posted: a.posted, title: a.title, content: a.content,
               photos: a.photos.length, confirmedAt: confirmedAt_(a, name, confs) };
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
    var a = notices_().filter(function (x) { return x.id === req.id; })[0];
    if (!a || a.recipients.indexOf(name) < 0) fail_('Announcement not found.');
    var confs = confirmations_(), at = confs[a.id + '\n' + name], already = !!at;
    if (!at) {
      at = nowStamp_();
      appendRecord_('Confirmations', [a.id, a.title, name, at]);
    }
    return { ok: true, confirmedAt: at, already: already, unread: unreadFor_(name, null, null).length,
             unreadRules: unreadRulesFor_(name).length };
  } finally {
    lock.releaseLock();
  }
}

function post_(req) {
  var name = whoAmI_(req.token);
  if (!isAdmin_(name)) fail_('Only managers can post announcements.');
  if (req.kind === 'rule' || req.rule) return createRule_(req, name);
  var title = String(req.title || '').trim().replace(/\s+/g, ' ');
  var content = String(req.content || '').replace(/\r\n?/g, '\n').trim();
  if (!title || !content) fail_('Please enter a title and the content.');
  var photos = parsePhotos_(req.photos);

  var target = resolveAudience_(req), recipients = target.recipients;
  var type = 'Notice' + (target.audience ? ' · ' + audienceLabel_(target.audience) : '');
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  var ann;
  try {
    var seq = Number(props_.getProperty('ANN_SEQ') || 0) + 1;
    var id = 'A' + ('000' + seq).slice(-4);
    var links = savePhotos_(photos, id);
    var posted = nowStamp_();
    appendRecord_('Announcements', [id, posted, name, title, content, links.join('\n'), recipients.join(', '), type]);
    props_.setProperty('ANN_SEQ', String(seq));
    ann = announcements_().filter(function (x) { return x.id === id; })[0];
  } finally {
    lock.releaseLock();
  }

  if (isQuiet_()) {
    queueAnnouncement_(ann.id); // 밤 23시~아침 9시 게시 -> 아침 9시에 푸시 + 메일
    return { ok: true, id: ann.id, notified: 0, queued: true, sendAt: ('0' + QUIET_END).slice(-2) + ':00' };
  }
  var sent = activeEmployees_().filter(function (e) { return recipients.indexOf(e.name) >= 0; })
    .map(function (e) { return notify_(e, [ann], true); });
  return { ok: true, id: ann.id, notified: sent.length };
}

function parsePhotos_(list) {
  var photos = (list || []).map(function (p, i) {
    var m = String(p || '').match(/^data:(image\/[\w.+-]+);base64,(.+)$/);
    if (!m) fail_('Photo ' + (i + 1) + ' is not an image.');
    return { type: m[1], data: m[2] };
  });
  if (photos.length > MAX_PHOTOS) fail_('Up to ' + MAX_PHOTOS + ' photos.');
  return photos;
}

function savePhotos_(photos, prefix) {
  if (!photos.length) return [];
  var folder = photoFolder_();
  return photos.map(function (p, i) {
    var file = folder.createFile(Utilities.newBlob(Utilities.base64Decode(p.data), p.type, prefix + '-' + (i + 1) + '.jpg'));
    return 'https://drive.google.com/file/d/' + file.getId() + '/view';
  });
}

function annStatus_(req) {
  var name = whoAmI_(req.token);
  if (!isAdmin_(name)) fail_('Only managers can see this.');
  var confs = confirmations_();
  var row = function (a, label) {
    var done = [], pending = [];
    a.recipients.forEach(function (r) {
      var at = confirmedAt_(a, r, confs);
      if (at) done.push({ name: r, at: at }); else pending.push(r);
    });
    return { id: a.key, posted: a.posted, title: label, rule: a.kind === 'rule',
             audience: audienceLabel_(a.audience) || 'Everyone', confirmed: done, pending: pending };
  };
  var list = notices_().map(function (a) { return row(a, a.title); })
    .concat(rules_().map(function (r) {
      var c = ruleItem_(r);
      return row(c, '[' + c.id + '] ' + c.title + (c.version > 1 ? ' (v' + c.version + ')' : ''));
    }))
    .sort(function (x, y) { return x.posted < y.posted ? 1 : -1; });
  var integrity = verifyRecords().every(function (x) { return x.ok; });
  return { ok: true, announcements: list, integrity: integrity };
}

// ------------------------------------------------------------------ notifications

/** 직원 한 명에게 웹 푸시 + 메일. anns 는 모두 공지이거나 모두 룰 (알림은 따로 감). */
function notify_(emp, anns, isNew) {
  var isRule = anns[0].kind === 'rule';
  var heading = isRule ? RULE_PUSH_TITLE : PUSH_TITLE;
  var ids = anns.map(function (a) { return a.key; }).join(', ');
  var appUrl = (props_.getProperty('APP_URL') || APP_URL_DEFAULT) + (isRule ? '?view=rules' : '?view=ann');
  var label = function (a) { return isRule ? '[' + a.id + '] ' + a.title + (a.version > 1 ? ' (updated)' : '') : a.title; };
  var body = anns.length === 1 ? label(anns[0]) : anns.length + (isRule ? ' rules: ' : ' announcements: ') +
    anns.map(label).join(', ');
  var results = [];

  var subs = pushSubscriptions_(emp.name);
  if (!subs.length) results.push(['push', 'no device registered']);
  subs.forEach(function (s) {
    var code;
    try {
      code = sendWebPush_(s.sub, { title: heading, body: body, url: appUrl, tag: isRule ? 'rules' : 'announcement' });
    } catch (err) {
      code = 'error: ' + err.message;
    }
    if (code === 404 || code === 410) props_.deleteProperty(s.key);
    results.push(['push', String(code)]);
  });

  if (emp.email) {
    try {
      var mail = buildMail_(anns, appUrl, isNew);
      MailApp.sendEmail({ to: emp.email, subject: heading, htmlBody: mail.html,
                          inlineImages: mail.images, name: 'monsieur Kim' });
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
      appendRecord_('Notifications', [nowStamp_(), ids, emp.name,
        (isNew ? 'new ' : 'reminder ') + (isRule ? 'rule ' : '') + r[0], r[1]]);
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
        var key = 'p' + a.key.replace(/\W/g, '') + '_' + i;
        images[key] = DriveApp.getFileById(fid).getBlob();
        imgs += '<p><img src="cid:' + key + '" style="max-width:100%;border-radius:8px"></p>';
      });
    }
    return '<div style="border:1px solid #dfe4e1;border-radius:12px;padding:16px;margin:12px 0">' +
      '<div style="color:#66706b;font-size:13px">' +
      (a.kind === 'rule' ? (a.version > 1 ? 'Updated ' : 'New rule · ') : '') + esc_(a.posted) + '</div>' +
      '<h2 style="margin:4px 0 8px;font-size:18px">' +
      (a.kind === 'rule' ? '[' + esc_(a.id) + '] ' : '') + esc_(a.title) + '</h2>' +
      '<div style="white-space:pre-wrap">' + esc_(a.content) + '</div>' + imgs + '</div>';
  });
  // 같은 제목의 메일이 쌓이면 Gmail 이 반복되는 뒷부분을 "…" 로 접어버림.
  // -> 버튼은 맨 위에 하나만 두고, 메일마다 다른 발송 시각·참조 번호를 끝에 넣어 접히지 않게 함.
  var button = '<p style="margin:16px 0"><a href="' + esc_(appUrl) + '" style="display:inline-block;' +
    'background:#1f6f54;color:#fff;padding:14px 28px;border-radius:10px;text-decoration:none;' +
    'font-weight:700;font-size:16px">Go to Confirm</a></p>';
  var heading = anns[0].kind === 'rule' ? RULE_PUSH_TITLE : PUSH_TITLE;
  var ref = anns.map(function (a) { return a.key; }).join(', ') + ' · sent ' + nowStamp_() + ' · ' +
    Utilities.getUuid().slice(0, 8);
  var html = '<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px">' +
    '<h1 style="font-size:20px;margin:0 0 4px">' + heading + '</h1>' + button + parts.join('') +
    '<p style="color:#66706b;font-size:13px">Please confirm in the app. ' +
    'You will get a reminder every day until you confirm.</p>' +
    '<p style="color:#9aa49f;font-size:11px">Ref ' + esc_(ref) + '</p></div>';
  return { html: html, images: images };
}

/** 예전 10시 트리거가 남아 있으면 새 방식(매일 09:00 정각)으로 바꿔 줌. */
function dailyReminder() {
  installTriggers_();
}

/**
 * 매일 09:00 정각 (파리):
 *  1) 밤사이(23~9시) 게시되어 아직 알리지 않은 공지 -> 대상자에게 푸시 + 메일 (첫 알림)
 *  2) 어제까지 게시된 공지 중 확인 안 한 사람 -> 리마인더
 *  한 사람에게는 1)+2)를 합쳐 메일 1통·푸시 1번만 보냄.
 *  3) 밤사이 Supervisor 알림(출퇴근·로그인)을 한 번에 요약해서 보냄.
 */
function morningRun() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'morningRun') ScriptApp.deleteTrigger(t);
  });
  var queued = JSON.parse(props_.getProperty('NOTIFY_QUEUE') || '[]');
  props_.deleteProperty('NOTIFY_QUEUE');
  var today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  var confs = confirmations_();
  var split = function (all) {
    return {
      fresh: all.filter(function (a) { return queued.indexOf(a.key) >= 0; }),
      old: all.filter(function (a) { return queued.indexOf(a.key) < 0 && a.posted.slice(0, 10) < today; }),
    };
  };
  var kinds = [split(notices_()), split(rules_().map(ruleItem_))]; // 공지와 룰은 알림을 따로 보냄
  activeEmployees_().forEach(function (e) {
    kinds.forEach(function (k) {
      var n = unreadFor_(e.name, k.fresh, confs), r = unreadFor_(e.name, k.old, confs);
      if (n.length || r.length) notify_(e, n.concat(r), n.length > 0);
    });
  });
  flushSupervisorQueue_();
}
