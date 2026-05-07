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

// 旧 doGet (page=caption/register/input → captionUI/registerUI/inputUI) は
// 2026-05-07 に削除。UI は Firebase Hosting (caption.html / register.html /
// input.html) に完全移行済。/exec は doPost (gasCall) 専用。

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

    // Phase 6d: dead handlers (loadAllData / getQrData / saveActiveFields /
    // verifyExCode / getArtworksByArtist / saveArtwork / updateArtwork /
    // deleteArtwork) を撤去。Cloud Function (submitArtwork 等) または
    // Firestore 直接読みに移行済。

    if (action === 'updateExName') {
      output.setContent(JSON.stringify(updateExName(ex, e.parameter.newName)));
      return output;
    }

    // Phase 7-A1 (2026-05-07): caption_templates / caption_fields は
    // Firestore に移行済。getCaptionTemplates / saveCaptionTemplate /
    // deleteCaptionTemplate / getCaptionFields / saveCaptionFields は撤去。

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

    // Phase 6d: getArtistList / getArtworkList / getRegistrationFields は
    // 撤去 (クライアントは Firestore 直読み)。saveRegistrationFields は
    // Master SS への mirror として残置。

    if (action === 'saveRegistrationFields') {
      output.setContent(JSON.stringify(
        saveRegistrationFields(ex, e.parameter.fieldsJson)
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

    // categorizeArtwork は Cloud Function に移行済 (2026-05-06)。
    // CLAUDE_API_KEY も Script Properties から CF Secret Manager に移したので、
    // GAS の Script Properties からは外して構わない。

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

// Phase 6e: verifyExCode / getCaptionData は撤去 (Phase 6d でクライアント側を
// Firestore exhibitions / artworks 直読みに移行済)。

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

// Phase 7-A1 (2026-05-07): caption_templates 系の関数 (getTemplatesSheet /
// getCaptionTemplates / saveCaptionTemplate / deleteCaptionTemplate) は
// Firestore に移行済のため撤去。caption.html は firebase.firestore() で直接
// caption_templates コレクションを読み書きする。

// Phase 6e: getQrData は撤去 (caption.html は fsLoadAllData で Firestore 直読み)。

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

// Phase 6e: loadAllData は撤去 (caption.html の fsLoadAllData が Firestore 直読みで代替)。

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
    const artworkSeeds = [];
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
      const seed = { exCode: exCode };
      headers.forEach((h, idx) => { seed[h] = row[idx]; });
      artworkSeeds.push(seed);
    }

    sheet.getRange(data.length + 1, 1, newRows.length, totalCols).setValues(newRows);
    clearAllCache(exCode);
    bumpArtworkCount(exCode, addCount, 0);
    return { success: true, addedCount: addCount, artworks: artworkSeeds };
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

// categorizeArtwork は Cloud Function に移行 (2026-05-06)。
// functions/index.js の exports.categorizeArtwork が Anthropic API を直接叩く。
// CLAUDE_API_KEY は Cloud Function Secret Manager に投入済。

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