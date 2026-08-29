/**
 * Fidyo 과거 데이터 백필 (일회성) — 기본 8/8 ~ 8/25/2026 각 날짜별 수집.
 * Fidyo 는 Flutter 앱 → 접근성(semantics) 트리를 켜서 조작.
 * 날짜칸은 aria-label 로 찾음: 시작=起始时间, 종료=Heure de fin (둘 다 type=text).
 * 환경변수: FIDYO_USER, FIDYO_PASS, UPLOAD_URL, UPLOAD_TOKEN
 * (선택) BACKFILL_START, BACKFILL_END = 'YYYY-MM-DD'
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const USER = process.env.FIDYO_USER;
const PASS = process.env.FIDYO_PASS;
const UPLOAD_URL = process.env.UPLOAD_URL;
const UPLOAD_TOKEN = process.env.UPLOAD_TOKEN;
const LOGIN_URL = 'https://adm.fidyo.fr/#/login';
const START = process.env.BACKFILL_START || '2026-08-08';
const END = process.env.BACKFILL_END || '2026-08-25';

for (const [k, v] of Object.entries({ FIDYO_USER: USER, FIDYO_PASS: PASS, UPLOAD_URL, UPLOAD_TOKEN })) {
  if (!v) { console.error('환경변수 누락: ' + k); process.exit(1); }
}

function dateList(s, e) {
  const out = []; const d = new Date(s + 'T00:00:00Z'); const end = new Date(e + 'T00:00:00Z');
  while (d <= end) { out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
}
const DATES = dateList(START, END);
const toDMY = iso => iso.slice(8, 10) + '-' + iso.slice(5, 7) + '-' + iso.slice(0, 4);

const DEBUG = path.resolve('debug');
fs.mkdirSync(DEBUG, { recursive: true });
let step = 0;

async function run() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ acceptDownloads: true, locale: 'fr-FR', timezoneId: 'Europe/Paris', viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(45000);

  async function shot(name) { step++; try { await page.screenshot({ path: path.join(DEBUG, String(step).padStart(2, '0') + '-' + name + '.png') }); } catch {} }
  async function dumpSemantics(tag) { try { fs.writeFileSync(path.join(DEBUG, 'semantics-' + tag + '.html'), await page.evaluate(() => (document.querySelector('flt-semantics-host') || document.body).outerHTML)); } catch {} }
  async function enableSemantics() {
    try { await page.locator('flt-semantics-placeholder').click({ force: true, timeout: 4000 }); } catch {}
    try { await page.evaluate(() => { const el = document.querySelector('flt-semantics-placeholder'); if (el) { el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); el.dispatchEvent(new MouseEvent('click', { bubbles: true })); if (el.click) el.click(); } }); } catch {}
  }
  async function tapByName(name, timeout = 45000) {
    const loc = page.getByRole('button', { name, exact: false }).or(page.locator(`flt-semantics[aria-label*="${name}"]`)).or(page.getByText(name, { exact: false })).first();
    await loc.waitFor({ state: 'visible', timeout }); await loc.click();
  }
  async function typeInto(loc, value, label) {
    for (let a = 1; a <= 4; a++) {
      await loc.click(); await page.waitForTimeout(600);
      try { await page.keyboard.press('Control+A'); await page.keyboard.press('Delete'); } catch {}
      await page.waitForTimeout(150); await page.keyboard.type(value, { delay: 90 }); await page.waitForTimeout(300);
      let v = null; try { v = await loc.inputValue(); } catch {}
      if (v === null || v.length === value.length) { console.log('   ' + label + ': OK'); return; }
      console.log('   ' + label + ': ' + v.length + '/' + value.length + ' 재시도 ' + a);
    }
  }
  // 날짜칸 클릭 → 달력(Material date picker) 열림 → 해당 날짜 버튼 클릭 → OK
  const FR_MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
  async function pickDate(dateISO) {
    const [y, m, d] = dateISO.split('-').map(Number);
    const dayRe = new RegExp('^' + d + ',.*' + FR_MONTHS[m - 1] + ' ' + y);
    const days = () => page.locator('flt-semantics[role="button"]').filter({ hasText: dayRe });
    for (let i = 0; i < 18; i++) {
      if (await days().count()) break;
      let shownM = -1, shownY = -1;
      const sample = await page.locator('flt-semantics[role="button"]').filter({ hasText: /^\d+,.* \d{4}\s*$/ }).first().textContent().catch(() => null);
      if (sample) { const mm = /([^\s]+) (\d{4})\s*$/.exec(sample.trim()); if (mm) { shownM = FR_MONTHS.indexOf(mm[1]); shownY = +mm[2]; } }
      let goNext = false; // 표시 월을 못 읽으면 과거(이전 달) 방향이 기본 — 어제/백필용
      if (shownY >= 0 && shownM >= 0) goNext = (shownY < y) || (shownY === y && shownM < (m - 1));
      await page.getByRole('button', { name: goNext ? 'Mois suivant' : 'Mois précédent' }).click();
      await page.waitForTimeout(500);
    }
    await days().first().click();
    await page.getByRole('button', { name: 'OK', exact: true }).click();
    await page.waitForTimeout(600);
  }
  async function setDateField(loc, dateISO) {
    await loc.click();               // 날짜칸 → 달력 열림
    await page.waitForTimeout(900);
    await pickDate(dateISO);          // 달력에서 날짜 선택 + OK
  }
  async function uploadFile(saved, suggested) {
    const b64 = fs.readFileSync(saved).toString('base64');
    const res = await fetch(UPLOAD_URL, { method: 'POST', body: new URLSearchParams({ token: UPLOAD_TOKEN, name: suggested, data: b64 }) });
    const txt = await res.text();
    if (res.status >= 400 || /unauthorized|missing|error/i.test(txt)) throw new Error('업로드 실패: ' + res.status + ' ' + txt.slice(0, 120));
  }

  let ok = 0; const fail = [];
  try {
    console.log('로그인');
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
    try { await page.waitForFunction(() => !!document.querySelector('flutter-view'), { timeout: 60000 }); } catch {}
    await page.waitForTimeout(6000); await enableSemantics(); await page.waitForTimeout(3000);
    await page.waitForSelector('input', { timeout: 45000 });
    let nom = page.locator('input[aria-label*="Nom" i]').first(); if (!(await nom.count())) nom = page.locator('input').first();
    await typeInto(nom, USER, 'Nom');
    let pw = page.locator('input[type="password"]').first(); if (!(await pw.count())) pw = page.locator('input').nth(1);
    await typeInto(pw, PASS, 'Mot de passe');
    await tapByName('Connexion', 30000);
    await tapByName('Statistiques', 90000); await page.waitForTimeout(2500); await shot('statistiques');

    for (let di = 0; di < DATES.length; di++) {
      const date = DATES[di];
      console.log('=== ' + date + ' (' + (di + 1) + '/' + DATES.length + ') ===');
      try {
        await tapByName('商品销售统计', 45000); await page.waitForTimeout(1800);
        // 날짜칸 (aria-label 로 정확히)
        let startF = page.locator('input[aria-label="起始时间"]').first();
        let endF = page.locator('input[aria-label="Heure de fin"]').first();
        if (!(await startF.count()) || !(await endF.count())) {
          const di2 = page.locator('flt-semantics[role="dialog"] input');
          startF = di2.nth(0); endF = di2.nth(1);
        }
        if (di === 0) { await shot('dialog'); await dumpSemantics('dialog'); }
        if (!(await startF.count()) || !(await endF.count())) throw new Error('날짜 입력칸 못 찾음');

        await setDateField(startF, date);
        await setDateField(endF, date);
        if (di === 0) await shot('dates-set');

        await tapByName('Valider', 30000);
        await page.getByText('下载表格', { exact: false }).first().waitFor({ state: 'visible', timeout: 45000 });
        await page.waitForTimeout(1500);

        const [download] = await Promise.all([
          page.waitForEvent('download', { timeout: 45000 }),
          tapByName('下载表格', 30000),
        ]);
        const suggested = download.suggestedFilename() || ('ARTICLE VENTE ' + toDMY(date) + '.xlsx');
        // 검증: 파일명 날짜가 원하는 날짜와 같은가
        const m = /(\d{2}-\d{2}-\d{4})/.exec(suggested);
        const got = m ? m[1] : '';
        if (got && got !== toDMY(date)) {
          await shot('DATEMISMATCH-' + date);
          throw new Error('날짜 지정이 안 먹힘: 기대 ' + toDMY(date) + ', 실제 ' + got + ' (달력 방식 필요할 수 있음)');
        }
        const saved = path.join(DEBUG, suggested);
        await download.saveAs(saved);
        await uploadFile(saved, suggested);
        console.log('   ✅ ' + suggested + ' (' + fs.statSync(saved).size + ' bytes)');
        ok++; await page.waitForTimeout(800);
      } catch (e) {
        console.error('   ❌ ' + date + ' 실패: ' + e.message);
        await shot('ERROR-' + date);
        if (di === 0) { await dumpSemantics('error'); }
        fail.push(date);
        if (di === 0) break; // 첫 날짜부터 실패면 구조 파악 후 중단
      }
    }

    await browser.close();
    console.log('\n완료: 성공 ' + ok + '개, 실패 ' + fail.length + '개' + (fail.length ? ' → ' + fail.join(', ') : ''));
    if (ok === 0) process.exit(1);
  } catch (err) {
    await shot('FATAL'); await dumpSemantics('fatal');
    try { fs.writeFileSync(path.join(DEBUG, 'page.html'), await page.content()); } catch {}
    await browser.close(); console.error('FATAL ❌', err); process.exit(1);
  }
}
run();
