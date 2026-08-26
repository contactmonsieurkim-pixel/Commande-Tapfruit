/**
 * Fidyo 과거 데이터 백필 (일회성) — 8/8 ~ 8/25/2026 각 날짜별로 수집.
 * -------------------------------------------------------------------
 * 흐름(날짜마다 반복):
 *   商品销售统计(날짜 팝업 열기) → 시작칸/종료칸에 그 날짜 입력 → Valider
 *   → 下载表格 다운로드 → Apps Script 업로드
 * ※ Fidyo 는 Flutter(CanvasKit) 앱 → 접근성(semantics) 트리를 켜서 조작.
 * ※ 날짜 칸에 직접 입력하는 방식(캘린더 팝업 대신). 안 되면 debug 의
 *   semantics-dialog.html 로 구조를 보고 방식을 바꿉니다.
 * 환경변수: FIDYO_USER, FIDYO_PASS, UPLOAD_URL, UPLOAD_TOKEN
 * (선택) BACKFILL_START, BACKFILL_END = 'YYYY-MM-DD' 로 범위 변경 가능
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

// 날짜 목록 만들기 (YYYY-MM-DD, 포함 범위)
function dateList(startStr, endStr) {
  const out = [];
  const d = new Date(startStr + 'T00:00:00Z');
  const end = new Date(endStr + 'T00:00:00Z');
  while (d <= end) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}
const DATES = dateList(START, END);

const DEBUG = path.resolve('debug');
fs.mkdirSync(DEBUG, { recursive: true });
let step = 0;

async function run() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ acceptDownloads: true, locale: 'fr-FR', timezoneId: 'Europe/Paris', viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(45000);

  async function shot(name) {
    step++;
    try { await page.screenshot({ path: path.join(DEBUG, String(step).padStart(2, '0') + '-' + name + '.png') }); } catch {}
  }
  async function dumpSemantics(tag) {
    try {
      const html = await page.evaluate(() => (document.querySelector('flt-semantics-host') || document.body).outerHTML);
      fs.writeFileSync(path.join(DEBUG, 'semantics-' + tag + '.html'), html);
    } catch {}
  }
  async function enableSemantics() {
    try { await page.locator('flt-semantics-placeholder').click({ force: true, timeout: 4000 }); } catch {}
    try {
      await page.evaluate(() => {
        const el = document.querySelector('flt-semantics-placeholder');
        if (el) { el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); el.dispatchEvent(new MouseEvent('click', { bubbles: true })); if (el.click) el.click(); }
      });
    } catch {}
  }
  async function tapByName(name, timeout = 45000) {
    const loc = page.getByRole('button', { name, exact: false })
      .or(page.locator(`flt-semantics[aria-label*="${name}"]`))
      .or(page.getByText(name, { exact: false }))
      .first();
    await loc.waitFor({ state: 'visible', timeout });
    await loc.click();
  }
  async function typeInto(loc, value, label) {
    for (let attempt = 1; attempt <= 4; attempt++) {
      await loc.click();
      await page.waitForTimeout(600);
      try { await page.keyboard.press('Control+A'); await page.keyboard.press('Delete'); } catch {}
      await page.waitForTimeout(150);
      await page.keyboard.type(value, { delay: 90 });
      await page.waitForTimeout(300);
      let val = null;
      try { val = await loc.inputValue(); } catch {}
      if (val === null) { console.log('   ' + label + ': 값 확인 불가, 진행'); return; }
      if (val.length === value.length) { console.log('   ' + label + ': OK (' + val.length + '자)'); return; }
      console.log('   ' + label + ': ' + val.length + '/' + value.length + '자 → 재시도 ' + attempt);
    }
  }
  // 날짜값(2026-08-25 형태)이 들어있는 보이는 입력칸들 = 시작/종료 날짜 칸
  async function dateFields() {
    const all = page.locator('input:visible');
    const n = await all.count();
    const fields = [];
    for (let i = 0; i < n; i++) {
      const v = await all.nth(i).inputValue().catch(() => '');
      if (/\d{4}-\d{2}-\d{2}|\d{2}\/\d{2}\/\d{4}/.test(v)) fields.push({ loc: all.nth(i), val: v });
    }
    return fields;
  }
  async function setDate(field, dateISO) {
    // 화면 형식에 맞춰 입력 (예: 2026-08-25). fill 먼저, 안 되면 타이핑.
    const fmt = /\d{2}\/\d{2}\/\d{4}/.test(field.val)
      ? dateISO.slice(8, 10) + '/' + dateISO.slice(5, 7) + '/' + dateISO.slice(0, 4)
      : dateISO;
    try { await field.loc.fill(''); await field.loc.fill(fmt); } catch {}
    let v = await field.loc.inputValue().catch(() => '');
    if (v.replace(/\D/g, '') === fmt.replace(/\D/g, '')) return true;
    await typeInto(field.loc, fmt, 'date');
    v = await field.loc.inputValue().catch(() => '');
    return v.replace(/\D/g, '') === fmt.replace(/\D/g, '');
  }
  async function uploadFile(saved, suggested) {
    const b64 = fs.readFileSync(saved).toString('base64');
    const body = new URLSearchParams({ token: UPLOAD_TOKEN, name: suggested, data: b64 });
    const res = await fetch(UPLOAD_URL, { method: 'POST', body });
    const txt = await res.text();
    if (res.status >= 400 || /unauthorized|missing|error/i.test(txt)) throw new Error('업로드 실패: ' + res.status + ' ' + txt.slice(0, 120));
  }

  let ok = 0, fail = [];
  try {
    console.log('로그인');
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
    try { await page.waitForFunction(() => !!document.querySelector('flutter-view'), { timeout: 60000 }); } catch {}
    await page.waitForTimeout(6000);
    await enableSemantics();
    await page.waitForTimeout(3000);
    await page.waitForSelector('input', { timeout: 45000 });
    let nom = page.locator('input[aria-label*="Nom" i]').first();
    if (!(await nom.count())) nom = page.locator('input').first();
    await typeInto(nom, USER, 'Nom');
    let pw = page.locator('input[type="password"]').first();
    if (!(await pw.count())) pw = page.locator('input[aria-label*="passe" i]').first();
    if (!(await pw.count())) pw = page.locator('input').nth(1);
    await typeInto(pw, PASS, 'Mot de passe');
    await tapByName('Connexion', 30000);
    await tapByName('Statistiques', 90000);
    await page.waitForTimeout(2500);
    await shot('statistiques');

    for (let di = 0; di < DATES.length; di++) {
      const date = DATES[di];
      console.log('=== ' + date + ' (' + (di + 1) + '/' + DATES.length + ') ===');
      try {
        await tapByName('商品销售统计', 45000);   // 날짜 팝업 열기
        await page.waitForTimeout(1800);
        if (di === 0) { await shot('dialog'); await dumpSemantics('dialog'); }

        const fields = await dateFields();
        console.log('   날짜칸 수:', fields.length, fields.map(f => f.val).join(', '));
        if (fields.length < 2) {
          await shot('nofields-' + date); await dumpSemantics('nofields');
          throw new Error('날짜 입력칸을 못 찾음(직접입력 불가일 수 있음). semantics-nofields.html 확인 필요');
        }
        await setDate(fields[0], date);   // 시작
        await setDate(fields[1], date);   // 종료
        if (di === 0) await shot('dates-set');

        await tapByName('Valider', 30000);
        await page.getByText('下载表格', { exact: false }).first().waitFor({ state: 'visible', timeout: 45000 });
        await page.waitForTimeout(1500);

        const [download] = await Promise.all([
          page.waitForEvent('download', { timeout: 45000 }),
          tapByName('下载表格', 30000),
        ]);
        const suggested = download.suggestedFilename() || ('ARTICLE VENTE ' + date + '.xlsx');
        const saved = path.join(DEBUG, suggested);
        await download.saveAs(saved);
        await uploadFile(saved, suggested);
        console.log('   ✅ ' + suggested + ' (' + fs.statSync(saved).size + ' bytes) 업로드 완료');
        ok++;
        await page.waitForTimeout(1000);
      } catch (e) {
        console.error('   ❌ ' + date + ' 실패: ' + e.message);
        await shot('ERROR-' + date);
        fail.push(date);
        if (di === 0) { await dumpSemantics('error'); break; } // 첫 날짜부터 실패면 구조 파악용으로 중단
      }
    }

    await browser.close();
    console.log('\n완료: 성공 ' + ok + '개, 실패 ' + fail.length + '개' + (fail.length ? ' → ' + fail.join(', ') : ''));
    if (ok === 0) process.exit(1);
  } catch (err) {
    await shot('FATAL');
    await dumpSemantics('fatal');
    try { fs.writeFileSync(path.join(DEBUG, 'page.html'), await page.content()); } catch {}
    await browser.close();
    console.error('FATAL ❌', err);
    process.exit(1);
  }
}
run();
