/**
 * Fidyo 일일 수집 — "어제(파리 기준, 영업이 끝난 완전한 하루)" 데이터를 받아옵니다.
 * 새벽에 실행되므로, 실행 시점의 '오늘'이 아니라 날짜를 직접 지정합니다.
 * (GitHub 예약 실행이 몇 시간 밀려도 '어제'는 그대로라 안전)
 * Fidyo 는 Flutter 앱 → 접근성(semantics) 트리를 켜서 조작.
 * 환경변수: FIDYO_USER, FIDYO_PASS, UPLOAD_URL, UPLOAD_TOKEN
 * (선택) TARGET_DATE = 'YYYY-MM-DD' 로 특정 날짜 강제 가능
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

// 어제(파리 기준) 날짜
function yesterdayParis() {
  const p = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
  p.setDate(p.getDate() - 1);
  return p.getFullYear() + '-' + String(p.getMonth() + 1).padStart(2, '0') + '-' + String(p.getDate()).padStart(2, '0');
}
const TARGET = process.env.TARGET_DATE || yesterdayParis();
const toDMY = iso => iso.slice(8, 10) + '-' + iso.slice(5, 7) + '-' + iso.slice(0, 4);

const DEBUG = path.resolve('debug');
fs.mkdirSync(DEBUG, { recursive: true });
let step = 0;

async function run() {
  console.log('대상 날짜:', TARGET);
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
  async function setDateField(loc, dateISO) {
    await loc.click(); await page.waitForTimeout(700);
    try { await page.keyboard.press('Control+A'); await page.keyboard.press('Delete'); } catch {}
    await page.waitForTimeout(200); await page.keyboard.type(dateISO, { delay: 90 }); await page.waitForTimeout(300);
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
    const res = await fetch(UPLOAD_URL, { method: 'POST', body: new URLSearchParams({ token: UPLOAD_TOKEN, name: suggested, data: b64 }) });
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
