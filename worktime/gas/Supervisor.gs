// Supervisor (Employees 탭 G열 = TRUE) 에게만 가는 웹 푸시 알림
//   - 직원이 새 기기(브라우저)에서 로그인할 때
//   - 출퇴근 태그가 기록될 때마다 (누가, 몇 시, START/END)
// Supervisor 는 관리자(Admin) 권한도 가짐. 시트에서 TRUE 로 바꾸기만 하면 바로 적용(재배포 불필요).

function supervisors_() {
  return activeEmployees_().filter(function (e) { return e.supervisor; });
}

/** Supervisor 알림. 조용한 시간(23~9시)에는 모아 두었다가 09:00 에 한 번에 보냄. */
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
