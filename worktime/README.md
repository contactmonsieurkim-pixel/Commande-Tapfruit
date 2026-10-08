# Work Time Log with NFC (NTAG 424 DNA)

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
   - 이름은 바꾸지 마세요. (기록이 이름으로 연결됩니다)
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
3. Android: 홈 화면에 추가(설치)하면 태그를 찍을 때 앱으로 열립니다.
   iPhone: 태그는 항상 **Safari**로 열리므로 Safari에서 한 번 로그인해 두면 됩니다.
   (iPhone은 홈 화면 앱과 Safari가 로그인 정보를 공유하지 않습니다)

## 공지사항 · 읽음 확인

```
관리자 (PWA "Manager: announcements") ── 제목/내용/사진 게시
   │
   ├─▶ 모든 재직 직원에게 동시에: 웹 푸시 "I have an unread announcement !" + 메일
   ├─▶ 매일 10:00 (파리): 확인 안 한 사람에게만 푸시 + 메일 하루 1통 (확인할 때까지)
   └─▶ 직원이 NFC 태그 저장 후, 확인 안 한 공지가 있으면 자동으로 공지 화면 → "I have read and understood" 1번 클릭
```

- 확인한 사람은 출퇴근 로그인 정보(각 폰에 저장된 이름)로 기록됩니다.
- 게시 시점의 재직 직원이 대상입니다. 이후 입사자는 예전 공지를 받지 않습니다.
- 기록: Drive `Announcement Records` 스프레드시트
  - `Announcements`: ID, 게시 일시, 게시자, 제목, 내용, 사진(Drive 링크), 대상자
  - `Confirmations`: 공지 ID, 제목, 이름, 확인 일시(초 단위)
  - `Notifications`: 푸시/메일을 언제 누구에게 보냈고 결과가 어땠는지
  - 사진 원본은 `Announcement Photos` 폴더 (비공개, 앱에서 로그인한 직원에게만 전달)
- **수정 방지**
  - 모든 시트가 보호되어 있고, 시스템(스크립트)만 기록합니다. 이 스프레드시트는 아무에게도 편집 권한으로 공유하지 마세요. 보기 권한만 주세요.
  - Google 은 파일 소유자의 편집을 막을 수 없습니다. 그래서 각 행에 직전 행과 이어지는 서명(Hash)을 남깁니다.
    누군가 셀을 고치거나 행을 지우면 관리자 화면에 `⚠ Records were changed outside the system`이 뜹니다.
    편집기에서 `verifyRecords`를 실행하면 몇 번째 행인지 알려줍니다.

### 알림 켜기 (직원 폰, 1회)

- **iPhone (iOS 16.4 이상)**: Safari/Chrome에서 PWA 주소 열기 → 공유 → **홈 화면에 추가** →
  홈 화면의 Work Time 앱 실행 → 로그인 → **Turn on notifications** → 허용.
  (iPhone은 홈 화면 앱에서만 웹 푸시를 받을 수 있습니다)
- **Android**: Chrome에서 로그인 → **Turn on notifications** → 허용.
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
