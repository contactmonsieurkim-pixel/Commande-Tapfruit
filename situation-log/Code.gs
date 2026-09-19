/**
 * Situation Log — self-contained Google Apps Script Web App (SINGLE FILE)
 * ---------------------------------------------------------------------------
 * This ONE file is both the web page and the backend. Paste it into your Apps
 * Script project's Code.gs (replace everything), redeploy, and open the /exec
 * URL — the app renders in the browser and saves straight to your Google Sheet.
 *
 *   - doGet()        serves the app UI (HTML is inlined below, in page_()).
 *   - submitReport() appends one report as a row (called via google.script.run).
 *   - getLedger()    returns the accumulated ledger for the dashboard.
 *
 * Requirements met:
 *   - Receipt Date/Time is stamped on the SERVER at submit (never typed).
 *   - Incident Date/Time is entered by the reporter and is required.
 *   - Log No. auto-increments per report.
 *
 * ---- UPDATE YOUR EXISTING DEPLOYMENT (3 steps) ----------------------------
 *   1. Apps Script editor: select all in Code.gs and paste THIS file.
 *   2. Deploy > Manage deployments > (pencil) Edit > Version: "New version" > Deploy.
 *      Keep: Execute as = Me, Who has access = Anyone.
 *   3. Open the same Web app URL (/exec) in a browser.
 * ---------------------------------------------------------------------------
 */

// ==== Configuration =========================================================

var SHEET_ID = '1P9OLYvPPePr-YPruuZjhEthuW7ZyGE2KjKCfo01gpcw';
var SHEET_NAME = 'Situation Log';
var TIMEZONE = 'Europe/Paris'; // used for the auto Receipt timestamp

var HEADERS = [
  'Log No.', 'Receipt Date/Time', 'Incident Date/Time', 'Reporter',
  'Subject / Process', 'Report Content', 'Category', 'Cross-Verification',
  'Verification Source', 'Action Status'
];

// ==== Web page ==============================================================

function doGet() {
  return HtmlService.createHtmlOutput(page_())
    .setTitle('Situation Log')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0');
}

// ==== Server functions called from the page (google.script.run) =============

/** Append one report. Returns { ok, logNo, receipt } or { ok:false, error }. */
function submitReport(payload) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
  } catch (lockErr) {
    return { ok: false, error: 'Server busy, please try again.' };
  }
  try {
    var data = payload || {};
    var incidentAt = clean_(data.incidentAt);
    if (!incidentAt) return { ok: false, error: 'Incident Date/Time is required.' };

    var sh = getSheet_();
    var receipt = Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM-dd HH:mm:ss');
    var logNo = Math.max(0, sh.getLastRow() - 1) + 1;

    sh.appendRow([
      logNo, receipt, incidentAt,
      clean_(data.reporter), clean_(data.subject), clean_(data.content),
      clean_(data.category) || 'Other', clean_(data.verification) || 'Pending',
      clean_(data.verificationSource), clean_(data.status) || 'Observation'
    ]);

    return { ok: true, logNo: logNo, receipt: receipt };
  } catch (err) {
    return { ok: false, error: String(err) };
  } finally {
    lock.releaseLock();
  }
}

/** Return the whole ledger: { ok, headers, rows }. */
function getLedger() {
  try {
    var sh = getSheet_();
    var values = sh.getDataRange().getValues();
    var headers = values.length ? values.shift() : HEADERS.slice();
    var rows = values.map(function (r) {
      var o = {};
      for (var i = 0; i < headers.length; i++) {
        var v = r[i];
        if (v instanceof Date) v = Utilities.formatDate(v, TIMEZONE, 'yyyy-MM-dd HH:mm:ss');
        o[headers[i]] = v;
      }
      return o;
    });
    return { ok: true, headers: headers, rows: rows };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// ==== Helpers ===============================================================

function getSheet_() {
  var ss = SHEET_ID ? SpreadsheetApp.openById(SHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('No spreadsheet found. Set SHEET_ID or bind the script to a sheet.');
  var sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) sh = ss.insertSheet(SHEET_NAME);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.setColumnWidth(6, 320);
  }
  return sh;
}

function clean_(v) {
  if (v == null) return '';
  return String(v).trim().slice(0, 2000);
}

// Optional: run once from the editor to initialize + authorize.
function setup() {
  var sh = getSheet_();
  var ss = sh.getParent();
  ss.getSheets().forEach(function (s) {
    if (s.getSheetId() !== sh.getSheetId() && s.getLastRow() === 0 && s.getLastColumn() <= 1) {
      try { ss.deleteSheet(s); } catch (e) {}
    }
  });
  Logger.log('Ledger ready: "%s" (%s)', SHEET_NAME, SHEET_ID || 'bound spreadsheet');
}

// ==== The page (inlined HTML). No backticks/${} inside, so this stays valid. =
function page_() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Situation Log</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
:root {
  --bg: #eef1f5; --surface: #ffffff; --border: #d7dee6;
  --text: #1b2733; --muted: #64748b; --accent: #1f3a5f; --accent-dark: #16293f;
  --accent-light: #e9eff6; --accent-line: #b9cbe0;
  --amber: #b45309; --amber-bg: #fef3c7; --amber-line: #fcd34d;
  --green: #15803d; --green-bg: #dcfce7; --green-line: #86efac;
  --red: #b91c1c; --red-bg: #fee2e2; --red-line: #fca5a5;
  --font: 'DM Sans', system-ui, sans-serif; --mono: 'DM Mono', ui-monospace, monospace;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html { -webkit-text-size-adjust: 100%; }
body { font-family: var(--font); background: var(--bg); color: var(--text); line-height: 1.5; }
.topbar { background: var(--accent-dark); color: #fff; padding: 16px 20px; display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.brand { display: flex; align-items: baseline; gap: 10px; }
.brand h1 { font-size: 17px; font-weight: 600; letter-spacing: -0.01em; }
.brand .tag { font-size: 11px; font-weight: 400; color: #9db4cf; text-transform: uppercase; letter-spacing: 0.09em; }
.clock { font-family: var(--mono); font-size: 12px; color: #9db4cf; }
.tabs { display: flex; gap: 2px; background: var(--surface); border-bottom: 1px solid var(--border); padding: 0 12px; position: sticky; top: 0; z-index: 5; overflow-x: auto; }
.tab { font-family: var(--font); font-size: 13px; font-weight: 500; color: var(--muted); background: none; border: none; padding: 14px 16px; cursor: pointer; border-bottom: 2px solid transparent; white-space: nowrap; }
.tab:hover { color: var(--text); }
.tab.active { color: var(--accent); border-bottom-color: var(--accent); }
.wrap { max-width: 1080px; margin: 0 auto; padding: 24px 20px 64px; }
.view { display: none; }
.view.active { display: block; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 22px; }
.card-title { font-size: 14px; font-weight: 600; margin-bottom: 4px; }
.card-sub { font-size: 12.5px; color: var(--muted); margin-bottom: 18px; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.field { display: flex; flex-direction: column; }
.field.full { grid-column: 1 / -1; }
.field label { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); margin-bottom: 7px; }
.field label .req { color: var(--red); margin-left: 3px; }
.field .hint { font-size: 11.5px; color: var(--muted); margin-top: 6px; font-weight: 400; text-transform: none; letter-spacing: 0; }
input, select, textarea { font-family: var(--font); font-size: 14px; width: 100%; padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg); color: var(--text); outline: none; transition: border-color 0.15s, background 0.15s; }
input:focus, select:focus, textarea:focus { border-color: var(--accent-line); background: var(--surface); box-shadow: 0 0 0 3px var(--accent-light); }
input[type="datetime-local"] { font-family: var(--mono); }
textarea { resize: vertical; min-height: 88px; line-height: 1.55; }
.field.invalid input, .field.invalid select, .field.invalid textarea { border-color: var(--red); }
.auto-note { display: flex; align-items: center; gap: 10px; font-size: 12.5px; color: var(--muted); background: var(--accent-light); border: 1px solid var(--accent-line); border-radius: 8px; padding: 10px 12px; margin-top: 18px; }
.auto-note b { color: var(--accent); font-weight: 600; }
.actions { display: flex; align-items: center; gap: 14px; margin-top: 20px; }
.btn { font-family: var(--font); font-size: 14px; font-weight: 600; padding: 12px 22px; border-radius: 8px; border: none; cursor: pointer; transition: all 0.15s; }
.btn-primary { background: var(--accent); color: #fff; }
.btn-primary:hover { background: var(--accent-dark); }
.btn-primary:disabled { background: var(--border); color: var(--muted); cursor: not-allowed; }
.btn-primary.success { background: var(--green); }
.btn-ghost { background: none; color: var(--muted); border: 1px solid var(--border); }
.btn-ghost:hover { color: var(--text); border-color: var(--muted); }
.stat-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin-bottom: 18px; }
.stat { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 16px; }
.stat .n { font-family: var(--mono); font-size: 28px; font-weight: 500; line-height: 1; }
.stat .l { font-size: 11.5px; color: var(--muted); margin-top: 8px; text-transform: uppercase; letter-spacing: 0.04em; }
.stat.warn { border-color: var(--red-line); background: var(--red-bg); }
.stat.warn .n { color: var(--red); }
.alerts { margin-bottom: 18px; }
.alert { display: flex; gap: 12px; align-items: flex-start; border-radius: 10px; padding: 12px 14px; font-size: 13px; margin-bottom: 8px; }
.alert.rep { background: var(--amber-bg); border: 1px solid var(--amber-line); color: #7c4a06; }
.alert.sev { background: var(--red-bg); border: 1px solid var(--red-line); color: #8f1616; }
.alert .ico { font-size: 15px; line-height: 1.3; }
.alert b { font-weight: 600; }
.toolbar { display: flex; gap: 10px; align-items: center; margin-bottom: 14px; flex-wrap: wrap; }
.toolbar input, .toolbar select { width: auto; flex: 0 0 auto; }
.toolbar .search { flex: 1 1 220px; }
.count-note { font-size: 12px; color: var(--muted); margin-left: auto; }
.table-wrap { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; overflow: auto; }
table { width: 100%; border-collapse: collapse; font-size: 13px; min-width: 860px; }
th { text-align: left; font-size: 10.5px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); padding: 12px 12px; border-bottom: 1px solid var(--border); white-space: nowrap; background: var(--surface); position: sticky; top: 0; }
td { padding: 11px 12px; border-bottom: 1px solid var(--border); vertical-align: top; }
tr:last-child td { border-bottom: none; }
tr.flag-rep td { background: #fffaf0; }
.mono { font-family: var(--mono); font-size: 12px; color: var(--muted); white-space: nowrap; }
.logno { font-family: var(--mono); font-size: 12px; color: var(--muted); }
.subj { font-weight: 500; }
.subj .badge-rep { display: inline-block; font-family: var(--mono); font-size: 10px; font-weight: 500; color: var(--amber); background: var(--amber-bg); border: 1px solid var(--amber-line); border-radius: 5px; padding: 0 5px; margin-left: 6px; vertical-align: middle; }
.content-cell { max-width: 320px; }
.badge { display: inline-block; font-size: 11px; font-weight: 600; padding: 3px 9px; border-radius: 20px; white-space: nowrap; }
.b-observation { color: var(--amber); background: var(--amber-bg); border: 1px solid var(--amber-line); }
.b-resolved { color: var(--green); background: var(--green-bg); border: 1px solid var(--green-line); }
.b-escalated { color: var(--red); background: var(--red-bg); border: 1px solid var(--red-line); }
.cat { display: inline-block; font-size: 11px; padding: 2px 8px; border-radius: 6px; background: var(--accent-light); color: var(--accent); border: 1px solid var(--accent-line); }
.cat.sev { background: var(--red-bg); color: var(--red); border-color: var(--red-line); }
.verif { font-size: 12px; }
.empty { text-align: center; color: var(--muted); font-size: 13px; padding: 44px 20px; line-height: 1.7; }
.loading { text-align: center; color: var(--muted); font-size: 13px; padding: 44px 20px; }
.toast { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%) translateY(12px); background: var(--text); color: #fff; font-size: 13px; padding: 11px 20px; border-radius: 99px; opacity: 0; pointer-events: none; transition: all 0.25s; z-index: 999; max-width: 90vw; }
.toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
.toast.error { background: var(--red); }
.toast.ok { background: var(--green); }
@media (max-width: 720px) {
  .grid { grid-template-columns: 1fr; }
  .stat-row { grid-template-columns: 1fr 1fr; }
  .wrap { padding: 18px 14px 56px; }
}
</style>
</head>
<body>
<div class="topbar">
  <div class="brand"><h1>Situation Log</h1><span class="tag">Issue &amp; Report Ledger</span></div>
  <div class="clock" id="clock">&mdash;</div>
</div>
<div class="tabs">
  <button class="tab active" data-view="entry" onclick="switchView('entry')">&#43; New Entry</button>
  <button class="tab" data-view="log" onclick="switchView('log')">&#9776; Log &amp; Analysis</button>
</div>
<div class="wrap">
  <section class="view active" id="view-entry">
    <div class="card">
      <div class="card-title">Record a Report</div>
      <div class="card-sub">Log one report per row — keep it short and fact-based. Receipt date/time is stamped automatically when you submit.</div>
      <form id="log-form" autocomplete="off" novalidate>
        <div class="grid">
          <div class="field full" id="f-incidentAt">
            <label>Incident Date/Time <span class="req">*</span></label>
            <input type="datetime-local" id="incidentAt" name="incidentAt">
            <span class="hint">When did the event actually occur? This is required — it is not the same as the submit time.</span>
          </div>
          <div class="field" id="f-reporter">
            <label>Reporter (author) <span class="req">*</span></label>
            <input type="text" id="reporter" name="reporter" placeholder="e.g. J. Martin">
          </div>
          <div class="field" id="f-subject">
            <label>Subject / Process <span class="req">*</span></label>
            <input type="text" id="subject" name="subject" placeholder="Worker name or work stage — e.g. Closing / Zone B">
            <span class="hint">Use a consistent name so repeats can be counted.</span>
          </div>
          <div class="field full" id="f-content">
            <label>Report Content <span class="req">*</span></label>
            <textarea id="content" name="content" placeholder="Objective facts only — e.g. Zone B floor cleaning skipped at closing."></textarea>
          </div>
          <div class="field" id="f-category">
            <label>Category</label>
            <select id="category" name="category">
              <option value="Quality">Quality</option>
              <option value="Hygiene">Hygiene (severity)</option>
              <option value="Safety">Safety (severity)</option>
              <option value="Legal">Legal (severity)</option>
              <option value="Financial">Financial (severity)</option>
              <option value="Other">Other</option>
            </select>
            <span class="hint">Hygiene / Safety / Legal / Financial count as high-severity triggers.</span>
          </div>
          <div class="field" id="f-verification">
            <label>1st Cross-Verification</label>
            <select id="verification" name="verification">
              <option value="Pending">Pending</option>
              <option value="Verified">Verified</option>
              <option value="Not Verified">Not Verified</option>
            </select>
            <span class="hint">Confirmed against objective data (checklist, system record)?</span>
          </div>
          <div class="field" id="f-verificationSource">
            <label>Verification Source</label>
            <input type="text" id="verificationSource" name="verificationSource" placeholder="e.g. Closing checklist, CCTV, POS log">
          </div>
          <div class="field" id="f-status">
            <label>Action Status</label>
            <select id="status" name="status">
              <option value="Observation">Observation (watching)</option>
              <option value="Resolved">Resolved</option>
              <option value="Escalated">Escalated (formal process)</option>
            </select>
          </div>
        </div>
        <div class="auto-note">
          <span>&#128338;</span>
          <span><b>Auto-stamped on submit:</b> Receipt Date/Time and Log No. are added automatically by the server — you don't fill them in.</span>
        </div>
        <div class="actions">
          <button type="submit" class="btn btn-primary" id="submit-btn">Submit to Ledger &rarr;</button>
          <button type="button" class="btn btn-ghost" onclick="resetForm()">Clear</button>
        </div>
      </form>
    </div>
  </section>
  <section class="view" id="view-log">
    <div class="stat-row" id="stats"></div>
    <div class="alerts" id="alerts"></div>
    <div class="toolbar">
      <input type="text" class="search" id="search" placeholder="Search subject / content…" oninput="renderTable()">
      <select id="filter-status" onchange="renderTable()">
        <option value="">All statuses</option>
        <option value="Observation">Observation</option>
        <option value="Resolved">Resolved</option>
        <option value="Escalated">Escalated</option>
      </select>
      <button class="btn btn-ghost" onclick="refresh()" style="padding:9px 16px;font-size:13px;">&#8635; Refresh</button>
      <span class="count-note" id="count-note"></span>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>No.</th><th>Receipt (auto)</th><th>Incident</th><th>Reporter</th>
          <th>Subject / Process</th><th>Report Content</th><th>Category</th><th>Verified</th><th>Status</th>
        </tr></thead>
        <tbody id="log-body"><tr><td colspan="9"><div class="loading">Loading ledger…</div></td></tr></tbody>
      </table>
    </div>
  </section>
</div>
<div class="toast" id="toast"></div>
<script>
var SEVERITY = ['Hygiene', 'Safety', 'Legal', 'Financial'];
var REPEAT_THRESHOLD = 3;
var ledger = [];

function $(id){ return document.getElementById(id); }
function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
function localNowValue(){ var d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0,16); }
function showToast(msg, kind){ var t = $('toast'); t.textContent = msg; t.className = 'toast show' + (kind ? ' ' + kind : ''); clearTimeout(showToast._t); showToast._t = setTimeout(function(){ t.className = 'toast'; }, 4200); }
function tickClock(){ var d = new Date(); var p = function(n){ return String(n).padStart(2,'0'); }; $('clock').textContent = d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+' '+p(d.getHours())+':'+p(d.getMinutes())+':'+p(d.getSeconds()); }

function switchView(name){
  var tabs = document.querySelectorAll('.tab');
  for (var i=0;i<tabs.length;i++){ tabs[i].classList.toggle('active', tabs[i].getAttribute('data-view') === name); }
  var views = document.querySelectorAll('.view');
  for (var j=0;j<views.length;j++){ views[j].classList.remove('active'); }
  $('view-' + name).classList.add('active');
  if (name === 'log') refresh();
}

function resetForm(){
  $('log-form').reset();
  $('incidentAt').value = localNowValue();
  var inv = document.querySelectorAll('.field.invalid');
  for (var i=0;i<inv.length;i++){ inv[i].classList.remove('invalid'); }
}

function validate(){
  var ok = true;
  var reqs = [['incidentAt','incidentAt'],['reporter','reporter'],['subject','subject'],['content','content']];
  for (var i=0;i<reqs.length;i++){
    var val = $(reqs[i][0]).value.trim();
    var field = $('f-' + reqs[i][1]);
    if (!val){ field.classList.add('invalid'); ok = false; } else { field.classList.remove('invalid'); }
  }
  return ok;
}

document.getElementById('log-form').addEventListener('submit', function(e){
  e.preventDefault();
  if (!validate()){ showToast('Please fill in all required fields (incl. when the incident occurred).', 'error'); return; }
  var payload = {
    incidentAt: $('incidentAt').value.replace('T',' '),
    reporter: $('reporter').value.trim(),
    subject: $('subject').value.trim(),
    content: $('content').value.trim(),
    category: $('category').value,
    verification: $('verification').value,
    verificationSource: $('verificationSource').value.trim(),
    status: $('status').value
  };
  var btn = $('submit-btn');
  btn.disabled = true; btn.textContent = 'Submitting…';
  google.script.run
    .withSuccessHandler(function(res){
      btn.disabled = false;
      if (res && res.ok){
        btn.classList.add('success'); btn.textContent = '✓ Recorded #' + res.logNo;
        showToast('Report #' + res.logNo + ' saved. Receipt time: ' + res.receipt, 'ok');
        setTimeout(function(){ btn.classList.remove('success'); btn.textContent = 'Submit to Ledger →'; }, 3600);
        resetForm();
      } else {
        btn.textContent = 'Submit to Ledger →';
        showToast((res && res.error) || 'Could not save the report.', 'error');
      }
    })
    .withFailureHandler(function(err){
      btn.disabled = false; btn.textContent = 'Submit to Ledger →';
      showToast('Server error: ' + ((err && err.message) || err), 'error');
    })
    .submitReport(payload);
});

function refresh(){
  $('log-body').innerHTML = '<tr><td colspan="9"><div class="loading">Loading ledger…</div></td></tr>';
  google.script.run
    .withSuccessHandler(function(data){
      if (!data || !data.ok){ onLoadError(); return; }
      ledger = (data.rows || []).map(normalizeRow);
      renderDashboard();
    })
    .withFailureHandler(function(){ onLoadError(); })
    .getLedger();
}

function onLoadError(){
  $('log-body').innerHTML = '<tr><td colspan="9"><div class="empty">Could not load the ledger. Try Refresh.</div></td></tr>';
  $('stats').innerHTML = ''; $('alerts').innerHTML = '';
}

function normalizeRow(r){
  return {
    no: r['Log No.'] || '', receipt: r['Receipt Date/Time'] || '', incident: r['Incident Date/Time'] || '',
    reporter: r['Reporter'] || '', subject: r['Subject / Process'] || '', content: r['Report Content'] || '',
    category: r['Category'] || '', verification: r['Cross-Verification'] || '',
    verificationSource: r['Verification Source'] || '', status: r['Action Status'] || ''
  };
}

function subjectCounts(){
  var m = {};
  for (var i=0;i<ledger.length;i++){
    var k = String(ledger[i].subject || '').trim().toLowerCase();
    if (!k) continue;
    if (!m[k]) m[k] = { label: ledger[i].subject, n: 0 };
    m[k].n++;
  }
  return m;
}

function renderDashboard(){
  var counts = subjectCounts();
  var repeated = Object.keys(counts).filter(function(k){ return counts[k].n >= REPEAT_THRESHOLD; });
  var escalated = ledger.filter(function(r){ return r.status === 'Escalated'; });
  var openObs = ledger.filter(function(r){ return r.status === 'Observation'; });
  var openSevere = ledger.filter(function(r){ return SEVERITY.indexOf(String(r.category).split(' ')[0]) >= 0 && r.status !== 'Resolved'; });

  $('stats').innerHTML =
    stat(ledger.length, 'Total reports') +
    stat(openObs.length, 'Under observation') +
    stat(escalated.length, 'Escalated') +
    stat(repeated.length, 'Repeat triggers (≥' + REPEAT_THRESHOLD + ')', repeated.length > 0);

  var alerts = '';
  repeated.forEach(function(k){
    var c = counts[k];
    alerts += '<div class="alert rep"><span class="ico">&#128257;</span><span><b>Repetition trigger:</b> ' + esc(c.label) + ' has <b>' + c.n + '</b> accumulated reports (≥ ' + REPEAT_THRESHOLD + '). Consider opening formal documentation (interview record / written notice).</span></div>';
  });
  openSevere.forEach(function(r){
    alerts += '<div class="alert sev"><span class="ico">&#9888;</span><span><b>Severity trigger:</b> ' + esc(r.category) + ' — ' + esc(clip(r.content,80)) + ' (' + esc(r.subject) + ') is unresolved. High-impact issues warrant immediate formal handling.</span></div>';
  });
  $('alerts').innerHTML = alerts;
  renderTable();
}

function stat(n, label, warn){ return '<div class="stat' + (warn ? ' warn' : '') + '"><div class="n">' + n + '</div><div class="l">' + label + '</div></div>'; }
function clip(s, n){ s = String(s || ''); return s.length > n ? s.slice(0,n) + '…' : s; }
function statusBadge(s){ var cls = s === 'Resolved' ? 'b-resolved' : s === 'Escalated' ? 'b-escalated' : 'b-observation'; return '<span class="badge ' + cls + '">' + esc(s || 'Observation') + '</span>'; }
function catCell(c){ var head = String(c || '').split(' ')[0]; var sev = SEVERITY.indexOf(head) >= 0; return c ? '<span class="cat' + (sev ? ' sev' : '') + '">' + esc(head) + '</span>' : ''; }

function renderTable(){
  var q = $('search') ? $('search').value.trim().toLowerCase() : '';
  var fs = $('filter-status') ? $('filter-status').value : '';
  var counts = subjectCounts();
  var rows = ledger.filter(function(r){
    if (fs && r.status !== fs) return false;
    if (q){ var hay = (r.subject + ' ' + r.content + ' ' + r.reporter).toLowerCase(); if (hay.indexOf(q) < 0) return false; }
    return true;
  }).slice().reverse();

  if (!ledger.length){ $('log-body').innerHTML = '<tr><td colspan="9"><div class="empty">The ledger is empty.<br>Submit your first report from the New Entry tab.</div></td></tr>'; $('count-note').textContent = ''; return; }
  if (!rows.length){ $('log-body').innerHTML = '<tr><td colspan="9"><div class="empty">No reports match your filters.</div></td></tr>'; }
  else {
    $('log-body').innerHTML = rows.map(function(r){
      var key = String(r.subject || '').trim().toLowerCase();
      var repeat = counts[key] && counts[key].n >= REPEAT_THRESHOLD;
      var repBadge = repeat ? '<span class="badge-rep">×' + counts[key].n + '</span>' : '';
      return '<tr class="' + (repeat ? 'flag-rep' : '') + '">' +
        '<td class="logno">' + esc(r.no) + '</td>' +
        '<td class="mono">' + esc(r.receipt) + '</td>' +
        '<td class="mono">' + esc(r.incident) + '</td>' +
        '<td>' + esc(r.reporter) + '</td>' +
        '<td class="subj">' + esc(r.subject) + repBadge + '</td>' +
        '<td class="content-cell">' + esc(r.content) + (r.verificationSource ? '<div class="mono" style="margin-top:4px">src: ' + esc(r.verificationSource) + '</div>' : '') + '</td>' +
        '<td>' + catCell(r.category) + '</td>' +
        '<td class="verif">' + esc(r.verification) + '</td>' +
        '<td>' + statusBadge(r.status) + '</td>' +
      '</tr>';
    }).join('');
  }
  $('count-note').textContent = rows.length + ' of ' + ledger.length + ' shown';
}

resetForm();
tickClock();
setInterval(tickClock, 1000);
</script>
</body>
</html>`;
}
