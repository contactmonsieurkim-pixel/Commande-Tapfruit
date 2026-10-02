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
   `gas/Code.gs`, `gas/Crypto.gs`를 붙여 넣습니다. (`Index.html`은 삭제)
2. 프로젝트 설정 → "appsscript.json 표시" 체크 → `gas/appsscript.json` 내용으로 교체
3. 프로젝트 설정 → 스크립트 속성에 추가:
   - `SDM_META_KEY` = genkeys 출력값
   - `SDM_FILE_KEY` = genkeys 출력값
4. 편집기에서 `setup` 함수를 한 번 실행합니다. (권한 승인)
   폴더 안에 `WorkTime Config` 시트가 생깁니다. `Employees` 탭에 직원 이름 / PIN 을 입력하세요.
   퇴사자는 Active 를 `FALSE` 로 바꾸면 바로 로그인이 막힙니다.
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

## 테스트 (리더기 없이)

```bash
cd worktime/tools
python test_ntag424.py   # NXP AN12196 공식 벡터 + 가상 태그로 program/read/reset
node test_gas.js         # 가상 Google 서비스로 로그인/태그/재사용 차단/시간 변경
```

## 참고

- 자정을 넘기는 근무는 END 가 다음 날짜(월말이면 다음 달 파일)에 기록됩니다.
- 서버 시간대는 `Europe/Paris` 고정입니다.
