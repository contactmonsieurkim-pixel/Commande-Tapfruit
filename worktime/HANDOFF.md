# 인수인계 메모 (새 세션은 이 파일부터 읽기)

> 마지막 정리: 2026-10-10 · Chat(단체 채팅) 추가
> 설치·사용법은 `README.md`, 이 파일은 **구조 · 결정한 이유 · 작업 방식 · 남은 일**.

## 1. 한눈에 보기

monsieur Kim(파리 레스토랑) 직원용 시스템. 세 덩어리:

| 부분 | 위치 | 역할 |
|---|---|---|
| NFC 태그 (NTAG 424 DNA ×2: START, END) | 가게 벽 | 폰을 대면 서명된 1회용 URL 을 염 |
| PWA (앱 이름 **monsieur Kim**) | `worktime/index.html` → GitHub Pages `https://contactmonsieurkim-pixel.github.io/Commande-Tapfruit/worktime/` | 출퇴근 결과, 공지, Our Rules, Chat, Request, 관리자 화면 |
| 서버 | Google Apps Script 프로젝트 "Work Time Log with NFC" (`worktime/gas/*.gs`), `/exec` URL 은 `index.html` 의 `API_URL` | JSON API, 시트 기록, 메일, 웹 푸시, 트리거 |

데이터는 모두 Drive 폴더 **Work Time Log with NFC** 안:
- `yyyy-MM` 월별 시트 → 직원 이름 탭 → `DATE | TIME | Info(START/END) | Modify`
- **WorkTime Config** → `Employees` 탭: `Name | PIN | Active | Email | Admin | Team | Supervisor | Transport receipt` (A~H, H 빈칸=대상, FALSE=제외)
- **Announcement Records** (보호 + HMAC 체인): `Announcements`, `Confirmations`, `Notifications`, `Logins`, `Our Rules`, `Requests`, `Deleted`, `Receipts`, `Receipt Mails`, `Chat`
- `Transport Receipts` 폴더 (영수증 `이름 yyyy-MM.jpg`, 회계사에게 보내면 휴지통으로)
- `Announcement Photos` 폴더 (비공개, 앱에는 API 로 base64 전달)

## 2. 서버 파일 (Apps Script 에 같은 이름으로 9개 + appsscript.json)

| 파일 | 내용 | `setup` 잘림 검사 표식(파일 마지막 함수) |
|---|---|---|
| `Code.gs` | 상수(맨 위 `DEFAULT_FOLDER_ID`, `TZ`, `props_`), `setup`, `doPost` 라우터, 로그인, 출퇴근(`tap_`), 시간변경(`modify_`), 직원 명단 | `json_` + 맨 위 변수 |
| `Crypto.gs` | 순수 JS AES-128 / CMAC, `verifySun_` (NTAG 424 SUN 검증) | `verifySun_` |
| `WebPush.gs` | 순수 JS P-256(BigInt), ECDSA(VAPID ES256), ECDH, AES-GCM, RFC 8291 암호화, `sendWebPush_` | `sendWebPush_` |
| `Announce.gs` | 기록 시트·해시 체인, 공지, 수신 대상(팀/개인), 알림(`notify_`), 조용한 시간, `morningRun` | `morningRun` |
| `Supervisor.gs` | Supervisor 알림(출퇴근 즉시 / 로그인은 밤에 보류), 로그인 기록, Request | `recordLogin_` |
| `Rules.gs` | Our Rules (번호, 버전, 이관, 확인, 수정) | `announceRule_` |
| `Schedule.gs` | 스케줄 시트 읽기(주 단위), 주별 읽고 동의(내용 지문), 2주 전 화요일 알림, 변경 감지 | `checkSchedule` |
| `Receipts.gs` | 교통카드 영수증: 업로드·삭제·보기, 1~5일 알림, Supervisor 현황, 회계사 메일(미리보기 → Confirm) | `notifyReceipts_` |
| `Chat.gs` | 단체 채팅(전체 방 + 팀별 방): 메시지·사진·삭제·알림 끄기, 방별 캐시, 모아서 보내는 푸시(`chatPushRun`) | `chatPushRun` |

API 액션(`doPost` 의 `action`): `login me tap modify pushKey subscribe anns photo confirm post status staff rules ruleConfirm rulePhoto ruleEdit request requests schedule scheduleConfirm team annDelete receipt receiptUpload receiptDelete receiptFile receiptStatus receiptSend chat chatSend chatDelete chatPhoto chatMute`

스크립트 속성: `SDM_META_KEY`, `SDM_FILE_KEY`(태그 키, 사람이 넣음) · 나머지는 자동: `CONFIG_SHEET_ID ANN_SHEET_ID PHOTO_FOLDER_ID RECEIPT_FOLDER_ID ACCOUNTANT_EMAIL RECEIPT_NOTIFIED LOG_KEY VAPID_* ANN_SEQ RULE_SEQ RULES_MIGRATED NOTIFY_QUEUE SUP_QUEUE CHAT_SEQ CHAT_VER_<방> CHAT_PUSH_AT chatr_<이름> chatn_<이름> chain_<시트> tok_<토큰> push_<해시> ctr_<UID>`

트리거: `scheduleMorning`(매일 07시대) → 그날 09:00 정각 1회용 `morningRun` 예약. `checkScheduleChanges`(30분마다, 조용한 시간엔 건너뜀).
`chatPushRun`: 채팅 메시지가 오면 약 1분 뒤 1회용으로 자동 예약(동시에 하나만, 자기 자신을 지움). setup 에서 만들 필요 없음.

## 3. 주요 결정과 이유 (바꾸기 전에 읽기)

**NFC / 출퇴근**
- 태그 URL `…/worktime/?p=<암호화 UID+카운터>&a=START|END&c=<CMAC>`. `a=` 도 MAC 범위에 포함 → START↔END 위조 불가. 서버가 태그별 카운터를 기억해 **복사 링크 재사용 차단**.
- 태그 키(`keys.json`)는 레포 밖(사장님 Mac `worktime/tools/keys.json`, gitignore). **레포는 public** — 비밀값 커밋 금지.
- 출퇴근 결과 화면: 저장 중에도 랜덤 규칙 팁, 하단 고정 버튼 하나(미확인 있으면 *I have read and understood*, 없으면 *Close*). 같은 자리·같은 모양 = 습관화 목적(사장님 요청).
- Close: Android 는 탭이 닫힘, iPhone 은 막혀서 "Done" 화면.

**로그인**
- 이름 + PIN. **로그아웃 버튼 없음**(남의 이름으로 바꿔 찍기 방지). localStorage + IndexedDB 이중 저장.
- iPhone 은 홈 화면 앱과 Safari 저장공간이 분리 → **로그인 2번 필요(정상)**. Supervisor 의 "New login … device #2" 알림도 그래서 정상.
- 퇴사/차단 = 시트에서 Active `FALSE`.

**공지 · Our Rules**
- 공지와 룰은 **알림·화면·기록이 분리**. 룰은 `Rule-001` 번호, 수정 시 새 버전 행 추가(덮어쓰기 없음), 대상자 **재확인 필요**, 이전 내용은 작게 표시.
- 확인 화면: 미확인만 하나씩(집중 모드) → 다 확인해야 지난 목록. 앱을 열면 **메인 화면 먼저**(공지 창 자동 진입은 압박감 때문에 제거). 알림·메일 링크로 들어온 경우만 바로 해당 화면.
- 공지·Our Rules 목록(다 확인한 뒤)은 **제목만, 눌러서 펼침**(사진은 펼칠 때 받음, 앱 복귀로 다시 그려도 펼친 것 유지) + 왼쪽 아래 떠 있는 **← Back** = 메인 화면.
- **← Back** 은 메인 외 모든 화면(공지·룰 확인 중 포함, 확인 버튼 위)에 늘 떠 있음, 반투명(`--fab-bg`). 예전 'Later' 버튼은 Back 으로 대체. 스케줄에서 연 Request 의 Back 은 스케줄로.
- 확인은 사람당 1회 기록(브라우저든 앱이든). 앱은 다시 열릴 때 서버에서 새로고침.
- 업로더 이름은 **앱·메일에서 숨김**, 기록 시트에는 남김(감사용).
- **공지**: 게시 시점의 대상자만 확인 대상. 나중에 온 직원도 지금 대상(전체/팀/개인)에 해당하면 지난 공지를 **읽을 수는 있음**(확인 요청 없음, `mustConfirm: false`). Supervisor 는 모든 공지를 봄.
- **룰**: 확인 대상 = 저장된 받는 사람 + 지금 대상에 해당하는 재직자(`ruleTargets_`) → **새로 온 직원도 모든 룰을 확인**해야 함(09:00 리마인더·관리자 현황에도 포함). 로그인 직후 확인 안 한 룰이 있으면 홈 대신 바로 Our Rules.
- 순서: 룰은 번호순(기록), 공지는 최신이 위(현장성).
- 공지 삭제 = Supervisor 전용(펼친 공지 아래 *Delete announcement*). 기록 시트 행은 그대로 두고 **Deleted** 탭(HMAC 체인)에 한 줄 추가 → 앱·알림·현황에서 사라짐.
- 관리자도 대상자면 자기 글을 확인해야 함(그대로 둠, 사장님이 바꾸길 원하면 "작성자 자동 확인" 추가).
- 메일: 버튼 **Go to Confirm 하나만 맨 위**, 끝에 메일마다 다른 `Ref` 줄 → Gmail 이 반복으로 접는 것 방지.

**알림 시간**
- 파리 **23:00–09:00 조용한 시간**: 공지·룰 푸시/메일, 로그인 알림은 09:00 정각에 모아서. 예외: **Supervisor 출퇴근 알림, Request 는 즉시**.
- 09:00 에 한 사람당 공지 메일 1통 + 룰 메일 1통(+ 각 푸시) 으로 합침.
- Apps Script 하루 트리거는 1시간 안 아무 때나 → 07시 트리거가 09:00 정각 1회 트리거를 예약하는 구조.
- 출퇴근 알림 제목은 `🟢 START · 이름` / `🔴 END · 이름` (iPhone 이 제목 끝을 자르므로 앞에 둠).

**기록 무결성**
- 기록 시트는 보호 + 행마다 직전 행과 이어지는 HMAC. 소유자 편집은 Google 이 막을 수 없으므로 "막기"가 아니라 "드러나게". 관리자 화면 경고 / 편집기에서 `verifyRecords`.
- 시트 구조를 바꿀 때 **기존 행·열을 건드리지 말 것**(체인이 깨짐). 예: 수신 대상은 새 열 대신 Type 칸에 ` · Teams: …` 로 덧붙임.

**현재 상태 (오른쪽 위 아이콘 · Team status)**
- 오른쪽 위 = 마지막 출퇴근 기록: START → 초록 시계(바늘 회전) *Now working* + `In 09:02`, END → 회색 달 *Off duty* + `Out 18:31`, 기록 없음 → 점선 원. 오늘이 아니면 `yesterday`/`Thu 8 Oct` 를 붙임. 누르면 상세(시간 변경 요청 포함).
- START 뒤 16시간이 지나도 END 가 없으면 주황 `!` *No clock-out?* (퇴근 태그 잊음).
- 기준은 시트(이번 달, 없으면 지난달; 마지막 20줄 중 START/END 인 마지막 줄). 시간은 **기록된 시간**, Modify 열 값은 "Change requested" 로 따로 표시.
- 직원 화면은 `me` 에 실려 오고 10분 캐시(`clk_<이름>`, 태그·시간 변경 때 즉시 갱신). 폰에도 `wt_clock` 저장 → 앱을 열자마자 표시.
- Supervisor(G열) 전용 홈 버튼 **Team status** (`team` 액션): 매번 시트에서 새로 읽음. Working / No clock-out? / Off duty / No record yet 순, 근무 중엔 경과 시간.
- 시트를 손으로 고친 것은 Team status 에는 바로, 직원 본인 화면에는 최대 10분 뒤 반영.

**메인 화면 = 앱 아이콘** (2026-10-10)
- 버튼 목록 대신 3열 아이콘 그리드: Announcements · Our Rules · Schedule · Pass receipt · Request (+ 관리자면 **Manager 폴더**).
- 확인할 것이 있으면 아이콘 오른쪽 위 빨간 숫자 배지(예전 "채워진 버튼" 대신). 영수증 1~5일 미제출 = 파란 점 + 아이콘 아래 `by 5 October`.
- **Manager 폴더**(iPhone 폴더처럼, 눌러서 열고 바깥을 누르면 닫힘): Admin(E열) → *Post & status*(예전 Manager 화면), Supervisor(G열) → *Requests inbox* · *Team status* · *To accountant*. 안에 보이는 앱이 하나도 없으면 폴더 자체가 안 보임(`syncManager`). 폴더 아이콘은 안에 든 앱을 작게 2×2.
- 버튼 id(`b-anns` 등)와 동작은 그대로 — 화면만 바뀜.

**Chat (단체 채팅)** (2026-10-10)
- 방 = **Everyone + 팀별 방**(Employees F열 Team 값마다 자동). 직원은 Everyone + 자기 팀, Supervisor 는 모든 팀 방(자기 팀 아닌 방은 처음에 알림 꺼짐). 1:1 대화 없음.
- 글(1000자) + 사진 1장, 내 글 삭제(Supervisor 는 모든 글 삭제 가능 = 관리용). 삭제는 기록 시트 행을 남기고 `Deleted` 탭에 `C000123` 한 줄. 읽음 표시·입력 중 표시·답장/반응은 없음(필요하면 나중에).
- 실시간이 아님: Apps Script 는 서버가 먼저 보낼 수 없어 화면이 **방 5초 / 방 목록 15초마다** 새 메시지를 물어봄(화면이 보일 때만). 보내기 1~2초.
  서버는 방마다 최근 100개를 CacheService 에 둠(`chat_t_<방>`, `CHAT_VER_<방>` 으로 낡았는지 판단, 없으면 시트 끝 3000줄에서 다시 만듦). 더 오래된 것은 *Earlier messages* 로 시트에서.
- 읽음: 방을 열거나(서버가 그 방 최신 번호를 `chatr_<이름>` 에 기록) 그 방에 글을 보내면 읽은 것. 홈 Chat 아이콘 배지 = 알림을 켠 방들의 안 읽은 수(알림 끈 방은 방 목록에만 숫자).
  **처음 로그인하는 직원**은 지난 대화를 안 읽음으로 세지 않음(`chatJoin_`, 기기 0대일 때만).
- **푸시 = 모아서**: 보내는 사람을 기다리게 하지 않도록(푸시 암호화가 순수 JS 라 사람 수만큼 느림) 메시지마다 보내지 않고 약 1분 뒤 `chatPushRun` 이 사람마다 1번 요약해서 보냄
  ('💬 Kitchen' · '3 new messages · Nam KIM: …', 여러 방이면 '💬 4 new messages' + 방별 한 줄). 알림 tag `chat` → 폰에는 최신 채팅 알림 하나만 남음. 같은 사람에게 **5분에 한 번**까지(그 안의 새 메시지는 5분 뒤 한 번에). 메일은 안 보냄.
- **조용한 시간(23~9시)은 Supervisor 를 빼고 무조건 지킴**(사장님 지시): 밤에는 Supervisor 만 채팅 푸시를 받고, 나머지는 09:00 `morningRun` 에서 한 번에. 기존 알림도 같은 원칙(밤에 바로 가는 것은 Supervisor 대상 출퇴근·Request·스케줄 경고뿐).
- 방마다 오른쪽 위 종 모양 = 그 방 알림 끄기/켜기(`chatMute`). 알림 링크 `?view=chat&room=team%3AKitchen` → 그 방으로 바로.
- 폰 저장: `wt_chat_v1`(방 목록 + 방마다 최근 60개) → 열면 바로 보이고 뒤에서 갱신. 컴퓨터(마우스)에서는 Enter = 보내기, 폰은 Enter = 줄바꿈.
- 무결성: Chat 도 HMAC 체인이라 관리자 화면의 `verifyRecords` 대상. 메시지가 아주 많아지면(수천 줄) 그 검사가 느려질 수 있음 → 그때는 Chat 을 검사에서 빼거나 월별로 나누는 것을 검토.

## 4. 작업 방식 (사장님과 합의된 흐름)

- 사장님: 한국어, Mac + iPhone(Chrome/Safari), Supervisor = **Kim namheon**.
- **PR 은 요청할 때만** 만든다. 작업 브랜치는 세션마다 지정됨(Chat 은 `claude/busy-lovelace-zyng5o`), 병합된 뒤 새 작업은 최신 `main` 에서 시작.
- 서버(.gs)가 바뀌는 변경의 배포 순서: **① Apps Script 파일 교체 → ② 필요하면 `setup` 실행 → ③ 배포 관리 → 수정 → 새 버전 → ④ 그다음 PR 병합**(화면이 새 서버를 부르기 때문).
- 파일 복사 안내는 raw 링크 + "⌘A → ⌘C" (예전에 앞/뒤가 잘려 붙은 적 있음 → `setup` 의 `checkFiles_` 가 잡아줌).
- **사장님 요청: .gs 파일을 고칠 때마다 답변 끝에 바뀐 파일 각각의 raw 링크를 항상 붙일 것** (푸시한 작업 브랜치 기준).
  형식: `https://raw.githubusercontent.com/contactmonsieurkim-pixel/Commande-Tapfruit/<커밋 SHA>/worktime/gas/<파일>.gs`
  (**브랜치 이름 대신 커밋 SHA** — raw 는 브랜치 링크를 몇 분 캐시해서 방금 푸시한 수정 전 내용이 복사된 적 있음)
  새 파일이면 "새 파일 — Apps Script 에서 ＋ → 스크립트 → 이름" 도 함께. index.html 등 화면 파일은 PR 병합으로 반영되므로 링크 불필요.
- 큰 기능은 **미리보기(아티팩트)로 먼저 보여주고 합의 후 반영**하길 원함.
- 병합 후 화면이 안 바뀌면: GitHub Pages 배포(보통 30초~수분) + iPhone 앱 캐시 → 몇 분 뒤 앱 완전 종료 후 재실행.

## 5. 테스트

```bash
cd worktime/tools
python3 test_ntag424.py                 # NXP 공식 벡터 + 가상 태그
node test_gas.js                        # 가짜 Google 서비스로 서버 전체 (현재 110개, python 의 pycryptodome 필요)
node test_webpush.js                    # 푸시 암호를 Node crypto 와 교차검증
# 푸시 복호화까지: npm install http_ece 후 HTTP_ECE_PATH=<경로>/node_modules/http_ece 로 실행
```
- `test_gas.js` 의 테스트 시계는 파리 정오로 고정(실행 시각 무관). `makeEnv()` 를 export 하므로 Playwright 로 `index.html` 을 띄우고 `https://script.google.com/**` 요청을 `env.call()` 로 연결해 화면 테스트 가능(이 방식으로 매번 확인해 왔음).
- 이 환경(클라우드)에서는 script.google.com / github.io / 실제 푸시 서버 접속이 막혀 있음 → 실기기 확인은 사장님께 요청.

**Schedule**
- 스케줄은 시트에서만 수정(앱은 읽기 전용, 웹 게시 불필요 — Apps Script 가 `openById` 로 읽음, 2분 캐시). WorkTime Config `Schedules` 탭에 URL 등록.
- 주 = `Monday…Sunday` 줄 + 다음 줄 날짜로 월요일 계산. 확인 ID 에 **주 내용 지문**(글자+배경색+글자색, 두 달에 걸친 주는 두 탭 합산)을 넣음 → 확인 후 시트가 바뀌면 "다시 확인".
- 지문은 **사람별**: WorkTime Config `Schedule Colors`(Name | 칠한 Color 칸)로 칸 색 → 사람. 칸 글자 속 이름도 인정.
  내 지문 = 내 근무 칸들의 (날짜, 시간대=첫 열 라벨, 역할=요일 앞 열, 그 시간대 같은 열의 HH:MM 시작·끝, 칸 글자). 색이 없는 사람은 주 전체 지문.
  라벨 열에 쓰인 색은 디자인(배경)으로 보고 무시. 색 표 자체를 바꾸면 해당 사람들 지문도 바뀜(재확인 요청됨).
- 폰 UI: 주마다 My shifts / By day / Table. 서버가 주마다 `slots`(근무 칸 목록) 를 줌 (`weekSlots_`). 두 달에 걸친 주는 두 탭 합산.
- 문제 찾기: 편집기에서 `checkSchedule` 실행 → 실행 로그에 단계별 OK/FAIL. 서버 오류는 앱에도 `(문구 @ 파일:줄)` 로 보임(`errDetail_`).
- 날짜는 칸에 **보이는 글자**('1/10') 기준 (시트 시간대가 파리와 다르면 날짜 값이 하루 밀려 보일 수 있어서).
- 근무 칸 규칙(사장님 지정): 칸 안에 **시간이 있으면 그 사람만** 시작·끝 중 가까운 쪽을 바꿈(2개면 둘 다), 그 밖의 글자(이름 등)는 무시·표시 안 함.
  시간대 시간 = 역할(P/F/W)이 없는 줄의 시간. 라벨에 meal/break/pause/repas 가 있는 줄 = 식사 시간(🍽 로 표시). 화면엔 시간대 이름 대신 시간 + 굵은 P/F/W.
- 역할(P/F/W) = 그 줄의 라벨 열(예: 'Service Role' 열) 또는 월요일 열에 있는 대문자 1~3 글자. 보기(My shifts/By day/Table)는 모든 주에 같이 적용.
- 속도: 받은 스케줄을 폰(localStorage `wt_sch_cache_v1`)에 저장 → 열면 바로 표시 + 뒤에서 갱신, 다른 팀·달은 뒤에서 미리 받음. 1분 안 것은 서버에 안 물음. 앱으로 돌아올 땐 항상 새로, 알림·메일 링크(?view=schedule)로 들어오면 저장 화면 없이 새로. 서버 쪽 C(미리 계산)·D(설정 캐시)는 아직.
- 주마다 작은 팀 버튼(Kitchen/Service) — 모든 주에 같이 적용, 같은 달·같은 주 자리 유지. My shifts 의 그날 줄(Off 포함)을 누르면 By day 그날.
- 역할이 하나도 없는 스케줄(Service)은 P/F/W 자리를 아예 안 그림. 16:30 부터 시작하는 근무는 짙은 바탕, 그 전은 흰 바탕.
- 화면 튐 방지: 다시 그릴 때 보고 있던 주의 위쪽 끝을 같은 자리로(holdView/keepPlace), 이미 Schedule 화면이면 맨 위로 안 올림,
  Loading/Updating 표시는 떠 있는 배지(내용을 밀지 않음), 표 확대/축소는 즉시 적용.
- 칸 글자 속 이름: 전체 이름 또는 첫 단어(하이픈 포함 한 덩어리)만. 하이픈을 쪼개면 'LIN hsin-yu' 의 'yu' 가 'Yu-hsuan CHEN' 으로 잡혔음.
- 화면: 탭 전환 즉시 Loading…(한 번 본 화면은 메모리에서 바로), My shifts 의 오늘 줄 강조 + 떠 있는 Today 버튼.
- 한계: "Yuna off" 처럼 이름이 들어간 메모 칸도 그 사람 근무로 표시됨.
- 알림: 2주 전 화요일 09:00 부터 매일 리마인더(공지와 같은 방식). 변경은 30분 검사 + "한 번 더 같게 보일 때" 발송(편집 중 연속 알림 방지), 같은 변경은 1번.
- 직원의 변경 요청 = Request(`topic: 'schedule'`), 별도 기록 시트 없음.

**교통카드 정기권 영수증 (TCL)** — 사장님 결정: "안 올리면 그 사람 손해, 회사엔 차이 없음" → 알림은 가볍게
- 그달 1~5일(`RECEIPT_DUE_DAY`)에 **그달** 정기권 영수증(지난달 영수증은 갖고 있는 사람이 드물어서). 5일 이후 업로드도 그대로 받음(`late` 기록, 직원에겐 5일 이후에 올린 뒤에만 노란 안내로 기간만 담담하게 — 사장님 태도: '올리면 본인 이득, 안 올리면 본인 손해', 부탁·🙏·'thank you' 금지(사용자는 손님이 아니라 직원: '✓ Uploaded.' 정도로 사실만), 다음 발송 때 같이 감). 5일 마감은 사람을 움직이게 하려는 것(사장님: 10월 영수증은 11월에 회계사 → 11월 월급에 반영).
- 알림: 1일 09:00 `morningRun` 에서 **메일만** 1통(`RECEIPT_NOTIFIED` 중복 방지). 앱에서는 1~5일 미제출이면 메인 버튼 **파란색**(빨강은 의무 느낌이라 X). 출근 도장 화면 카드·푸시 없음.
- 업로드 화면에 "정기권 50% 가 월급에 포함되어 지원" 설명.
- 회계사 메일: 표는 이름 + 제출 여부(Yes/No)만, 영수증 첨부. 보내는 사람 고정 `SENDER_EMAIL = contact.monsieurkim@gmail.com` — MailApp 은 배포한 계정으로 나가므로 `checkSender_` 가 다르면 거절. replyTo 도 같은 주소.
  `receiptSend` 를 confirm 없이 부르면 미리보기, confirm 때 `expect` 가 다르면 `CHANGED`. 보낸 파일은 Drive 휴지통(Gmail 보낸편지함에 남음), 다시 보내면 안 보낸 것만.

## 6. 남은 일

**조직도 (보류 중, 다음 세션 후보)**
- 미리보기: https://claude.ai/artifact/KUUmYjuszTMaXc754D75b7 (원본: 세션 scratchpad 에만 있음, 필요하면 위 링크를 읽어서 시작)
- 합의된 것: WorkTime Config 에 **Org Chart** 탭 `Position | Reports to | Person | Team` (포지션 중심, 공석 가능, 행 순서 = 화면 순서, Reports to = 위 직책 이름) · **세로 트리** · 내 위치 강조 · 눌러서 상세(사진·이름·직책·팀) · 공석 표시 · 프로필 사진(Drive `Profile Photos/이름.jpg`) · **시트에서만 수정**. 직속 상사/부하 목록은 지금은 불필요(회사가 크면 추후).
- 아직 안 정한 것: 카드 정보량·크기, 팀 색, 처음에 전부 펼칠지, 버튼 이름("Our Team"?).

**알려진 한계 / 아이디어**
- 실기기 확인 현황: PR #9(앱 재개 시 새로고침, 메일·앱 중복 확인 해결)와 PR #10(로고 = 홈) 모두 사장님이 iPhone 에서 동작 확인.
- 로그아웃이 없어도 사이트 데이터 삭제/다른 폰으로 다른 이름 로그인은 가능 → PIN 비밀 유지가 핵심, Supervisor 로그인 알림으로 감시.
- Request 에 사진 첨부, Supervisor 답장 기능 없음.
- 작성자 자동 확인 처리 안 함(위 3 참고).
