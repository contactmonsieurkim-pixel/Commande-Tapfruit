# Work Time Log with NFC (NTAG 424 DNA)

> 개발을 이어서 할 때는 먼저 [`HANDOFF.md`](HANDOFF.md) (구조 · 결정한 이유 · 작업 방식 · 남은 일)를 읽으세요.

직원이 자기 폰으로 START / END NFC 태그를 찍으면, 파리 시간 기준으로
Google Drive `Work Time Log with NFC` 폴더의 월별 시트(`2026-10`)에 직원 이름별 탭으로 기록됩니다.

| DATE  | TIME  | Info  | Modify |
|-------|-------|-------|--------|
| 10-02 | 09:31 | START |        |
| 10-02 | 17:58 | END   | 18:30  |

## 구조

```
NTAG 424 태그 ──(폰이 URL 열기)──▶ PWA (GitHub Pages, worktime/index.html)
  URL: .../worktime/?p=<암호화 UID+카운터>&a=START&c=<CMAC>
                                   │  fetch POST
                                   ▼
                     Apps Script (worktime/gas)  ── 검증 ──▶ Google Sheets
```

- **복사 링크 재사용 차단**: 태그는 읽힐 때마다 카운터를 1 올리고 `p`(암호화된 UID+카운터)와
  `c`(CMAC 서명)를 새로 만듭니다. 서버는 태그별 마지막 카운터를 기억해서 같거나 작은 값은 거부합니다.
  비밀키 없이는 유효한 `c`를 만들 수 없고, `a=START/END`도 서명 범위에 포함되어 바꿀 수 없습니다.
- **로그인**: 직원 명단 시트(이름 + PIN)로 폰에서 한 번 로그인하면 그 폰의 브라우저에 기억됩니다.
- **시간 변경 요청**: 태그 후 1시간 안에 *Request time change*를 누르면 안내문을 보여준 뒤
  입력한 시간을 `Modify` 열에 기록하고 노란색으로 표시합니다. 원래 시간은 그대로 남습니다.

## 준비물

- NTAG 424 DNA 태그 2개 (START용, END용)
- PC/SC USB NFC 리더기 1개 (예: **ACS ACR1252U** 권장, ACR122U도 대부분 동작)
  - 태그에 키를 심는 작업은 폰으로는 할 수 없고, PC + 리더기가 필요합니다.
- PC 에 Python 3

## 설치 순서

### 1. 비밀키 만들기 (PC, 1회)

```bash
cd worktime/tools
pip install pyscard pycryptodome
python ntag424_setup.py genkeys
```

`keys.json`이 생성되고 `SDM_META_KEY`, `SDM_FILE_KEY` 값이 화면에 표시됩니다.
**keys.json 을 USB/비밀번호 관리자 등에 백업하세요.** 이 파일을 잃어버리면 태그를 재설정할 수 없습니다.
(이 레포는 공개 저장소입니다. keys.json 은 .gitignore 에 등록되어 있으니 절대 커밋하지 마세요.)

### 2. Apps Script 백엔드

1. 기존 "Work Time Log with NFC" Apps Script 프로젝트를 열고 기존 코드를 지운 뒤
   `gas/` 의 `.gs` 파일 4개(`Code`, `Crypto`, `WebPush`, `Announce`)를 같은 이름으로 붙여 넣습니다.
   (`Index.html`은 삭제. 파일 끝까지 복사됐는지는 `setup` 실행 시 자동으로 검사합니다)
2. 프로젝트 설정 → "appsscript.json 표시" 체크 → `gas/appsscript.json` 내용으로 교체
3. 프로젝트 설정 → 스크립트 속성에 추가:
   - `SDM_META_KEY` = genkeys 출력값
   - `SDM_FILE_KEY` = genkeys 출력값
4. 편집기에서 `setup` 함수를 실행합니다. (권한 승인. 여러 번 실행해도 안전)
   폴더 안에 `WorkTime Config`, `Announcement Records` 시트가 생깁니다.
   `Employees` 탭: `Name | PIN | Active | Email | Admin`
   - 퇴사자는 Active 를 `FALSE` 로 바꾸면 바로 로그인이 막히고 알림도 가지 않습니다.
   - Email: 공지 메일을 받을 주소. Admin: 공지를 올릴 수 있는 관리자는 `TRUE`.
   - Team: `Kitchen`, `Service` 등 팀 이름. 공지를 팀 단위로 보낼 때 사용합니다. (비워 두면 '전체'나 '개인 선택'으로만 받음)
   - 이름은 바꾸지 마세요. (기록이 이름으로 연결됩니다)
   - Supervisor: `TRUE` 인 사람 폰(🔔 알림을 켠 기기)에 **출퇴근할 때마다**(누가·몇 시·START/END)와
     **직원이 새 기기에서 로그인할 때마다** 웹 푸시 알림이 갑니다. Supervisor 는 관리자 권한도 가집니다.
     여러 명 지정 가능, 바꾸려면 TRUE 를 옮기기만 하면 됩니다.
   - **직원 추가·퇴사·PIN·팀·Admin·Supervisor 변경은 시트만 고치면 바로 적용됩니다. 재배포 필요 없음.**
     재배포는 `.gs` 코드를 바꿨을 때만 필요합니다.
5. 배포 → 새 배포 → 웹 앱, 실행: **나**, 액세스: **모든 사용자** → 배포 후 `/exec` URL 복사
   - 코드를 고친 뒤에는 "배포 관리 → 수정 → 새 버전"으로 재배포해야 반영됩니다. (URL 유지)

### 3. PWA (GitHub Pages)

1. `worktime/index.html`의 `API_URL`에 위 `/exec` URL 을 넣습니다.
2. 이 브랜치를 `main`에 병합하면
   `https://contactmonsieurkim-pixel.github.io/Commande-Tapfruit/worktime/` 에서 열립니다.
   (레포 Settings → Pages 가 main 브랜치 / root 로 되어 있는지 확인)

### 4. 태그 설정 (PC + 리더기)

태그를 리더기 위에 올려두고:

```bash
python ntag424_setup.py program --base https://contactmonsieurkim-pixel.github.io/Commande-Tapfruit/worktime/ --action START
# 태그 교체 후
python ntag424_setup.py program --base https://contactmonsieurkim-pixel.github.io/Commande-Tapfruit/worktime/ --action END
```

마지막에 `검증 성공 ✅`이 나오면 끝입니다. 이 명령은 다음을 수행합니다:
URL 기록 → SDM(SUN) 켜기 → NDEF 쓰기 잠금 → Key1/Key2 교체 → 마스터 Key0 교체 → 다시 읽어서 서명 검증.

- 이미 설정한 태그를 다시 `program` 해도 됩니다. (URL 변경 등)
- `python ntag424_setup.py read` : 태그를 읽어 서명 검증만
- `python ntag424_setup.py reset` : 공장 초기 상태로 되돌리기

### 5. 직원 사용법

1. 처음 태그를 찍으면 로그인 화면 → 이름 + PIN 입력 → 바로 기록됩니다.
2. 이후로는 태그만 찍으면 ✅ 화면이 뜹니다.
3. **로그아웃 버튼은 없습니다.** 한 번 로그인하면 그 폰(브라우저)에 계속 유지되어, 다른 사람 이름으로 바꿔 찍을 수 없습니다.
   로그인 정보는 두 곳(localStorage, IndexedDB)에 저장해 앱을 껐다 켜도 유지됩니다.
   관리자가 직원을 Active = `FALSE`로 바꾸면 그 폰은 다음 사용 때 로그인 화면으로 돌아갑니다.
4. Android: 홈 화면에 추가(설치)하면 태그를 찍을 때 앱으로 열립니다.
   iPhone: 태그는 항상 **Safari**로 열리므로 Safari에서 한 번 로그인해 두면 됩니다.
   (iPhone은 홈 화면 앱과 Safari가 로그인 정보를 공유하지 않습니다)

## Our Rules (규칙)

- 관리자 화면에서 **Rule** 을 선택해 올리면 `Rule-001`, `Rule-002` … 번호가 붙고, 공지와 따로 관리·알림됩니다.
  (알림 제목: "Our Rules: please read and confirm", 앱의 **Our Rules** 버튼)
- 출근 도장 화면의 팁도 Our Rules 에서 `[Rule-001] 제목` 형태로 랜덤 표시됩니다.
- **수정**: Admin 이상이 Our Rules 화면의 *Edit rule* → 저장하면 새 버전(v2, v3…)이 됩니다.
  - 룰 안에 "Updated 날짜"가 표시되고, 예전 내용은 그 아래 작게 남습니다.
  - 대상자에게 다시 알림이 가고, 다시 *I have read and understood* 를 눌러야 합니다.
  - 사진을 새로 고르지 않으면 기존 사진을 유지합니다. 대상(팀/개인)은 처음 지정한 그대로입니다.
- 기록: `Announcement Records` 의 **Our Rules** 탭(버전마다 한 줄, 서명 체인). 확인 기록은 Confirmations 탭에 `Rule-001 v2` 로.
- 예전에 공지에서 "Rule" 체크로 올린 것은 처음 한 번 자동으로 Rule-001… 로 옮겨지고, 그때 확인한 사람은 확인한 것으로 인정됩니다.
- 앱과 메일에는 올린 사람 이름이 표시되지 않습니다. (기록 시트에는 감사용으로 남음)

## 교통카드 영수증 (Transport receipt)

- 직원: 메인 화면 **Transport receipt** → 카메라로 찍기 또는 사진/PDF 선택 → Upload. 파일은 Drive `Transport Receipts` 폴더에 `이름 yyyy-MM.jpg` 로 저장.
- 대상: Employees 탭 **H열 `Transport receipt`** — 빈칸 = 대상, `FALSE` = 제외.
- 알림: 매월 **1일 09:00 메일 + 푸시 1번**. 1~5일에는 안 올린 사람에게 출근 도장 화면·메인 화면 버튼(!)에 매번 표시. 5일이 지나면 올릴 때 "반영 안 됨" 경고, `late` 로 기록.
- Supervisor: 메인 화면 **Transport receipts · accountant** → 사람별 현황(Received / Late / Missing) → 회계사 주소 입력 → **Check the email**(받는 사람·제목·표·첨부 미리보기) → **Confirm and send**.
  보낸 파일은 Gmail 보낸편지함에 남으므로 Drive 에서는 휴지통으로 옮겨짐. 회계사 주소는 기억됨(스크립트 속성 `ACCOUNTANT_EMAIL`).
- 기록: Receipts, Receipt Mails 탭.

## Request (직원 → Supervisor)

- 모든 직원이 앱의 **Request** 로 Supervisor 에게 직접 요청·고민을 보낼 수 있습니다. 공개되지 않습니다.
- Supervisor 폰에 **밤낮 상관없이 바로** 푸시("✉️ Request · 이름") + 메일이 갑니다.
- Supervisor 는 앱의 **Requests inbox** 에서 모두 볼 수 있습니다. 기록: Requests 탭.

## Schedule (주간 스케줄 · 읽고 동의)

- **수정은 Supervisor 가 스프레드시트에서 직접.** 앱은 읽기 전용이고, 웹 게시(Publish to web)는 필요 없습니다.
  앱이 Apps Script 로 시트를 바로 읽어 옵니다(시트 수정이 앱에 보이기까지 최대 2분).
- 연결: `WorkTime Config` 의 **Schedules** 탭(`setup` 이 만듦)에 한 줄씩:
  `Name | Spreadsheet | Team` → 예: `Kitchen | https://docs.google.com/spreadsheets/d/…/edit | Kitchen`
  - Spreadsheet 는 URL 그대로 붙여 넣으면 됩니다. 이 Apps Script 를 배포한 계정(사장님 계정)이 열 수 있어야 합니다.
  - 새 분기 파일을 만들면 **같은 Name 으로 한 줄 더** 추가 → 앱에서 모든 파일의 달 탭이 이어서 보입니다.
  - Team: 확인해야 하는 팀(쉼표로 여러 개, 비우면 전체). Supervisor 는 확인 대상이 아닙니다(작성자).
- 앱에서 직원이 볼 수 있는 달은 **이번 달과 다음 달**뿐입니다(버튼: October / November). 지난 달은 시트에서만.
- 시트 모양: 탭 하나 = 한 달(탭 이름 `10`, `09` …). `Monday … Sunday` 줄에서 한 주가 시작하고, 바로 아래 줄이 날짜.
  색·굵게·병합·숨긴 열이 그대로 보입니다. 두 달에 걸친 주는 어느 탭에서 확인해도 같은 주로 기록됩니다.
- **확인 요청**: 각 주를 **2주 전 화요일**(예: 11월 16일 주 → 11월 3일)부터 *I have read … and I agree* 체크 + Confirm.
  그날 09:00 에 푸시 + 메일, 확인할 때까지 매일 09:00 리마인더(주가 시작되면 끝). 그 주가 시트에 아직 없으면 Supervisor 에게 알림.
- **색 = 사람**: `WorkTime Config` 의 **Schedule Colors** 탭(`setup` 이 만듦)에 `Name | Color`.
  Color 칸을 스케줄에서 쓰는 **같은 색으로 칠하기만** 하면 됩니다(또는 `#6b1f45` 처럼 글자로). Name 은 Employees 이름과 같게.
  칸 글자 속 이름(`Chris 23:00`)도 그 사람으로 봅니다. 색이 겹치지 않게 하고, 표 배경색(진한 회색 등)은 사람 색으로 쓰지 마세요.
- **폰 화면**: 주마다 세 가지 보기 — **My shifts**(내 7일: 날짜·시간·시간대·역할), **By day**(그날 누가 어디서),
  **Table**(시트 그대로, *Whole week* 로 한 화면에). 마지막에 고른 보기를 기억합니다. 색 표가 없으면 Table 만.
- **변경**: 확인한 뒤 Supervisor 가 **그 사람의 근무**(칸, 그 시간대의 시작·끝 시간, 칸 글자)를 고치면 → 그 사람만
  Schedule 버튼에 배지 + 주에
  *Changed — confirm again* 표시 + 푸시·메일 → 다시 확인해야 합니다(주가 끝날 때까지).
  다른 사람 칸만 바뀌면 나는 다시 확인할 필요 없음. (색 표에 없는 사람은 그 주의 어떤 변경이든 다시 확인)
  30분마다 검사하고, 고치는 도중에 여러 번 울리지 않도록 **바뀐 내용이 30분 이상 그대로일 때** 한 번 보냅니다.
- **직원의 변경 요청**: 각 주의 *Request a change* → Request 로 Supervisor 에게 바로(밤에도) "📅 Schedule change request · 이름".
  Supervisor 가 시트를 고치면 위의 "변경" 흐름으로 모두 다시 확인합니다.
- Admin/Supervisor 는 주마다 *Who has agreed* 에서 누가 언제 확인했는지(변경 후 재확인 안 한 사람 포함) 볼 수 있습니다.
- 기록: `Announcement Records` 의 Confirmations 탭 `Schedule · Kitchen · 2026-11-16 · <내용 지문>`.

## 공지사항 · 읽음 확인

```
관리자 (PWA "Manager: announcements") ── 제목/내용/사진 게시
   │
   ├─▶ 모든 재직 직원에게 동시에: 웹 푸시 "I have an unread announcement !" + 메일
   ├─▶ 매일 09:00 정각 (파리): 확인 안 한 사람에게만 푸시 + 메일 하루 1통 (확인할 때까지)
   └─▶ 직원이 NFC 태그 저장 후, 확인 안 한 공지가 있으면 자동으로 공지 화면 → "I have read and understood" 1번 클릭
```

- 확인한 사람은 출퇴근 로그인 정보(각 폰에 저장된 이름)로 기록됩니다.
- **조용한 시간 (파리 23:00 ~ 09:00)**: 푸시·메일을 보내지 않습니다.
  - 이 시간에 올린 공지는 바로 기록·앱에 표시되고, 알림과 메일은 **09:00 정각**에 갑니다.
  - 09:00에는 밤사이 공지 + 확인 안 한 예전 공지를 **한 사람당 메일 1통·푸시 1번**으로 합쳐 보냅니다.
  - 예외: Supervisor 의 **출퇴근 알림은 밤에도 바로** 갑니다(🟢 START · 이름 / 🔴 END · 이름).
    새 기기 로그인 알림만 모아 두었다가 09:00에 "Overnight (N)" 한 통으로 보냅니다.
  - 정확히 09:00에 보내기 위해 매일 07시대에 그날 09:00 정각 실행을 예약합니다(`scheduleMorning` → `morningRun`).
- **출근 도장 화면**: 태그를 찍는 순간 `Rule`로 게시한 규칙 중 하나가 랜덤으로 뜨고(직전과 다른 것), 저장 후에도 그대로 남습니다.
  화면 맨 아래의 큰 버튼은 항상 같은 자리·같은 모양입니다:
  확인 안 한 공지가 있으면 **I have read and understood**, 다 확인하면 **Close**(브라우저 탭 닫기).
  - 팁은 Our Rules 에서만 나옵니다. 일반 공지는 팁에 나오지 않습니다.
  - Close: Android Chrome은 태그로 열린 탭이 닫힙니다. iPhone은 브라우저가 탭 닫기를 허용하지 않아
    "Done – you can close this tab" 화면이 뜹니다. (Safari 설정 → 탭 닫기 → "1일 후"로 두면 쌓이지 않습니다)
- **수신 대상**: 게시할 때 *Everyone* 또는 *Choose teams / people*. 팀(예: Kitchen)과 개인을 섞어서 고를 수 있고,
  화면에 "Will be sent to N people: …"로 실제 받는 사람이 미리 표시됩니다.
  기록 시트 Type 칸에 `Rule · Teams: Kitchen · People: Leo` 처럼 대상이 남습니다.
- 게시 시점의 대상 직원에게만 확인 요청이 갑니다. 이후 입사자는 예전 공지를 받지 않습니다.
- 팀 대상 규칙(Rule)은 출근 도장 팁으로 그 팀 사람에게만 나옵니다. (나중에 그 팀에 들어온 사람 포함)
- 기록: Drive `Announcement Records` 스프레드시트
  - `Announcements`: ID, 게시 일시, 게시자, 제목, 내용, 사진(Drive 링크), 대상자, 종류(Rule/Notice)
  - `Confirmations`: 공지 ID, 제목, 이름, 확인 일시(초 단위)
  - `Notifications`: 푸시/메일을 언제 누구에게 보냈고 결과가 어땠는지
  - `Logins`: 누가 언제 어떤 기기(예: iPhone · Safari)에서 로그인했고, 그 사람의 몇 번째 기기인지
  - 사진 원본은 `Announcement Photos` 폴더 (비공개, 앱에서 로그인한 직원에게만 전달)
- **수정 방지**
  - 모든 시트가 보호되어 있고, 시스템(스크립트)만 기록합니다. 이 스프레드시트는 아무에게도 편집 권한으로 공유하지 마세요. 보기 권한만 주세요.
  - Google 은 파일 소유자의 편집을 막을 수 없습니다. 그래서 각 행에 직전 행과 이어지는 서명(Hash)을 남깁니다.
    누군가 셀을 고치거나 행을 지우면 관리자 화면에 `⚠ Records were changed outside the system`이 뜹니다.
    편집기에서 `verifyRecords`를 실행하면 몇 번째 행인지 알려줍니다.

### 알림 켜기 (직원 폰, 1회)

- **iPhone (iOS 16.4 이상)**: Safari/Chrome에서 PWA 주소 열기 → 공유 → **홈 화면에 추가** →
  홈 화면의 monsieur Kim 앱 실행 → 로그인 → 오른쪽 위 **🔔 종 아이콘** → 허용.
  (iPhone은 홈 화면 앱에서만 웹 푸시를 받을 수 있습니다)
- **Android**: Chrome에서 로그인 → 오른쪽 위 **🔔 종 아이콘** → 허용.
- 종에 사선이 그어져 있으면 알림이 꺼진 상태, 초록색이면 켜진 상태입니다.
- 알림을 켜지 않아도 메일은 갑니다.

## 테스트 (리더기 없이)

```bash
cd worktime/tools
python test_ntag424.py   # NXP AN12196 공식 벡터 + 가상 태그로 program/read/reset
node test_gas.js         # 가상 Google 서비스로 로그인/태그/재사용 차단/시간 변경/공지/리마인더/위변조 감지
node test_webpush.js     # 웹 푸시 암호화·서명을 Node crypto 와 교차 검증
# (선택) npm install http_ece 후 실행하면 푸시 내용을 참조 구현으로 복호화까지 검증
```

## 참고

- 자정을 넘기는 근무는 END 가 다음 날짜(월말이면 다음 달 파일)에 기록됩니다.
- 서버 시간대는 `Europe/Paris` 고정입니다.
