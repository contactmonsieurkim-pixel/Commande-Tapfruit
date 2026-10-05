// PWA 화면을 실제 브라우저(Playwright)로 조작하는 테스트. API 요청은 가짜 Google 서비스 위의 Code.gs 로 보냄.
// 실행: node test_ui.js [스크린샷 폴더]
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { execSync } = require('child_process');
const { makeEnv } = require('./test_gas.js');

let playwright;
try { playwright = require('playwright'); } catch (e) {
  playwright = require(path.join(execSync('npm root -g').toString().trim(), 'playwright'));
}

const ROOT = path.join(__dirname, '..');
const SHOTS = process.argv[2];
const API = 'https://script.google.com/macros/s/TEST/exec';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

const server = http.createServer((req, res) => {
  const file = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]).replace(/\/$/, '/index.html'));
  if (!file.startsWith(ROOT) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

(async () => {
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}/`;
  const env = makeEnv();
  const browser = await playwright.chromium.launch();
  const errors = [];
  let n = 0;
  let offline = false;

  async function newPage(opts) {
    const ctx = await browser.newContext(Object.assign({ viewport: { width: 390, height: 844 }, locale: 'ko-KR' }, opts));
    await ctx.route(API, async (route) => {
      if (offline) return route.abort('internetdisconnected');
      const body = route.request().postData();
      const r = env.call(JSON.parse(body));
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(r) });
    });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('dialog', (d) => d.accept());
    return page;
  }
  const shot = async (page, name) => { if (SHOTS) await page.waitForTimeout(300); if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${String(++n).padStart(2, '0')}-${name}.png`), fullPage: true }); };
  const toast = async (page, re) => {
    await page.waitForSelector('#toast:not(.hidden)');
    const t = await page.textContent('#toast');
    assert.match(t, re);
    await page.evaluate(() => document.getElementById('toast').classList.add('hidden'));
  };
  const step = (s) => console.log('ok -', s);

  // ---------------------------------------------------------------- 관리자
  const a = await newPage();
  await a.goto(base);
  await a.fill('#f-api', 'https://example.com/x');
  await a.click('button:has-text("연결")');
  await toast(a, /script\.google\.com/);
  await a.fill('#f-api', API);
  await shot(a, 'config');
  await a.click('button:has-text("연결")');
  await a.waitForSelector('text=처음 설정');
  await shot(a, 'setup');
  await a.fill('#f-name', '사장님');
  await a.fill('#f-user', 'boss');
  await a.fill('#f-pw', 'secret1');
  await a.click('button:has-text("관리자 계정 만들기")');
  await a.waitForSelector('text=대시보드');
  assert.strictEqual(await a.textContent('#mode'), '관리자 모드');
  step('config → first admin setup → dashboard');

  // 상품 추가
  await a.click('nav button:has-text("상품")');
  await a.waitForSelector('text=아직 상품이 없습니다');
  for (const [name, sku, cat, stock, min] of [['사과', 'A-001', '과일', '12', '3'], ['배', 'A-002', '과일', '2', '5'], ['선물세트', 'G-001', '선물', '0', '1']]) {
    await a.click('button:has-text("＋ 상품")');
    await a.fill('#e-name', name);
    await a.fill('#e-sku', sku);
    await a.fill('#e-category', cat);
    await a.fill('#e-price', '10');
    await a.fill('#e-cost', '6,5');
    await a.fill('#e-stock', stock);
    await a.fill('#e-minStock', min);
    if (name === '사과') await shot(a, 'product-form');
    await a.click('#sheet button:has-text("추가")');
    await toast(a, /추가/);
  }
  assert.strictEqual(await a.locator('.item').count(), 3);
  await shot(a, 'products');
  await a.click('.chip:has-text("부족")');
  assert.strictEqual(await a.locator('.item').count(), 1);
  await a.click('.chip:has-text("품절")');
  assert.strictEqual(await a.locator('.item').count(), 1);
  await a.click('.chip:has-text("전체")');
  await a.fill('#q', 'g-001');
  assert.strictEqual(await a.locator('.item').count(), 1);
  await a.fill('#q', '');
  step('products added, filters and search');

  // 입고 / 출고 / 조정 / 수정
  await a.click('.item:has-text("사과")');
  await a.waitForSelector('#p-hist .mv');
  await a.fill('#f-qty', '5');
  await a.fill('#f-note', '거래처 입고');
  await shot(a, 'product-detail');
  await a.click('#b-move');
  await toast(a, /입고 5 → 재고 17/);
  await a.click('.item:has-text("사과")');
  await a.click('.seg button:has-text("출고")');
  await a.fill('#f-qty', '20');
  await a.click('#b-move');
  await toast(a, /재고가 부족/);
  await a.fill('#f-qty', '7');
  await a.click('#b-move');
  await toast(a, /출고 7 → 재고 10/);
  await a.click('.item:has-text("사과")');
  await a.click('#sheet button:has-text("재고 조정")');
  await a.fill('#a-stock', '9');
  await a.fill('#a-note', '실사');
  await a.click('#sheet button:has-text("조정 저장")');
  await toast(a, /조정 -1 → 재고 9/);
  await a.click('.item:has-text("배")');
  await a.click('#sheet button:has-text("수정")');
  await a.fill('#e-location', 'B-2 선반');
  await a.click('#sheet button:has-text("저장")');
  await toast(a, /저장/);
  assert.match(await a.textContent('.item:has-text("배")'), /B-2 선반/);
  step('IN / OUT (insufficient rejected) / adjust / edit');

  // 대시보드
  await a.click('nav button:has-text("대시보드")');
  await a.waitForSelector('#chart svg');
  assert.match(await a.textContent('.tiles'), /오늘 입고\s*19/);
  await a.hover('.hit[data-i="6"]');
  assert.match(await a.textContent('#tip'), /입고 19.*출고 7/);
  await shot(a, 'dashboard');
  await a.click('button:has-text("표로 보기")');
  assert.ok(await a.isVisible('#chart-table table'));
  step('dashboard tiles, chart tooltip, table view');

  // 기록 + 취소
  await a.click('nav button:has-text("입출고 기록")');
  await a.waitForSelector('#log-list .mv');
  assert.strictEqual(await a.locator('#log-list .mv').count(), 5);
  await a.click('#log-list .mv:has-text("실사") button:has-text("취소")');
  await toast(a, /취소/);
  await a.waitForSelector('#log-list .mv.canceled');
  assert.strictEqual(await a.locator('#log-list .mv').count(), 6);
  await a.selectOption('#l-type', 'OUT');
  await a.click('button:has-text("조회")');
  await a.waitForSelector('#log-list .mv');
  assert.strictEqual(await a.locator('#log-list .mv').count(), 1);
  const [dl] = await Promise.all([a.waitForEvent('download'), a.click('button:has-text("CSV 내보내기")')]);
  assert.match(fs.readFileSync(await dl.path(), 'utf8'), /^﻿일시[,;]구분/);
  await shot(a, 'log');
  step('log, cancel movement, filter, CSV export');

  // 관리: 카테고리
  await a.click('nav button:has-text("관리")');
  await a.waitForSelector('[data-cat]');
  await a.fill('[data-cat="0"]', '생과일');
  await a.click('button:has-text("＋ 추가")');
  await a.fill('[data-cat="2"]', '채소');
  await a.click('button:has-text("저장")');
  await toast(a, /카테고리/);
  await shot(a, 'categories');
  // 사용자
  await a.click('.chip:has-text("사용자")');
  await a.waitForSelector('text=@boss');
  await a.click('button:has-text("＋ 사용자")');
  await a.fill('#u-name', '직원1');
  await a.fill('#u-user', 'staff1');
  await a.fill('#u-pw', '0000');
  await a.click('#sheet button:has-text("추가")');
  await toast(a, /저장/);
  await a.waitForSelector('text=@staff1');
  await shot(a, 'users');
  // 설정
  await a.click('.chip:has-text("설정")');
  await a.fill('#s-shop', 'Tapfruit');
  await a.uncheck('input[name=userCanMove]');
  await shot(a, 'settings');
  await a.click('button:has-text("설정 저장")');
  await toast(a, /설정/);
  assert.strictEqual(await a.textContent('#title'), 'Tapfruit');
  // 데이터: CSV 가져오기
  await a.click('.chip:has-text("데이터")');
  await a.setInputFiles('#csvfile', { name: 'p.csv', mimeType: 'text/csv',
    buffer: Buffer.from('﻿상품코드;상품명;카테고리;재고;판매가\nA-001;;;30;12,5\nV-001;당근;채소;40;2\n') });
  await a.waitForSelector('text=2</b>행', { state: 'attached' }).catch(() => {});
  await shot(a, 'import');
  await a.click('#b-import');
  await toast(a, /추가 1 · 수정 1/);
  await a.click('nav button:has-text("상품")');
  assert.match(await a.textContent('.item:has-text("사과")'), /30/);
  assert.match(await a.textContent('.item:has-text("사과")'), /생과일/);
  assert.strictEqual(await a.locator('.item').count(), 4);
  step('manage: categories rename, add user, settings, CSV import');

  // 모드 전환
  await a.click('#mode');
  assert.strictEqual(await a.textContent('#mode'), '사용자 모드');
  assert.ok(await a.isVisible('nav button:has-text("재고")'));
  assert.ok(!(await a.isVisible('nav button:has-text("관리")')));
  await a.click('#mode');
  await toast(a, /관리자 모드/);
  step('admin can preview user mode');

  // ---------------------------------------------------------------- 사용자 (다크 모드)
  const u = await newPage({ colorScheme: 'dark' });
  await u.goto(base);
  await u.fill('#f-api', API);
  await u.click('button:has-text("연결")');
  await u.waitForSelector('#f-user');
  await u.fill('#f-user', 'staff1');
  await u.fill('#f-pw', 'wrong');
  await u.click('button:has-text("로그인")');
  await toast(u, /맞지 않습니다/);
  await u.fill('#f-pw', '0000');
  await u.click('button:has-text("로그인")');
  await u.waitForSelector('.item');
  assert.ok(!(await u.isVisible('#mode')));
  assert.deepStrictEqual(await u.locator('nav button').allTextContents(), ['📦재고', '🧾내 기록', '👤내 정보']);
  await shot(u, 'user-stock-dark');
  await u.click('.item:has-text("사과")');
  await u.waitForSelector('#p-hist .mv');
  assert.ok(!(await u.isVisible('#b-move')), 'move disabled by settings');
  assert.ok(!(await u.isVisible('#sheet button:has-text("수정")')));
  assert.ok(!(await u.textContent('#sheet')).includes('원가'));
  await u.click('#sheet [data-act=close]');
  step('user mode: read-only stock (moves disabled), no cost, no admin tabs');

  // 관리자가 입출고 허용 → 사용자 새로고침 후 출고
  await a.click('nav button:has-text("관리")');
  await a.click('.chip:has-text("설정")');
  await a.check('input[name=userCanMove]');
  await a.click('button:has-text("설정 저장")');
  await toast(a, /설정/);
  await u.click('#sync');
  await u.waitForTimeout(200);
  await u.click('.item:has-text("당근")');
  await u.click('.seg button:has-text("출고")');
  await u.fill('#f-qty', '3');
  await shot(u, 'user-move-dark');
  await u.click('#b-move');
  await toast(u, /출고 3 → 재고 37/);
  await u.click('nav button:has-text("내 기록")');
  await u.waitForSelector('#mine .mv');
  assert.strictEqual(await u.locator('#mine .mv').count(), 1);
  step('user can move after admin enables it; own history');

  // 관리자가 비활성화 → 사용자 다음 요청에서 로그아웃
  await a.click('.chip:has-text("사용자")');
  await a.click('.item:has-text("staff1")');
  await a.uncheck('#sheet input[name=active]');
  await a.click('#sheet button:has-text("저장")');
  await toast(a, /저장/);
  await u.click('#sync');
  await u.waitForSelector('#f-user');
  step('deactivated user is logged out');

  // 오프라인: 캐시로 표시
  await a.click('nav button:has-text("상품")');
  await a.context().setOffline(true);
  offline = true;
  await a.reload().catch(() => {});
  await a.waitForSelector('#banner:not(.hidden)');
  await a.click('nav button:has-text("상품")');
  await a.waitForSelector('.item');
  await shot(a, 'offline');
  await a.context().setOffline(false);
  offline = false;
  step('offline: app shell from service worker + cached data');

  // 데스크톱 폭에서 가로 스크롤 없음
  await a.setViewportSize({ width: 1280, height: 900 });
  await a.reload();
  await a.click('nav button:has-text("대시보드")');
  await a.waitForSelector('#chart svg');
  await shot(a, 'desktop-dashboard');
  for (const p of [a, u]) {
    assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no horizontal scroll');
  }

  assert.deepStrictEqual(errors.filter((e) => !/Failed to load resource|ERR_INTERNET_DISCONNECTED/.test(e)), []);
  console.log('\nUI tests passed');
  await browser.close();
  server.close();
})().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
