// Supervisor (Employees 탭 G열 = TRUE) 에게만 가는 웹 푸시 알림
//   - 직원이 새 기기(브라우저)에서 로그인할 때
//   - 출퇴근 태그가 기록될 때마다 (누가, 몇 시, START/END) — 밤에도 바로 보냄
// Supervisor 는 관리자(Admin) 권한도 가짐. 시트에서 TRUE 로 바꾸기만 하면 바로 적용(재배포 불필요).

function supervisors_() {
  return activeEmployees_().filter(function (e) { return e.supervisor; });
}

/**
 * 출퇴근 알림 -> Supervisor (조용한 시간에도 바로).
 * iPhone 잠금화면은 긴 제목의 뒷부분을 자르므로 START/END 를 제목 맨 앞에 두고 본문에도 한 번 더 씀.
 */
function notifyClock_(name, action, date, time) {
  var start = action === 'START';
  return pushSupervisors_({
    title: (start ? '🟢 START' : '🔴 END') + ' · ' + name,
    body: name + (start ? ' clocked in (START)' : ' clocked out (END)') + ' at ' + time + ' · ' + date,
    tag: 'clock-' + Utilities.getUuid(),
  });
}

/** Supervisor 알림(로그인 등). 조용한 시간(23~9시)에는 모아 두었다가 09:00 에 한 번에 보냄. */
function notifySupervisors_(message) {
  if (isQuiet_()) return queueSupervisor_(message);
  return pushSupervisors_(message);
}

function queueSupervisor_(message) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return 0;
  try {
    var q = JSON.parse(props_.getProperty('SUP_QUEUE') || '[]');
    q.push(message.title + '  ' + message.body);
    props_.setProperty('SUP_QUEUE', JSON.stringify(q.slice(-80)));
  } finally {
    lock.releaseLock();
  }
  return 0;
}

/** 밤사이 쌓인 Supervisor 알림을 한 통으로. */
function flushSupervisorQueue_() {
  var q = JSON.parse(props_.getProperty('SUP_QUEUE') || '[]');
  props_.deleteProperty('SUP_QUEUE');
  if (!q.length) return 0;
  var body = q.join('\n');
  if (body.length > 1500) body = body.slice(0, 1500) + '\n…';
  return pushSupervisors_({ title: 'Overnight (' + q.length + ')', body: body, tag: 'overnight-' + Utilities.getUuid() });
}

/** 모든 Supervisor 의 등록된 기기로 웹 푸시. 보낸 기기 수 반환. */
function pushSupervisors_(message) {
  var sent = 0;
  supervisors_().forEach(function (sup) {
    pushSubscriptions_(sup.name).forEach(function (s) {
      var code;
      try {
        code = sendWebPush_(s.sub, message);
      } catch (err) {
        console.error(err);
        return;
      }
      if (code === 404 || code === 410) props_.deleteProperty(s.key);
      else if (code >= 200 && code < 300) sent++;
    });
  });
  return sent;
}

// ------------------------------------------------------------------ Request (직원 → Supervisor)

/**
 * 직원이 Supervisor 에게 직접 보내는 요청/고민. 공개되지 않음. 밤에도 바로 알림 + 메일.
 * 스케줄 화면의 'Request a change' 는 topic = 'schedule' (+ 어느 주인지) 로 와서 제목이 달라짐.
 */
function request_(req) {
  var name = whoAmI_(req.token);
  var message = String(req.message || '').replace(/\r\n?/g, '\n').trim();
  if (!message) fail_('Please write your request.');
  if (message.length > 3000) fail_('Please keep it under 3000 characters.');
  var schedule = req.topic === 'schedule';
  if (schedule) {
    var about = String(req.about || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    message = '[Schedule change' + (about ? ' · ' + about : '') + ']\n' + message;
  }
  var at = nowStamp_();
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    appendRecord_('Requests', [at, name, message]);
  } finally {
    lock.releaseLock();
  }
  var url = (props_.getProperty('APP_URL') || APP_URL_DEFAULT) + '?view=requests';
  try {
    pushSupervisors_({ title: (schedule ? '📅 Schedule change request · ' : '✉️ Request · ') + name,
                       body: message.length > 160 ? message.slice(0, 160) + '…' : message,
                       url: url, tag: 'request-' + Utilities.getUuid() });
  } catch (err) { console.error(err); }
  supervisors_().forEach(function (s) {
    if (!s.email) return;
    try {
      MailApp.sendEmail({ to: s.email, subject: (schedule ? 'Schedule change request from ' : 'Request from ') + name,
        name: 'monsieur Kim',
        htmlBody: '<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px">' +
          '<p style="color:#66706b;font-size:13px">' + esc_(at) + '</p>' +
          '<h2 style="font-size:18px;margin:0 0 8px">Request from ' + esc_(name) + '</h2>' +
          '<div style="white-space:pre-wrap">' + esc_(message) + '</div>' +
          '<p><a href="' + esc_(url) + '">Open requests</a></p></div>' });
    } catch (err2) { console.error(err2); }
  });
  return { ok: true, sentAt: at };
}

/** Supervisor 전용: 받은 요청 (최신순). */
function requestsList_(req) {
  var me = findEmployee_(whoAmI_(req.token));
  if (!me || !me.supervisor) fail_('Only the supervisor can see requests.');
  var list = readRecords_('Requests').map(function (r) { return { at: r[0], from: r[1], message: r[2] }; });
  return { ok: true, requests: list.reverse().slice(0, 300) };
}

/** Supervisor 전용: 모든 직원의 현재 상태(마지막 출퇴근 기록). 매번 시트에서 새로 읽음. */
function teamClock_(req) {
  var me = findEmployee_(whoAmI_(req.token));
  if (!me || !me.supervisor) fail_('Only the supervisor can see the team status.');
  var books = clockBooks_();
  var staff = employees_().map(function (e) {
    var clock = readClock_(e.name, books);
    putClock_(e.name, clock);
    return { name: e.name, team: e.team, clock: clock };
  });
  return { ok: true, today: todayStamp_(), staff: staff };
}

/** 이 직원 이름으로 로그인되어 있는 기기(브라우저) 수. */
function deviceCount_(name) {
  var all = props_.getProperties(), n = 0;
  Object.keys(all).forEach(function (k) { if (k.indexOf('tok_') === 0 && all[k] === name) n++; });
  return n;
}

function deviceLabel_(device) {
  var ua = String((device && device.ua) || '');
  var os = /iPhone|iPad|iPod/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android'
    : /Macintosh/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : 'Other';
  var app = device && device.standalone ? 'home screen app'
    : /CriOS|Chrome/.test(ua) ? 'Chrome' : /FxiOS|Firefox/.test(ua) ? 'Firefox' : /Safari/.test(ua) ? 'Safari' : 'browser';
  return os + ' · ' + app;
}

/** 로그인 기록(Logins 시트) + Supervisor 알림. */
function recordLogin_(name, label, count) {
  var at = nowStamp_();
  if (props_.getProperty('ANN_SHEET_ID')) {
    var lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      appendRecord_('Logins', [at, name, label, String(count)]);
    } finally {
      lock.releaseLock();
    }
  }
  var nth = count === 1 ? 'first device' : 'device #' + count;
  notifySupervisors_({ title: 'New login: ' + name, body: label + ' (' + nth + ')  ·  ' + at.slice(5, 16),
                       tag: 'login-' + Utilities.getUuid() });
}
