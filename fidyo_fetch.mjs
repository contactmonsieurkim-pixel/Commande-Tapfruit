/**
 * Fidyo 수집 스크립트 (일일 저녁마감 / 점심마감 겸용).
 *
 *  · 기본(야간 실행): "어제(영업이 끝난 완전한 하루)" 전체 매출 → Data 폴더.
 *  · 점심 실행(15~19시 사이): "오늘(점심 마감분)" 매출 → Lunch Sale 폴더.
 *
 * Fidyo 는 Flutter 앱 → 접근성(semantics) 트리를 켜서 조작.
 *
 * 환경변수: FIDYO_USER, FIDYO_PASS, UPLOAD_URL, UPLOAD_TOKEN
 * (선택) TARGET_MODE   = 'yesterday'(기본) | 'today'
 * (선택) UPLOAD_FOLDER = ''(기본, Data) | 'lunch'(Lunch Sale)
 * (선택) TARGET_DATE   = 'YYYY-MM-DD' 로 특정 날짜 강제 (TARGET_MODE 보다 우선)
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const USER = process.env.FIDYO_USER;
const PASS = process.env.FIDYO_PASS;
const UPLOAD_URL = process.env.UPLOAD_URL;
const UPLOAD_TOKEN = process.env.UPLOAD_TOKEN;
const LOGIN_URL = 'https://adm.fidyo.fr/#/login';

for (const [k, v] of Object.entries({ FIDYO_USER: USER, FIDYO_PASS: PASS, UPLOAD_URL, UPLOAD_TOKEN })) {
  if (!v) { console.error('환경변수 누락: ' + k); process.exit(1); }
}

// 파리 기준 오늘 / 어제
function parisYMD(offsetDays) {
  const p = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
  p.setDate(p.getDate() + (offsetDays || 0));
  return p.getFullYear() + '-' + String(p.getMonth() + 1).padStart(2, '0') + '-' + String(p.getDate()).padStart(2, '0');
}
const MODE = (process.env.TARGET_MODE || 'yesterday').toLowerCase();
const FOLDER = (process.env.UPLOAD_FOLDER || '').toLowerCase(); // '' = Data, 'lunch' = Lunch Sale
const TARGET = process.env.TARGET_DATE || (MODE === 'today' ? parisYMD(0) : parisYMD(-1));
const toDMY = iso => iso.slice(8, 10) + '-' + iso.slice(5, 7) + '-' + iso.slice(0, 4);

const DEBUG = path.resolve('debug');
fs.mkdirSync(DEBUG, { recursive: true });
let step = 0;

async function run() {
  console.log('대상 날짜:', TARGET, '| 모드:', MODE, '| 폴더:', FOLDER === 'lunch' ? 'Lunch Sale' : 'Data');
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
    await tapByName('Statistiques', 90000); await page.waitForTimeout(2500);

    console.log('날짜 팝업 열기 + ' + TARGET + ' 지정');
    await tapByName('商品销售统计', 45000); await page.waitForTimeout(1800);
    let startF = page.locator('input[aria-label="起始时间"]').first();
    let endF = page.locator('input[aria-label="Heure de fin"]').first();
    if (!(await startF.count()) || !(await endF.count())) {
      const d2 = page.locator('flt-semantics[role="dialog"] input'); startF = d2.nth(0); endF = d2.nth(1);
    }
    await shot('dialog'); await dumpSemantics('dialog');
    if (!(await startF.count()) || !(await endF.count())) throw new Error('날짜 입력칸 못 찾음');
    await setDateField(startF, TARGET);
    await setDateField(endF, TARGET);
    await shot('dates-set');

    await tapByName('Valider', 30000);
    await page.getByText('下载表格', { exact: false }).first().waitFor({ state: 'visible', timeout: 45000 });
    await page.waitForTimeout(1500);

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 45000 }),
      tapByName('下载表格', 30000),
    ]);
    const suggested = download.suggestedFilename() || ('ARTICLE VENTE ' + toDMY(TARGET) + '.xlsx');
    const m = /(\d{2}-\d{2}-\d{4})/.exec(suggested);
    if (m && m[1] !== toDMY(TARGET)) { await shot('DATEMISMATCH'); throw new Error('날짜 지정 실패: 기대 ' + toDMY(TARGET) + ', 실제 ' + m[1]); }
    const saved = path.join(DEBUG, suggested);
    await download.saveAs(saved);
    const b64 = fs.readFileSync(saved).toString('base64');
    const body = { token: UPLOAD_TOKEN, name: suggested, data: b64 };
    if (FOLDER) body.folder = FOLDER; // 'lunch' → Lunch Sale 폴더
    const res = await fetch(UPLOAD_URL, { method: 'POST', body: new URLSearchParams(body) });
    const txt = await res.text();
    if (res.status >= 400 || /unauthorized|missing|error/i.test(txt)) throw new Error('업로드 실패: ' + res.status + ' ' + txt.slice(0, 120));
    console.log('DONE ✅ ' + suggested + ' (' + fs.statSync(saved).size + ' bytes)');

    await browser.close();
  } catch (err) {
    await shot('ERROR'); await dumpSemantics('error');
    try { fs.writeFileSync(path.join(DEBUG, 'page.html'), await page.content()); } catch {}
    await browser.close(); console.error('FAILED ❌', err); process.exit(1);
  }
}
run();
