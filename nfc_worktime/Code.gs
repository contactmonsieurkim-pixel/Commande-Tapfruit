const FOLDER_ID = "1YmCPvxaWF6sv61p94Iyt0B3VLzlZDGUJ"; 
const SECRET_KEY = PropertiesService.getScriptProperties().getProperty("SECRET_KEY"); // 파이썬으로 태그에 넣을 16자리 암호와 동일해야 함

function doGet(e) {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Work time log with NFC system')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// 프론트엔드에서 호출되는 메인 처리 함수
function processNfcLog(name, action, uid, ctr, cmac) {
  // 1. 암호 검증 (의사 코드 - 실제 구현 시 CryptoJS 활용)
  // const isValid = verifyCMAC(SECRET_KEY, uid, ctr, cmac);
  // if (!isValid) return { success: false, errorMsg: "This is a false tag." };
  
  // 2. 카운터 검증 (복사된 이전 링크 사용 방지)
  // if (isCounterReused(uid, ctr)) return { success: false, errorMsg: "This CODE had been already used. Try Again." };

  // 3. 프랑스 파리 시간 기준 설정
  const dateObj = new Date();
  const monthFileName = Utilities.formatDate(dateObj, "Europe/Paris", "yyyy-MM"); // 예: 2026-09
  const dateStr = Utilities.formatDate(dateObj, "Europe/Paris", "MM-dd");         // 예: 09-23
  const timeStr = Utilities.formatDate(dateObj, "Europe/Paris", "HH:mm");         // 예: 09:30
  
  // 4. 구글 시트 파일 찾기 또는 생성
  const folder = DriveApp.getFolderById(FOLDER_ID);
  const files = folder.searchFiles(`title = '${monthFileName}' and mimeType = '${MimeType.GOOGLE_SHEETS}'`);
  let ss;
  if (files.hasNext()) {
    ss = SpreadsheetApp.open(files.next());
  } else {
    ss = SpreadsheetApp.create(monthFileName);
    DriveApp.getFileById(ss.getId()).moveTo(folder);
  }

  // 5. 사용자 이름의 시트 찾기 또는 생성
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
  }

  // 6. 데이터 입력 (날짜 / 시간 / 내용)
  sheet.appendRow([dateStr, timeStr, action]);

  return { success: true, date: dateStr, time: timeStr, action: action };
}
