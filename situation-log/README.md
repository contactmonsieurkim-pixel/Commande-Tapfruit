# Situation Log — Issue & Report Ledger

A lightweight web app that records reports into a **single accumulated Google
Sheet ledger**, the way a military-style situation log (상황일지) works: every
report is one concise line. It follows a two-stage process — accumulate lightly
in one ledger, then convert to formal documentation only when a trigger is hit.

- **Receipt Date/Time is stamped automatically** on the server the moment a
  report is submitted (the reporter never types it).
- **Incident Date/Time is required** — the author must record *when the event
  actually occurred*, which is not the same as the submit time.
- **Log No.** is assigned automatically and increments by one per report.
- Language: **English**.

## Files

| File | Role |
|------|------|
| `index.html` | The web app (form + "Log & Analysis" dashboard). Static — host it anywhere, or open locally. |
| `Code.gs` | Google Apps Script backend. Stamps the receipt time and appends rows to the sheet. |
| `README.md` | This file. |

It reuses the same pattern already used by `commande_tapfruit.html` in this
repo: a static page that POSTs to a Google Apps Script web app, which writes to
a Google Sheet.

## Ledger columns

| # | Column | Source | Notes |
|---|--------|--------|-------|
| 1 | Log No. | auto | Sequential. |
| 2 | Receipt Date/Time | **auto (submit)** | Server timestamp, `Europe/Paris`. |
| 3 | Incident Date/Time | **reporter (required)** | When the event occurred. |
| 4 | Reporter | reporter | The author of the entry. |
| 5 | Subject / Process | reporter | Worker name or work stage. Keep it consistent so repeats are counted. |
| 6 | Report Content | reporter | Objective, short, fact-based. |
| 7 | Category | reporter | Quality / Hygiene / Safety / Legal / Financial / Other. |
| 8 | Cross-Verification | reporter | Pending / Verified / Not Verified (checked against objective data). |
| 9 | Verification Source | reporter | e.g. checklist, CCTV, POS log. |
| 10 | Action Status | reporter | Observation / Resolved / Escalated. |

## Setup (about 5 minutes)

1. **Create the Google Sheet** that will hold the ledger (any empty spreadsheet).
2. In that sheet: **Extensions → Apps Script**. Delete the default `Code.gs`
   content and paste the contents of this folder's `Code.gs`.
   - If you keep the script *standalone* instead of bound to the sheet, set
     `SHEET_ID` at the top of `Code.gs` to your spreadsheet's ID.
   - Adjust `TIMEZONE` if you are not in `Europe/Paris`.
3. (Optional) Run the `setup` function once from the editor to create the
   header row and approve the authorization prompt.
4. **Deploy → New deployment → Web app**
   - *Execute as:* **Me**
   - *Who has access:* **Anyone**
5. Copy the **Web app URL** (it ends with `/exec`).
6. Open `index.html`, and set:
   ```js
   var SCRIPT_URL = 'https://script.google.com/macros/s/XXXXXXXX/exec';
   ```
7. Open `index.html` in a browser. Submit a test report, then check the
   **Log & Analysis** tab and the Google Sheet.

> After any change to `Code.gs`, re-deploy via **Manage deployments → Edit →
> New version**, or the live URL keeps serving the old code.

### Hosting `index.html`

It's a single static file. You can open it directly, or publish it (e.g. via
GitHub Pages) so a team can reach it. No secrets live in the page — it only
holds the public `/exec` URL, same as `commande_tapfruit.html`.

## How it implements the two-stage process

**Stage 1 — Accumulate in one ledger (daily).**
Every report goes in as a single line via the form. The receipt time and log
number are added automatically; the reporter only supplies the facts.

**Stage 2 — Convert to formal documentation only on a trigger.**
The **Log & Analysis** tab reviews the accumulated data (the weekly/monthly
pattern check) and surfaces the trigger points from the guideline:

- **Repetition** — when the same *Subject / Process* reaches **≥ 3** accumulated
  reports, the row is highlighted and a "Repetition trigger" alert appears,
  suggesting formal documentation (interview record, written notice).
- **Severity** — reports categorized as **Hygiene / Safety / Legal / Financial**
  that are not yet resolved raise a "Severity trigger" alert for immediate
  formal handling.
- **Formal sanction stage** — setting a report's **Action Status** to
  **Escalated** marks that the formal process has begun; the dashboard counts
  these separately.

This keeps day-to-day admin light while building an objective, timestamped
evidence trail for any later HR or legal action.

## Tuning

- Repetition threshold: change `REPEAT_THRESHOLD` in `index.html` (default `3`).
- Severity categories: change the `SEVERITY` array in `index.html` and the
  category options in the form.
- Timezone for the receipt stamp: `TIMEZONE` in `Code.gs`.

## Notes & limits

- The dashboard reads the ledger through JSONP, so the Apps Script must be
  deployed with access **Anyone**. Anyone with the `/exec` URL can read and
  append. If you need access control, deploy with restricted access and use an
  authenticated front end instead.
- To edit or delete an entry (e.g. move a status to *Resolved* or *Escalated*),
  edit the row directly in the Google Sheet — the ledger is the source of truth.
