/**
 * Exhibition Setup Web App
 * - Deployed as a standalone GAS Web App
 * - Accessible via URL (no spreadsheet menu needed)
 * - Sends completion email to organizer
 */

// QRlikes_tot のデプロイURL（来場者が作品QRを読んだときに開く感想入力画面のURL）
const VISITOR_QR_URL = "https://rohei-printer-system.web.app/";

// 作品 QR トークン発行用の Cloud Function URL (Plan 5-A セッション 3)
const QR_TOKEN_CF_URL = "https://asia-northeast1-rohei-printer-system.cloudfunctions.net/mintArtworkQrTokenFromGas";

// 新規 QR URL のデフォルト有効期限 (日)
const QR_TOKEN_DEFAULT_DAYS = 365;

// マスタースプレッドシートのID
const MASTER_SS_ID = "1h0uSnoUBuQnEqWmFXIOUIRK2CvigmkOmucsWOnaS6xQ";

// =========================================================
// 🌟 作品単位の HMAC QR URL を Cloud Function 経由で生成
//   security_key を URL に乗せない方針 (Plan 5-A 完成形)
// =========================================================
function buildArtworkQrUrl(exCode, artworkId, expDays) {
  const adminSecret = PropertiesService.getScriptProperties().getProperty('ADMIN_SECRET');
  if (!adminSecret) {
    throw new Error('Script Property ADMIN_SECRET が未設定です');
  }
  const days = expDays || QR_TOKEN_DEFAULT_DAYS;
  const res = UrlFetchApp.fetch(QR_TOKEN_CF_URL, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({
      adminSecret: adminSecret,
      exCode: exCode,
      artworkId: artworkId,
      expDays: days,
    }),
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  const body = JSON.parse(res.getContentText());
  if (code !== 200 || !body.success) {
    throw new Error('QR トークン発行失敗: ' + (body && body.error ? body.error : 'HTTP ' + code));
  }
  return VISITOR_QR_URL + '?ex=' + encodeURIComponent(exCode)
    + '&id=' + encodeURIComponent(artworkId)
    + '&exp=' + body.exp
    + '&sig=' + body.sig;
}

// =========================================================
// 🌟 ユーティリティ
// =========================================================
function colIndex(headers, name) {
  const idx = headers.indexOf(name);
  if (idx === -1) throw new Error("Column not found: " + name);
  return idx;
}

// Drive 操作は一時不調が多いので、最大 maxAttempts 回リトライする
// 成功時は戻り値を返す。最後まで失敗したら最後の例外を投げる
function withDriveRetry(label, fn, maxAttempts) {
  maxAttempts = maxAttempts || 3;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return fn();
    } catch (e) {
      lastErr = e;
      console.warn('[' + label + '] attempt ' + attempt + ' failed: ' + e);
      if (attempt < maxAttempts) Utilities.sleep(500 * attempt);
    }
  }
  throw lastErr;
}

// setSharing は権限制限で本当に動かないこともあるので、
// 失敗してもエラーを投げず、警告として蓄積するだけにする
function safeSetSharing(target, access, permission, label, warnings) {
  try {
    withDriveRetry('setSharing:' + label, () => {
      target.setSharing(access, permission);
    });
  } catch (e) {
    console.warn('safeSetSharing failed for ' + label + ': ' + e);
    if (warnings) warnings.push(label);
  }
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
        email: e.parameter.email,
        sandbox: e.parameter.sandbox === '1'
      };
      output.setContent(JSON.stringify(submitApplication(payload)));
      return output;
    }

    if (action === 'graduateExhibition') {
      output.setContent(JSON.stringify(graduateExhibition(e.parameter.ex, e.parameter.email)));
      return output;
    }

    if (action === 'confirmToken') {
      output.setContent(JSON.stringify(confirmToken(e.parameter.token)));
      return output;
    }

    if (action === 'verifyTokenForFinalize') {
      const payload = {
        token: e.parameter.token,
        exCode: e.parameter.exCode
      };
      output.setContent(JSON.stringify(verifyTokenForFinalize(payload)));
      return output;
    }

    if (action === 'getCanonicalExhibitionDocAdmin') {
      const payload = {
        exCode: e.parameter.exCode,
        adminSecret: e.parameter.adminSecret
      };
      output.setContent(JSON.stringify(getCanonicalExhibitionDocAdmin(payload)));
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

    if (action === 'regenerateQrUrls') {
      output.setContent(JSON.stringify(regenerateQrUrls(e.parameter.ex)));
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
    const wsFolder = withDriveRetry('createFolder(WorkSpace)', () => parentFolder.createFolder(exCode + "_WorkSpace"));
    const imagesFolder = withDriveRetry('createFolder(images)', () => wsFolder.createFolder("images"));
    const shareWarnings = [];
    safeSetSharing(imagesFolder, DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW, 'images フォルダ', shareWarnings);
    const imagesFolderId = imagesFolder.getId();

    // --- 作品台帳SS構築 ---
    const artworkSS = withDriveRetry('create(artworks)', () => SpreadsheetApp.create(exCode + "_artworks"));
    const artworkId = artworkSS.getId();
    const artworkFile = withDriveRetry('getFileById(artwork)', () => DriveApp.getFileById(artworkId));
    withDriveRetry('addFile(artwork)', () => wsFolder.addFile(artworkFile));
    withDriveRetry('removeFile(artwork)', () => DriveApp.getRootFolder().removeFile(artworkFile));
    // 作品台帳：PRIVATE
    safeSetSharing(artworkFile, DriveApp.Access.PRIVATE, DriveApp.Permission.NONE, '作品台帳SS', shareWarnings);

    const aSheet = artworkSS.getSheets()[0];
    aSheet.setName(exCode + "_artworks");

    // 列構成
    const aHeader = [
      "artwork_id", "security_key", "title", "title_en", "artist", "artist_en",
      "birth_year", "death_year", "birthplace", "year", "series", "technique", "material",
      "size", "sheet_size", "image_size", "edition", "price", "price_framed", "certificate", "collection",
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
    const artworkSeeds = [];
    for (let i = 1; i <= workCount; i++) {
      const wId = "w" + ("00" + i).slice(-3);
      const sKey = Math.random().toString(36).substring(2, 10);
      const url = buildArtworkQrUrl(exCode, wId);
      const row = new Array(totalCols).fill("");
      row[0] = wId;
      row[1] = sKey;
      row[aHeader.indexOf("qr_url")] = url;
      row[aHeader.indexOf("status")] = "0";
      rows.push(row);
      const seed = { exCode: exCode };
      aHeader.forEach((h, idx) => { seed[h] = row[idx]; });
      artworkSeeds.push(seed);
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
    const commentSS = withDriveRetry('create(comments)', () => SpreadsheetApp.create(exCode + "_comments"));
    const commentId = commentSS.getId();
    const commentFile = withDriveRetry('getFileById(comment)', () => DriveApp.getFileById(commentId));
    withDriveRetry('addFile(comment)', () => wsFolder.addFile(commentFile));
    withDriveRetry('removeFile(comment)', () => DriveApp.getRootFolder().removeFile(commentFile));
    // 感想シート：リンクを知っている全員が閲覧可能
    safeSetSharing(commentFile, DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW, '感想シートSS', shareWarnings);

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

    // --- registration_fields / caption_fields の初期値 ---
    const defaultActiveFields = [
      { name: 'title', required: true },
      { name: 'year', required: false },
      { name: 'technique', required: false },
      { name: 'size', required: false },
      { name: 'price', required: false }
    ];
    const defaultJson = JSON.stringify(defaultActiveFields);

    // applications 行から連絡先系をコピー
    const venueIdx = appHeaders.indexOf('venue');
    const startDateIdx = appHeaders.indexOf('start_date');
    const organizerIdx = appHeaders.indexOf('organizer');
    const emailIdx = appHeaders.indexOf('email');
    const sandboxIdx = appHeaders.indexOf('sandbox');
    const appRow = appData[appRowIdx - 1];
    const venue = venueIdx !== -1 ? (appRow[venueIdx] || '') : '';
    const startDate = startDateIdx !== -1 ? (appRow[startDateIdx] || '') : '';
    const organizer = organizerIdx !== -1 ? (appRow[organizerIdx] || '') : '';
    const appEmail = emailIdx !== -1 ? (appRow[emailIdx] || '') : '';
    const isSandbox = sandboxIdx !== -1 && String(appRow[sandboxIdx]).toUpperCase().trim() === 'TRUE';

    // 練習モードなら 14 日後に自動削除予定の expire_at を設定
    let expireAtIso = '';
    if (isSandbox) {
      const expireMs = Date.now() + 14 * 24 * 60 * 60 * 1000;
      expireAtIso = new Date(expireMs).toISOString();
    }

    // ヘッダー名 → 値の dict を作って、ヘッダー順に並べて appendRow（列順非依存）
    // 既存マスター sheet に is_sandbox / expire_at 列が無ければ追加する
    let masterHeaders = masterSheet.getRange(1, 1, 1, masterSheet.getLastColumn()).getValues()[0];
    if (masterHeaders.indexOf('is_sandbox') === -1) {
      masterSheet.getRange(1, masterHeaders.length + 1).setValue('is_sandbox');
      masterHeaders = masterSheet.getRange(1, 1, 1, masterSheet.getLastColumn()).getValues()[0];
    }
    if (masterHeaders.indexOf('expire_at') === -1) {
      masterSheet.getRange(1, masterHeaders.length + 1).setValue('expire_at');
      masterHeaders = masterSheet.getRange(1, 1, 1, masterSheet.getLastColumn()).getValues()[0];
    }
    const newRow = {
      ex_code: exCode,
      ex_name: exName,
      status: 'active',
      artworks_registered: 0,
      artworks_total: workCount,
      last_artwork_update_at: '',
      organizer: organizer,
      email: appEmail || email,
      venue: venue,
      start_date: startDate,
      image_folder_id: imagesFolderId,
      artwork_sheet_id: artworkId,
      comment_sheet_id: commentId,
      registration_fields: defaultJson,
      caption_fields: defaultJson,
      created_at: timestamp,
      updated_at: timestamp,
      memo: '',
      is_sandbox: isSandbox ? 'TRUE' : 'FALSE',
      expire_at: expireAtIso
    };
    const rowArr = masterHeaders.map(h => newRow[h] !== undefined ? newRow[h] : '');
    masterSheet.appendRow(rowArr);

    // --- applications シートに ex_code と setup_at を記録 ---
    const setupAt = Utilities.formatDate(new Date(), 'JST', 'yyyy/MM/dd HH:mm:ss');
    appSheet.getRange(appRowIdx, exCodeColIdx + 1).setValue(exCode);
    appSheet.getRange(appRowIdx, setupAtIdx + 1).setValue(setupAt);

    // --- 完了メール送信 ---
    sendCompletionEmail(email, exCode, exName, isSandbox);

    return {
      success: true,
      exCode: exCode,
      exName: exName,
      artworks: artworkSeeds,
      exhibitionDoc: {
        ex_code: exCode,
        ex_name: exName,
        status: 'active',
        artworks_registered: 0,
        artworks_total: workCount,
        last_artwork_update_at: '',
        organizer: organizer,
        email: appEmail || email,
        venue: venue,
        start_date: startDate,
        image_folder_id: imagesFolderId,
        artwork_sheet_id: artworkId,
        comment_sheet_id: commentId,
        registration_fields: defaultJson,
        caption_fields: defaultJson,
        created_at: timestamp,
        updated_at: timestamp,
        memo: '',
        is_sandbox: isSandbox,
        expire_at: expireAtIso
      },
      warning: shareWarnings.length > 0
        ? '\n※ 以下のリソースの共有設定が自動でできませんでした。Drive で手動設定してください:\n  - ' + shareWarnings.join('\n  - ')
        : undefined
    };

  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

// =========================================================
// 🌟 完了メール送信
// =========================================================
function sendCompletionEmail(email, exCode, exName, isSandbox) {
  const captionUrl = "https://rohei-printer-system.web.app/caption.html?ex=" + exCode;
  const registerUrl = "https://rohei-printer-system.web.app/register.html?ex=" + exCode;
  const inquiryUrl = "https://rohei-printer-system.web.app/inquiry.html?ex=" + exCode;

  const subjectPrefix = isSandbox ? '[練習モード] ' : '';
  const subject = subjectPrefix + `[Exhibition Setup Complete] ${exName} (${exCode})`;
  const sandboxNote = isSandbox ? `
[練習] これは練習モードで作成された展覧会です:
・14 日後に自動的に削除されます
・作家への案内メール送信は無効化されており、運営者宛にだけ届きます
・気に入った設定で本番運用したい場合は、register.html の項目設定タブから「本番運用に切替」できます
` : '';
  const body = `
Your exhibition has been set up successfully!
━━━━━━━━━━━━━━━━━━━━━━━━
Exhibition Details
━━━━━━━━━━━━━━━━━━━━━━━━
Exhibition code : ${exCode}
Exhibition name : ${exName}
━━━━━━━━━━━━━━━━━━━━━━━━
${sandboxNote}
━━━━━━━━━━━━━━━━━━━━━━━━
Exhibition Register（作品登録・項目設定）
━━━━━━━━━━━━━━━━━━━━━━━━
${registerUrl}

━━━━━━━━━━━━━━━━━━━━━━━━
Caption Manager（キャプション印刷・QR印刷）
━━━━━━━━━━━━━━━━━━━━━━━━
${captionUrl}

【手順】
1. 上の Exhibition Register URL からアクセスし、運営者メールアドレスでログインしてください。届いたリンクをクリックすると自動でログインします。
2. 「項目設定」タブで作家が入力する項目・必須/任意を設定して保存してください。
3. 同タブの「案内メールを送信」ボタンを押すと、項目説明入りの案内メールが届くので、作家へ転送してください。
4. 作家から作品情報の入力完了の連絡を受けたら、Caption ManagerでキャプションをPreview→Printしてください。
5. QR PrintタブでQRコードを印刷してください。
━━━━━━━━━━━━━━━━━━━━━━━━
このメールは送信専用です。返信はできません。
お問い合わせは下記URLのフォームからお願いします。
${inquiryUrl}
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
// 🌟 練習モード展覧会の自動メンテナンス (毎日定期実行)
// - expire_at < now の sandbox 展覧会 → master sheet 行と Drive フォルダを削除、運営者に通知
// - expire_at が翌日以内の sandbox 展覧会 → 運営者に「明日削除されます」と通知
// 注: Firestore ドキュメント (artworks / likes) は GAS から直接削除できないため、
//     master sheet 削除後に運営者がアクセスしても展覧会一覧に出なくなる挙動になる。
//     完全な Firestore クリーンアップは将来 Cloud Functions 移行時に実装予定。
// =========================================================
function dailySandboxMaintenance() {
  try {
    const ss = SpreadsheetApp.openById(MASTER_SS_ID);
    const sheet = ss.getSheetByName('exhibitions');
    if (!sheet) return;

    const data = sheet.getDataRange().getValues();
    const headers = data[0];
    const exCodeIdx = headers.indexOf('ex_code');
    const exNameIdx = headers.indexOf('ex_name');
    const emailIdx = headers.indexOf('email');
    const isSandboxIdx = headers.indexOf('is_sandbox');
    const expireAtIdx = headers.indexOf('expire_at');
    const folderIdIdx = headers.indexOf('image_folder_id');
    const artworkSheetIdx = headers.indexOf('artwork_sheet_id');
    const commentSheetIdx = headers.indexOf('comment_sheet_id');

    if (isSandboxIdx === -1 || expireAtIdx === -1) {
      Logger.log('dailySandboxMaintenance: is_sandbox / expire_at 列が見つからないためスキップ');
      return;
    }

    const now = new Date();
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const rowsToDelete = [];
    const rowsToWarn = [];

    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const isSandbox = String(row[isSandboxIdx]).toUpperCase().trim() === 'TRUE';
      if (!isSandbox) continue;
      const expireRaw = row[expireAtIdx];
      if (!expireRaw) continue;
      const expireAt = new Date(expireRaw);
      if (isNaN(expireAt.getTime())) continue;
      if (expireAt <= now) {
        rowsToDelete.push({ rowIndex: i + 1, row: row });
      } else if (expireAt <= tomorrow) {
        rowsToWarn.push({ rowIndex: i + 1, row: row });
      }
    }

    // 翌日警告
    rowsToWarn.forEach(item => {
      const r = item.row;
      const exCode = r[exCodeIdx];
      const exName = r[exNameIdx];
      const email = r[emailIdx];
      if (email) {
        sendSandboxExpiringNotification(email, exCode, exName, r[expireAtIdx]);
      }
    });

    // 削除実行 (下から削除しないと行番号がずれる)
    rowsToDelete.sort((a, b) => b.rowIndex - a.rowIndex);
    rowsToDelete.forEach(item => {
      const r = item.row;
      const exCode = r[exCodeIdx];
      const exName = r[exNameIdx];
      const email = r[emailIdx];
      const folderId = folderIdIdx !== -1 ? r[folderIdIdx] : '';
      const artworkSheetId = artworkSheetIdx !== -1 ? r[artworkSheetIdx] : '';
      const commentSheetId = commentSheetIdx !== -1 ? r[commentSheetIdx] : '';

      // Drive フォルダ・スプレッドシート削除
      [folderId, artworkSheetId, commentSheetId].forEach(id => {
        if (!id) return;
        try {
          const file = DriveApp.getFileById(id);
          file.setTrashed(true);
        } catch (e) {
          Logger.log('Drive 削除失敗 (' + id + '): ' + e);
        }
      });

      // master sheet 行削除
      sheet.deleteRow(item.rowIndex);

      // 運営者に削除完了通知
      if (email) {
        sendSandboxDeletedNotification(email, exCode, exName);
      }
    });

    Logger.log('dailySandboxMaintenance: 警告 ' + rowsToWarn.length + ' 件、削除 ' + rowsToDelete.length + ' 件');
  } catch (e) {
    Logger.log('dailySandboxMaintenance error: ' + e);
  }
}

// 翌日削除予定の通知
function sendSandboxExpiringNotification(email, exCode, exName, expireAtIso) {
  const subject = '[練習モード] 明日削除されます: ' + exName;
  const body = `${exName} (${exCode}) は練習モードで作成された展覧会です。
明日 (${expireAtIso} 以降) に自動的に削除されます。

このまま運用を続けたい場合は、本日中に「本番運用に切替」ボタンを押してください:
https://rohei-printer-system.web.app/register.html?ex=${exCode}

削除後はテスト作品データ・コメント・いいねがすべて消えます。
━━━━━━━━━━━━━━━━━━━━━━━━
Rohei Printer System
`;
  GmailApp.sendEmail(email, subject, body, {
    name: 'Rohei Printer System',
    replyTo: 'Rohei Printer <ryohei.miyagawa.art@gmail.com>',
    from: 'noreply.rohei.printer@gmail.com'
  });
}

// 削除完了通知
function sendSandboxDeletedNotification(email, exCode, exName) {
  const subject = '[練習モード] 削除しました: ' + exName;
  const body = `${exName} (${exCode}) は練習モードでの試行期間 (14 日) を過ぎたため、自動的に削除されました。

新たに練習を始めたい場合、または本番運用したい場合は再度申請してください:
https://rohei-printer-system.web.app/setup.html
━━━━━━━━━━━━━━━━━━━━━━━━
Rohei Printer System
`;
  GmailApp.sendEmail(email, subject, body, {
    name: 'Rohei Printer System',
    replyTo: 'Rohei Printer <ryohei.miyagawa.art@gmail.com>',
    from: 'noreply.rohei.printer@gmail.com'
  });
}

// 定期トリガを設定する関数 (運営者が一度だけ実行する)
function setupSandboxTrigger() {
  // 既存の dailySandboxMaintenance トリガを削除して二重登録を防ぐ
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'dailySandboxMaintenance') {
      ScriptApp.deleteTrigger(t);
    }
  });
  // 毎日 4 時 (JST) に実行
  ScriptApp.newTrigger('dailySandboxMaintenance')
    .timeBased()
    .everyDays(1)
    .atHour(4)
    .create();
  Logger.log('Trigger created: dailySandboxMaintenance (daily at 4am JST)');
}

// =========================================================
// 🌟 練習モードから本番運用に切替（卒業）
// 主催者が認証済みであることをチェックし、master sheet の is_sandbox / expire_at をクリアする。
// Firestore 側のフラグ更新と関連データ (artworks / likes / 画像) のクリアはクライアント側で行う。
// =========================================================
function graduateExhibition(exCode, requesterEmail) {
  try {
    if (!exCode) return { success: false, error: '展覧会コードが必要です。' };
    if (!requesterEmail) return { success: false, error: 'リクエスト元のメールアドレスが必要です。' };

    const ss = SpreadsheetApp.openById(MASTER_SS_ID);
    const sheet = ss.getSheetByName('exhibitions');
    if (!sheet) return { success: false, error: 'exhibitions シートが見つかりません。' };

    const data = sheet.getDataRange().getValues();
    const headers = data[0];
    const exCodeIdx = headers.indexOf('ex_code');
    const emailIdx = headers.indexOf('email');
    const isSandboxIdx = headers.indexOf('is_sandbox');
    const expireAtIdx = headers.indexOf('expire_at');
    const updatedAtIdx = headers.indexOf('updated_at');

    if (isSandboxIdx === -1 || expireAtIdx === -1) {
      return { success: false, error: 'is_sandbox / expire_at 列が見つかりません。setup.html から作成された展覧会のみ卒業可能です。' };
    }

    const requesterNorm = String(requesterEmail).trim().toLowerCase();
    let rowIdx = -1;
    for (let i = 1; i < data.length; i++) {
      if (data[i][exCodeIdx].toString().trim() === exCode) {
        const rowEmail = String(data[i][emailIdx] || '').trim().toLowerCase();
        if (rowEmail !== requesterNorm) {
          return { success: false, error: 'この展覧会の主催者ではありません。' };
        }
        rowIdx = i + 1; // 1-based
        break;
      }
    }
    if (rowIdx === -1) return { success: false, error: '展覧会が見つかりません: ' + exCode };

    sheet.getRange(rowIdx, isSandboxIdx + 1).setValue('FALSE');
    sheet.getRange(rowIdx, expireAtIdx + 1).setValue('');
    if (updatedAtIdx !== -1) {
      sheet.getRange(rowIdx, updatedAtIdx + 1).setValue(
        Utilities.formatDate(new Date(), 'JST', 'yyyy/MM/dd, HH:mm:ss')
      );
    }

    return { success: true };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
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
    const artworkSeeds = [];
    for (let i = 1; i <= addCount; i++) {
      const wId = "w" + ("00" + (lastNum + i)).slice(-3);
      const sKey = Math.random().toString(36).substring(2, 10);
      const url = buildArtworkQrUrl(exCode, wId);
      const row = new Array(totalCols).fill("");
      row[artworkIdCol] = wId;
      row[headers.indexOf("security_key")] = sKey;
      row[qrUrlCol] = url;
      row[statusCol] = "0";
      newRows.push(row);
      const seed = { exCode: exCode };
      headers.forEach((h, idx) => { seed[h] = row[idx]; });
      artworkSeeds.push(seed);
    }

    sheet.getRange(data.length + 1, 1, newRows.length, totalCols).setValues(newRows);

    bumpArtworkCount(exCode, addCount, 0);

    return { success: true, artworks: artworkSeeds };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

// =========================================================
// 🌟 既存展覧会の qr_url を HMAC 形式に再生成
//   旧 ?ex=&id=&key= 形式を新 ?ex=&id=&exp=&sig= 形式に置き換える。
//   呼び出し: register.html / 主催者が「QR URL 再発行」ボタンで実行。
//   security_key は doc に残るが、URL からは消える。
// =========================================================
function regenerateQrUrls(exCode) {
  try {
    if (!exCode) return { success: false, error: 'exCode が指定されていません' };
    const master = getMasterData(exCode);
    if (!master) return { success: false, error: 'Exhibition not found' };

    const ss = SpreadsheetApp.openById(master.artwork_sheet_id);
    const sheet = ss.getSheetByName(exCode + '_artworks');
    if (!sheet) return { success: false, error: 'artworks シートが見つかりません' };
    const data = sheet.getDataRange().getValues();
    const headers = data[0];
    const idCol = headers.indexOf('artwork_id');
    const qrCol = headers.indexOf('qr_url');
    if (idCol === -1 || qrCol === -1) {
      return { success: false, error: 'artwork_id / qr_url 列が見つかりません' };
    }

    let updated = 0;
    let failed = 0;
    const errors = [];
    for (let r = 1; r < data.length; r++) {
      const wId = (data[r][idCol] || '').toString().trim();
      if (!wId) continue;
      try {
        const url = buildArtworkQrUrl(exCode, wId);
        sheet.getRange(r + 1, qrCol + 1).setValue(url);
        updated++;
      } catch (e) {
        failed++;
        errors.push(wId + ': ' + e.message);
      }
    }
    return {
      success: failed === 0,
      updated: updated,
      failed: failed,
      errors: errors.slice(0, 10),
    };
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
      'confirmed', 'ex_code', 'setup_at', 'sandbox'
    ];
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    const headerRange = sheet.getRange(1, 1, 1, headers.length);
    headerRange.setBackground('#1a73e8');
    headerRange.setFontColor('#ffffff');
    headerRange.setFontWeight('bold');
    sheet.setFrozenRows(1);
  } else {
    // 既存シートに sandbox 列が無ければ追加
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    if (headers.indexOf('sandbox') === -1) {
      sheet.getRange(1, headers.length + 1).setValue('sandbox');
    }
  }
  return sheet;
}

// =========================================================
// 🌟 申請を受け付ける
// =========================================================
function submitApplication(payload) {
  try {
    const { exName, venue, startDate, organizer, email, sandbox } = payload;

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

    // applicationsシートに記録（ヘッダー順に依存しないよう dict で構築）
    const sheet = getApplicationsSheet();
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const rowDict = {
      timestamp: timestamp,
      ex_name: exName,
      venue: venue,
      start_date: startDate,
      organizer: organizer,
      email: email,
      confirm_token: token,
      confirmed: 'FALSE',
      ex_code: '',
      setup_at: '',
      sandbox: sandbox ? 'TRUE' : 'FALSE'
    };
    const rowArr = headers.map(h => rowDict[h] !== undefined ? rowDict[h] : '');
    sheet.appendRow(rowArr);

    // 確認メール送信
    const confirmUrl = "https://rohei-printer-system.web.app/setup.html?token=" + token;
    sendConfirmationEmail(email, organizer, exName, venue, startDate, confirmUrl, sandbox);

    return { success: true };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

// =========================================================
// 🌟 確認メール送信
// =========================================================
function sendConfirmationEmail(email, organizer, exName, venue, startDate, confirmUrl, sandbox) {
  const subjectPrefix = sandbox ? '[練習モード] ' : '';
  const subject = subjectPrefix + `[Exhibition Setup] メールアドレスの確認`;
  const sandboxNote = sandbox ? `
[練習] これは練習モードでの申請です:
・14 日後に自動的に削除されます (期限が来る前に「本番運用に切替」も可能)
・案内メールは作家には送られず、運営者宛にのみ届きます
・気軽に試行錯誤してください

` : '';
  const body = `
${organizer} 様

以下の展覧会のセットアップ申請を受け付けました。
${sandboxNote}
展覧会名　: ${exName}
開催場所　: ${venue}
開催予定日: ${startDate}

下のURLをクリックしてメールアドレスを確認し、セットアップを開始してください。

${confirmUrl}

このリンクは申請者本人のみ使用してください。

──
セットアップ画面に進んだ後、もう 1 通「展覧会セットアップの確認」メール
が届きます。迷惑メールフォルダに振り分けられる場合がありますので、
受信トレイに届かない場合はそちらもご確認ください。
──

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

// =========================================================
// 🌟 finalizeExhibitionSetup 用の token 検証 + canonical doc 返却
//   Cloud Function `finalizeExhibitionSetup` から呼ばれる。
//   applications 行の confirmed=TRUE / setup_at 記録済 / ex_code 一致を確認し、
//   authoritative な email + master SS exhibitions 行から組み立てた
//   canonical な exhibitionDoc を返す。Cloud Function はクライアント値を
//   信用せず、ここで返した dict を Firestore に書き込む。
// =========================================================
function verifyTokenForFinalize(payload) {
  try {
    const token = ((payload && payload.token) || '').toString().trim();
    const exCode = ((payload && payload.exCode) || '').toString().trim();
    if (!token) return { success: false, error: 'token が指定されていません' };
    if (!exCode) return { success: false, error: 'exCode が指定されていません' };

    const sheet = getApplicationsSheet();
    const data = sheet.getDataRange().getValues();
    const headers = data[0];
    const tokenIdx = headers.indexOf('confirm_token');
    const emailIdx = headers.indexOf('email');
    const confirmedIdx = headers.indexOf('confirmed');
    const setupAtIdx = headers.indexOf('setup_at');
    const exCodeIdx = headers.indexOf('ex_code');

    if (tokenIdx === -1 || emailIdx === -1 || confirmedIdx === -1
      || setupAtIdx === -1 || exCodeIdx === -1) {
      return { success: false, error: 'applications シートのヘッダー構成が想定外です' };
    }

    for (let i = 1; i < data.length; i++) {
      const rowToken = data[i][tokenIdx].toString().trim();
      if (rowToken !== token) continue;
      const confirmed = String(data[i][confirmedIdx]).toUpperCase().trim() === 'TRUE';
      if (!confirmed) {
        return { success: false, error: 'token がまだ確認されていません' };
      }
      const setupAt = data[i][setupAtIdx].toString().trim();
      if (!setupAt) {
        return { success: false, error: 'setup が完了していません' };
      }
      const recordedExCode = data[i][exCodeIdx].toString().trim();
      if (recordedExCode !== exCode) {
        return { success: false, error: 'exCode が一致しません (記録: ' + recordedExCode + ')' };
      }
      const email = data[i][emailIdx].toString().trim().toLowerCase();
      const exhibitionDoc = readMasterExhibitionDoc(exCode);
      if (!exhibitionDoc) {
        return { success: false, error: 'master SS に exhibitions 行が見つかりません: ' + exCode };
      }
      // GAS が確認した email を必ず採用 (master SS 値とのズレ吸収)
      exhibitionDoc.email = email;
      return { success: true, email: email, exCode: exCode, exhibitionDoc: exhibitionDoc };
    }
    return { success: false, error: 'token が見つかりません' };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

// =========================================================
// 🌟 admin 復旧用: ex_code だけで canonical doc を返す
//   Cloud Function `adminRecoverExhibitionDoc` から呼ばれる。
//   Script Property `ADMIN_SECRET` と一致する adminSecret が必要。
//   token 照合は行わない (admin 復旧のため、Cloud Function 側で operator
//   email auth を済ませている前提)。applications 行から authoritative な
//   email を引き、master SS exhibitions 行と合わせて返す。
// =========================================================
function getCanonicalExhibitionDocAdmin(payload) {
  try {
    const exCode = ((payload && payload.exCode) || '').toString().trim();
    const adminSecret = ((payload && payload.adminSecret) || '').toString();
    if (!exCode) return { success: false, error: 'exCode が指定されていません' };
    if (!adminSecret) return { success: false, error: 'adminSecret が指定されていません' };

    const expected = PropertiesService.getScriptProperties().getProperty('ADMIN_SECRET');
    if (!expected) {
      return { success: false, error: 'GAS 側で ADMIN_SECRET が未設定です' };
    }
    if (adminSecret !== expected) {
      return { success: false, error: 'adminSecret が一致しません' };
    }

    const exhibitionDoc = readMasterExhibitionDoc(exCode);
    if (!exhibitionDoc) {
      return { success: false, error: 'master SS に exhibitions 行が見つかりません: ' + exCode };
    }

    // applications 行から email を引き直す (verifyTokenForFinalize と同じく
    // master SS 値とのズレを吸収する目的)
    let email = (exhibitionDoc.email || '').toString().trim().toLowerCase();
    try {
      const appSheet = getApplicationsSheet();
      const data = appSheet.getDataRange().getValues();
      const headers = data[0];
      const exCodeIdx = headers.indexOf('ex_code');
      const emailIdx = headers.indexOf('email');
      if (exCodeIdx !== -1 && emailIdx !== -1) {
        for (let i = 1; i < data.length; i++) {
          if (data[i][exCodeIdx].toString().trim() === exCode) {
            const appEmail = data[i][emailIdx].toString().trim().toLowerCase();
            if (appEmail) email = appEmail;
            break;
          }
        }
      }
    } catch (e) {
      // applications 検索失敗時は master SS の email を採用
    }
    exhibitionDoc.email = email;
    return { success: true, exCode: exCode, email: email, exhibitionDoc: exhibitionDoc };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

// master SS exhibitions シートから ex_code 一致行を読み、JSON-safe な dict に整形して返す。
// 該当行が無ければ null。Cloud Function に渡す canonical な exhibitionDoc を作る用途。
function readMasterExhibitionDoc(exCode) {
  const masterSS = SpreadsheetApp.openById(MASTER_SS_ID);
  const masterSheet = masterSS.getSheetByName('exhibitions');
  const all = masterSheet.getDataRange().getValues();
  const headers = all[0];
  const exCodeIdx = headers.indexOf('ex_code');
  if (exCodeIdx === -1) return null;
  for (let i = 1; i < all.length; i++) {
    if (all[i][exCodeIdx].toString().trim() !== exCode) continue;
    const dict = {};
    headers.forEach(function (h, idx) {
      if (!h) return;
      dict[h] = normalizeExhibitionFieldValue(h, all[i][idx]);
    });
    return dict;
  }
  return null;
}

// セルの生値を Cloud Function (JSON) に乗せやすい形に正規化する。
// runSetup が返していた exhibitionDoc の型と揃える:
//   - Date は JST の文字列に
//   - is_sandbox は boolean に
//   - artworks_registered / artworks_total は number に
//   - その他はそのまま
function normalizeExhibitionFieldValue(key, value) {
  if (value instanceof Date) {
    return Utilities.formatDate(value, 'JST', 'yyyy/MM/dd, HH:mm:ss');
  }
  if (key === 'is_sandbox') {
    if (typeof value === 'boolean') return value;
    return String(value).toUpperCase().trim() === 'TRUE';
  }
  if (key === 'artworks_registered' || key === 'artworks_total') {
    const n = parseInt(value, 10);
    return isNaN(n) ? 0 : n;
  }
  if (value === null || value === undefined) return '';
  return value;
}