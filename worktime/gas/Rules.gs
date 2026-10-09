// Our Rules — 번호(Rule-001…)가 붙는 규칙. 공지와 따로 관리·알림.
//   - 기록: "Announcement Records" 의 Our Rules 탭. 수정할 때마다 새 버전 행을 추가 (예전 내용은 그대로 남음)
//   - 확인: Confirmations 탭에 'Rule-001 v2' 처럼 버전별로 기록. 수정되면 대상자는 다시 확인해야 함
//   - 예전에 공지로 올린 Rule 은 처음 한 번 자동으로 Rule-001… 로 옮김 (그 공지를 확인한 사람은 v1 확인으로 인정)

function ruleId_(n) { return 'Rule-' + ('00' + n).slice(-3); }

/** 예전 'Rule' 공지 -> Our Rules (한 번만). */
function migrateLegacyRules_() {
  if (props_.getProperty('RULES_MIGRATED')) return;
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    if (props_.getProperty('RULES_MIGRATED')) return;
    var seq = Number(props_.getProperty('RULE_SEQ') || 0);
    announcements_().filter(function (a) { return a.rule; }).forEach(function (a) {
      seq++;
      appendRecord_('Our Rules', [ruleId_(seq), '1', a.posted, a.by, a.title, a.content,
        a.photos.map(function (f) { return 'https://drive.google.com/file/d/' + f + '/view'; }).join('\n'),
        a.recipients.join(', '), audienceLabel_(a.audience), a.id]);
    });
    props_.setProperty('RULE_SEQ', String(seq));
    props_.setProperty('RULES_MIGRATED', '1');
  } finally {
    lock.releaseLock();
  }
}

/** 모든 룰 (번호순). 각 룰은 versions[] (오래된 → 최신). */
function rules_() {
  if (!props_.getProperty('ANN_SHEET_ID')) return [];
  migrateLegacyRules_();
  var map = {}, order = [];
  readRecords_('Our Rules').forEach(function (r) {
    if (!map[r[0]]) { map[r[0]] = { id: r[0], legacy: r[9], versions: [] }; order.push(r[0]); }
    map[r[0]].versions.push({
      version: Number(r[1]), at: r[2], title: r[4], content: r[5],
      photos: (r[6].match(/\/d\/[\w-]+/g) || []).map(function (s) { return s.slice(3); }),
      recipients: r[7] ? r[7].split(', ') : [],
      audience: r[8] ? parseAudience_('Rule · ' + r[8]) : null,
    });
  });
  return order.sort().map(function (id) { return map[id]; });
}

/** 최신 버전을 공지와 같은 모양의 항목으로 (알림·확인 공용). */
function ruleItem_(rule) {
  var cur = rule.versions[rule.versions.length - 1];
  return {
    kind: 'rule', key: rule.id + ' v' + cur.version, id: rule.id, version: cur.version,
    title: cur.title, content: cur.content, photos: cur.photos, recipients: cur.recipients,
    audience: cur.audience, posted: cur.at, created: rule.versions[0].at,
    legacy: cur.version === 1 ? rule.legacy : '',
  };
}

/** 이 사람에게 해당하는 룰: 전체 대상, 받는 사람에 포함, 또는 지정 팀·개인 (나중에 들어온 팀원 포함). */
function visibleRules_(name) {
  var me = name ? findEmployee_(name) : null;
  return rules_().filter(function (r) {
    var c = ruleItem_(r);
    if (!c.audience || !me) return true;
    return c.recipients.indexOf(me.name) >= 0 || c.audience.people.indexOf(me.name) >= 0 ||
      (me.team && c.audience.teams.indexOf(me.team) >= 0);
  });
}

function unreadRulesFor_(name, confs) {
  if (!props_.getProperty('ANN_SHEET_ID')) return [];
  return unreadFor_(name, rules_().map(ruleItem_), confs);
}

// ------------------------------------------------------------------ API

function rulesList_(req) {
  var name = whoAmI_(req.token), confs = confirmations_();
  return { ok: true, admin: isAdmin_(name), rules: visibleRules_(name).map(function (r) {
    var c = ruleItem_(r), mine = c.recipients.indexOf(name) >= 0;
    return {
      id: c.id, version: c.version, title: c.title, content: c.content, photos: c.photos.length,
      created: c.created, updatedAt: c.version > 1 ? c.posted : null,
      history: r.versions.slice(0, -1).reverse().map(function (v) {
        return { version: v.version, at: v.at, title: v.title, content: v.content };
      }),
      mustConfirm: mine, confirmedAt: mine ? confirmedAt_(c, name, confs) : null,
    };
  }) };
}

function findRule_(id) {
  var r = rules_().filter(function (x) { return x.id === id; })[0];
  if (!r) fail_('Rule not found.');
  return r;
}

function ruleConfirm_(req) {
  var name = whoAmI_(req.token);
  migrateLegacyRules_(); // 잠금 밖에서 먼저 (중첩 잠금 방지)
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var c = ruleItem_(findRule_(req.id));
    if (c.recipients.indexOf(name) < 0) fail_('Rule not found.');
    var confs = confirmations_(), at = confirmedAt_(c, name, confs), already = !!at;
    if (!at) {
      at = nowStamp_();
      appendRecord_('Confirmations', [c.key, '[' + c.id + '] ' + c.title, name, at]);
    }
  } finally {
    lock.releaseLock();
  }
  return { ok: true, confirmedAt: at, already: already, unreadRules: unreadRulesFor_(name).length };
}

function rulePhoto_(req) {
  var name = whoAmI_(req.token);
  var r = visibleRules_(name).filter(function (x) { return x.id === req.id; })[0];
  if (!r) fail_('Not found.');
  var fileId = ruleItem_(r).photos[Number(req.index)];
  if (!fileId) fail_('Not found.');
  var blob = DriveApp.getFileById(fileId).getBlob();
  return { ok: true, dataUrl: 'data:' + blob.getContentType() + ';base64,' + Utilities.base64Encode(blob.getBytes()) };
}

function cleanText_(req) {
  var title = String(req.title || '').trim().replace(/\s+/g, ' ');
  var content = String(req.content || '').replace(/\r\n?/g, '\n').trim();
  if (!title || !content) fail_('Please enter a title and the content.');
  return { title: title, content: content };
}

/** 새 룰 (post_ 에서 kind = 'rule' 일 때). */
function createRule_(req, name) {
  var t = cleanText_(req), photos = parsePhotos_(req.photos), target = resolveAudience_(req);
  migrateLegacyRules_();
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  var id;
  try {
    var seq = Number(props_.getProperty('RULE_SEQ') || 0) + 1;
    id = ruleId_(seq);
    appendRecord_('Our Rules', [id, '1', nowStamp_(), name, t.title, t.content, savePhotos_(photos, id).join('\n'),
      target.recipients.join(', '), audienceLabel_(target.audience), '']);
    props_.setProperty('RULE_SEQ', String(seq));
  } finally {
    lock.releaseLock();
  }
  return announceRule_(findRule_(id));
}

/** 룰 수정 (Admin 이상). 새 버전으로 기록하고 대상자에게 다시 확인 요청. 사진을 안 보내면 기존 사진 유지. */
function ruleEdit_(req) {
  var name = whoAmI_(req.token);
  if (!isAdmin_(name)) fail_('Only managers can edit rules.');
  var t = cleanText_(req), photos = parsePhotos_(req.photos);
  migrateLegacyRules_();
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var r = findRule_(req.id), c = ruleItem_(r), v = c.version + 1;
    var recipients;
    try {
      recipients = resolveAudience_({ audience: c.audience || 'all' }).recipients;
    } catch (err) { // 지정했던 팀이 없어진 경우 등: 예전 대상자 중 재직자
      recipients = activeEmployees_().map(function (e) { return e.name; })
        .filter(function (n) { return c.recipients.indexOf(n) >= 0; });
    }
    var links = photos.length ? savePhotos_(photos, r.id + '-v' + v)
      : c.photos.map(function (f) { return 'https://drive.google.com/file/d/' + f + '/view'; });
    appendRecord_('Our Rules', [r.id, String(v), nowStamp_(), name, t.title, t.content, links.join('\n'),
      recipients.join(', '), audienceLabel_(c.audience), '']);
  } finally {
    lock.releaseLock();
  }
  return announceRule_(findRule_(req.id));
}

/** 새 룰/수정된 룰 알림 (조용한 시간이면 09:00). */
function announceRule_(rule) {
  var c = ruleItem_(rule);
  if (isQuiet_()) {
    queueAnnouncement_(c.key);
    return { ok: true, id: c.id, version: c.version, notified: 0, queued: true,
             sendAt: ('0' + QUIET_END).slice(-2) + ':00' };
  }
  var sent = activeEmployees_().filter(function (e) { return c.recipients.indexOf(e.name) >= 0; })
    .map(function (e) { return notify_(e, [c], true); });
  return { ok: true, id: c.id, version: c.version, notified: sent.length };
}
