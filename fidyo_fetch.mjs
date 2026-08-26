/**
 * Fidyo → Google Drive 자동 수집기 (방식 2: 브라우저 로봇)
 * -------------------------------------------------------------------
 * 매일 밤 GitHub Actions가 실행:
 *   1) adm.fidyo.fr 로그인 (Nom + Mot de passe)
 *   2) 좌측 Statistiques → 商品销售统计
 *   3) 날짜 팝업(오늘 자동) → Valider
 *   4) 下载表格 클릭 → xlsx 다운로드
 *   5) 받은 xlsx 를 Apps Script(doPost)로 전송 → Data 폴더에 저장
 *
 * 환경변수(=GitHub Secrets): FIDYO_USER, FIDYO_PASS, UPLOAD_URL, UPLOAD_TOKEN
 * Fidyo UI 는 커스텀 요소라, "보이는 글자/입력칸" 기준으로 찾습니다.
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

const DEBUG = path.resolve('debug');
fs.mkdirSync(DEBUG, { recursive: true });
let step = 0;

async function run() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ acceptDownloads: true, locale: 'fr-FR', timezoneId: 'Europe/Paris' });
  const page = await ctx.newPage();
  page.setDefaultTimeout(60000);

  async function shot(name) {
    step++;
    try { await page.screenshot({ path: path.join(DEBUG, String(step).padStart(2, '0') + '-' + name + '.png') }); } catch {}
  }
  // 보이는 글자로 요소를 찾아 클릭 (커스텀 버튼 대응)
  async function clickText(t, timeout = 60000) {
    const el = page.getByText(t, { exact: false }).first();
    await el.waitFor({ state: 'visible', timeout });
    await el.click();
  }

  try {
    console.log('1) 로그인 페이지 열기');
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5000); // SPA 부팅 대기
    // 로그인 폼이 뜰 때까지 (Connexion 글자가 보일 때까지)
    await page.getByText('Connexion', { exact: false }).first().waitFor({ state: 'visible', timeout: 120000 });
    await page.waitForTimeout(1500);
    await shot('login');

    console.log('   아이디/비밀번호 입력 (보이는 입력칸 기준)');
    const visInputs = page.locator('input:visible');
    await visInputs.first().waitFor({ state: 'visible', timeout: 30000 });
    const nCount = await visInputs.count();
    console.log('   보이는 입력칸 수:', nCount);
    // 첫 번째 보이는 입력칸 = Nom, 비밀번호칸 = type=password
    await visInputs.nth(0).click();
    await visInputs.nth(0).fill(USER);
    const pw = page.locator('input[type="password"]:visible').first();
    if (await pw.count()) { await pw.click(); await pw.fill(PASS); }
    else { await visInputs.nth(1).click(); await visInputs.nth(1).fill(PASS); }
    await shot('filled');

    await clickText('Connexion', 30000);

    console.log('   로그인 완료 대기…');
    await page.getByText('Statistiques', { exact: true }).waitFor({ state: 'visible', timeout: 120000 });
    await page.waitForTimeout(1500);
    await shot('home');

    console.log('2) Statistiques 클릭');
    await clickText('Statistiques');
    await page.waitForTimeout(2000);
    await shot('statistiques');

    console.log('3) 商品销售统计 클릭');
    await clickText('商品销售统计');
    await page.waitForTimeout(2000);
    await shot('daterange');

    console.log('4) Valider 클릭 (오늘 날짜 자동)');
    await clickText('Valider');
    await page.getByText('下载表格', { exact: false }).first().waitFor({ state: 'visible', timeout: 60000 });
    await page.waitForTimeout(2000);
    await shot('table');

    console.log('5) 下载表格 클릭 → 다운로드');
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 60000 }),
      clickText('下载表格', 30000),
    ]);
    const suggested = download.suggestedFilename() || ('EXPORT-' + Date.now() + '.xlsx');
    const saved = path.join(DEBUG, suggested);
    await download.saveAs(saved);
    console.log('   다운로드됨:', suggested, fs.statSync(saved).size + ' bytes');
    await shot('after-download');

    console.log('6) Apps Script 로 업로드');
    const b64 = fs.readFileSync(saved).toString('base64');
    const body = new URLSearchParams({ token: UPLOAD_TOKEN, name: suggested, data: b64 });
    const res = await fetch(UPLOAD_URL, { method: 'POST', body });
    const txt = await res.text();
    console.log('   업로드 응답:', res.status, txt.slice(0, 200));
    if (res.status >= 400 || /unauthorized|missing|error/i.test(txt)) {
      throw new Error('업로드 실패: ' + res.status + ' ' + txt.slice(0, 200));
    }

    await browser.close();
    console.log('DONE ✅');
  } catch (err) {
    await shot('ERROR');
    // 디버깅용: 현재 페이지 HTML 일부도 남김
    try { fs.writeFileSync(path.join(DEBUG, 'page.html'), await page.content()); } catch {}
    await browser.close();
    console.error('FAILED ❌', err);
    process.exit(1);
  }
}
run();
