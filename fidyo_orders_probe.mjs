/**
 * Fidyo Commandes(주문) 구조 탐사용 probe — 데이터 업로드 없음, 화면 덤프만.
 *  1) 로그인
 *  2) 좌측 메뉴 "Commandes" 클릭
 *  3) 주문 목록 화면 스크린샷 + semantics 덤프 (+ 보이는 버튼/텍스트 라벨 로그)
 *  4) 첫 번째 주문으로 보이는 항목을 클릭해 상세 화면 스크린샷 + semantics 덤프
 * 결과는 debug/ 아티팩트로 업로드됩니다. 저에게 그 파일들을 주세요.
 *
 * 환경변수: FIDYO_USER, FIDYO_PASS   (UPLOAD_* 불필요)
 * (선택) TARGET_DATE = 'YYYY-MM-DD'  (기본: 파리 어제)
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const USER = process.env.FIDYO_USER;
const PASS = process.env.FIDYO_PASS;
const LOGIN_URL = 'https://adm.fidyo.fr/#/login';
for (const [k, v] of Object.entries({ FIDYO_USER: USER, FIDYO_PASS: PASS })) {
  if (!v) { console.error('환경변수 누락: ' + k); process.exit(1); }
}
function parisYMD(off) {
  const p = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
  p.setDate(p.getDate() + (off || 0));
  return p.getFullYear() + '-' + String(p.getMonth() + 1).padStart(2, '0') + '-' + String(p.getDate()).padStart(2, '0');
}
const TARGET = process.env.TARGET_DATE || parisYMD(-1);

const DEBUG = path.resolve('debug');
fs.mkdirSync(DEBUG, { recursive: true });
let step = 0;

async function run() {
  console.log('probe 대상 날짜(참고):', TARGET);
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ acceptDownloads: true, locale: 'fr-FR', timezoneId: 'Europe/Paris', viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(45000);

  async function shot(name) { step++; try { await page.screenshot({ path: path.join(DEBUG, String(step).padStart(2, '0') + '-' + name + '.png'), fullPage: false }); } catch {} }
  async function dump(tag) {
    try { fs.writeFileSync(path.join(DEBUG, 'semantics-' + tag + '.html'), await page.evaluate(() => (document.querySelector('flt-semantics-host') || document.body).outerHTML)); } catch {}
    try { fs.writeFileSync(path.join(DEBUG, 'page-' + tag + '.html'), await page.content()); } catch {}
  }
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
    }
  }
  // 화면의 role=button 라벨들을 로그로 남겨 구조 파악을 돕습니다.
  async function logButtons(tag) {
    try {
      const texts = await page.locator('flt-semantics[role="button"]').evaluateAll(els => els.map(e => (e.getAttribute('aria-label') || e.textContent || '').trim()).filter(Boolean));
      console.log('--- [' + tag + '] 버튼 라벨 ' + texts.length + '개 ---');
      texts.slice(0, 80).forEach((t, i) => console.log('  ' + i + ': ' + t.slice(0, 80)));
    } catch (e) { console.log('logButtons 실패: ' + e.message); }
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
    await page.waitForTimeout(4000); await enableSemantics(); await page.waitForTimeout(1500);
    await shot('after-login'); await logButtons('after-login');

    console.log('Commandes 열기');
    await tapByName('Commandes', 60000);
    await page.waitForTimeout(3500); await enableSemantics(); await page.waitForTimeout(1500);
    await shot('commandes-list'); await dump('commandes-list'); await logButtons('commandes-list');

    // 주문 상세로 추정되는 항목 클릭 시도: 시간(HH:MM) 또는 금액(€)이 들어간 role=button 우선
    console.log('첫 주문 상세 열기 시도');
    let opened = false;
    const cands = page.locator('flt-semantics[role="button"]').filter({ hasText: /\d{1,2}\s*[:hH]\s*\d{2}|€|\d+[.,]\d{2}/ });
    if (await cands.count()) {
      await cands.first().click().catch(() => {});
      opened = true;
    }
    if (!opened) {
      // 대안: 목록 영역의 첫 tappable 클릭
      const any = page.locator('flt-semantics[flt-tappable], flt-semantics[role="button"]');
      const n = await any.count();
      if (n > 8) { await any.nth(8).click().catch(() => {}); opened = true; } // 좌측 메뉴 이후 항목 추정
    }
    await page.waitForTimeout(3000); await enableSemantics(); await page.waitForTimeout(1200);
    await shot('order-detail'); await dump('order-detail'); await logButtons('order-detail');

    console.log('probe 완료 — debug/ 아티팩트를 확인하세요.');
    await browser.close();
  } catch (err) {
    await shot('ERROR'); await dump('error');
    await browser.close(); console.error('probe 실패 ❌', err); process.exit(1);
  }
}
run();
