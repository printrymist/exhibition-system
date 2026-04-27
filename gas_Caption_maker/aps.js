// =========================================================
// 🌟 Exhibition Caption Manager
// スタンドアロンWebアプリ
// URLにアクセスして展覧会コードを入力しキャプションを生成・印刷する
// =========================================================

const MASTER_SS_ID = "1h0uSnoUBuQnEqWmFXIOUIRK2CvigmkOmucsWOnaS6xQ";

// QRlikes_tot のデプロイURL（来場者が作品QRを読んだときに開く感想入力画面のURL）
const VISITOR_QR_URL = "https://rohei-printer-system.web.app/";

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

    if (action === 'verifyPassword') {
      output.setContent(JSON.stringify(
        verifyPassword(ex, e.parameter.password)
      ));
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

// =========================================================
// 🌟 マスターデータを取得
// =========================================================
function getMasterData(ex) {
  const ss = SpreadsheetApp.openById(MASTER_SS_ID);
  const allData = ss.getSheetByName('exhibitions').getDataRange().getValues();
  const headers = allData[0];
  const row = allData.find((r, i) => i > 0 && r[colIndex(headers, 'ex_code')].toString().trim() === ex.toString().trim());
  if (!row) return null;
  return {
    ex_code: row[colIndex(headers, 'ex_code')],
    image_folder_id: row[colIndex(headers, 'image_folder_id')],
    artwork_sheet_id: row[colIndex(headers, 'artwork_sheet_id')],
    comment_sheet_id: row[colIndex(headers, 'comment_sheet_id')],
    ex_name: row[colIndex(headers, 'ex_name')],
    password: row[colIndex(headers, 'password')],
    memo: row[colIndex(headers, 'memo')]
  };
}

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
    const cacheKey = 'loadAllData_' + ex + '_v' + version;
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
      const url = `${VISITOR_QR_URL}?ex=${exCode}&id=${wId}&key=${sKey}`;
      const row = new Array(totalCols).fill("");
      row[artworkIdCol] = wId;
      row[secKeyCol] = sKey;
      row[qrUrlCol] = url;
      row[statusCol] = "0";
      newRows.push(row);
    }

    sheet.getRange(data.length + 1, 1, newRows.length, totalCols).setValues(newRows);
    clearAllCache(exCode);
    return { success: true, addedCount: addCount };
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