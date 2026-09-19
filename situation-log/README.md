# Situation Log — Issue & Report Ledger

A military-style situation log (상황일지) as a web app. Every report is one
concise line in a **single Google Sheet ledger**. Two-stage process: accumulate
lightly in one ledger, then convert to formal documentation only when a trigger
is hit.

- **Receipt Date/Time is stamped automatically** on the server at submit.
- **Incident Date/Time is required** — the author records *when the event
  occurred* (not the same as the submit time).
- **Log No.** auto-increments per report.
- Language: **English**.

## How it works (important)

The whole app is **one Google Apps Script project**. Apps Script serves the web
page *and* stores the data, so you just open the deployed `/exec` URL in any
browser (phone included) — it runs there and saves straight to the sheet. No
hosting, no file downloads, no CORS hacks.

`situation-log/Code.gs` is the entire app — the UI HTML is inlined inside it.

**Ledger spreadsheet:**
[Situation Log — Issue & Report Ledger](https://docs.google.com/spreadsheets/d/1P9OLYvPPePr-YPruuZjhEthuW7ZyGE2KjKCfo01gpcw/edit)

## Deploy / update (3 steps)

You must do this in your own Google account (Google requires you to authorize
code that runs as you).

1. Open your Apps Script project → select everything in `Code.gs` → paste this
   folder's `Code.gs` (replace all).
2. **Deploy → Manage deployments → ✏️ Edit → Version: “New version” → Deploy.**
   Keep *Execute as: Me* and *Who has access: Anyone*. (Editing the existing
   deployment keeps the same `/exec` URL.)
3. Open the Web app `/exec` URL in a browser. That's your app.

> The `/exec` URL only shows the app **after** you paste this single-file
> `Code.gs` and redeploy. Before that, the old deployment returns raw JSON.

## Ledger columns

| # | Column | Source |
|---|--------|--------|
| 1 | Log No. | auto |
| 2 | Receipt Date/Time | auto (server, at submit) |
| 3 | Incident Date/Time | reporter (required) |
| 4 | Reporter | reporter |
| 5 | Subject / Process | reporter |
| 6 | Report Content | reporter |
| 7 | Category | reporter (Quality/Hygiene/Safety/Legal/Financial/Other) |
| 8 | Cross-Verification | reporter (Pending/Verified/Not Verified) |
| 9 | Verification Source | reporter |
| 10 | Action Status | reporter (Observation/Resolved/Escalated) |

## Two-stage process (built in)

**Stage 1 — accumulate (daily):** every report is one line via the form.

**Stage 2 — convert to formal documentation only on a trigger.** The
**Log & Analysis** tab reviews accumulated data and flags:

- **Repetition** — same *Subject / Process* reaches **≥ 3** reports → highlighted
  row + alert.
- **Severity** — unresolved **Hygiene / Safety / Legal / Financial** reports →
  alert.
- **Formal sanction stage** — *Escalated* status is counted separately.

## Tuning

- `REPEAT_THRESHOLD` and `SEVERITY` — in the inlined page inside `Code.gs`.
- `TIMEZONE` — top of `Code.gs` (default `Europe/Paris`).

## Notes

- Deployed with access **Anyone**, so anyone with the `/exec` link can open the
  app and add reports. Share the link accordingly.
- To change/resolve/escalate an entry, edit the row directly in the sheet.
