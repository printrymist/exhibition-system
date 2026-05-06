// =========================================================
// 🌟 Exhibition Caption Manager
// スタンドアロンWebアプリ
// URLにアクセスして展覧会コードを入力しキャプションを生成・印刷する
// =========================================================

const MASTER_SS_ID = "1h0uSnoUBuQnEqWmFXIOUIRK2CvigmkOmucsWOnaS6xQ";

// QRlikes_tot のデプロイURL（来場者が作品QRを読んだときに開く感想入力画面のURL）
const VISITOR_QR_URL = "https://rohei-printer-system.web.app/";

// 作品 QR トークン発行用 Cloud Function (Plan 5-A セッション 3)
const QR_TOKEN_CF_URL = "https://asia-northeast1-rohei-printer-system.cloudfunctions.net/mintArtworkQrTokenFromGas";
const QR_TOKEN_DEFAULT_DAYS = 365;

// HMAC ベースの作品 QR URL を Cloud Function 経由で生成
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

// exhibitions シートのスキーマ版数。ヘッダーや返り値の構造を変えたら必ず上げる。
// バンプすると既存キャッシュが自動的に無視される。
const EX_SCHEMA_VERSION = 'a3';

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
  var cacheKey = 'master_data_' + EX_SCHEMA_VERSION + '_' + ex + '_v' + version;
  var cached = cache.get(cacheKey);

  if (cached) {
    console.log('マスターをキャッシュから読み込みました: ' + ex);
    return JSON.parse(cached);
  }

  console.log('マスターをスプレッドシートから読み込みます: ' + ex);
  const ss = SpreadsheetApp.openById(MASTER_SS_ID);
  const allData = ss.getSheetByName('exhibitions').getDataRange().getValues();
  const headers = allData[0];
  const row = allData.find((r, i) => i > 0 && r[colIndex(headers, 'ex_code')].toString().trim() === ex.toString().trim());
  if (!row) return null;

  function pick(name) {
    const i = headers.indexOf(name);
    return i === -1 ? '' : (row[i] === undefined || row[i] === null ? '' : row[i]);
  }

  const masterObj = {
    ex_code: pick('ex_code'),
    ex_name: pick('ex_name'),
    status: pick('status'),
    organizer: pick('organizer'),
    email: pick('email'),
    venue: pick('venue'),
    start_date: pick('start_date'),
    password: pick('password'),
    image_folder_id: pick('image_folder_id'),
    artwork_sheet_id: pick('artwork_sheet_id'),
    comment_sheet_id: pick('comment_sheet_id'),
    created_at: pick('created_at'),
    updated_at: pick('updated_at'),
    memo: pick('memo'),
    updatedAt: new Date().getTime()
  };

  cache.put(cacheKey, JSON.stringify(masterObj), 21600);
  return masterObj;
}

// =========================================================
// 🌟 Warmup
// =========================================================
function warmUp() {
  Logger.log('warm up: ' + new Date());
}

// =========================================================
// 【aps.gs の doGet を以下に置き換え】
// page=input を追加
// =========================================================
function doGet(e) {
  const page = e.parameter.page || 'caption';
  const ex = e.parameter.ex || '';

  if (page === 'register') {
    const tmp = HtmlService.createTemplateFromFile('registerUI');
    tmp.ex = ex;
    tmp.appUrl = ScriptApp.getService().getUrl();
    return tmp.evaluate()
      .setTitle('Exhibition Register Setup')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }

  if (page === 'input') {
    const tmp = HtmlService.createTemplateFromFile('inputUI');
    tmp.ex = ex;
    tmp.appUrl = ScriptApp.getService().getUrl();
    return tmp.evaluate()
      .setTitle('作品情報入力')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }

  // デフォルト：キャプション画面
  const tmp = HtmlService.createTemplateFromFile('captionUI');
  tmp.ex = ex;
  tmp.appUrl = ScriptApp.getService().getUrl();
  return tmp.evaluate()
    .setTitle('Exhibition Caption Manager')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// =========================================================
// 🌟 ヘッダー名から列インデックスを取得するユーティリティ
// =========================================================
function colIndex(headers, name) {
  const idx = headers.indexOf(name);
  if (idx === -1) throw new Error("Column not found: " + name);
  return idx;
}

function doPost(e) {
  const output = ContentService.createTextOutput();
  output.setMimeType(ContentService.MimeType.JSON);

  try {
    const action = e.parameter.action;
    const ex = e.parameter.ex || '';

    if (action === 'loadAllData') {
      output.setContent(JSON.stringify(loadAllData(ex)));
      return output;
    }

    if (action === 'updateExName') {
      output.setContent(JSON.stringify(updateExName(ex, e.parameter.newName)));
      return output;
    }

    if (action === 'getCaptionTemplates') {
      output.setContent(JSON.stringify(getCaptionTemplates()));
      return output;
    }

    if (action === 'saveCaptionTemplate') {
      output.setContent(JSON.stringify(
        saveCaptionTemplate(e.parameter.name, e.parameter.settingsJson)
      ));
      return output;
    }

    if (action === 'deleteCaptionTemplate') {
      output.setContent(JSON.stringify(
        deleteCaptionTemplate(e.parameter.name)
      ));
      return output;
    }

    if (action === 'getQrData') {
      output.setContent(JSON.stringify(getQrData(ex)));
      return output;
    }

    if (action === 'saveActiveFields') {
      output.setContent(JSON.stringify(
        saveActiveFields(ex, e.parameter.activeFields)
      ));
      return output;
    }

    if (action === 'verifyExCode') {
      output.setContent(JSON.stringify(verifyExCode(ex)));
      return output;
    }

    if (action === 'getArtworksByArtist') {
      output.setContent(JSON.stringify(
        getArtworksByArtist(ex, e.parameter.artistName)
      ));
      return output;
    }

    if (action === 'saveArtwork') {
      const data = JSON.parse(e.parameter.data || '{}');
      output.setContent(JSON.stringify(saveArtwork(ex, data)));
      return output;
    }

    if (action === 'updateArtwork') {
      output.setContent(JSON.stringify(
        updateArtwork(
          ex,
          e.parameter.artworkId,
          JSON.parse(e.parameter.artworkData || '{}'),
          JSON.parse(e.parameter.artistData || '{}'),
          e.parameter.originalArtist
        )
      ));
      return output;
    }

    if (action === 'deleteArtwork') {
      output.setContent(JSON.stringify(
        deleteArtwork(ex, e.parameter.artworkId)
      ));
      return output;
    }

    if (action === 'bumpArtworkCount') {
      const dT = parseInt(e.parameter.dT || '0') || 0;
      const dR = parseInt(e.parameter.dR || '0') || 0;
      bumpArtworkCount(ex, dT, dR);
      output.setContent(JSON.stringify({ success: true }));
      return output;
    }

    if (action === 'setArtworkCount') {
      const total = e.parameter.total === undefined || e.parameter.total === '' ? null : parseInt(e.parameter.total);
      const registered = e.parameter.registered === undefined || e.parameter.registered === '' ? null : parseInt(e.parameter.registered);
      output.setContent(JSON.stringify(setArtworkCount(ex, total, registered)));
      return output;
    }

    if (action === 'appendInquiryToIndex') {
      const payload = JSON.parse(e.parameter.payload || '{}');
      output.setContent(JSON.stringify(appendInquiryToIndex(payload)));
      return output;
    }

    if (action === 'updateInquiryInIndex') {
      const payload = JSON.parse(e.parameter.payload || '{}');
      output.setContent(JSON.stringify(updateInquiryInIndex(payload)));
      return output;
    }

    if (action === 'getArtistList') {
      output.setContent(JSON.stringify(getArtistList(ex)));
      return output;
    }

    if (action === 'getArtworkList') {
      output.setContent(JSON.stringify(getArtworkList(ex)));
      return output;
    }

    if (action === 'getRegistrationFields') {
      output.setContent(JSON.stringify(getRegistrationFields(ex)));
      return output;
    }

    if (action === 'saveRegistrationFields') {
      output.setContent(JSON.stringify(
        saveRegistrationFields(ex, e.parameter.fieldsJson)
      ));
      return output;
    }

    if (action === 'getCaptionFields') {
      output.setContent(JSON.stringify(getCaptionFields(ex)));
      return output;
    }

    if (action === 'saveCaptionFields') {
      output.setContent(JSON.stringify(
        saveCaptionFields(ex, e.parameter.fieldsJson)
      ));
      return output;
    }

    if (action === 'addArtworks') {
      output.setContent(JSON.stringify(
        addArtworks(ex, parseInt(e.parameter.addCount || '0'))
      ));
      return output;
    }

    if (action === 'regenerateQrUrls') {
      output.setContent(JSON.stringify(regenerateQrUrls(ex)));
      return output;
    }

    if (action === 'categorizeArtwork') {
      output.setContent(JSON.stringify(
        categorizeArtwork(e.parameter.imageUrl || '')
      ));
      return output;
    }

    if (action === 'sendArtistGuide') {
      output.setContent(JSON.stringify(
        sendArtistGuide(ex, e.parameter.subject, e.parameter.body)
      ));
      return output;
    }

    if (action === 'graduateExhibition') {
      output.setContent(JSON.stringify(
        graduateExhibition(ex, e.parameter.email)
      ));
      return output;
    }

    if (action === 'getInquiryContext') {
      output.setContent(JSON.stringify({
        success: true,
        context: getInquiryContext(ex)
      }));
      return output;
    }

    if (action === 'sendInquiryNotification') {
      const payload = JSON.parse(e.parameter.payload || '{}');
      output.setContent(JSON.stringify(
        sendInquiryNotification(payload)
      ));
      return output;
    }

    if (action === 'sendInquiryReply') {
      const payload = JSON.parse(e.parameter.payload || '{}');
      output.setContent(JSON.stringify(
        sendInquiryReply(payload)
      ));
      return output;
    }

    if (action === 'sendAdminFollowupNotification') {
      const payload = JSON.parse(e.parameter.payload || '{}');
      output.setContent(JSON.stringify(
        sendAdminFollowupNotification(payload)
      ));
      return output;
    }

    output.setContent(JSON.stringify({
      success: false, error: '不明なアクション: ' + action
    }));
    return output;

  } catch (err) {
    output.setContent(JSON.stringify({
      success: false, error: err.message
    }));
    return output;
  }
}

// （非キャッシュ版の getMasterData は削除：上のキャッシュ版に一本化）

// =========================================================
// 🌟 展覧会コードを検証
// =========================================================
function verifyExCode(ex) {
  try {
    const master = getMasterData(ex);
    if (!master) return { success: false, error: `Exhibition code "${ex}" not found.` };
    return { success: true, exName: master.ex_name };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

// =========================================================
// 🌟 作品台帳のヘッダーと作品データを取得
// =========================================================
function getCaptionData(ex) {
  try {
    const master = getMasterData(ex);
    if (!master) return { success: false, error: 'Exhibition not found.' };

    const ss = SpreadsheetApp.openById(master.artwork_sheet_id);
    const sheet = ss.getSheetByName(ex + '_artworks');
    const data = sheet.getDataRange().getValues();
    const headers = data[0];

    // キャプションに不要な列を除外
    const excludedCols = ['artwork_id', 'security_key', 'image_url', 'qr_url', 'status', 'insta', 'x', 'facebook', 'web'];
    const captionHeaders = headers.filter(h => !excludedCols.includes(h) && h !== '');

    // 登録済み作品のみ取得
    const artworks = [];
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      if (row[colIndex(headers, 'status')].toString() !== '1') continue;
      if (!row[colIndex(headers, 'artwork_id')]) continue;
      const artwork = {};
      headers.forEach((h, idx) => { artwork[h] = row[idx] || ''; });
      artworks.push(artwork);
    }


    return {
      success: true,
      exCode: ex,
      exName: master.ex_name,
      headers: captionHeaders,
      artworks: artworks,
    };

  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

// =========================================================
// 🌟 WorkSpaceフォルダを取得するユーティリティ
// =========================================================
function getWorkspaceFolder(ex) {
  try {
    const masterFile = DriveApp.getFileById(MASTER_SS_ID);
    const parentFolder = masterFile.getParents().next();
    const folders = parentFolder.getFoldersByName(ex + '_WorkSpace');
    return folders.hasNext() ? folders.next() : null;
  } catch (e) {
    return null;
  }
}

// =========================================================
// 🌟 caption_templates シートを取得（なければ作成）
// =========================================================
function getTemplatesSheet() {
  const ss = SpreadsheetApp.openById(MASTER_SS_ID);
  let sheet = ss.getSheetByName('caption_templates');
  if (!sheet) {
    sheet = ss.insertSheet('caption_templates');
    sheet.appendRow(['name', 'settings_json', 'created_at']);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

// =========================================================
// 🌟 保存済みテンプレート一覧を取得
// =========================================================
function getCaptionTemplates() {
  try {
    const sheet = getTemplatesSheet();
    const data = sheet.getDataRange().getValues();
    if (data.length <= 1) return { success: true, templates: [] };
    const templates = [];
    for (let i = 1; i < data.length; i++) {
      if (!data[i][0]) continue; // 名前が空の行はスキップ
      templates.push({
        name: data[i][0].toString(),
        settingsJson: data[i][1].toString(),
        createdAt: data[i][2].toString()
      });
    }
    return { success: true, templates: templates };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

// =========================================================
// 🌟 テンプレートを保存（同名の場合は上書き）
// =========================================================
function saveCaptionTemplate(name, settingsJson) {
  try {
    const sheet = getTemplatesSheet();
    const data = sheet.getDataRange().getValues();
    const now = new Date().toLocaleString('ja-JP');
    // 同名行を検索して上書き
    for (let i = 1; i < data.length; i++) {
      if (data[i][0].toString() === name) {
        sheet.getRange(i + 1, 1, 1, 3).setValues([[name, settingsJson, now]]);
        return { success: true, overwritten: true };
      }
    }
    // 新規追加
    sheet.appendRow([name, settingsJson, now]);
    return { success: true, overwritten: false };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

// =========================================================
// 🌟 テンプレートを削除
// =========================================================
function deleteCaptionTemplate(name) {
  try {
    const sheet = getTemplatesSheet();
    const data = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (data[i][0].toString() === name) {
        sheet.deleteRow(i + 1);
        return { success: true };
      }
    }
    return { success: false, error: 'Template not found.' };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

// =========================================================
// 🌟 全作品のQRデータを取得（status=0含む）
// =========================================================
function getQrData(ex) {
  try {
    const master = getMasterData(ex);
    if (!master) return { success: false, error: 'Exhibition not found.' };
    const ss = SpreadsheetApp.openById(master.artwork_sheet_id);
    const sheet = ss.getSheetByName(ex + '_artworks');
    const data = sheet.getDataRange().getValues();
    const headers = data[0];
    const artworks = [];
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const artworkId = row[headers.indexOf('artwork_id')].toString();
      const qrUrl = row[headers.indexOf('qr_url')].toString();
      const status = row[headers.indexOf('status')].toString();
      if (!artworkId || !qrUrl) continue;
      artworks.push({ artwork_id: artworkId, qr_url: qrUrl, status: status });
    }
    return { success: true, artworks: artworks, exCode: ex };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

function updateExName(ex, newName) {
  try {
    const ss = SpreadsheetApp.openById(MASTER_SS_ID);
    const sheet = ss.getSheetByName('exhibitions');
    const data = sheet.getDataRange().getValues();
    const headers = data[0];
    const rowIdx = data.findIndex((r, i) => i > 0 && r[colIndex(headers, 'ex_code')].toString().trim() === ex.toString().trim());
    if (rowIdx === -1) return { success: false, error: '展覧会が見つかりません' };
    sheet.getRange(rowIdx + 1, colIndex(headers, 'ex_name') + 1).setValue(newName);
    const updatedAtIdx = headers.indexOf('updated_at');
    if (updatedAtIdx !== -1) {
      sheet.getRange(rowIdx + 1, updatedAtIdx + 1)
        .setValue(Utilities.formatDate(new Date(), 'JST', 'yyyy/MM/dd HH:mm:ss'));
    }
    clearAllCache(ex);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

function loadAllData(ex) {
  try {
    const master = getMasterData(ex);
    if (!master) return { success: false, error: `Exhibition code "${ex}" not found.` };

    // キャッシュを確認
    const cache = CacheService.getScriptCache();
    const version = getCacheVersion(ex);
    const cacheKey = 'loadAllData_' + EX_SCHEMA_VERSION + '_' + ex + '_v' + version;
    const cached = cache.get(cacheKey);
    if (cached) {
      console.log('loadAllData をキャッシュから読み込みました: ' + ex);
      return JSON.parse(cached);
    }

    console.log('loadAllData をスプレッドシートから読み込みます: ' + ex);
    const ss = SpreadsheetApp.openById(master.artwork_sheet_id);
    const sheet = ss.getSheetByName(ex + '_artworks');

    // ② シートの存在チェック
    if (!sheet) return { success: false, error: `Sheet "${ex}_artworks" not found.` };

    const data = sheet.getDataRange().getValues();
    const headers = data[0];

    const excludedCols = ['artwork_id', 'security_key', 'image_url', 'qr_url', 'status', 'insta', 'x', 'facebook', 'web'];
    const captionHeaders = headers.filter(h => !excludedCols.includes(h) && h !== '');

    // ① ループ外でインデックスを取得
    const artworkIdIdx = headers.indexOf('artwork_id');
    const qrUrlIdx = headers.indexOf('qr_url');
    const statusIdx = headers.indexOf('status');

    const artworks = [];
    const qrList = [];
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const artworkId = row[artworkIdIdx].toString();
      const qrUrl = row[qrUrlIdx].toString();
      const status = row[statusIdx].toString();

      // ③ 厳密な存在チェック
      if (artworkId === '' || qrUrl === '') continue;

      qrList.push({ artwork_id: artworkId, qr_url: qrUrl, status: status });
      if (status !== '1') continue;
      const artwork = {};
      headers.forEach((h, idx) => { artwork[h] = row[idx] || ''; });
      artworks.push(artwork);
    }

    const result = {
      success: true,
      exCode: ex,
      exName: master.ex_name,
      headers: captionHeaders,
      artworks: artworks,
      qrList: qrList,
      registrationFields: getRegistrationFields(ex),
      captionFields: getCaptionFields(ex)
    };

    // 6時間キャッシュ
    cache.put(cacheKey, JSON.stringify(result), 21600);
    return result;

  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

// =========================================================
// 🌟 作品枠を追加
// =========================================================
function addArtworks(exCode, addCount) {
  try {
    const master = getMasterData(exCode);
    if (!master) return { success: false, error: "Exhibition not found." };

    const ss = SpreadsheetApp.openById(master.artwork_sheet_id);
    const sheet = ss.getSheetByName(exCode + "_artworks");
    if (!sheet) return { success: false, error: "Sheet not found." };

    const data = sheet.getDataRange().getValues();
    const headers = data[0];

    const artworkIdCol = headers.indexOf("artwork_id");
    const lastRow = data[data.length - 1];
    const lastId = lastRow[artworkIdCol].toString();
    const lastNum = parseInt(lastId.replace("w", "")) || 0;

    const qrUrlCol = headers.indexOf("qr_url");
    const statusCol = headers.indexOf("status");
    const secKeyCol = headers.indexOf("security_key");
    const totalCols = headers.length;

    const newRows = [];
    for (let i = 1; i <= addCount; i++) {
      const wId = "w" + ("00" + (lastNum + i)).slice(-3);
      const sKey = Math.random().toString(36).substring(2, 10);
      const url = buildArtworkQrUrl(exCode, wId);
      const row = new Array(totalCols).fill("");
      row[artworkIdCol] = wId;
      row[secKeyCol] = sKey;
      row[qrUrlCol] = url;
      row[statusCol] = "0";
      newRows.push(row);
    }

    sheet.getRange(data.length + 1, 1, newRows.length, totalCols).setValues(newRows);
    clearAllCache(exCode);
    bumpArtworkCount(exCode, addCount, 0);
    return { success: true, addedCount: addCount };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

// =========================================================
// 既存展覧会の qr_url を HMAC 形式に再生成 (Plan 5-A セッション 3)
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
    clearAllCache(exCode);
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

// URLパラメータ取得（GAS用）
function getParam(url, param) {
  const reg = new RegExp('[?&]' + param + '=([^&#]*)');
  const results = reg.exec(url);
  return results ? decodeURIComponent(results[1]) : '';
}

function updateQrUrls() {
  const MASTER_SS_ID = "1h0uSnoUBuQnEqWmFXIOUIRK2CvigmkOmucsWOnaS6xQ";
  const NEW_BASE_URL = "https://rohei-printer-system.web.app/";

  const ss = SpreadsheetApp.openById(MASTER_SS_ID);
  const exSheet = ss.getSheetByName('exhibitions');
  const exData = exSheet.getDataRange().getValues();
  const exHeaders = exData[0];

  let totalUpdated = 0;

  for (let i = 1; i < exData.length; i++) {
    const exCode = exData[i][exHeaders.indexOf('ex_code')].toString().trim();
    const artworkSheetId = exData[i][exHeaders.indexOf('artwork_sheet_id')].toString().trim();
    if (!exCode || !artworkSheetId) continue;

    try {
      const artSS = SpreadsheetApp.openById(artworkSheetId);
      const sheet = artSS.getSheetByName(exCode + '_artworks');
      if (!sheet) { Logger.log('Sheet not found: ' + exCode); continue; }

      const data = sheet.getDataRange().getValues();
      const headers = data[0];
      const qrCol = headers.indexOf('qr_url');
      if (qrCol === -1) { Logger.log('qr_url column not found: ' + exCode); continue; }

      // ✅ メモリ上で書き換え
      let updated = 0;
      for (let r = 1; r < data.length; r++) {
        const oldUrl = data[r][qrCol].toString().trim();
        if (!oldUrl || !oldUrl.includes('script.google.com')) continue;

        const ex = getParam(oldUrl, 'ex');
        const id = getParam(oldUrl, 'id');
        const key = getParam(oldUrl, 'key');

        data[r][qrCol] = `${NEW_BASE_URL}?ex=${ex}&id=${id}&key=${key}`;
        updated++;
      }

      // ✅ 変更があった場合のみ一括書き込み
      if (updated > 0) {
        sheet.getRange(1, 1, data.length, data[0].length).setValues(data);
      }

      Logger.log(`${exCode}: ${updated}件更新`);
      totalUpdated += updated;

    } catch (e) {
      Logger.log(`Error in ${exCode}: ${e.toString()}`);
    }
  }

  Logger.log(`完了！合計 ${totalUpdated} 件のqr_urlを更新しました。`);
}

// 初回認証を強制発動するためのトリガー関数
// (エディタで一度実行 → 権限承認 → 以降 UrlFetchApp が使える)
function authorizeExternalRequest() {
  const r = UrlFetchApp.fetch('https://www.google.com', { muteHttpExceptions: true });
  Logger.log('UrlFetchApp authorized; status=' + r.getResponseCode());
}

// =========================================================
// 🤖 Claude API による作品自動分類
// =========================================================
function categorizeArtwork(imageUrl) {
  try {
    if (!imageUrl) return { success: false, error: 'image_url が空です' };

    const apiKey = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
    if (!apiKey) return { success: false, error: 'CLAUDE_API_KEY が Script Properties に設定されていません' };

    const systemPrompt = '美術作品を分類するアシスタントです。\n' +
      '画像を見て、以下の4層で分類してください。\n\n' +
      'レイヤー1 メディア（複数選択可、形式）:\n' +
      '[絵画, 版画, 写真, 彫刻, インスタレーション, 映像, テキスタイル, 陶芸, ドローイング]\n\n' +
      'レイヤー2 モチーフ（複数選択可、内容）:\n' +
      '[人物, 風景, 静物, 抽象, 動物, 都市, 自然]\n\n' +
      'レイヤー3 スタイル（1つ選択）:\n' +
      '[具象, 抽象, アニメ・イラスト系, コンセプチュアル]\n\n' +
      'レイヤー4 キーワード（日本語で3〜5個、自由記述）\n\n' +
      'JSON のみ返答してください。説明文・コードブロック不要。\n' +
      '形式: {"media": [...], "motif": [...], "style": "...", "keywords": [...]}';

    const requestBody = {
      model: 'claude-sonnet-4-6',
      max_tokens: 512,
      system: [{
        type: 'text',
        text: systemPrompt,
        cache_control: { type: 'ephemeral' }
      }],
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'url', url: imageUrl } },
          { type: 'text', text: 'この作品を分類してください。' }
        ]
      }]
    };

    const response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      payload: JSON.stringify(requestBody),
      muteHttpExceptions: true
    });

    const code = response.getResponseCode();
    const body = response.getContentText();
    if (code >= 400) {
      return { success: false, error: 'Claude API ' + code + ': ' + body };
    }

    const result = JSON.parse(body);
    const textBlock = (result.content || []).find(b => b.type === 'text');
    if (!textBlock) return { success: false, error: 'No text in Claude response' };

    let jsonText = textBlock.text.trim();
    jsonText = jsonText.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch (e) {
      return { success: false, error: 'JSON parse failed: ' + jsonText.substring(0, 200) };
    }

    return {
      success: true,
      media: Array.isArray(parsed.media) ? parsed.media : [],
      motif: Array.isArray(parsed.motif) ? parsed.motif : [],
      style: typeof parsed.style === 'string' ? parsed.style : '',
      keywords: Array.isArray(parsed.keywords) ? parsed.keywords : [],
      usage: result.usage || null
    };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

// =========================================================
// 🌟 練習モードから本番運用に切替（卒業）
// 主催者本人 (email 一致) のみ実行可能。master sheet の is_sandbox / expire_at をクリアする。
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