/**
 * Situation Log — backend (Google Apps Script Web App)
 * ---------------------------------------------------------------------------
 * Stores incoming reports as ONE ROW PER REPORT in a single Google Sheet that
 * acts as the accumulated "Issue / Report Management Log" (the single ledger).
 *
 * Design points that match the requirements:
 *   - Receipt Date/Time is stamped HERE, on the server, at the moment of submit
 *     (the reporter never types it).
 *   - Incident Date/Time is supplied by the reporter and is required in the form
 *     (when the event actually occurred).
 *   - Log No. is assigned automatically and increases by one per report.
 *
 * Endpoints:
 *   doPost(e)  <- the web form submits here (data = JSON string). Appends a row.
 *   doGet(e)   -> returns the whole ledger as JSON (supports ?callback= for JSONP,
 *                 which is how index.html reads the log without CORS problems).
 *
 * ---- HOW TO DEPLOY --------------------------------------------------------
 *   1. Create (or open) the Google Sheet that will hold the ledger.
 *   2. Extensions > Apps Script. Delete the default code, paste THIS file.
 *   3. (Optional) Set SHEET_ID below if you keep the script standalone instead
 *      of bound to the sheet. Adjust TIMEZONE if you are not in Europe/Paris.
 *   4. Deploy > New deployment > type "Web app".
 *        - Execute as: Me
 *        - Who has access: Anyone
 *   5. Copy the Web app URL (ends with /exec) and paste it into index.html as
 *      SCRIPT_URL. Re-deploy ("Manage deployments") after any code change.
 * ---------------------------------------------------------------------------
 */

// ==== Configuration =========================================================

// Pre-wired to the "Situation Log — Issue & Report Ledger" spreadsheet created
// for this project. The script therefore works as a STANDALONE project (no need
// to bind it to the sheet). Leave empty only if you bind the script to a sheet
// via Extensions > Apps Script instead.
var SHEET_ID = '1P9OLYvPPePr-YPruuZjhEthuW7ZyGE2KjKCfo01gpcw';

// Tab (worksheet) name used for the ledger. Created automatically if missing.
var SHEET_NAME = 'Situation Log';

// Timezone for the auto Receipt Date/Time stamp. This project runs in France.
var TIMEZONE = 'Europe/Paris';

// Column layout of the ledger. Order here defines the column order in the sheet.
var HEADERS = [
  'Log No.',              // auto, sequential
  'Receipt Date/Time',    // auto, server timestamp at submit
  'Incident Date/Time',   // required, entered by the reporter
  'Reporter',             // author of the report
  'Subject / Process',    // worker or work stage
  'Report Content',       // objective short summary
  'Category',             // Quality / Hygiene / Safety / Legal / Financial / Other
  'Cross-Verification',   // Pending / Verified / Not Verified
  'Verification Source',  // checklist / system record note
  'Action Status'         // Observation / Resolved / Escalated
];

// ==== Web app entry points ==================================================

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000); // serialize appends so Log No. stays consistent
  } catch (lockErr) {
    return json_({ ok: false, error: 'busy, try again' });
  }
  try {
    var data = JSON.parse((e && e.parameter && e.parameter.data) || '{}');
    var sh = getSheet_();

    var now = new Date();
    var receipt = Utilities.formatDate(now, TIMEZONE, 'yyyy-MM-dd HH:mm:ss');
    var logNo = Math.max(0, sh.getLastRow() - 1) + 1; // row 1 is the header

    var incidentAt = clean_(data.incidentAt);
    if (!incidentAt) {
      return json_({ ok: false, error: 'Incident Date/Time is required.' });
    }

    sh.appendRow([
      logNo,
      receipt,
      incidentAt,
      clean_(data.reporter),
      clean_(data.subject),
      clean_(data.content),
      clean_(data.category) || 'Other',
      clean_(data.verification) || 'Pending',
      clean_(data.verificationSource),
      clean_(data.status) || 'Observation'
    ]);

    return json_({ ok: true, logNo: logNo, receipt: receipt });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function doGet(e) {
  var callback = e && e.parameter && e.parameter.callback;
  try {
    var sh = getSheet_();
    var values = sh.getDataRange().getValues();
    var headers = values.length ? values.shift() : HEADERS.slice();

    var rows = values.map(function (r) {
      var o = {};
      for (var i = 0; i < headers.length; i++) {
        var v = r[i];
        // Dates come back as Date objects; send them as plain strings.
        if (v instanceof Date) v = Utilities.formatDate(v, TIMEZONE, 'yyyy-MM-dd HH:mm:ss');
        o[headers[i]] = v;
      }
      return o;
    });

    return respond_({ ok: true, headers: headers, rows: rows }, callback);
  } catch (err) {
    return respond_({ ok: false, error: String(err) }, callback);
  }
}

// ==== Helpers ===============================================================

function getSheet_() {
  var ss = SHEET_ID ? SpreadsheetApp.openById(SHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    throw new Error('No spreadsheet found. Bind this script to a sheet or set SHEET_ID.');
  }
  var sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) sh = ss.insertSheet(SHEET_NAME);

  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.setColumnWidth(6, 320); // Report Content
  }
  return sh;
}

function clean_(v) {
  if (v == null) return '';
  return String(v).trim().slice(0, 2000);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function respond_(obj, callback) {
  var body = JSON.stringify(obj);
  if (callback) {
    return ContentService.createTextOutput(callback + '(' + body + ');')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(body)
    .setMimeType(ContentService.MimeType.JSON);
}

// Optional: run once from the editor to create the sheet + header row early,
// and to trigger the authorization prompt before the first real submit.
function setup() {
  getSheet_();
  Logger.log('Ledger ready: "%s" in %s', SHEET_NAME, (SHEET_ID || 'bound spreadsheet'));
}
