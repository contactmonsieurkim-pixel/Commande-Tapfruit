/**
 * Tapfruit — Item Master backend (Google Apps Script Web App)
 * ------------------------------------------------------------
 * 1) Create a NEW Google Sheet.
 * 2) Extensions -> Apps Script. Delete the sample, paste ALL of this, Save.
 * 3) Run the `setup` function once (Run -> setup). Approve permissions.
 *    -> This creates the tabs (Managers, Menus, Suppliers, Units, Boxes, Items, BOM)
 *       with headers + default values. You only fill the "Managers" tab with the 3 names.
 * 4) Deploy -> New deployment -> type "Web app"
 *      - Execute as: Me
 *      - Who has access: Anyone
 *    Deploy, copy the "/exec" Web app URL, and send it to me.
 *
 * Reads  : JSONP  GET  ...exec?callback=fn      -> fn({ ok, managers, menus, suppliers, units, boxes, items })
 * Writes : POST form field `data` = JSON string {action:'upsert'|'delete', item?, id?}
 */

var TABS = {
  Managers:  ['Name'],
  Menus:     ['Menu'],
  Suppliers: ['Supplier', 'MinOrderEUR'],
  Units:     ['Unit'],
  Boxes:     ['BoxSize'],
  Items:     ['id','name','category','subCategory','menus','avgShelfLifeDays','suppliers',
              'orderUnit','gramsPerOrderUnit','piecesPerOrderUnit','unitPrice','parLevel','boxSize','gramsPerBox',
              'createdBy','createdAt','updatedBy','updatedAt','batchYield','supplierRef'],
  BOM:       ['parentId','parentName','ingredientId','ingredientName','qty','unit']
};

var SEED = {
  Managers:  [['Manager 1'], ['Manager 2'], ['Manager 3']],   // <- replace with the real names
  Menus:     [['Bibimbap']],
  Suppliers: [['Metro',''], ['Tapfruit',''], ['Leaf Market',''], ['Beauvallet',''], ['Acemart',''], ['Internet','']],
  Units:     [['g'],['kg'],['piece'],['bunch'],['bag'],['tray'],['box'],['bottle'],['L'],['can'],['pack']],
  Boxes:     [['1.8L'],['2.5L'],['3.5L'],['5L'],['12L'],['22L']]
};

function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(TABS).forEach(function(name) {
    var existed = !!ss.getSheetByName(name);
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    var hadRows = sh.getLastRow() > 0;
    // write / repair the header row (safe to re-run; new columns are appended at the end)
    sh.getRange(1, 1, 1, TABS[name].length).setValues([TABS[name]]).setFontWeight('bold');
    sh.setFrozenRows(1);
    if (!hadRows && SEED[name]) SEED[name].forEach(function(r) { sh.appendRow(r); });
  });
  var s1 = ss.getSheetByName('Sheet1');
  if (s1 && ss.getSheets().length > 1 && s1.getLastRow() === 0) ss.deleteSheet(s1);
  return 'Setup done';
}

/* ---------------- read ---------------- */

function doGet(e) {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Tapfruit Item Master')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/* Called from the page via google.script.run */
function getData() { return readAll_(); }
function saveItemToSheet(item) {
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try { upsertItem_(item); return { ok: true }; } finally { lock.releaseLock(); }
}
function deleteItemFromSheet(id) {
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try { deleteItem_(id); return { ok: true }; } finally { lock.releaseLock(); }
}

function readAll_() {
  var itemsRaw = rows_('Items'), bom = rows_('BOM');
  var recipeByParent = {};
  bom.forEach(function(b) {
    if (!b.parentId) return;
    (recipeByParent[b.parentId] = recipeByParent[b.parentId] || []).push({
      itemId: b.ingredientId, itemName: b.ingredientName,
      qty: b.qty === '' ? null : Number(b.qty), unit: b.unit
    });
  });
  var items = itemsRaw.map(function(r) {
    return {
      id: r.id, name: r.name, category: r.category, subCategory: r.subCategory,
      menus: splitList_(r.menus), avgShelfLifeDays: numOrNull_(r.avgShelfLifeDays),
      suppliers: splitList_(r.suppliers), orderUnit: r.orderUnit,
      gramsPerOrderUnit: numOrNull_(r.gramsPerOrderUnit), piecesPerOrderUnit: numOrNull_(r.piecesPerOrderUnit), unitPrice: numOrNull_(r.unitPrice),
      parLevel: numOrNull_(r.parLevel), boxSize: r.boxSize, gramsPerBox: numOrNull_(r.gramsPerBox),
      recipe: recipeByParent[r.id] || [],
      createdBy: r.createdBy, createdAt: r.createdAt, updatedBy: r.updatedBy, updatedAt: r.updatedAt,
      batchYield: numOrNull_(r.batchYield), supplierRef: r.supplierRef
    };
  });
  return {
    ok: true,
    managers: colValues_('Managers'),
    menus: colValues_('Menus'),
    suppliers: rows_('Suppliers').map(function(s) { return { name: s.Supplier, minOrder: numOrNull_(s.MinOrderEUR) }; })
                                 .filter(function(s) { return s.name; }),
    units: colValues_('Units'),
    boxes: colValues_('Boxes'),
    items: items
  };
}

/* ---------------- write ---------------- */

/* Writes go through google.script.run (saveItemToSheet / deleteItemFromSheet). */

function upsertItem_(it) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Items');
  var row = [
    it.id, it.name, it.category, it.subCategory,
    (it.menus || []).join(', '), blank_(it.avgShelfLifeDays),
    (it.suppliers || []).join(', '), it.orderUnit || '', blank_(it.gramsPerOrderUnit), blank_(it.piecesPerOrderUnit),
    blank_(it.unitPrice), blank_(it.parLevel), it.boxSize || '', blank_(it.gramsPerBox),
    it.createdBy || '', it.createdAt || '', it.updatedBy || '', it.updatedAt || '', blank_(it.batchYield), it.supplierRef || ''
  ];
  var r = findRow_(sh, it.id);
  if (r > 0) sh.getRange(r, 1, 1, row.length).setValues([row]);
  else sh.appendRow(row);
  var bom = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('BOM');
  deleteBomFor_(bom, it.id);
  (it.recipe || []).forEach(function(rc) {
    bom.appendRow([it.id, it.name, rc.itemId || '', rc.itemName || '', blank_(rc.qty), rc.unit || '']);
  });
}

function deleteItem_(id) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName('Items');
  var r = findRow_(sh, id);
  if (r > 0) sh.deleteRow(r);
  deleteBomFor_(ss.getSheetByName('BOM'), id);
}

/* ---------------- helpers ---------------- */

function rows_(name) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh || sh.getLastRow() < 2) return [];
  var headers = TABS[name];
  return sh.getRange(2, 1, sh.getLastRow() - 1, headers.length).getValues().map(function(r) {
    var o = {}; headers.forEach(function(h, i) { o[h] = r[i]; }); return o;
  });
}
function colValues_(name) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues()
           .map(function(r) { return ('' + r[0]).trim(); })
           .filter(function(v) { return v; });
}
function findRow_(sh, id) {
  var last = sh.getLastRow(); if (last < 2) return -1;
  var ids = sh.getRange(2, 1, last - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) if (('' + ids[i][0]) === ('' + id)) return i + 2;
  return -1;
}
function deleteBomFor_(sh, parentId) {
  var last = sh.getLastRow(); if (last < 2) return;
  var ids = sh.getRange(2, 1, last - 1, 1).getValues();
  for (var i = ids.length - 1; i >= 0; i--) if (('' + ids[i][0]) === ('' + parentId)) sh.deleteRow(i + 2);
}
function splitList_(v) { return ('' + (v || '')).split(',').map(function(s) { return s.trim(); }).filter(function(s) { return s; }); }
function numOrNull_(v) { if (v === '' || v == null) return null; if (typeof v === 'string') v = v.replace(',', '.').replace(/[^\d.\-]/g, ''); var n = Number(v); return isNaN(n) ? null : n; }
function blank_(v) { return (v == null) ? '' : v; }
