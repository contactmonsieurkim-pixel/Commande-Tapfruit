// Chat — 직원 단체 채팅: 전체 방(Everyone) + 팀별 방(Employees 탭 F열 Team 마다 하나)
//   - 방: 모두 = Everyone + 자기 팀 방. Supervisor = 모든 팀 방 (자기 팀이 아닌 방은 처음에 알림 꺼짐).
//   - 기록: "Announcement Records" 의 Chat 탭 (ID | Sent at | Room | From | Text | Photo | Hash, HMAC 체인).
//     지운 메시지 = Deleted 탭에 한 줄 추가(ID 가 C 로 시작). 원래 행은 그대로 남음. 본인 또는 Supervisor 만 삭제.
//   - 화면은 몇 초마다 새 메시지를 물어봄(Apps Script 는 서버가 먼저 보낼 수 없음) -> 방마다 최근 메시지를 캐시에 둠.
//   - 사람별 상태 (스크립트 속성):
//       chatr_<이름> = { r: { 방: 마지막으로 읽은 번호 }, m: { 방: 1 알림 끔 / 0 알림 켬 } }
//       chatn_<이름> = { n: { 방: 알림에 넣은 마지막 번호 }, at: 마지막 채팅 푸시 시각(ms) }
//   - 푸시: 보내는 사람을 기다리게 하지 않도록 1회 트리거(chatPushRun)가 약 1분 뒤 모아서 보냄.
//     한 사람에게 CHAT_PUSH_GAP_MIN 분에 한 번까지, 알림 tag 'chat' -> 폰에는 최신 채팅 알림 하나만 남음.
//     조용한 시간(23~9시): Supervisor 만 받음. 나머지는 09:00 morningRun 에서 한 번에.
//   - 메일은 보내지 않음.

var CHAT_KEEP = 100;               // 방마다 캐시에 두는 최근 메시지 수 (더 오래된 것은 'Earlier messages' 로 시트에서)
var CHAT_CACHE_BYTES = 90000;      // CacheService 값 한도(100KB) 안으로
var CHAT_MAX_TEXT = 1000;
var CHAT_PUSH_DELAY_MS = 60 * 1000;
var CHAT_PUSH_GAP_MIN = 5;

// ------------------------------------------------------------------ 방

function chatTeams_(staff) {
  var seen = {};
  staff.forEach(function (e) { if (e.team) seen[e.team] = true; });
  return Object.keys(seen).sort();
}

function chatRoomName_(room) { return room === 'all' ? 'Everyone' : room.slice(5); }

/** 이 사람이 쓸 수 있는 방 (Everyone 이 먼저, 자기 팀, 그다음 다른 팀). */
function chatRoomsFor_(me, staff) {
  var rooms = ['all'];
  if (me.team) rooms.push('team:' + me.team);
  if (me.supervisor) {
    chatTeams_(staff).forEach(function (t) { if (t !== me.team) rooms.push('team:' + t); });
  }
  return rooms;
}

function chatMuted_(st, me, room) {
  if (room in st.m) return st.m[room] === 1;
  return room !== 'all' && room !== 'team:' + me.team; // Supervisor 가 보는 다른 팀 방: 처음엔 알림 끔
}

// ------------------------------------------------------------------ 사람별 상태

function chatState_(name) {
  var raw = props_.getProperty('chatr_' + name);
  var st = raw ? JSON.parse(raw) : {};
  return { r: st.r || {}, m: st.m || {}, isNew: !raw };
}

function saveChatState_(name, st) {
  props_.setProperty('chatr_' + name, JSON.stringify({ r: st.r, m: st.m }));
}

function chatNoti_(name) {
  var raw = props_.getProperty('chatn_' + name);
  var ns = raw ? JSON.parse(raw) : {};
  return { n: ns.n || {}, at: ns.at || 0 };
}

/** 처음 로그인하는 직원: 지난 대화를 '안 읽음'으로 세지 않도록 지금까지를 읽은 것으로. */
function chatJoin_(name, devicesBefore) {
  if (devicesBefore > 0 || props_.getProperty('chatr_' + name) || !props_.getProperty('ANN_SHEET_ID')) return;
  var me = findEmployee_(name);
  if (!me) return;
  var st = chatState_(name);
  chatRoomsFor_(me, activeEmployees_()).forEach(function (room) {
    var list = chatTail_(room);
    if (list.length) st.r[room] = list[list.length - 1].s;
  });
  saveChatState_(name, st);
}

// ------------------------------------------------------------------ 메시지 (시트 + 캐시)

function chatSeqOf_(id) { return Number(String(id).slice(1)); }

function chatMsg_(r, gone) {
  return { id: r[0], s: chatSeqOf_(r[0]), at: r[1], room: r[2], from: r[3], text: r[4], p: r[5], del: !!gone[r[0]] };
}

function chatDeletedIds_() {
  var gone = {};
  readRecords_('Deleted').forEach(function (r) { if (/^C\d+$/.test(r[0])) gone[r[0]] = true; });
  return gone;
}

/** 바이트 수 근사 (한글 등은 3바이트). */
function chatBytes_(s) { return s.length + 2 * s.replace(/[\x00-\x7f]/g, '').length; }

function chatPutTail_(room, ver, list) {
  list = list.slice(-CHAT_KEEP);
  var s = JSON.stringify({ ver: ver, list: list });
  while (list.length > 1 && chatBytes_(s) > CHAT_CACHE_BYTES) {
    list = list.slice(Math.ceil(list.length / 10));
    s = JSON.stringify({ ver: ver, list: list });
  }
  try {
    CacheService.getScriptCache().put('chat_t_' + room, s, 21600);
  } catch (err) {
    console.error(err);
  }
  return list;
}

function chatVer_(room) { return props_.getProperty('CHAT_VER_' + room) || '0'; }

/** 방의 최근 메시지 (오래된 → 최신). 캐시가 없거나 낡았으면 시트 끝부분에서 다시 만듦. */
function chatTail_(room) {
  var ver = chatVer_(room);
  var hit = CacheService.getScriptCache().get('chat_t_' + room);
  if (hit) {
    var o = JSON.parse(hit);
    if (o.ver === ver) return o.list;
  }
  return chatRebuild_(room, ver);
}

function chatRebuild_(room, ver) {
  var sh = recSheet_('Chat'), last = sh.getLastRow(), n = Math.min(last - 1, 3000);
  if (n < 1) return chatPutTail_(room, ver, []);
  var gone = chatDeletedIds_();
  var list = sh.getRange(last - n + 1, 1, n, 6).getValues().map(function (r) { return r.map(String); })
    .filter(function (r) { return r[2] === room; }).map(function (r) { return chatMsg_(r, gone); });
  return chatPutTail_(room, ver, list);
}

/** 기록 뒤 캐시를 고침 (script lock 안에서). 캐시가 없으면 다음 읽기 때 시트에서 새로 만듦. */
function chatTouch_(room, change) {
  var old = chatVer_(room), ver = String(Number(old) + 1);
  props_.setProperty('CHAT_VER_' + room, ver);
  var hit = CacheService.getScriptCache().get('chat_t_' + room);
  if (!hit) return;
  var o = JSON.parse(hit);
  if (o.ver !== old) return;
  chatPutTail_(room, ver, change(o.list));
}

/** 화면에 보내는 모양 (사진 파일 ID 는 빼고, 지운 메시지는 글도 뺌). */
function chatOut_(m) {
  return { id: m.id, s: m.s, at: m.at, from: m.from, text: m.del ? '' : m.text, photo: !m.del && !!m.p, del: m.del };
}

function chatUnreadIn_(list, name, base) {
  return list.filter(function (m) { return m.s > base && m.from !== name && !m.del; });
}

/** 메인 화면 Chat 배지: 알림을 끈 방은 세지 않음. */
function chatUnreadCount_(name) {
  if (!props_.getProperty('ANN_SHEET_ID')) return 0;
  var me = findEmployee_(name), st = chatState_(name), n = 0;
  chatRoomsFor_(me, activeEmployees_()).forEach(function (room) {
    if (!chatMuted_(st, me, room)) n += chatUnreadIn_(chatTail_(room), name, st.r[room] || 0).length;
  });
  return n;
}

// ------------------------------------------------------------------ API

/**
 * 방 목록(안 읽은 수·마지막 메시지) + room 이 있으면 그 방의 메시지.
 *   after: 이 번호 뒤의 새 메시지만 / before: 이 번호 앞의 50개 (시트에서) / 둘 다 없으면 최근 메시지.
 * 방을 열면 그 방은 읽은 것으로 기록.
 */
function chatView_(req) {
  var name = whoAmI_(req.token), me = findEmployee_(name), staff = activeEmployees_();
  var rooms = chatRoomsFor_(me, staff), st = chatState_(name), out = { ok: true, me: name };
  var room = req.room ? String(req.room) : '';
  if (room && rooms.indexOf(room) < 0) fail_('You are not in this chat.');
  var tails = {};
  rooms.forEach(function (r) { tails[r] = chatTail_(r); });

  if (room) {
    var list = tails[room], top = list.length ? list[list.length - 1].s : 0;
    if (req.before) {
      out.messages = chatOlder_(room, Number(req.before)).map(chatOut_);
      out.older = true;
    } else if (req.after != null && req.after !== '') {
      var after = Number(req.after);
      // 지운 표시가 바뀐 메시지도 다시 보내도록 화면이 가진 범위 전체를 줌
      out.messages = list.filter(function (m) { return m.s > after || m.del; }).map(chatOut_);
    } else {
      out.messages = list.map(chatOut_);
      out.hasOlder = list.length > 0 && chatHasOlder_(room, list[0].s);
    }
    if (top > (st.r[room] || 0)) {
      st.r[room] = top;
      saveChatState_(name, st);
    }
    out.room = room;
    out.muted = chatMuted_(st, me, room);
    out.canDeleteAll = !!me.supervisor;
  }

  out.rooms = rooms.map(function (r) {
    var list = tails[r], last = null;
    for (var i = list.length - 1; i >= 0; i--) if (!list[i].del) { last = list[i]; break; }
    return { id: r, name: chatRoomName_(r), muted: chatMuted_(st, me, r),
             members: r === 'all' ? staff.length : staff.filter(function (e) { return 'team:' + e.team === r; }).length,
             unread: chatUnreadIn_(list, name, st.r[r] || 0).length,
             last: last ? { from: last.from, text: last.text || (last.p ? '📷 Photo' : ''), at: last.at } : null };
  });
  return out;
}

/** 캐시보다 오래된 메시지 50개 (시트 전체에서). */
function chatOlder_(room, before) {
  var gone = chatDeletedIds_();
  var list = readRecords_('Chat').filter(function (r) { return r[2] === room && chatSeqOf_(r[0]) < before; });
  return list.slice(-50).map(function (r) { return chatMsg_(r, gone); });
}

/** 캐시에 든 것보다 오래된 메시지가 시트에 있는지 (방의 첫 메시지 번호는 바뀌지 않으므로 캐시). */
function chatHasOlder_(room, firstSeq) {
  var key = 'chat_first_' + room, cache = CacheService.getScriptCache(), first = Number(cache.get(key) || 0);
  if (!first) {
    var sh = recSheet_('Chat'), n = sh.getLastRow() - 1;
    var rows = n > 0 ? sh.getRange(2, 1, n, 3).getValues() : [];
    for (var i = 0; i < rows.length; i++) if (String(rows[i][2]) === room) { first = chatSeqOf_(rows[i][0]); break; }
    if (first) cache.put(key, String(first), 21600);
  }
  return first > 0 && first < firstSeq;
}

function chatSend_(req) {
  var name = whoAmI_(req.token), me = findEmployee_(name);
  var room = String(req.room || '');
  if (chatRoomsFor_(me, activeEmployees_()).indexOf(room) < 0) fail_('You are not in this chat.');
  var text = String(req.text || '').replace(/\r\n?/g, '\n').trim();
  var photos = parsePhotos_(req.photo ? [req.photo] : []);
  if (!text && !photos.length) fail_('Please write a message.');
  if (text.length > CHAT_MAX_TEXT) fail_('Please keep it under ' + CHAT_MAX_TEXT + ' characters.');

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  var msg;
  try {
    var seq = Number(props_.getProperty('CHAT_SEQ') || 0) + 1;
    var id = 'C' + ('00000' + seq).slice(-6);
    var link = savePhotos_(photos, id)[0] || '';
    var at = nowStamp_();
    appendRecord_('Chat', [id, at, room, name, text, link]);
    props_.setProperty('CHAT_SEQ', String(seq));
    msg = { id: id, s: seq, at: at, room: room, from: name, text: text,
            p: link ? link.match(/\/d\/([\w-]+)/)[1] : '', del: false };
    chatTouch_(room, function (list) { return list.concat([msg]); });
    var st = chatState_(name); // 내가 보낸 것까지는 읽은 것
    st.r[room] = seq;
    saveChatState_(name, st);
    scheduleChatPush_(CHAT_PUSH_DELAY_MS);
  } finally {
    lock.releaseLock();
  }
  return { ok: true, message: chatOut_(msg) };
}

function chatDelete_(req) {
  var name = whoAmI_(req.token), me = findEmployee_(name);
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var id = String(req.id || '');
    var row = /^C\d+$/.test(id) && readRecords_('Chat').filter(function (r) { return r[0] === id; })[0];
    if (!row || chatDeletedIds_()[id]) fail_('Message not found (maybe already deleted).');
    if (row[3] !== name && !me.supervisor) fail_('You can only delete your own messages.');
    if (chatRoomsFor_(me, activeEmployees_()).indexOf(row[2]) < 0) fail_('You are not in this chat.');
    appendRecord_('Deleted', [id, 'Chat · ' + chatRoomName_(row[2]) + ' · ' + row[3], nowStamp_(), name]);
    chatTouch_(row[2], function (list) {
      return list.map(function (m) { return m.id === id ? Object.assign({}, m, { del: true }) : m; });
    });
  } finally {
    lock.releaseLock();
  }
  return { ok: true, id: id };
}

function chatPhoto_(req) {
  var name = whoAmI_(req.token), me = findEmployee_(name);
  var id = String(req.id || '');
  var row = /^C\d+$/.test(id) && readRecords_('Chat').filter(function (r) { return r[0] === id; })[0];
  if (!row || chatDeletedIds_()[id] || chatRoomsFor_(me, activeEmployees_()).indexOf(row[2]) < 0) fail_('Not found.');
  var fid = (row[5].match(/\/d\/([\w-]+)/) || [])[1];
  if (!fid) fail_('Not found.');
  var blob = DriveApp.getFileById(fid).getBlob();
  return { ok: true, dataUrl: 'data:' + blob.getContentType() + ';base64,' + Utilities.base64Encode(blob.getBytes()) };
}

function chatMute_(req) {
  var name = whoAmI_(req.token), me = findEmployee_(name);
  var room = String(req.room || '');
  if (chatRoomsFor_(me, activeEmployees_()).indexOf(room) < 0) fail_('You are not in this chat.');
  var st = chatState_(name);
  st.m[room] = req.muted ? 1 : 0;
  saveChatState_(name, st);
  return { ok: true, room: room, muted: !!req.muted };
}

// ------------------------------------------------------------------ 푸시 (모아서)

/** ms 뒤에 chatPushRun 1회 실행 (이미 그보다 일찍 예약되어 있으면 그대로). script lock 안에서 호출. */
function scheduleChatPush_(ms) {
  var now = Date.now(), want = now + ms, at = Number(props_.getProperty('CHAT_PUSH_AT') || 0);
  if (at && at <= want && at > now - 10 * 60 * 1000) return; // 예약됨 (10분 넘게 지난 예약은 사라진 것으로 봄)
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'chatPushRun') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('chatPushRun').timeBased().after(ms).create();
  props_.setProperty('CHAT_PUSH_AT', String(want));
}

function chatPushBody_(groups) {
  var line = function (m) {
    var t = m.text || (m.p ? '📷 Photo' : '');
    return m.from + ': ' + (t.length > 120 ? t.slice(0, 120) + '…' : t);
  };
  var total = groups.reduce(function (n, g) { return n + g.unread.length; }, 0);
  if (groups.length === 1) {
    var g = groups[0], last = g.unread[g.unread.length - 1];
    return { title: '💬 ' + chatRoomName_(g.room),
             body: (g.unread.length > 1 ? g.unread.length + ' new messages · ' : '') + line(last),
             url: 'chat&room=' + encodeURIComponent(g.room) };
  }
  return { title: '💬 ' + total + ' new messages',
           body: groups.map(function (x) {
             return chatRoomName_(x.room) + ' (' + x.unread.length + ') · ' + line(x.unread[x.unread.length - 1]);
           }).join('\n'),
           url: 'chat' };
}

/**
 * 트리거로 실행 (그리고 매일 09:00 morningRun 에서 force=true).
 * 아직 알리지 않은 새 메시지가 있는 사람에게 푸시 1번 (그 사람의 안 읽은 메시지를 방별로 요약).
 * 조용한 시간에는 Supervisor 만. 최근 CHAT_PUSH_GAP_MIN 분 안에 받은 사람은 그 뒤로 미룸.
 */
function chatPushRun(force) {
  force = force === true;
  employeesMemo_ = null;
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    ScriptApp.getProjectTriggers().forEach(function (t) {
      if (t.getHandlerFunction() === 'chatPushRun') ScriptApp.deleteTrigger(t);
    });
    props_.deleteProperty('CHAT_PUSH_AT');
  } finally {
    lock.releaseLock();
  }
  if (!props_.getProperty('ANN_SHEET_ID')) return 0;
  var quiet = !force && isQuiet_(), staff = activeEmployees_(), tails = {}, now = Date.now(), later = 0, pushed = 0;
  var appUrl = props_.getProperty('APP_URL') || APP_URL_DEFAULT;
  staff.forEach(function (e) {
    if (quiet && !e.supervisor) return; // 조용한 시간: Supervisor 만
    var st = chatState_(e.name), ns = chatNoti_(e.name), groups = [], fresh = false;
    chatRoomsFor_(e, staff).forEach(function (room) {
      if (chatMuted_(st, e, room)) return;
      if (!tails[room]) tails[room] = chatTail_(room);
      var unread = chatUnreadIn_(tails[room], e.name, st.r[room] || 0);
      if (!unread.length) return;
      groups.push({ room: room, unread: unread });
      if (unread[unread.length - 1].s > (ns.n[room] || 0)) fresh = true;
    });
    if (!fresh) return;
    var wait = ns.at + CHAT_PUSH_GAP_MIN * 60000 - now;
    if (wait > 0 && !force) {
      later = later ? Math.min(later, wait) : wait;
      return;
    }
    var msg = chatPushBody_(groups);
    msg.url = appUrl + '?view=' + msg.url;
    msg.tag = 'chat';
    pushSubscriptions_(e.name).forEach(function (s) {
      var code;
      try {
        code = sendWebPush_(s.sub, msg);
      } catch (err) {
        console.error(err);
        return;
      }
      if (code === 404 || code === 410) props_.deleteProperty(s.key);
      else if (code >= 200 && code < 300) pushed++;
    });
    groups.forEach(function (g) { ns.n[g.room] = g.unread[g.unread.length - 1].s; });
    ns.at = now;
    props_.setProperty('chatn_' + e.name, JSON.stringify(ns));
  });
  if (later) {
    lock.waitLock(30000);
    try {
      scheduleChatPush_(Math.max(later, CHAT_PUSH_DELAY_MS));
    } finally {
      lock.releaseLock();
    }
  }
  return pushed;
}
