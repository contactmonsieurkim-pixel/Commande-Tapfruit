/**
 * Fidyo → Google Drive 자동 수집기 (방식 2: 브라우저 로봇)
 * -------------------------------------------------------------------
 * ※ Fidyo 는 Flutter(CanvasKit) 앱이라 화면이 canvas 로 그려집니다.
 *   → Flutter '접근성(semantics)' 트리를 켜야 진짜 DOM(입력칸/버튼)이 생깁니다.
 *
 * 흐름: 로그인 → Statistiques → 商品销售统计 → Valider → 下载表格 → Apps Script 업로드
 * 환경변수(=GitHub Secrets): FIDYO_USER, FIDYO_PASS, UPLOAD_URL, UPLOAD_TOKEN
 * 디버깅: debug/ 에 단계별 스크린샷 + semantics.html(접근성 트리 구조) 저장
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
  // Flutter 접근성 트리 켜기 (숨은 placeholder 를 활성화)
  async function enableSemantics() {
    try { await page.locator('flt-semantics-placeholder').click({ force: true, timeout: 4000 }); } catch {}
    try {
      await page.evaluate(() => {
        const el = document.querySelector('flt-semantics-placeholder');
        if (el) { el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); el.dispatchEvent(new MouseEvent('click', { bubbles: true })); if (el.click) el.click(); }
      });
    } catch {}
  }
  // semantics 트리에서 '보이는 텍스트/라벨' 로 요소 찾아 클릭
  async function tapByName(name, timeout = 45000) {
    const loc = page.getByRole('button', { name, exact: false })
      .or(page.locator(`flt-semantics[aria-label*="${name}"]`))
      .or(page.getByText(name, { exact: false }))
      .first();
    await loc.waitFor({ state: 'visible', timeout });
    await loc.click();
  }
  // Flutter 입력칸: 클릭 후 준비 대기 → 비우고 → 천천히 입력 → 글자수 검증/재시도
  async function typeInto(loc, value, label) {
    for (let attempt = 1; attempt <= 4; attempt++) {
      await loc.click();
      await page.waitForTimeout(600);                 // Flutter 입력요소 준비 대기 (첫 글자 씹힘 방지)
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
    console.log('   ' + label + ': 글자수 안 맞지만 진행');
  }

  try {
    console.log('1) 로그인 페이지 열기 + Flutter 로딩');
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
    // Flutter 첫 프레임 대기
    try { await page.waitForFunction(() => !!document.querySelector('flutter-view'), { timeout: 60000 }); } catch {}
    await page.waitForTimeout(6000);
    await shot('loaded');

    console.log('   접근성(semantics) 켜기');
    await enableSemantics();
    await page.waitForTimeout(3000);
    await shot('after-a11y');
    await dumpSemantics('login');

    console.log('   입력칸 대기');
    await page.waitForSelector('input', { timeout: 45000 });

    console.log('   아이디/비밀번호 입력');
    // Nom = aria-label 우선, 없으면 첫 input
    let nom = page.locator('input[aria-label*="Nom" i]').first();
    if (!(await nom.count())) nom = page.locator('input').first();
    await typeInto(nom, USER, 'Nom');

    let pw = page.locator('input[type="password"]').first();
    if (!(await pw.count())) pw = page.locator('input[aria-label*="passe" i]').first();
    if (!(await pw.count())) pw = page.locator('input').nth(1);
    await typeInto(pw, PASS, 'Mot de passe');
    await shot('filled');

    console.log('   Connexion');
    await tapByName('Connexion', 30000);

    console.log('2) 로그인 완료 대기 → Statistiques');
    await tapByName('Statistiques', 90000);
    await page.waitForTimeout(2500);
    await shot('statistiques');
    await dumpSemantics('stat');

    console.log('3) 商品销售统计');
    await tapByName('商品销售统计', 45000);
    await page.waitForTimeout(2500);
    await shot('daterange');

    console.log('4) Valider (오늘 날짜 자동)');
    await tapByName('Valider', 45000);
    await page.waitForTimeout(3000);
    await shot('table');
    await dumpSemantics('table');

    console.log('5) 下载表格 → 다운로드');
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 60000 }),
      tapByName('下载表格', 45000),
    ]);
    const suggested = download.suggestedFilename() || ('EXPORT-' + Date.now() + '.xlsx');
    const saved = path.join(DEBUG, suggested);
    await download.saveAs(saved);
    console.log('   다운로드됨:', suggested, fs.statSync(saved).size + ' bytes');
    await shot('after-download');

    console.log('6) Apps Script 업로드');
    const b64 = fs.readFileSync(saved).toString('base64');
    const body = new URLSearchParams({ token: UPLOAD_TOKEN, name: suggested, data: b64 });
    const res = await fetch(UPLOAD_URL, { method: 'POST', body });
    const txt = await res.text();
    console.log('   업로드 응답:', res.status, txt.slice(0, 200));
    if (res.status >= 400 || /unauthorized|missing|error/i.test(txt)) throw new Error('업로드 실패: ' + res.status + ' ' + txt.slice(0, 200));

    await browser.close();
    console.log('DONE ✅');
  } catch (err) {
    await shot('ERROR');
    await dumpSemantics('error');
    try { fs.writeFileSync(path.join(DEBUG, 'page.html'), await page.content()); } catch {}
    await browser.close();
    console.error('FAILED ❌', err);
    process.exit(1);
  }
}
run();
