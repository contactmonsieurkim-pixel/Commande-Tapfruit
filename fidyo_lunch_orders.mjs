/**
 * Fidyo 점심 매출 수집 (Commandes 기반, 시간 정확).
 * ------------------------------------------------------------------
 * Fidyo 통계는 날짜로만 필터되어 '점심만' 뽑을 수 없으므로, 주문(Commandes) 목록에서
 * 접수 시각이 점심 창(기본 11:30~16:00) 안인 주문만 골라 상세를 열어 품목을 취합합니다.
 * → 언제 실행하든(다음날·며칠 뒤 백필) 정확한 점심 데이터를 만들 수 있습니다.
 *
 * 목록/상세 모두 페이지네이션이 있으므로 끝까지 넘겨서 읽습니다. Annulée(취소) 주문 제외.
 * 집계 결과(품목·수량·매출)를 JSON 으로 백엔드에 보내면 Lunch Sale 폴더에 시트로 저장됩니다.
 *
 * 환경변수: FIDYO_USER, FIDYO_PASS, UPLOAD_URL, UPLOAD_TOKEN
 * (선택) TARGET_DATE='YYYY-MM-DD' (기본: 파리 어제)
 * (선택) BACKFILL_START, BACKFILL_END='YYYY-MM-DD' (범위 지정 시 그 기간 반복)
 * (선택) LUNCH_START='11:30', LUNCH_END='16:00'
 * (선택) DRY=1 (업로드 없이 집계만 로그)
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const USER = process.env.FIDYO_USER;
const PASS = process.env.FIDYO_PASS;
const UPLOAD_URL = process.env.UPLOAD_URL;
const UPLOAD_TOKEN = process.env.UPLOAD_TOKEN;
const LOGIN_URL = 'https://adm.fidyo.fr/#/login';
const DRY = !!process.env.DRY;
for (const [k, v] of Object.entries({ FIDYO_USER: USER, FIDYO_PASS: PASS })) {
  if (!v) { console.error('환경변수 누락: ' + k); process.exit(1); }
}
if (!DRY) for (const [k, v] of Object.entries({ UPLOAD_URL, UPLOAD_TOKEN })) {
  if (!v) { console.error('환경변수 누락: ' + k + ' (DRY=1 이면 불필요)'); process.exit(1); }
}

function parisYMD(off) {
  const p = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
  p.setDate(p.getDate() + (off || 0));
  return p.getFullYear() + '-' + String(p.getMonth() + 1).padStart(2, '0') + '-' + String(p.getDate()).padStart(2, '0');
}
function dateList(s, e) { const out = []; const d = new Date(s + 'T00:00:00Z'), end = new Date(e + 'T00:00:00Z'); while (d <= end) { out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); } return out; }
const DATES = (process.env.BACKFILL_START && process.env.BACKFILL_END)
  ? dateList(process.env.BACKFILL_START, process.env.BACKFILL_END)
  : [process.env.TARGET_DATE || parisYMD(-1)];
const toDMY = iso => iso.slice(8, 10) + '-' + iso.slice(5, 7) + '-' + iso.slice(0, 4);
const toDMY2 = iso => iso.slice(8, 10) + '/' + iso.slice(5, 7) + '/' + iso.slice(0, 4); // dd/mm/yyyy (목록 표시형식)
function hm(str) { const m = /(\d{1,2})[:hH](\d{2})/.exec(str); return m ? (+m[1]) * 60 + (+m[2]) : null; }
const LUNCH_START = hm(process.env.LUNCH_START || '11:30');
const LUNCH_END = hm(process.env.LUNCH_END || '16:00');

const DEBUG = path.resolve('debug');
fs.mkdirSync(DEBUG, { recursive: true });
let step = 0;

async function run() {
  console.log('점심 수집 대상:', DATES.join(', '), '| 창:', process.env.LUNCH_START || '11:30', '~', process.env.LUNCH_END || '16:00', DRY ? '| DRY' : '');
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ acceptDownloads: true, locale: 'fr-FR', timezoneId: 'Europe/Paris', viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(45000);

  async function shot(name) { step++; try { await page.screenshot({ path: path.join(DEBUG, String(step).padStart(2, '0') + '-' + name + '.png') }); } catch {} }
  async function dump(tag) { try { fs.writeFileSync(path.join(DEBUG, 'semantics-' + tag + '.html'), await page.evaluate(() => (document.querySelector('flt-semantics-host') || document.body).outerHTML)); } catch {} }
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
  // 화면의 모든 '텍스트 잎' 셀을 좌표와 함께 읽습니다 (빈 칸에 강건한 표 파싱용).
  async function readCellsRaw() {
    return await page.$$eval('flt-semantics', els => els
      .filter(e => e.children.length === 0 && e.textContent && e.textContent.trim())
      .map(e => { const r = e.getBoundingClientRect(); return { t: e.textContent.trim(), x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 }; })
      .filter(c => c.w > 0 && c.h > 0));
  }
  // semantics 트리가 꺼져 있으면 다시 켜고 재시도 (Flutter는 화면 전환 시 트리를 비울 수 있음).
  async function cells() {
    for (let a = 0; a < 4; a++) {
      const out = await readCellsRaw();
      if (out.length) return out;
      await enableSemantics(); await page.waitForTimeout(500);
    }
    return await readCellsRaw();
  }
  // 헤더 라벨들의 x 중심을 찾아 컬럼 기준을 만든 뒤, 각 셀을 가장 가까운 컬럼에 배정.
  function parseTable(all, headerLabels, tableLeft) {
    const heads = {};
    headerLabels.forEach(h => { const c = all.find(c => c.t === h); if (c) heads[h] = c.cx; });
    const headerY = Math.max(...Object.keys(heads).map(h => { const c = all.find(cc => cc.t === h); return c ? c.cy : 0; }), 0);
    const body = all.filter(c => c.cy > headerY + 6 && c.x >= (tableLeft || 160) && !/^\d+\s*[–-]\s*\d+\s*sur\s*\d+$/.test(c.t) && !/^Page (précédente|suivante)$/.test(c.t));
    // y 로 행 클러스터링
    const rows = [];
    body.sort((a, b) => a.cy - b.cy || a.cx - b.cx);
    body.forEach(c => {
      let row = rows.find(r => Math.abs(r.cy - c.cy) < 14);
      if (!row) { row = { cy: c.cy, cells: [] }; rows.push(row); }
      row.cells.push(c);
    });
    return rows.map(r => {
      const o = { cy: r.cy, _cells: r.cells };
      for (const h in heads) {
        let best = null; r.cells.forEach(c => { const d = Math.abs(c.cx - heads[h]); if (best === null || d < best.d) best = { d, c }; });
        if (best && best.d < 90) o[h] = best.c;
      }
      o.leftX = Math.min(...r.cells.map(c => c.x));
      return o;
    });
  }
  // 상세 표: 컬럼 헤더가 0크기라 위치기반이 불안정 → 각 행에서 '이름(앞쪽 텍스트) + 숫자열' 구조로 파싱.
  // 숫자열 순서 = [단가, Qté, 할인, Total, TURN]. 그래서 수량=nums[1], 매출=nums[3].
  function isNumTxt(t) { return /^[\d]+([.,]\d+)?\s*%?$/.test(String(t).trim()); }
  function toNumTxt(t) { var v = parseFloat(String(t).replace(/\s/g, '').replace('%', '').replace(',', '.')); return isNaN(v) ? null : v; }
  function parseDetailRows(all) {
    var body = all.filter(function (c) { return c.x >= 160; });
    body.sort(function (a, b) { return a.cy - b.cy || a.cx - b.cx; });
    var rows = [];
    body.forEach(function (c) { var r = rows.find(function (r) { return Math.abs(r.cy - c.cy) < 14; }); if (!r) { r = { cy: c.cy, cells: [] }; rows.push(r); } r.cells.push(c); });
    var out = [];
    rows.forEach(function (r) {
      var cs = r.cells.slice().sort(function (a, b) { return a.cx - b.cx; });
      var nameParts = [], nums = [], seen = false;
      cs.forEach(function (c) { if (isNumTxt(c.t)) { seen = true; nums.push(toNumTxt(c.t)); } else if (!seen) { nameParts.push(c.t); } });
      var name = nameParts.join(' ').trim();
      if (!name) return;
      if (/suite/i.test(name) || /^[-\s]+$/.test(name)) return;
      if (['Nom du produit', 'Prix unitaire', 'Qté', 'Remise %', 'Total', 'Note', 'TURN', 'SESS', 'Code', 'Fixé €'].indexOf(name) >= 0) return;
      if (nums.length < 4) return; // 단가·Qté·할인·Total 최소 4개
      out.push({ p: name, q: nums[1] || 0, r: nums[3] || 0 });
    });
    return out;
  }
  function pageMeta(all) {
    const c = all.find(c => /\d+\s*[–-]\s*\d+\s*sur\s*\d+/.test(c.t));
    if (!c) return null;
    const m = /(\d+)\s*[–-]\s*(\d+)\s*sur\s*(\d+)/.exec(c.t);
    return { a: +m[1], b: +m[2], c: +m[3] };
  }
  async function clickText(txt) { const el = all => all; const c = (await cells()).find(c => c.t === txt); if (c) { await page.mouse.click(c.cx, c.cy); return true; } return false; }
  async function nextPage() { return clickText('Page suivante'); }
  async function firstPage() { for (let i = 0; i < 12; i++) { const m = pageMeta(await cells()); if (!m || m.a <= 1) break; if (!(await clickText('Page précédente'))) break; await page.waitForTimeout(700); } }

  async function setDate(target) {
    const want = toDMY2(target);
    for (let i = 0; i < 100; i++) {
      const all = await cells();
      const dc = all.find(c => /^\d{2}\/\d{2}\/\d{4}$/.test(c.t));
      if (!dc) { await page.waitForTimeout(400); continue; }
      if (dc.t === want) return true;
      const [cd, cm, cy] = dc.t.split('/').map(Number);
      const cur = new Date(cy, cm - 1, cd), tgt = new Date(+target.slice(0, 4), +target.slice(5, 7) - 1, +target.slice(8, 10));
      // 날짜 텍스트 좌/우의 화살표(가장 가까운 버튼 좌표) 클릭
      const arrows = all.filter(c => Math.abs(c.cy - dc.cy) < 22 && (c.t === '' || /[<>]/.test(c.t)));
      // 텍스트가 없는 아이콘 버튼은 cells()에 안 잡히므로 좌표로 추정: 날짜 좌측/우측 32px
      const y = dc.cy; const xLeft = dc.x - 20, xRight = dc.x + dc.w + 20;
      await page.mouse.click(cur > tgt ? xLeft : xRight, y);
      await page.waitForTimeout(700);
    }
    return false;
  }

  // 상세 페이지 전체(모든 페이지) 품목 수집
  async function scrapeDetail() {
    const items = [];
    for (let pg = 0; pg < 20; pg++) {
      await page.waitForTimeout(500);
      const all = await cells();
      const rows = parseDetailRows(all);
      if (pg === 0) console.log('     [진단] 상세 셀 ' + all.length + '개, 파싱 품목행 ' + rows.length);
      rows.forEach(r => items.push(r));
      const m = pageMeta(all);
      if (!m || m.b >= m.c) break;
      if (!(await nextPage())) break;
    }
    return items;
  }
  async function backToList() {
    // 상세 상단의 RETOUR(목록으로) 클릭. 실패 시 브라우저 뒤로.
    if (!(await clickText('RETOUR'))) { try { await page.goBack(); } catch {} }
    await page.waitForTimeout(1500); await enableSemantics(); await page.waitForTimeout(500);
    // 목록 화면 확인
    for (let i = 0; i < 10; i++) { const cc = await cells(); if (cc.some(c => c.t === 'Mes commandes' || c.t === 'Heure')) return true; await page.waitForTimeout(500); }
    return false;
  }
  function isDetailOpen(cc) { return cc.some(c => /Détails de la commande/.test(c.t) || c.t === 'Enregistrement de statut'); }

  const results = {}; // date -> {p -> {q,r}}
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
    await page.waitForTimeout(3500); await enableSemantics(); await page.waitForTimeout(1200);
    await tapByName('Commandes', 60000);
    await page.waitForTimeout(3000); await enableSemantics(); await page.waitForTimeout(1200);

    for (const date of DATES) {
      console.log('=== ' + date + ' ===');
      if (!(await setDate(date))) { console.warn('   날짜 설정 실패: ' + date); await shot('datefail-' + date); continue; }
      await page.waitForTimeout(1200); await firstPage();
      await shot('list-' + date); await dump('list-' + date);

      // 1) 목록 전체를 훑어 점심 창 주문 식별자(시각) 수집
      const targets = []; // {time, hm, page}
      let pg = 0;
      for (; pg < 30; pg++) {
        const all = await cells();
        const rows = parseTable(all, ['Heure', 'Total', 'Dispo', 'Date'], 160);
        if (pg === 0) {
          console.log('   [진단] 목록 셀 ' + all.length + '개, 헤더 발견: ' + ['Heure', 'Total', 'Dispo', 'Date'].filter(h => all.some(c => c.t === h)).join('/'));
          console.log('   [진단] 1페이지 행: ' + rows.map(r => (r['Heure'] ? r['Heure'].t : '?') + (r['Dispo'] ? '(' + r['Dispo'].t + ')' : '')).join(', '));
        }
        rows.forEach(r => {
          const hC = r['Heure']; if (!hC) return; const t = hC.t; const mm = hm(t); if (mm == null) return;
          // 취소 주문 제외: 행 내용 어디든 Annulée 가 있으면 스킵 (Dispo 헤더가 0크기라 열 매칭이 불안정)
          const cancelled = (r._cells || []).some(c => /annul/i.test(c.t));
          if (cancelled) return;
          if (mm >= LUNCH_START && mm < LUNCH_END) targets.push({ time: t, hm: mm, page: pg });
        });
        const m = pageMeta(all);
        if (!m || m.b >= m.c) break;
        if (!(await nextPage())) break;
        await page.waitForTimeout(700);
      }
      await firstPage();
      // 중복 시각 제거(같은 시각 여러 주문 가능성 → 유지하되 순서대로 처리)
      console.log('   점심 창 주문 ' + targets.length + '건: ' + targets.map(t => t.time).join(', '));

      // 2) 각 주문 상세 열어 취합
      const agg = {};
      let done = 0;
      for (const tg of targets) {
        // 목록을 tg.page 로 이동
        await firstPage(); for (let k = 0; k < tg.page; k++) { await nextPage(); await page.waitForTimeout(700); }
        const all = await cells();
        const rows = parseTable(all, ['Heure', 'Total', 'Dispo'], 160);
        const row = rows.find(r => r['Heure'] && r['Heure'].t === tg.time);
        if (!row) { console.warn('   행 못 찾음: ' + tg.time); continue; }
        // 행의 맨 왼쪽 셀(주문번호) 좌표로 클릭 → 상세 열림. 실패 시 Heure 셀 클릭 재시도.
        await page.mouse.click(row.leftX + 6, row.cy);
        let ok = false;
        for (let i = 0; i < 12; i++) { await page.waitForTimeout(500); await enableSemantics(); if (isDetailOpen(await cells())) { ok = true; break; } }
        if (!ok && row['Heure']) {
          await page.mouse.click(row['Heure'].cx, row['Heure'].cy);
          for (let i = 0; i < 10; i++) { await page.waitForTimeout(500); await enableSemantics(); if (isDetailOpen(await cells())) { ok = true; break; } }
        }
        if (!ok) { console.warn('   상세 안 열림: ' + tg.time); await shot('nodetail-' + date + '-' + tg.time.replace(':', '')); await dump('nodetail-' + date); continue; }
        await enableSemantics(); await page.waitForTimeout(300);
        const items = await scrapeDetail();
        console.log('   주문 ' + tg.time + ': 품목 ' + items.length + '개');
        if (!items.length) { await shot('emptydetail-' + date + '-' + tg.time.replace(':', '')); await dump('emptydetail-' + date + '-' + tg.time.replace(':', '')); }
        items.forEach(it => { const k = it.p; (agg[k] = agg[k] || { q: 0, r: 0 }); agg[k].q += it.q; agg[k].r += it.r; });
        done++;
        if (done === 1) { await shot('detail-' + date); await dump('detail-' + date); }
        await backToList();
      }

      const rowsOut = Object.keys(agg).map(p => ({ p: p, q: Math.round(agg[p].q), r: Math.round(agg[p].r * 100) / 100 }));
      const totR = rowsOut.reduce((s, x) => s + x.r, 0), totQ = rowsOut.reduce((s, x) => s + x.q, 0);
      console.log('   → 주문 ' + done + '건 / 품목 ' + rowsOut.length + '종 / 수량 ' + totQ + ' / 매출 ' + totR.toFixed(2) + ' €');
      results[date] = rowsOut;
      fs.writeFileSync(path.join(DEBUG, 'lunch-' + date + '.json'), JSON.stringify(rowsOut, null, 2));

      if (!DRY && rowsOut.length) {
        const name = 'LUNCH VENTE ' + toDMY(date);
        const res = await fetch(UPLOAD_URL, { method: 'POST', body: new URLSearchParams({ token: UPLOAD_TOKEN, name: name, folder: 'lunch', rows: JSON.stringify(rowsOut) }) });
        const txt = await res.text();
        if (res.status >= 400 || /unauthorized|missing|error/i.test(txt)) throw new Error('업로드 실패: ' + res.status + ' ' + txt.slice(0, 160));
        console.log('   업로드 OK: ' + name);
      } else if (!rowsOut.length) {
        console.warn('   점심 주문 없음 → 업로드 생략');
      }
    }

    await browser.close();
    console.log('완료.');
  } catch (err) {
    await shot('ERROR'); await dump('error');
    try { fs.writeFileSync(path.join(DEBUG, 'page.html'), await page.content()); } catch {}
    await browser.close(); console.error('실패 ❌', err); process.exit(1);
  }
}
run();
