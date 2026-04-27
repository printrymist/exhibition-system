/**
 * Exhibition Setup Web App
 * - Deployed as a standalone GAS Web App
 * - Accessible via URL (no spreadsheet menu needed)
 * - Sends completion email to organizer
 */

// QRlikes_tot のデプロイURL（来場者が作品QRを読んだときに開く感想入力画面のURL）
const VISITOR_QR_URL = "https://rohei-printer-system.web.app/";

// マスタースプレッドシートのID
const MASTER_SS_ID = "1h0uSnoUBuQnEqWmFXIOUIRK2CvigmkOmucsWOnaS6xQ";

// =========================================================
// 🌟 ユーティリティ
// =========================================================
function colIndex(headers, name) {
  const idx = headers.indexOf(name);
  if (idx === -1) throw new Error("Column not found: " + name);
  return idx;
}

// =========================================================
// 🌟 キャッシュ管理
// =========================================================
function getCacheVersion(ex) {
  var cache = CacheService.getScriptCache();
  var version = cache.get('version_' + ex);
  if (!version) {
    version = new Date().getTime().toString();
    cache.put('version_' + ex, version, 21600);
  }
  return version;
}

function clearAllCache(ex) {
  var cache = CacheService.getScriptCache();
  cache.remove('version_' + ex);
  console.log(ex + ' のキャッシュをリセットしました。');
}

// =========================================================
// 🌟 マスターデータを取得
// =========================================================
function getMasterData(ex) {
  var cache = CacheService.getScriptCache();
  var version = getCacheVersion(ex);
  var cacheKey = 'master_data_' + ex + '_v' + version;
  var cached = cache.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const ss = SpreadsheetApp.openById(MASTER_SS_ID);
  const allData = ss.getSheetByName('exhibitions').getDataRange().getValues();
  const headers = allData[0];
  const row = allData.find((r, i) => i > 0 && r[colIndex(headers, 'ex_code')].toString().trim() === ex.toString().trim());
  if (!row) return null;

  const masterObj = {
    ex_code: row[colIndex(headers, 'ex_code')],
    image_folder_id: row[colIndex(headers, 'image_folder_id')],
    artwork_sheet_id: row[colIndex(headers, 'artwork_sheet_id')],
    comment_sheet_id: row[colIndex(headers, 'comment_sheet_id')],
    ex_name: row[colIndex(headers, 'ex_name')],
    password: row[colIndex(headers, 'password')],
    memo: row[colIndex(headers, 'memo')],
    updatedAt: new Date().getTime()
  };

  cache.put(cacheKey, JSON.stringify(masterObj), 21600);
  return masterObj;
}

// =========================================================
// 🌟 Webアプリのエントリーポイント
// =========================================================
function doGet(e) {
  const action = e.parameter.action || '';
  const token = e.parameter.token || '';

  const tmp = HtmlService.createTemplateFromFile('setup');

  // メール認証リンクからのアクセス
  if (action === 'confirm' && token) {
    const result = confirmToken(token);
    tmp.confirmedToken = result.success ? result.token : '';
    tmp.confirmError = result.success ? '' : result.error;
    tmp.exName = result.success ? result.exName : '';
    tmp.organizer = result.success ? result.organizer : '';
    tmp.email = result.success ? result.email : '';
  } else {
    // 通常アクセス（申請フォームを表示）
    tmp.confirmedToken = '';
    tmp.confirmError = '';
    tmp.exName = '';
    tmp.organizer = '';
    tmp.email = '';
  }

  return tmp.evaluate()
    .setTitle('Exhibition Setup')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function doPost(e) {
  const output = ContentService.createTextOutput();
  output.setMimeType(ContentService.MimeType.JSON);

  try {
    const action = e.parameter.action;

    if (!action) {
      output.setContent(JSON.stringify({ success: false, error: 'アクションが指定されていません。' }));
      return output;
    }

    if (action === 'submitApplication') {
      const payload = {
        exName: e.parameter.exName,
        venue: e.parameter.venue,
        startDate: e.parameter.startDate,
        organizer: e.parameter.organizer,
        email: e.parameter.email
      };
      output.setContent(JSON.stringify(submitApplication(payload)));
      return output;
    }

    if (action === 'confirmToken') {
      output.setContent(JSON.stringify(confirmToken(e.parameter.token)));
      return output;
    }

    if (action === 'runSetup') {
      const payload = {
        exCode: e.parameter.exCode,
        exName: e.parameter.exName,
        workCount: parseInt(e.parameter.workCount || '30'),
        email: e.parameter.email,
        token: e.parameter.token
      };
      output.setContent(JSON.stringify(runSetup(payload)));
      return output;
    }

    if (action === 'addArtworks') {
      const payload = {
        exCode: e.parameter.exCode,
        addCount: parseInt(e.parameter.addCount || '0')
      };
      output.setContent(JSON.stringify(addArtworks(payload)));
      return output;
    }

    output.setContent(JSON.stringify({ success: false, error: '不明なアクション: ' + action }));
    return output;

  } catch (err) {
    output.setContent(JSON.stringify({ success: false, error: err.message }));
    return output;
  }
}

// =========================================================
// 🌟 セットアップ処理（フォームから呼ばれる）
// =========================================================
function runSetup(payload) {
  try {
    const { exCode, exName, workCount, email, token } = payload;

    // トークン検証
    if (!token) {
      return { success: false, error: '認証が確認できません。メールの認証リンクから再度お試しください。' };
    }
    const appSheet = getApplicationsSheet();
    const appData = appSheet.getDataRange().getValues();
    const appHeaders = appData[0];
    const tokenIdx = appHeaders.indexOf('confirm_token');
    const confirmedIdx = appHeaders.indexOf('confirmed');
    const setupAtIdx = appHeaders.indexOf('setup_at');
    const exCodeColIdx = appHeaders.indexOf('ex_code');

    let appRowIdx = -1;
    for (let i = 1; i < appData.length; i++) {
      if (appData[i][tokenIdx].toString().trim() === token &&
        String(appData[i][confirmedIdx]).toUpperCase().trim() === 'TRUE') {
        appRowIdx = i + 1;
        break;
      }
    }
    if (appRowIdx === -1) {
      return { success: false, error: '認証が確認できません。メールの認証リンクから再度お試しください。' };
    }

    // --- 展覧会コードの重複チェック ---
    const masterSS = SpreadsheetApp.openById(MASTER_SS_ID);
    const masterSheet = masterSS.getSheetByName("exhibitions");
    const allData = masterSheet.getDataRange().getValues();
    const mHeaders = allData[0];
    const exists = allData.slice(1).some(r =>
      r[mHeaders.indexOf("ex_code")].toString().trim() === exCode
    );
    if (exists) {
      return { success: false, error: `Exhibition code "${exCode}" is already in use. Please choose a different code.` };
    }

    const masterFile = DriveApp.getFileById(MASTER_SS_ID);
    const parentFolder = masterFile.getParents().next();

    // --- フォルダ構築 ---
    const wsFolder = parentFolder.createFolder(exCode + "_WorkSpace");
    const imagesFolderId = wsFolder.createFolder("images").getId();

    // --- 作品台帳SS構築 ---
    const artworkSS = SpreadsheetApp.create(exCode + "_artworks");
    const artworkId = artworkSS.getId();
    const artworkFile = DriveApp.getFileById(artworkId);
    wsFolder.addFile(artworkFile);
    DriveApp.getRootFolder().removeFile(artworkFile);
    // 作品台帳：PRIVATE
    DriveApp.getFileById(artworkId)
      .setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);

    const aSheet = artworkSS.getSheets()[0];
    aSheet.setName(exCode + "_artworks");

    // 列構成
    const aHeader = [
      "artwork_id", "security_key", "title", "title_en", "artist", "artist_en",
      "birth_year", "death_year", "birthplace", "year", "series", "technique", "material",
      "size", "edition", "price", "price_framed", "certificate", "collection",
      "courtesy", "note", "artist_note", "image_url", "qr_url", "status",
      "insta", "x", "facebook", "web"
    ];

    const totalCols = aHeader.length;
    aSheet.getRange(1, 1, 1, totalCols).setValues([aHeader]);

    // ヘッダー行のスタイル設定
    const headerRange = aSheet.getRange(1, 1, 1, totalCols);
    headerRange.setBackground('#1a73e8');
    headerRange.setFontColor('#ffffff');
    headerRange.setFontWeight('bold');

    // 作品情報列（title〜artist_note）を水色に
    const artStartCol = aHeader.indexOf('title') + 1;
    const artEndCol = aHeader.indexOf('artist_note') + 1;
    aSheet.getRange(1, artStartCol, 1, artEndCol - artStartCol + 1).setBackground('#4a90d9');

    // システム列（image_url, qr_url, status）をグレーに
    const sysColNames = ['image_url', 'qr_url', 'status'];
    sysColNames.forEach(colName => {
      const colIdx = aHeader.indexOf(colName) + 1;
      if (colIdx > 0) aSheet.getRange(1, colIdx, 1, 1).setBackground('#888888');
    });

    let rows = [];
    for (let i = 1; i <= workCount; i++) {
      const wId = "w" + ("00" + i).slice(-3);
      const sKey = Math.random().toString(36).substring(2, 10);
      const url = `${VISITOR_QR_URL}?ex=${exCode}&id=${wId}&key=${sKey}`;
      const row = new Array(totalCols).fill("");
      row[0] = wId;
      row[1] = sKey;
      row[aHeader.indexOf("qr_url")] = url;
      row[aHeader.indexOf("status")] = "0";
      rows.push(row);
    }
    aSheet.getRange(2, 1, rows.length, totalCols).setValues(rows);

    // 非表示列
    const hideColNames = ['security_key', 'image_url', 'qr_url', 'status'];
    hideColNames.forEach(colName => {
      const colIdx = aHeader.indexOf(colName) + 1;
      if (colIdx > 0) aSheet.hideColumns(colIdx);
    });

    // artwork_id列を保護（閲覧可・編集不可）
    const artworkIdCol = aHeader.indexOf('artwork_id') + 1;
    const protection = aSheet.getRange(1, artworkIdCol, aSheet.getMaxRows(), 1).protect();
    protection.setDescription('artwork_id - 編集禁止');
    protection.removeEditors(protection.getEditors());

    // --- 感想SS構築 ---
    const commentSS = SpreadsheetApp.create(exCode + "_comments");
    const commentId = commentSS.getId();
    const commentFile = DriveApp.getFileById(commentId);
    wsFolder.addFile(commentFile);
    DriveApp.getRootFolder().removeFile(commentFile);
    // 感想シート：リンクを知っている全員が閲覧可能
    DriveApp.getFileById(commentId)
      .setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

    const cSheet = commentSS.getSheets()[0];
    cSheet.setName(exCode + "_comments");
    const cHeader = ["timestamp", "ex_code", "ex_name", "artwork_id", "title", "artist", "nickname", "like", "comment", "session_id"];
    cSheet.getRange(1, 1, 1, 10).setValues([cHeader]);
    const cHeaderRange = cSheet.getRange(1, 1, 1, 10);
    cHeaderRange.setBackground('#1a73e8');
    cHeaderRange.setFontColor('#ffffff');
    cHeaderRange.setFontWeight('bold');

    // --- exhibitions マスターに記録 ---
    const timestamp = Utilities.formatDate(new Date(), "JST", "yyyy/MM/dd, HH:mm:ss");
    const adminPass = ("0000" + Math.floor(Math.random() * 10000)).slice(-4);

    masterSheet.appendRow([
      exCode,
      imagesFolderId,
      artworkId,
      commentId,
      exName,
      adminPass,
      timestamp
    ]);

    // --- registration_fields / caption_fields の初期値を設定 ---
    const defaultActiveFields = [
      { name: 'title', required: true },
      { name: 'year', required: false },
      { name: 'technique', required: false },
      { name: 'size', required: false },
      { name: 'price', required: false }
    ];
    const defaultJson = JSON.stringify(defaultActiveFields);

    const masterHeaders = masterSheet.getRange(1, 1, 1, masterSheet.getLastColumn()).getValues()[0];

    // registration_fields
    let rfColIdx = masterHeaders.indexOf('registration_fields');
    if (rfColIdx === -1) {
      rfColIdx = masterSheet.getLastColumn();
      masterSheet.getRange(1, rfColIdx + 1).setValue('registration_fields');
    }
    masterSheet.getRange(masterSheet.getLastRow(), rfColIdx + 1).setValue(defaultJson);

    // caption_fields
    let cfColIdx = masterHeaders.indexOf('caption_fields');
    if (cfColIdx === -1) {
      cfColIdx = masterSheet.getLastColumn();
      masterSheet.getRange(1, cfColIdx + 1).setValue('caption_fields');
    }
    masterSheet.getRange(masterSheet.getLastRow(), cfColIdx + 1).setValue(defaultJson);

    // --- applications シートに ex_code と setup_at を記録 ---
    const setupAt = Utilities.formatDate(new Date(), 'JST', 'yyyy/MM/dd HH:mm:ss');
    appSheet.getRange(appRowIdx, exCodeColIdx + 1).setValue(exCode);
    appSheet.getRange(appRowIdx, setupAtIdx + 1).setValue(setupAt);

    // --- 完了メール送信 ---
    sendCompletionEmail(email, exCode, exName, adminPass);

    return {
      success: true,
      exCode: exCode,
      exName: exName,
      adminPass: adminPass
    };

  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

// =========================================================
// 🌟 完了メール送信
// =========================================================
function sendCompletionEmail(email, exCode, exName, adminPass) {
  const inputUrl = "https://rohei-printer-system.web.app/input.html?ex=" + exCode;
  const captionUrl = "https://rohei-printer-system.web.app/caption.html?ex=" + exCode;
  const registerUrl = "https://rohei-printer-system.web.app/register.html?ex=" + exCode;

  const subject = `[Exhibition Setup Complete] ${exName} (${exCode})`;
  const body = `
Your exhibition has been set up successfully!
━━━━━━━━━━━━━━━━━━━━━━━━
Exhibition Details
━━━━━━━━━━━━━━━━━━━━━━━━
Exhibition code : ${exCode}
Exhibition name : ${exName}
Admin password  : ${adminPass}
━━━━━━━━━━━━━━━━━━━━━━━━

━━━━━━━━━━━━━━━━━━━━━━━━
Exhibition Register（作品登録・項目設定）
━━━━━━━━━━━━━━━━━━━━━━━━
${registerUrl}

━━━━━━━━━━━━━━━━━━━━━━━━
Caption Manager（キャプション印刷・QR印刷）
━━━━━━━━━━━━━━━━━━━━━━━━
${captionUrl}

【手順】
1. Exhibition RegisterにアクセスしてExhibition code（${exCode}）を入力してLoadしてください。
2. 管理者パスワード（${adminPass}）を入力して認証してください。
3. 「項目設定」タブで作家が入力する項目・必須/任意を設定して保存してください。
4. 作家への案内メール（下記テンプレート）を送ってください。
5. 作家から作品情報の入力完了の連絡を受けたら、Caption ManagerでキャプションをPreview→Printしてください。
6. QR PrintタブでQRコードを印刷してください。
━━━━━━━━━━━━━━━━━━━━━━━━
【作家の方への案内テンプレート】
以下をコピーして作家の方にお送りください。
━━━━━━━━━━━━━━━━━━━━━━━━
件名：作品情報のご入力のお願い（${exName}）

この度は展覧会へのご参加ありがとうございます。
以下のURLより作品情報をご入力ください。

▼ 作品情報入力フォーム
${inputUrl}

入力の流れ：
1. 上のURLにアクセス
2. 作家名（日本語）を入力して「開始」をクリック
3. 「＋ 作品を追加」から作品を登録

ご不明な点は主催者までお問い合わせください。
━━━━━━━━━━━━━━━━━━━━━━━━
このメールは送信専用です。返信はできません。
お問い合わせは ryohei.miyagawa.art@gmail.com までご連絡ください。
━━━━━━━━━━━━━━━━━━━━━━━━
Rohei Printer System
  `;

  GmailApp.sendEmail(email, subject, body, {
    name: 'Rohei Printer System',
    replyTo: 'Rohei Printer <ryohei.miyagawa.art@gmail.com>',
    from: 'noreply.rohei.printer@gmail.com'
  });
}

// =========================================================
// 🌟 作品を追加する（後から作品数を増やしたい場合）
// =========================================================
function addArtworks(payload) {
  try {
    const { exCode, addCount } = payload;
    const master = getMasterData(exCode);
    if (!master) return { success: false, error: "Exhibition not found." };

    const ss = SpreadsheetApp.openById(master.artwork_sheet_id);
    const sheet = ss.getSheetByName(exCode + "_artworks");
    const data = sheet.getDataRange().getValues();
    const headers = data[0];

    // 現在の最終作品IDを取得
    const artworkIdCol = headers.indexOf("artwork_id");
    const lastRow = data[data.length - 1];
    const lastId = lastRow[artworkIdCol].toString();
    const lastNum = parseInt(lastId.replace("w", "")) || 0;

    const qrUrlCol = headers.indexOf("qr_url");
    const statusCol = headers.indexOf("status");
    const totalCols = headers.length;

    let newRows = [];
    for (let i = 1; i <= addCount; i++) {
      const wId = "w" + ("00" + (lastNum + i)).slice(-3);
      const sKey = Math.random().toString(36).substring(2, 10);
      const url = `${VISITOR_QR_URL}?ex=${exCode}&id=${wId}&key=${sKey}`;
      const row = new Array(totalCols).fill("");
      row[artworkIdCol] = wId;
      row[headers.indexOf("security_key")] = sKey;
      row[qrUrlCol] = url;
      row[statusCol] = "0";
      newRows.push(row);
    }

    sheet.getRange(data.length + 1, 1, newRows.length, totalCols).setValues(newRows);

    return { success: true };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

// =========================================================
// 🌟 applications シートを取得（なければ作成）
// =========================================================
function getApplicationsSheet() {
  const ss = SpreadsheetApp.openById(MASTER_SS_ID);
  let sheet = ss.getSheetByName('applications');
  if (!sheet) {
    sheet = ss.insertSheet('applications');
    const headers = [
      'timestamp', 'ex_name', 'venue', 'start_date',
      'organizer', 'email', 'confirm_token',
      'confirmed', 'ex_code', 'setup_at'
    ];
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    const headerRange = sheet.getRange(1, 1, 1, headers.length);
    headerRange.setBackground('#1a73e8');
    headerRange.setFontColor('#ffffff');
    headerRange.setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

// =========================================================
// 🌟 申請を受け付ける
// =========================================================
function submitApplication(payload) {
  try {
    const { exName, venue, startDate, organizer, email } = payload;

    // 開催日チェック（今日より後であること）
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const eventDate = new Date(startDate);
    if (isNaN(eventDate.getTime()) || eventDate <= today) {
      return { success: false, error: '開催予定日は今日より後の日付を入力してください。' };
    }

    // 確認トークン生成
    const token = Utilities.getUuid();
    const timestamp = Utilities.formatDate(new Date(), 'JST', 'yyyy/MM/dd HH:mm:ss');

    // applicationsシートに記録
    const sheet = getApplicationsSheet();
    sheet.appendRow([
      timestamp, exName, venue, startDate,
      organizer, email, token,
      'FALSE', '', ''
    ]);

    // 確認メール送信
    // Exhibition_register のデプロイURL（確認メールのリンクに使用）
    const confirmUrl = "https://rohei-printer-system.web.app/setup.html?token=" + token;
    sendConfirmationEmail(email, organizer, exName, venue, startDate, confirmUrl);

    return { success: true };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

// =========================================================
// 🌟 確認メール送信
// =========================================================
function sendConfirmationEmail(email, organizer, exName, venue, startDate, confirmUrl) {
  const subject = `[Exhibition Setup] メールアドレスの確認`;
  const body = `
${organizer} 様

以下の展覧会のセットアップ申請を受け付けました。

展覧会名　: ${exName}
開催場所　: ${venue}
開催予定日: ${startDate}

下のURLをクリックしてメールアドレスを確認し、セットアップを開始してください。

${confirmUrl}

このリンクは申請者本人のみ使用してください。

━━━━━━━━━━━━━━━━━━━━━━━━
このメールは送信専用です。返信はできません。
お問い合わせは ryohei.miyagawa.art@gmail.com までご連絡ください。
━━━━━━━━━━━━━━━━━━━━━━━━
Rohei Printer System
  `;

  GmailApp.sendEmail(email, subject, body, {
    name: 'Rohei Printer System',
    replyTo: 'Rohei Printer <ryohei.miyagawa.art@gmail.com>',
    from: 'noreply.rohei.printer@gmail.com'
  });
}

// =========================================================
// 🌟 メール認証（トークン確認）
// =========================================================
function confirmToken(token) {
  try {
    const sheet = getApplicationsSheet();
    const data = sheet.getDataRange().getValues();
    const headers = data[0];
    const emailIdx = headers.indexOf('email');
    const tokenIdx = headers.indexOf('confirm_token');
    const confirmedIdx = headers.indexOf('confirmed');
    const exNameIdx = headers.indexOf('ex_name');
    const organizerIdx = headers.indexOf('organizer');

    for (let i = 1; i < data.length; i++) {
      if (data[i][tokenIdx].toString().trim() !== token) continue;

      // 既に確認済みの場合
      if (String(data[i][confirmedIdx]).toUpperCase().trim() === 'TRUE') {
        return {
          success: true,
          alreadyConfirmed: true,
          exName: data[i][exNameIdx],
          organizer: data[i][organizerIdx],
          email: data[i][emailIdx],
          token: token  // 必ずtokenを返す
        };
      }

      // 確認済みに更新
      sheet.getRange(i + 1, confirmedIdx + 1).setValue('TRUE');
      return {
        success: true,
        alreadyConfirmed: false,
        exName: data[i][exNameIdx],
        organizer: data[i][organizerIdx],
        email: data[i][emailIdx],
        token: token  // 必ずtokenを返す
      };
    }
    return { success: false, error: '無効な認証リンクです。' };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}