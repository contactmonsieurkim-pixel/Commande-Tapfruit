# 쇼핑몰 재고 관리 (GAS + 스프레드시트 + PWA)

상품 등록, 입고/출고, 재고 조정, 기록 조회, 사용자와 권한 관리를 모두 **앱 화면(관리자 모드)** 에서 합니다.
스프레드시트는 데이터를 저장하는 곳으로만 쓰고, 직접 열어서 고칠 일은 없습니다.

```
PWA (GitHub Pages, inventory/index.html)  ── fetch POST ──▶  Apps Script 웹 앱 (inventory/gas/Code.gs)
  관리자 모드 / 사용자 모드, 오프라인 캐시                        인증 · 권한 · 재고 계산 · 기록
                                                                        │
                                                                        ▼
                                                  Google 스프레드시트 "Inventory DB" (데이터 저장)
                                     Products | Movements | Users | Categories | Settings
```

> **엑셀에 대해**: Apps Script 는 `.xlsx` 파일을 직접 읽고 쓸 수 없어서, 데이터는 **Google 스프레드시트**에 저장됩니다.
> 엑셀 파일이 필요하면 스프레드시트에서 *파일 → 다운로드 → Microsoft Excel(.xlsx)* 로 언제든 받을 수 있고,
> 기존 엑셀 상품 목록은 앱의 **관리 → 데이터 → CSV 가져오기**로 한 번에 넣을 수 있습니다.

## 기능

| | 관리자 모드 | 사용자 모드 (직원) |
|---|---|---|
| 재고 조회 · 검색 · 카테고리/부족/품절 필터 · 바코드 스캔 | ✅ | ✅ (판매 중인 상품만) |
| 입고 / 출고 | ✅ | 설정에서 허용 시 |
| 원가 보기 | ✅ | 설정에서 허용 시 |
| 내 입출고 기록 | ✅ | ✅ |
| 대시보드 (재고 금액, 품절/부족, 7일 입출고 차트) | ✅ | |
| 상품 추가 · 수정 · 삭제 · 판매중지 | ✅ | |
| 재고 조정 (실사 수량으로 맞추기) | ✅ | |
| 전체 입출고 기록 조회 · 필터 · 취소(되돌리기) · CSV 내보내기 | ✅ | |
| 카테고리 추가 · 이름 변경 · 순서 · 삭제 (상품에 자동 반영) | ✅ | |
| 사용자 추가 · 권한 · 비활성화 · 비밀번호 재설정 · 삭제 | ✅ | |
| 설정 (쇼핑몰 이름, 통화, 기본 안전재고, 사용자 권한, 마이너스 재고 허용) | ✅ | |
| 상품 CSV 가져오기 / 내보내기 | ✅ | |

- 관리자는 상단 **관리자 모드** 버튼을 눌러 직원이 보는 화면(사용자 모드)으로 바꿔 볼 수 있습니다.
- 재고 수량은 입고/출고/조정으로만 바뀌고, 모든 변경은 `Movements`에 누가·언제·얼마나·이전→이후로 남습니다.
  잘못 입력한 기록은 **취소**하면 반대 수량으로 되돌리고 취소 기록이 추가됩니다(원래 기록은 지우지 않음).
- 동시에 여러 명이 입출고해도 서버 잠금(LockService)으로 재고가 꼬이지 않습니다.
- 수량은 소수도 됩니다 (예: 2.5 kg). 입력할 때 `2,5` 도 받습니다.
- 비밀번호는 솔트 + SHA-256 해시로 저장됩니다. 로그인 5회 실패 시 10분 차단, 로그인은 기기마다 30일 유지.
  사용자를 비활성화하거나 비밀번호를 바꾸면 그 사용자의 기존 로그인은 바로 끊깁니다.
- 앱은 홈 화면에 설치(PWA)할 수 있고, 인터넷이 끊겨도 마지막으로 받은 재고 목록을 볼 수 있습니다.

## 설치

### 1. Apps Script 백엔드

1. <https://script.google.com> → **새 프로젝트** (이름 예: `Inventory`)
2. `Code.gs` 내용을 지우고 `gas/Code.gs` 를 붙여 넣기
3. 프로젝트 설정(⚙) → "appsscript.json 매니페스트 파일 표시" 체크 → `appsscript.json` 을 `gas/appsscript.json` 내용으로 교체
4. **배포 → 새 배포 → 유형: 웹 앱**, 실행: **나**, 액세스 권한: **모든 사용자** → 배포 → 권한 승인
5. 나오는 웹 앱 URL(`https://script.google.com/macros/s/…/exec`)을 복사

첫 요청 때 내 Google Drive 에 `Inventory DB` 스프레드시트가 자동으로 만들어집니다.
(편집기에서 `setup` 함수를 한 번 실행하면 미리 만들고 주소를 로그로 볼 수도 있습니다.)

- 이미 있는 스프레드시트를 쓰고 싶으면: 프로젝트 설정 → 스크립트 속성에 `SHEET_ID` = 시트 주소의 `/d/<여기>/edit` 부분.
  또는 그 시트에서 *확장 프로그램 → Apps Script* 로 만든 프로젝트(바인딩)에 코드를 넣으면 그 시트를 사용합니다.
  필요한 탭과 열은 자동으로 추가되고, 시트에 직접 추가한 다른 열은 건드리지 않습니다.
- 코드를 고친 뒤에는 **배포 관리 → 수정(연필) → 버전: 새 버전 → 배포** 해야 반영됩니다. (URL 유지)

### 2. PWA (GitHub Pages)

이 레포를 `main` 에 병합하면 `https://contactmonsieurkim-pixel.github.io/Commande-Tapfruit/inventory/` 에서 열립니다.
(레포 Settings → Pages 가 main 브랜치 / root 인지 확인)

서버 주소는 두 가지 방법 중 하나로 넣습니다.
- **앱에서 입력** (기본): 처음 열면 "서버 연결" 화면이 나오고 URL 을 붙여 넣으면 그 기기에 저장됩니다.
- **코드에 고정**: `index.html` 의 `const API_URL = '';` 에 URL 을 넣으면 직원들은 주소 입력 없이 바로 로그인 화면을 봅니다.

### 3. 첫 실행

1. 앱을 열면 **처음 설정** 화면 → 관리자 이름/아이디/비밀번호 입력 (최초 1회만 가능)
2. **관리 → 설정**에서 쇼핑몰 이름, 통화, 직원 권한 설정
3. **관리 → 사용자**에서 직원 계정 추가 (권한: 사용자)
4. **상품 → ＋ 상품**으로 하나씩 추가하거나, **관리 → 데이터 → CSV 가져오기**로 한꺼번에 추가

### CSV 형식

엑셀에서 *다른 이름으로 저장 → CSV UTF-8* 로 저장하면 됩니다. 쉼표/세미콜론 구분 모두 읽습니다.
첫 줄 열 이름(한국어 또는 영어, 필요한 열만 있으면 됨):

`상품코드(sku), 상품명(name), 카테고리(category), 옵션(option), 단위(unit), 판매가(price), 원가(cost), 재고(stock), 안전재고(minStock), 위치(location), 바코드(barcode), 이미지URL(imageUrl), 메모(memo), 판매중(active)`

- 상품코드가 같은 상품이 있으면 **수정**, 없으면 **추가** (새 상품은 상품명 필수)
- 빈 칸은 기존 값을 유지
- `재고` 에 값이 있으면 그 수량으로 맞추고 `CSV 가져오기` 기록을 남김
- **현재 상품 내보내기**로 받은 파일을 엑셀에서 고쳐서 다시 가져오면 일괄 수정이 됩니다.

## 데이터 구조 (참고용)

| 탭 | 열 |
|---|---|
| Products | id, sku, name, category, option, unit, price, cost, stock, minStock, location, barcode, imageUrl, memo, active, createdAt, updatedAt |
| Movements | id, time, productId, sku, productName, type(IN/OUT/ADJUST/CANCEL), qty(±), before, after, userId, userName, note, refId, canceled |
| Users | id, username, name, role(admin/user), passwordHash, active, createdAt, lastLogin |
| Categories | name, sort |
| Settings | key, value |

## 테스트

```bash
cd inventory/tools
node test_gas.js   # 가짜 Google 서비스 위에서 백엔드 전체 동작 (권한, 입출고, 취소, CSV, 카테고리 등)
node test_ui.js    # Playwright 로 실제 앱 화면 조작 (관리자/사용자 흐름, 다크 모드, 오프라인)
```

## 참고

- 서버 시간대는 `appsscript.json` 의 `Europe/Paris` 입니다. 다른 곳이면 `timeZone` 을 바꾸세요.
- 스프레드시트 한 개로 상품 수천 개, 기록 수만 건까지 무리 없이 동작합니다. 대시보드는 최근 기록 5000건만 읽습니다.
- Apps Script 응답은 보통 1~3초 걸립니다. 앱은 마지막 데이터를 먼저 보여주고 뒤에서 새로고침합니다.
- 바코드 스캔 버튼(▥)은 카메라 바코드 인식을 지원하는 브라우저(Android Chrome 등)에서만 보입니다.
