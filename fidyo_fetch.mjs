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
 * 실패해도 debug/ 에 각 단계 스크린샷을 남겨서 원인 파악이 쉽습니다.
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
async function shot(page, name) {
  step++;
  try { await page.screenshot({ path: path.join(DEBUG, String(step).padStart(2, '0') + '-' + name + '.png') }); } catch {}
}

async function run() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ acceptDownloads: true, locale: 'fr-FR', timezoneId: 'Europe/Paris' });
  const page = await ctx.newPage();
  page.setDefaultTimeout(60000);
  try {
    console.log('1) 로그인 페이지 열기');
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
    await shot(page, 'login');

    // Nom(이메일) = 비밀번호가 아닌 첫 입력칸, 비밀번호 = type=password
    await page.locator('input:not([type="password"])').first().fill(USER);
    await page.locator('input[type="password"]').first().fill(PASS);
    await shot(page, 'filled');
    await page.getByRole('button', { name: 'Connexion' }).click();

    console.log('   로그인 완료 대기…');
    await page.getByText('Statistiques', { exact: true }).waitFor({ timeout: 60000 });
    await page.waitForTimeout(1200);
    await shot(page, 'home');

    console.log('2) Statistiques 클릭');
    await page.getByText('Statistiques', { exact: true }).click();
    await page.waitForTimeout(1500);
    await shot(page, 'statistiques');

    console.log('3) 商品销售统计 클릭');
    await page.getByRole('button', { name: '商品销售统计' })
      .or(page.getByText('商品销售统计')).first().click();
    await page.waitForTimeout(1500);
    await shot(page, 'daterange');

    console.log('4) Valider 클릭 (오늘 날짜 자동)');
    await page.getByRole('button', { name: 'Valider' }).click();
    await page.getByText('下载表格').waitFor({ timeout: 60000 });
    await page.waitForTimeout(1500);
    await shot(page, 'table');

    console.log('5) 下载表格 클릭 → 다운로드');
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 60000 }),
      page.getByRole('button', { name: '下载表格' })
        .or(page.getByText('下载表格')).first().click(),
    ]);
    const suggested = download.suggestedFilename() || ('EXPORT-' + Date.now() + '.xlsx');
    const saved = path.join(DEBUG, suggested);
    await download.saveAs(saved);
    console.log('   다운로드됨:', suggested, fs.statSync(saved).size + ' bytes');
    await shot(page, 'after-download');

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
    await shot(page, 'ERROR');
    await browser.close();
    console.error('FAILED ❌', err);
    process.exit(1);
  }
}
run();
