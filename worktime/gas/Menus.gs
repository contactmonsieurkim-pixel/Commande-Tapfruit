// Menus — 메뉴 → 컴포넌트(레시피 또는 원재료) → 1인분 양. 편집 = Supervisor 만. 포션 추산(Portion estim)의 바탕.
//
// "Menus" 스프레드시트 (setup() 이 만듦, MENU_SHEET_ID). 시트의 이름 칸은 읽기 쉽게 쓰는 것뿐, 연결은 모두 코드.
//   Menus      : ID | Name | Active | Note                       ID = MENU-001. 지우기 = Active FALSE.
//   Components : ID | Link | Name | Added                         ID = CMP-001. Link = 레시피 RCP-… 또는 원재료 ING-… (하나당 컴포넌트 하나)
//                컴포넌트는 여러 메뉴가 같이 씀(재고도 같이). 이름 = 연결된 레시피·재료의 지금 이름.
//   Parts      : Menu ID | Menu | Component ID | Component | Portion | Unit
//                Portion = 1인분 양 (빈칸 = 아직 모름 → 포션 계산 안 함). Unit = g / ml / pcs (레시피가 Pieces 로 세면 pcs).
// "레시피 필요"인 새 컴포넌트 = 빈 레시피(To write)를 바로 만들어 연결. 재료가 들어갈 때까지 매일 09:00 Supervisor 에게 알림.
// 레시피가 필요 없는 컴포넌트는 Ingredients 목록의 재료만 (새 재료는 Ingredients 앱에서).

var MENU_HEAD = ['ID', 'Name', 'Active', 'Note'];
var COMP_HEAD = ['ID', 'Link', 'Name', 'Added'];
var PART_HEAD = ['Menu ID', 'Menu', 'Component ID', 'Component', 'Portion', 'Unit'];

function menuBook_() {
  var id = props_.getProperty('MENU_SHEET_ID');
  if (id) return SpreadsheetApp.openById(id);
  var ss = SpreadsheetApp.create('Menus');
  DriveApp.getFileById(ss.getId()).moveTo(folder_());
  props_.setProperty('MENU_SHEET_ID', ss.getId());
  ss.getSheets()[0].setName('Menus');
  return ss;
}

function ensureMenus_() {
  var ss = menuBook_();
  ingTab_(ss, 'Menus', MENU_HEAD, ['A:D']);
  ingTab_(ss, 'Components', COMP_HEAD, ['A:D']);
  ingTab_(ss, 'Parts', PART_HEAD, ['A:D', 'F:F']);
  return ss;
}

function readMenuBook_(ss) {
  var menus = ingRows_(ss.getSheetByName('Menus'), MENU_HEAD.length).map(function (r, i) {
    return { id: String(r[0]).toUpperCase(), name: String(r[1]), active: String(r[2]).toUpperCase() !== 'FALSE', note: String(r[3]), row: i + 2 };
  }).filter(function (m) { return m.id && m.name; });
  var comps = {};
  ingRows_(ss.getSheetByName('Components'), COMP_HEAD.length).forEach(function (r, i) {
    var id = String(r[0]).toUpperCase();
    if (id) comps[id] = { id: id, link: String(r[1]).toUpperCase(), name: String(r[2]), row: i + 2 };
  });
  var parts = ingRows_(ss.getSheetByName('Parts'), PART_HEAD.length).map(function (r, i) {
    var p = ingNum_(r[4]);
    return { menu: String(r[0]).toUpperCase(), cmp: String(r[2]).toUpperCase(), portion: p === null || p <= 0 ? null : p, row: i + 2 };
  }).filter(function (p) { return p.menu && p.cmp; });
  return { menus: menus, comps: comps, parts: parts };
}

/** 연결된 레시피·재료의 지금 이름·단위. → { name, kind: 'rcp'|'ing', unit, todo, recipeId, missing } */
function menuLinkInfo_(link, rcp, ings) {
  if (/^RCP-/.test(link)) {
    var r = rcp[link];
    if (!r) return { name: link, kind: 'rcp', unit: 'g', missing: true };
    return { name: r.name, kind: 'rcp', unit: r.countUnit === 'pcs' ? 'pcs' : 'g', todo: !!r.todo, recipeId: r.id, countUnit: r.countUnit };
  }
  var g = ings[link];
  if (!g) return { name: link, kind: 'ing', unit: 'g', missing: true };
  return { name: g.name, kind: 'ing', unit: g.unit, removed: !g.active };
}

/** 메뉴들 (Active, 시트 순서) + 컴포넌트 정보. */
function menuData_() {
  var ss = ensureMenus_(), mb = readMenuBook_(ss), rcp = {}, ings = ingCodeMap_();
  recipesAll_().recipes.forEach(function (r) { rcp[r.code] = r; });
  var menus = mb.menus.filter(function (m) { return m.active; }).map(function (m) {
    return { id: m.id, name: m.name, parts: mb.parts.filter(function (p) { return p.menu === m.id && mb.comps[p.cmp]; }).map(function (p) {
      var c = mb.comps[p.cmp], info = menuLinkInfo_(c.link, rcp, ings);
      return { cmp: c.id, link: c.link, name: info.name, kind: info.kind, unit: info.unit, todo: !!info.todo, recipeId: info.recipeId || '',
               missing: !!info.missing, removed: !!info.removed, portion: p.portion };
    }) };
  });
  var comps = Object.keys(mb.comps).map(function (k) {
    var c = mb.comps[k], info = menuLinkInfo_(c.link, rcp, ings);
    return { id: c.id, link: c.link, name: info.name, kind: info.kind, unit: info.unit, todo: !!info.todo };
  });
  return { ss: ss, mb: mb, menus: menus, comps: comps, rcp: rcp, ings: ings };
}

function menuEditor_(req) {
  var emp = findEmployee_(whoAmI_(req.token));
  if (!emp || !emp.supervisor) fail_('Only the supervisor can edit menus.');
  return emp;
}

function menuView_(req) {
  menuEditor_(req);
  var d = menuData_();
  return { ok: true, menus: d.menus, components: d.comps,
           recipes: Object.keys(d.rcp).map(function (c) { var r = d.rcp[c]; return { code: c, id: r.id, name: r.name, todo: !!r.todo }; }),
           ingredients: Object.keys(d.ings).filter(function (c) { return d.ings[c].active; }).map(function (c) { return { code: c, name: d.ings[c].name, unit: d.ings[c].unit }; }) };
}

function nextCode_(ids, kind) {
  var max = 0;
  ids.forEach(function (id) { var m = new RegExp('^' + kind + '-(\\d+)$').exec(id); if (m) max = Math.max(max, +m[1]); });
  return codeOf_(kind, max + 1);
}

/**
 * 메뉴 편집 (Supervisor). op:
 *   add {name} · rename {menu, name} · remove {menu}
 *   partAdd {menu, cmp} 이미 있는 컴포넌트 | {menu, link: 'RCP-…'|'ING-…'} | {menu, newRecipe: 이름} (빈 레시피 To write 를 만듦)
 *   portion {menu, cmp, portion} (빈칸 = 모름) · partRemove {menu, cmp}
 * → menuView 와 같은 모양 + done (새로 만든 것의 코드)
 */
function menuEdit_(req) {
  menuEditor_(req);
  var op = String(req.op || ''), done = null;
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var ss = ensureMenus_(), mb = readMenuBook_(ss), msh = ss.getSheetByName('Menus'), psh = ss.getSheetByName('Parts');
    var menu = function () {
      var m = mb.menus.filter(function (x) { return x.id === String(req.menu || '').toUpperCase() && x.active; })[0];
      if (!m) fail_('This menu is not in the list any more.', 'CHANGED');
      return m;
    };
    var cleanName = function () {
      var n = rcpText_(req.name, 80, 'The menu name').replace(/\s+/g, ' ');
      if (!n) fail_('Please enter the menu name.');
      var clash = mb.menus.filter(function (x) { return x.active && x.id !== String(req.menu || '').toUpperCase() && ingKey_(x.name) === ingKey_(n); })[0];
      if (clash) fail_('A menu called “' + clash.name + '” already exists.');
      return n;
    };
    if (op === 'add') {
      var name = cleanName(), id = nextCode_(mb.menus.map(function (x) { return x.id; }), 'MENU');
      appendRows_(msh, [[id, name, '', '']]);
      done = id;
    } else if (op === 'rename') {
      var m1 = menu(), n1 = cleanName();
      msh.getRange(m1.row, 2).setValue(safeCell_(n1));
      mb.parts.forEach(function (p) { if (p.menu === m1.id) psh.getRange(p.row, 2).setValue(safeCell_(n1)); });
    } else if (op === 'remove') {
      msh.getRange(menu().row, 3).setValue('FALSE');
    } else if (op === 'partAdd') {
      var m2 = menu(), cmp = String(req.cmp || '').toUpperCase(), link = String(req.link || '').toUpperCase();
      if (cmp && !mb.comps[cmp]) fail_('This component is not in the list any more.', 'CHANGED');
      if (!cmp) {
        if (req.newRecipe != null) link = recipeStub_(req.newRecipe);
        var rcp = {}, ings = ingCodeMap_();
        recipesAll_().recipes.forEach(function (r) { rcp[r.code] = r; });
        if (/^RCP-/.test(link) ? !rcp[link] : !(ings[link] && ings[link].active)) {
          fail_(/^ING-/.test(link) || !link ? 'Pick a recipe or an ingredient from the list. New ingredients are added in Manager › Ingredients.' : 'Recipe ' + link + ' not found.');
        }
        var have = Object.keys(mb.comps).filter(function (k) { return mb.comps[k].link === link; })[0];
        if (have) cmp = have;
        else {
          cmp = nextCode_(Object.keys(mb.comps), 'CMP');
          var info = menuLinkInfo_(link, rcp, ings);
          appendRows_(ss.getSheetByName('Components'), [[cmp, link, info.name, Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd')]]);
          mb.comps[cmp] = { id: cmp, link: link, name: info.name };
        }
      }
      if (mb.parts.some(function (p) { return p.menu === m2.id && p.cmp === cmp; })) fail_(mb.comps[cmp].name + ' is already in ' + m2.name + '.');
      var d2 = menuData_(), c2 = d2.comps.filter(function (x) { return x.id === cmp; })[0];
      appendRows_(psh, [[m2.id, m2.name, cmp, c2 ? c2.name : '', '', c2 ? c2.unit : '']]);
      done = cmp;
    } else if (op === 'portion') {
      var m3 = menu(), p3 = mb.parts.filter(function (p) { return p.menu === m3.id && p.cmp === String(req.cmp || '').toUpperCase(); })[0];
      if (!p3) fail_('This component is not in the menu any more.', 'CHANGED');
      var v = req.portion === '' || req.portion == null ? '' : ingNum_(req.portion);
      if (v === null || (v !== '' && (v <= 0 || v > 100000))) fail_('Portion: a number (g, ml or pieces for one plate), or empty.');
      psh.getRange(p3.row, 5).setValue(v === '' ? '' : Math.round(v * 100) / 100);
    } else if (op === 'partRemove') {
      var m4 = menu(), p4 = mb.parts.filter(function (p) { return p.menu === m4.id && p.cmp === String(req.cmp || '').toUpperCase(); })[0];
      if (p4) psh.deleteRow(p4.row);
    } else fail_('Unknown change.');
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  var out = menuView_(req);
  out.done = done;
  return out;
}

// ------------------------------------------------------------------ Portion estim (Kitchen 팀 + Supervisor)

/**
 * 메뉴별 컴포넌트의 남은 양 (모든 주소 합계) — 포션 계산은 화면에서 (총량 ÷ 1인분).
 * items = 프렙 재고(레시피별, Stock 과 같은 모양 + code · unit · amount(g 또는 개수)), raw = 원재료 마지막 조사 양.
 */
function portionsView_(req) {
  var emp = recipeUser_(req), st = stockView_(req), d = menuData_(), ss = ensureIngBook_(), stock = rawStock_(ss), fr = {};
  ingFridges_().forEach(function (f) { fr[f.code] = f.short; });
  var raw = readIngMaster_(ss).filter(function (i) { return stock[i.id]; }).map(function (i) {
    return { id: i.id, name: i.name, unit: i.unit, qty: stock[i.id].qty, at: stock[i.id].at, address: i.address,
             short: i.storage === 'Freezer' ? 'Freezer' : fr[i.address] || i.address };
  });
  return { ok: true, today: st.today, lastCount: st.lastCount, menus: d.menus, items: st.items, raw: raw,
           canCount: !!(emp.admin || emp.supervisor), canEdit: !!emp.supervisor };
}

// ------------------------------------------------------------------ 09:00 알림: 아직 쓰지 않은 레시피

/** 재료가 하나도 없는 레시피(To write)가 있으면 Supervisor 에게 푸시 + 메일 (하루 한 번, morningRun). */
function notifyTodoRecipes_() {
  if (!props_.getProperty('RECIPE_SHEET_ID')) return 0;
  var today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  if (props_.getProperty('TODO_NOTIFIED') === today) return 0;
  var todo = recipesAll_().recipes.filter(function (r) { return r.todo; });
  if (!todo.length) return 0;
  props_.setProperty('TODO_NOTIFIED', today);
  var names = todo.map(function (r) { return r.name; }), title = '📝 ' + todo.length + ' recipe' + (todo.length > 1 ? 's' : '') + ' to write';
  var url = (props_.getProperty('APP_URL') || APP_URL_DEFAULT) + '?view=todo';
  var sent = pushSupervisors_({ title: title, body: names.join(', ') + ' · tap to open', url: url, tag: 'recipes-todo' });
  supervisors_().forEach(function (s) {
    if (!s.email) return;
    try {
      MailApp.sendEmail({ to: s.email, subject: title, name: 'monsieur Kim',
        htmlBody: '<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px">' +
          '<h1 style="font-size:20px;margin:0 0 8px">' + esc_(title) + '</h1>' +
          '<p>These components need a recipe:</p><ul>' + names.map(function (n) { return '<li>' + esc_(n) + '</li>'; }).join('') + '</ul>' +
          '<p style="margin:16px 0"><a href="' + esc_(url) + '" style="display:inline-block;background:#1f6f54;color:#fff;padding:14px 28px;' +
          'border-radius:10px;text-decoration:none;font-weight:700;font-size:16px">Open the recipe editor</a></p></div>' });
    } catch (err) {
      console.error(err);
    }
  });
  return sent;
}

/** 편집기에서 실행: 메뉴마다 컴포넌트·1인분·연결 상태를 실행 로그에. */
function checkMenus() {
  var d = menuData_();
  d.menus.forEach(function (m) {
    Logger.log(m.id + ' ' + m.name + ': ' + m.parts.map(function (p) {
      return p.name + ' [' + p.link + (p.todo ? ' TO WRITE' : '') + (p.missing ? ' MISSING' : '') + '] ' + (p.portion == null ? '?' : p.portion + ' ' + p.unit);
    }).join(' · '));
  });
  return d.menus.length;
}
