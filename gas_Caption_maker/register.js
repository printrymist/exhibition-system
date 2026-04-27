// =========================================================
// ⚙️ Exhibition Register
// app.gs に追記してください
// =========================================================

// =========================================================
// 🌟 doGet ルーティング（app.gsのdoGetを以下に置き換え）
// =========================================================
// function doGet(e) {
//   const page = e.parameter.page || 'caption';
//   const ex   = e.parameter.ex   || '';
//   if (page === 'register') {
//     const tmp = HtmlService.createTemplateFromFile('registerUI');
//     tmp.ex = ex;
//     return tmp.evaluate()
//       .setTitle('Exhibition Register')
//       .addMetaTag('viewport', 'width=device-width, initial-scale=1')
//       .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
//   }
//   const tmp = HtmlService.createTemplateFromFile('captionUI');
//   tmp.ex = ex;
//   return tmp.evaluate()
//     .setTitle('Exhibition Caption Manager')
//     .addMetaTag('viewport', 'width=device-width, initial-scale=1')
//     .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
// }

// =========================================================
// 🌟 パスワード認証
// =========================================================
function verifyPassword(ex, password) {
  try {
    const master = getMasterData(ex);
    if (!master) return { success: false, error: '展覧会が見つかりません。' };
    const storedPw = master.password ? master.password.toString().trim() : '';
    if (!storedPw) return { success: false, error: 'パスワードが設定されていません。' };
    if (password.trim() !== storedPw) return { success: false, error: 'パスワードが正しくありません。' };
    return { success: true, registrationFields: getRegistrationFields(ex) };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

// =========================================================
// 🌟 registration_fields を取得
// =========================================================
function getRegistrationFields(ex) {
  try {
    const ss = SpreadsheetApp.openById(MASTER_SS_ID);
    const sheet = ss.getSheetByName('exhibitions');
    const data = sheet.getDataRange().getValues();
    const headers = data[0];

    // registration_fields を優先、なければ active_fields にフォールバック
    let colIdx = headers.indexOf('registration_fields');
    if (colIdx === -1) colIdx = headers.indexOf('active_fields');
    if (colIdx === -1) return null;

    const row = data.find((r, i) => i > 0 && r[headers.indexOf('ex_code')].toString().trim() === ex.toString().trim());
    if (!row) return null;
    const val = row[colIdx].toString().trim();
    if (!val) return null;
    return JSON.parse(val);
  } catch (e) {
    return null;
  }
}

// =========================================================
// 🌟 registration_fields を保存
// =========================================================
function saveRegistrationFields(ex, fieldsJson) {
  try {
    const ss = SpreadsheetApp.openById(MASTER_SS_ID);
    const sheet = ss.getSheetByName('exhibitions');
    const data = sheet.getDataRange().getValues();
    const headers = data[0];

    // registration_fields 列を取得、なければ追加
    let colIdx = headers.indexOf('registration_fields');
    if (colIdx === -1) {
      colIdx = sheet.getLastColumn();
      sheet.getRange(1, colIdx + 1).setValue('registration_fields');
    }

    // 行番号を特定して一発書き込み
    for (let i = 1; i < data.length; i++) {
      if (data[i][headers.indexOf('ex_code')].toString().trim() === ex.toString().trim()) {
        sheet.getRange(i + 1, colIdx + 1).setValue(fieldsJson);
        clearAllCache(ex);
        return { success: true };
      }
    }
    return { success: false, error: '展覧会が見つかりません。' };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

// =========================================================
// 🌟 caption_fields を取得
// =========================================================
function getCaptionFields(ex) {
  try {
    const ss = SpreadsheetApp.openById(MASTER_SS_ID);
    const sheet = ss.getSheetByName('exhibitions');
    const data = sheet.getDataRange().getValues();
    const headers = data[0];

    // caption_fields を優先、なければ registration_fields → active_fields にフォールバック
    let colIdx = headers.indexOf('caption_fields');
    if (colIdx === -1) colIdx = headers.indexOf('registration_fields');
    if (colIdx === -1) colIdx = headers.indexOf('active_fields');
    if (colIdx === -1) return null;

    const row = data.find((r, i) => i > 0 && r[headers.indexOf('ex_code')].toString().trim() === ex.toString().trim());
    if (!row) return null;
    const val = row[colIdx].toString().trim();
    if (!val) return null;
    return JSON.parse(val);
  } catch (e) {
    return null;
  }
}

// =========================================================
// 🌟 caption_fields を保存
// =========================================================
function saveCaptionFields(ex, fieldsJson) {
  try {
    const ss = SpreadsheetApp.openById(MASTER_SS_ID);
    const sheet = ss.getSheetByName('exhibitions');
    const data = sheet.getDataRange().getValues();
    const headers = data[0];

    // caption_fields 列を取得、なければ追加
    let colIdx = headers.indexOf('caption_fields');
    if (colIdx === -1) {
      colIdx = sheet.getLastColumn();
      sheet.getRange(1, colIdx + 1).setValue('caption_fields');
    }

    // 行番号を特定して一発書き込み
    for (let i = 1; i < data.length; i++) {
      if (data[i][headers.indexOf('ex_code')].toString().trim() === ex.toString().trim()) {
        sheet.getRange(i + 1, colIdx + 1).setValue(fieldsJson);
        clearAllCache(ex);
        return { success: true };
      }
    }
    return { success: false, error: '展覧会が見つかりません。' };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

// =========================================================
// 🌟 作品を登録（status=0の行に書き込む）
// =========================================================
function saveArtwork(ex, data) {
  try {
    const master = getMasterData(ex);
    if (!master) return { success: false, error: '展覧会が見つかりません。' };
    const ss = SpreadsheetApp.openById(master.artwork_sheet_id);
    const sheet = ss.getSheetByName(ex + '_artworks');
    if (!sheet) return { success: false, error: 'シート ' + ex + '_artworks が見つかりません。' };
    const allData = sheet.getDataRange().getValues();
    const headers = allData[0];
    const idColIdx = colIndex(headers, 'artwork_id');
    const statusColIdx = colIndex(headers, 'status');
    let targetRow = -1, targetId = '';
    for (let i = 1; i < allData.length; i++) {
      if (!allData[i][idColIdx]) continue;
      const status = allData[i][statusColIdx].toString().trim();
      if (status === '0' || status === '') { targetRow = i + 1; targetId = allData[i][idColIdx].toString(); break; }
    }
    if (targetRow === -1) return { success: false, error: '登録可能な空きがありません。すべての作品枠が埋まっています。' };
    Object.keys(data).forEach(key => {
      const idx = headers.indexOf(key);
      if (idx !== -1) sheet.getRange(targetRow, idx + 1).setValue(data[key]);
    });
    sheet.getRange(targetRow, statusColIdx + 1).setValue(1);
    clearAllCache(ex);
    return { success: true, artworkId: targetId };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

// =========================================================
// 🌟 作品を更新
//   artworkData  : その作品行だけ更新するフィールド
//   artistData   : 同じ作家名（originalArtist）の全行を更新するフィールド
//   originalArtist: 更新前の作家名（同一作家を特定するため）
// =========================================================
function updateArtwork(ex, artworkId, artworkData, artistData, originalArtist) {
  try {
    const master = getMasterData(ex);
    if (!master) return { success: false, error: '展覧会が見つかりません。' };
    const ss = SpreadsheetApp.openById(master.artwork_sheet_id);
    const sheet = ss.getSheetByName(ex + '_artworks');
    if (!sheet) return { success: false, error: 'シート ' + ex + '_artworks が見つかりません。' };

    const allData = sheet.getDataRange().getValues();
    const headers = allData[0];
    const idColIdx = colIndex(headers, 'artwork_id');
    const artistColIdx = headers.indexOf('artist');

    let updatedArtistCount = 0;

    for (let i = 1; i < allData.length; i++) {
      const row = allData[i];
      const rowId = row[idColIdx].toString().trim();
      const rowArtist = artistColIdx >= 0 ? row[artistColIdx].toString().trim() : '';

      if (rowId === artworkId) {
        // この作品行：作品情報 + 作家情報を更新
        Object.keys(artworkData).forEach(key => {
          const idx = headers.indexOf(key);
          if (idx !== -1) sheet.getRange(i + 1, idx + 1).setValue(artworkData[key]);
        });
        Object.keys(artistData).forEach(key => {
          const idx = headers.indexOf(key);
          if (idx !== -1) sheet.getRange(i + 1, idx + 1).setValue(artistData[key]);
        });
        updatedArtistCount++;
      } else if (rowArtist === originalArtist && originalArtist !== '') {
        // 同じ作家の他の作品行：作家情報のみ更新
        Object.keys(artistData).forEach(key => {
          const idx = headers.indexOf(key);
          if (idx !== -1) sheet.getRange(i + 1, idx + 1).setValue(artistData[key]);
        });
        updatedArtistCount++;
      }
    }
    clearAllCache(ex);
    return { success: true, updatedArtistCount: updatedArtistCount };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

// =========================================================
// 🌟 登録済み作品一覧を取得
// =========================================================
function getArtworkList(ex) {
  try {
    const master = getMasterData(ex);
    if (!master) return { success: false, error: '展覧会が見つかりません。' };
    const ss = SpreadsheetApp.openById(master.artwork_sheet_id);
    const sheet = ss.getSheetByName(ex + '_artworks');
    if (!sheet) return { success: false, error: 'シート ' + ex + '_artworks が見つかりません。' };
    const allData = sheet.getDataRange().getValues();
    const headers = allData[0];
    const statusIdx = headers.indexOf('status');
    const artworks = [];
    for (let i = 1; i < allData.length; i++) {
      const row = allData[i];
      if (!row[colIndex(headers, 'artwork_id')]) continue;
      if (statusIdx >= 0 && row[statusIdx].toString().trim() !== '1') continue;
      const art = { artwork_id: row[colIndex(headers, 'artwork_id')].toString() };
      headers.forEach((h, idx) => { if (h) art[h] = row[idx] !== undefined ? row[idx].toString() : ''; });
      artworks.push(art);
    }
    return { success: true, artworks: artworks };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

// =========================================================
// 🌟 登録済み作家一覧を取得（重複なし）
// =========================================================
function getArtistList(ex) {
  try {
    const master = getMasterData(ex);
    if (!master) return { success: false, error: '展覧会が見つかりません。' };
    const ss = SpreadsheetApp.openById(master.artwork_sheet_id);
    const sheet = ss.getSheetByName(ex + '_artworks');
    if (!sheet) return { success: false, error: 'シート ' + ex + '_artworks が見つかりません。' };
    const allData = sheet.getDataRange().getValues();
    const headers = allData[0];
    const statusIdx = headers.indexOf('status');
    const artistIdx = headers.indexOf('artist');
    const artistEnIdx = headers.indexOf('artist_en');
    const birthIdx = headers.indexOf('birth_year');
    const deathIdx = headers.indexOf('death_year');
    const instaIdx = headers.indexOf('insta');
    const xIdx = headers.indexOf('x');
    const fbIdx = headers.indexOf('facebook');
    const webIdx = headers.indexOf('web');
    const birthplaceIdx = headers.indexOf('birthplace');
    const seen = new Set(), artists = [];
    for (let i = 1; i < allData.length; i++) {
      const row = allData[i];
      if (statusIdx >= 0 && row[statusIdx].toString().trim() !== '1') continue;
      const artistName = artistIdx >= 0 ? row[artistIdx].toString().trim() : '';
      if (!artistName || seen.has(artistName)) continue;
      seen.add(artistName);
      artists.push({
        artist: artistName,
        artist_en: artistEnIdx >= 0 ? row[artistEnIdx].toString() : '',
        birth_year: birthIdx >= 0 ? row[birthIdx].toString() : '',
        death_year: deathIdx >= 0 ? row[deathIdx].toString() : '',
        insta: instaIdx >= 0 ? row[instaIdx].toString() : '',
        x: xIdx >= 0 ? row[xIdx].toString() : '',
        facebook: fbIdx >= 0 ? row[fbIdx].toString() : '',
        web: webIdx >= 0 ? row[webIdx].toString() : '',
        birthplace: birthplaceIdx >= 0 ? row[birthplaceIdx].toString() : '',
      });
    }
    return { success: true, artists: artists };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

// =========================================================
// 【register.gs に追記】
// getArtworksByArtist — 作家名で作品を検索（inputUI用）
// =========================================================
function getArtworksByArtist(ex, artistName) {
  try {
    const master = getMasterData(ex);
    if (!master) return { success: false, error: '展覧会が見つかりません。' };

    const ss = SpreadsheetApp.openById(master.artwork_sheet_id);
    const sheet = ss.getSheetByName(ex + '_artworks');
    if (!sheet) return { success: false, error: 'シート ' + ex + '_artworks が見つかりません。' };

    const allData = sheet.getDataRange().getValues();
    const headers = allData[0];
    const statusIdx = headers.indexOf('status');
    const artistIdx = headers.indexOf('artist');

    const artworks = [];
    for (let i = 1; i < allData.length; i++) {
      const row = allData[i];
      if (!row[colIndex(headers, 'artwork_id')]) continue;
      if (statusIdx >= 0 && row[statusIdx].toString().trim() !== '1') continue;
      // 作家名（部分一致・大文字小文字無視）
      const rowArtist = artistIdx >= 0 ? row[artistIdx].toString().trim() : '';
      if (rowArtist !== artistName.trim()) continue;
      const art = {};
      headers.forEach((h, idx) => { if (h) art[h] = row[idx] !== undefined ? row[idx].toString() : ''; });
      artworks.push(art);
    }

    return { success: true, artworks: artworks };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

// =========================================================
// 【register.gs に追記】
// deleteArtwork — 論理削除（status=0 + データクリア）
// =========================================================
function deleteArtwork(ex, artworkId) {
  try {
    const master = getMasterData(ex);
    if (!master) return { success: false, error: '展覧会が見つかりません。' };

    const ss = SpreadsheetApp.openById(master.artwork_sheet_id);
    const sheet = ss.getSheetByName(ex + '_artworks');
    if (!sheet) return { success: false, error: 'シート ' + ex + '_artworks が見つかりません。' };

    const allData = sheet.getDataRange().getValues();
    const headers = allData[0];
    const idColIdx = colIndex(headers, 'artwork_id');
    const statusColIdx = colIndex(headers, 'status');

    // 非表示にする列（artwork_id / security_key / image_url / qr_url はクリアしない）
    const KEEP_COLS = ['artwork_id', 'security_key', 'image_url', 'qr_url'];

    for (let i = 1; i < allData.length; i++) {
      if (allData[i][idColIdx].toString().trim() !== artworkId.toString().trim()) continue;

      // status を 0 に戻す
      sheet.getRange(i + 1, statusColIdx + 1).setValue(0);

      // KEEP_COLS 以外をクリア
      headers.forEach((h, idx) => {
        if (!h || KEEP_COLS.includes(h)) return;
        sheet.getRange(i + 1, idx + 1).setValue('');
      });
      clearAllCache(ex);
      return { success: true };
    }

    return { success: false, error: '作品が見つかりません。' };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}