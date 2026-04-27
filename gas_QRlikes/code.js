// =========================================================
// 🌟 ブロック①：共通の入り口と「切り替えスイッチ」
// =========================================================
const MASTER_SS_ID = "1h0uSnoUBuQnEqWmFXIOUIRK2CvigmkOmucsWOnaS6xQ";

// 🌟 ヘッダー名から列インデックスを取得するユーティリティ
// 列番号の直打ちをやめてヘッダー名で参照することで拡張性を確保
function colIndex(headers, name) {
  const idx = headers.indexOf(name);
  if (idx === -1) throw new Error("Column not found: " + name);
  return idx;
}

function doGet(e) {
  const { ex, id, key } = e.parameter;

  const data = ansGetArtworkData(ex, id);

  if (!data || data.securityKey !== key) {
    return HtmlService.createHtmlOutput(
      "<div style='padding:40px; text-align:center; font-family:sans-serif;'>" +
      "<h2 style='color:#d93025;'>🚫 アクセスエラー</h2>" +
      "<p>このURLは無効です。正しいQRコードを使用してください。</p>" +
      "<p style='color:#666; font-size:0.8em; margin-top:20px;'>Rohei Printer System</p></div>"
    ).setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }

  const mode = data.isRegistered ? "ANS" : "REG";

  const tmp = HtmlService.createTemplateFromFile('index');
  tmp.ex = ex;
  tmp.id = id;
  tmp.mode = mode;
  tmp.artworkData = mode === "ANS" ? JSON.stringify(data) : "null";

  return tmp.evaluate()
    .setTitle(`${data.exName} | ${data.title || '作品受付'}`)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function doPost(e) {
  const output = ContentService.createTextOutput();
  output.setMimeType(ContentService.MimeType.JSON);

  try {
    const action = e.parameter.action;
    const ex = e.parameter.ex;
    const id = e.parameter.id;
    const key = e.parameter.key;

    // セキュリティチェック
    const data = ansGetArtworkData(ex, id);
    if (!data || data.securityKey !== key) {
      output.setContent(JSON.stringify({
        success: false, error: 'アクセスエラー'
      }));
      return output;
    }

    if (action === 'checkArtworkStatus') {
      const mode = data.isRegistered ? "ANS" : "REG";
      const result = { mode: mode, success: true };
      if (mode === "ANS") Object.assign(result, data);
      output.setContent(JSON.stringify(result));
      return output;
    }

    if (action === 'getArtworkData' || action === 'ansGetArtworkData') {
      output.setContent(JSON.stringify(data));
      return output;
    }

    if (action === 'regGetSetupData') {
      const res = regGetSetupData(ex, id);
      output.setContent(JSON.stringify(res));
      return output;
    }

    if (action === 'regCommitRegistration') {
      // ✅ payloadを直接渡す
      const payload = {
        ex: ex,
        id: id,
        artistName: e.parameter.artistName,
        workTitle: e.parameter.workTitle,
        sns: JSON.parse(e.parameter.sns || '{}'),
        imageData: e.parameter.imageData || ''
      };
      const res = regCommitRegistration(payload);
      output.setContent(JSON.stringify(res));
      return output;
    }

    if (action === 'ansProcessForm') {
      // ✅ formDataを直接渡す
      const formData = {
        sessionId:  e.parameter.sessionId,
        workID:     e.parameter.workID,
        ex:         e.parameter.ex,
        workTitle:  e.parameter.workTitle,
        workArtist: e.parameter.workArtist,
        isLike:     e.parameter.isLike,
        nickname:   e.parameter.nickname,
        comment:    e.parameter.comment
      };
      const res = ansProcessForm(formData);
      output.setContent(JSON.stringify(res));
      return output;
    }

    if (action === 'verifyAdmin') {
      const res = verifyAdmin(ex, e.parameter.password);
      output.setContent(JSON.stringify(res));
      return output;
    }

    if (action === 'ansSyncSnsToAll') {
      const sns = JSON.parse(e.parameter.sns || '{}');
      const res = ansSyncSnsToAll(ex, e.parameter.artist, sns);
      output.setContent(JSON.stringify(res));
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

function checkArtworkStatus(ex, id) {
  try {
    const master = getMasterData(ex);
    if (!master) return { mode: "ERROR", msg: "展覧会データが見つかりません" };

    const ss = SpreadsheetApp.openById(master.artwork_sheet_id);
    const sheet = ss.getSheetByName(ex + "_artworks");
    const data = sheet.getDataRange().getValues();
    const headers = data[0];
    const row = data.find((r, i) => i > 0 && r[colIndex(headers, "artwork_id")].toString() === id.toString());

    if (!row) return { mode: "ERROR", msg: "作品IDが見つかりません" };

    if (row[colIndex(headers, "status")].toString() === "1") {
      return { mode: "ANS" };
    } else {
      return { mode: "REG" };
    }
  } catch (e) {
    return { mode: "ERROR", msg: e.toString() };
  }
}

// =========================================================
// 🟢 ブロック②：共通の裏方ツール（両方で使うもの）
// =========================================================
function verifyAdmin(ex, inputPw) {
  var master = getMasterData(ex);
  var sheetPw = master.password ? master.password.toString().trim() : "";
  var normalizedInput = inputPw.trim().replace(/[０-９]/g, function(s) {
    return String.fromCharCode(s.charCodeAt(0) - 0xFEE0);
  });
  return { success: (normalizedInput === sheetPw) };
}

function getCacheVersion(ex) {
  var cache = CacheService.getScriptCache();
  var version = cache.get("version_" + ex);
  if (!version) {
    version = new Date().getTime().toString(); 
    cache.put("version_" + ex, version, 21600);
  }
  return version;
}

function getMasterData(ex) {
  var cache = CacheService.getScriptCache();
  var version = getCacheVersion(ex);
  var cacheKey = "master_data_" + ex + "_v" + version;
  var cached = cache.get(cacheKey);

  if (cached) {
    console.log("マスターをキャッシュから読み込みました: " + ex);
    return JSON.parse(cached);
  }

  console.log("マスターをスプレッドシートから読み込みます: " + ex);
  var ss = SpreadsheetApp.openById(MASTER_SS_ID);
  var allData = ss.getSheetByName('exhibitions').getDataRange().getValues();
  var headers = allData[0];
  var row = allData.find((r, i) => i > 0 && r[colIndex(headers, "ex_code")].toString() === ex.toString());
  if (!row) return null;

  var masterObj = {
    ex_code:          row[colIndex(headers, "ex_code")],
    image_folder_id:  row[colIndex(headers, "image_folder_id")],
    artwork_sheet_id: row[colIndex(headers, "artwork_sheet_id")],
    comment_sheet_id: row[colIndex(headers, "comment_sheet_id")],
    ex_name:          row[colIndex(headers, "ex_name")],
    password:         row[colIndex(headers, "password")],
    memo:             row[colIndex(headers, "memo")],
    updatedAt:        new Date().getTime()
  };

  cache.put(cacheKey, JSON.stringify(masterObj), 21600); 
  return masterObj;
}

function clearAllCache(ex) {
  var cache = CacheService.getScriptCache();
  cache.remove("version_" + ex);
  console.log(ex + " のキャッシュをリセットしました。");
}

// =========================================================
// 🔵 ブロック③：作家向けの処理（登録用 / reg）
// =========================================================
function regGetSetupData(ex, id) {
  try {
    const master = getMasterData(ex);
    if (!master) throw new Error("展覧会データが見つかりません。");
    const boothSheet = SpreadsheetApp.openById(master.artwork_sheet_id).getSheetByName(ex + "_artworks");
    const boothData = boothSheet.getDataRange().getValues();
    const headers = boothData[0];

    const rowIdx = boothData.findIndex((r, i) => i > 0 && r[colIndex(headers, "artwork_id")].toString() === id.toString());
    if (rowIdx === -1) throw new Error("作品IDが見つかりません。");
    const currentRow = boothData[rowIdx];

    let displayImageUrl = "";
    let rawUrl = currentRow[colIndex(headers, "image_url")] || ""; 
    if (rawUrl.includes("drive.google.com/file/d/")) {
      const match = rawUrl.match(/d\/([a-zA-Z0-9_-]+)/);
      if (match && match[1]) {
        try {
          const file = DriveApp.getFileById(match[1]);
          displayImageUrl = "data:" + file.getMimeType() + ";base64," + Utilities.base64Encode(file.getBlob().getBytes());
        } catch(e) { displayImageUrl = ""; }
      }
    }

    const artistsMap = {};
    boothData.slice(1).forEach(r => {
      const name = r[colIndex(headers, "artist")];
      if (r[colIndex(headers, "status")] == 1 && name) {
        if (!artistsMap[name]) artistsMap[name] = { name: name, insta: "", x: "", fb: "", web: "" };
        if (!artistsMap[name].insta) artistsMap[name].insta = r[colIndex(headers, "insta")] || "";
        if (!artistsMap[name].x)     artistsMap[name].x     = r[colIndex(headers, "x")] || "";
        if (!artistsMap[name].fb)    artistsMap[name].fb    = r[colIndex(headers, "facebook")] || "";
        if (!artistsMap[name].web)   artistsMap[name].web   = r[colIndex(headers, "web")] || "";
      }
    });

    return {
      success: true,
      isLocked: (currentRow[colIndex(headers, "status")] == 1), 
      exName: master.ex_name || "名称未設定",
      masterPass: master.password.toString(),
      artistName: currentRow[colIndex(headers, "artist")] || "",
      workTitle:  currentRow[colIndex(headers, "title")] || "",
      imageUrl:   displayImageUrl,
      sns: {
        insta: currentRow[colIndex(headers, "insta")]    || "",
        x:     currentRow[colIndex(headers, "x")]        || "",
        fb:    currentRow[colIndex(headers, "facebook")] || "",
        web:   currentRow[colIndex(headers, "web")]      || ""
      },
      registeredArtists: Object.values(artistsMap)
    };
  } catch (e) { return { success: false, error: e.toString() }; }
}

function regCommitRegistration(payload) {
  try {
    const { ex, id, artistName, workTitle, sns, imageData } = payload;
    const master = getMasterData(ex);
    if (!master) throw new Error("マスターデータが見つかりません");

    const targetSS = SpreadsheetApp.openById(master.artwork_sheet_id);
    const boothSheet = targetSS.getSheetByName(ex + "_artworks");
    const data = boothSheet.getDataRange().getValues();
    const headers = data[0];

    const rowIdx = data.findIndex((r, i) => i > 0 && r[colIndex(headers, "artwork_id")].toString() === id.toString()) + 1;
    if (rowIdx === 0) throw new Error("作品IDが見つかりません");

    const titleCol   = colIndex(headers, "title")    + 1;
    const artistCol  = colIndex(headers, "artist")   + 1;
    const imageCol   = colIndex(headers, "image_url")+ 1;
    const statusCol  = colIndex(headers, "status")   + 1;
    const instaCol   = colIndex(headers, "insta")    + 1;
    const xCol       = colIndex(headers, "x")        + 1;
    const fbCol      = colIndex(headers, "facebook") + 1;
    const webCol     = colIndex(headers, "web")      + 1;

    boothSheet.getRange(rowIdx, titleCol).setValue(workTitle);
    boothSheet.getRange(rowIdx, artistCol).setValue(artistName);

    if (imageData) {
      const folder = DriveApp.getFolderById(master.image_folder_id);
      const oldFiles = folder.getFilesByName(`${ex}_${id}.jpg`);
      while (oldFiles.hasNext()) {
        oldFiles.next().setTrashed(true);
      }
      const blob = Utilities.newBlob(Utilities.base64Decode(imageData.split(',')[1]), "image/jpeg", `${ex}_${id}.jpg`);
      const file = folder.createFile(blob);
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      boothSheet.getRange(rowIdx, imageCol).setValue(file.getUrl());
    }

    boothSheet.getRange(rowIdx, instaCol).setValue(sns.insta);
    boothSheet.getRange(rowIdx, xCol).setValue(sns.x);
    boothSheet.getRange(rowIdx, fbCol).setValue(sns.fb);
    boothSheet.getRange(rowIdx, webCol).setValue(sns.web);
    boothSheet.getRange(rowIdx, statusCol).setValue("1");
    
    var cache = CacheService.getScriptCache();
    var version = getCacheVersion(ex); 
    cache.remove("artwork_" + ex + "_" + id + "_v" + version);
    
    console.log("作品ID:" + id + " の更新に伴い、個別キャッシュをクリアしました。");

    return { success: true };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

// =========================================================
// 🟡 ブロック④：一般客向けの処理（回答用 / ans）
// =========================================================
function ansGetArtworkData(ex, id) {
  try {
    var master = getMasterData(ex);
    if (!master) return { success: false, msg: "展覧会が見つかりません" };

    var cache = CacheService.getScriptCache();
    var version = getCacheVersion(ex); 
    var cacheKey = "artwork_" + ex + "_" + id + "_v" + version;
    var cached = cache.get(cacheKey);

    if (cached) {
      console.log("作品データをキャッシュから即時取得しました: " + id);
      return JSON.parse(cached);
    }

    console.log("作品データをスプレッドシートから読み込みます: " + id);
    var targetSS = SpreadsheetApp.openById(master.artwork_sheet_id);
    var allData = targetSS.getSheetByName(ex + "_artworks").getDataRange().getValues();
    var headers = allData[0];
    var work = allData.find((r, i) => i > 0 && r[colIndex(headers, "artwork_id")].toString() === id.toString());
    
    if (!work) return { success: false, msg: "作品IDが見つかりません" };

    var resultObj = {
      success:      true,
      securityKey:  work[colIndex(headers, "security_key")],
      isRegistered: (work[colIndex(headers, "status")].toString() === "1"),
      exName:       master.ex_name,
      title:        work[colIndex(headers, "title")],
      artist:       work[colIndex(headers, "artist")],
      image:        String(work[colIndex(headers, "image_url")]),
      sns: { 
        insta: work[colIndex(headers, "insta")]    || "",
        x:     work[colIndex(headers, "x")]        || "",
        fb:    work[colIndex(headers, "facebook")] || "",
        web:   work[colIndex(headers, "web")]      || ""
      }
    };

    cache.put(cacheKey, JSON.stringify(resultObj), 21600);
    return resultObj;

  } catch(e) { return { success: false, msg: "取得エラー: " + e.toString() }; }
}

function ansProcessForm(formData) {
  // --- A. 基本コマンド ---
  if (formData.nickname === formData.workArtist) {
    if (formData.comment === "ログイン" || formData.comment.toLowerCase() === "login") return { action: "PROMPT_PASSWORD" };
    if (formData.comment === "ログアウト" || formData.comment.toLowerCase() === "logout") return { action: "LOGOUT_SUCCESS" };
    if (formData.comment === "SNS同期" || formData.comment === "ＳＮＳ同期" || formData.comment === "sns同期" || formData.comment.toLowerCase() === "sns sync") {
      return { action: "SNS_SYNC_REQUEST" };
    }
  }

  // --- B. 展覧会設定の取得 ---
  var master = getMasterData(formData.ex);
  if (!master) return { action: "ERROR", msg: "展覧会データが見つかりません" };

  // --- C. 作家名が一致した場合のコマンド判定 ---
  if (formData.nickname === formData.workArtist) {
    
    if (formData.comment === "リセット" || formData.comment.toLowerCase() === "reset") {
      var cache = CacheService.getScriptCache();
      var newVersion = new Date().getTime().toString(); 
      cache.put("version_" + formData.ex, newVersion, 21600); 
      return { action: "ERROR", msg: "reset" };
    }

    if (formData.comment === "登録解除" || formData.comment.toLowerCase() === "unlock") {
      var targetSS = SpreadsheetApp.openById(master.artwork_sheet_id);
      var targetSheet = targetSS.getSheetByName(formData.ex + "_artworks");
      var data = targetSheet.getDataRange().getValues();
      var headers = data[0];
      var rowIndex = data.findIndex((r, i) => i > 0 && r[colIndex(headers, "artwork_id")].toString() === formData.workID.toString()) + 1;
      
      if (rowIndex > 0) {
        targetSheet.getRange(rowIndex, colIndex(headers, "status") + 1).setValue("");
        return { action: "UNLOCK_SUCCESS" };
      }
    }

    return { action: "ERROR", msg: "入力エラー：作家本人のお名前での投稿はできません。" };
  }

  // --- D. 一般客用の感想保存処理 ---
  var ss = SpreadsheetApp.openById(master.comment_sheet_id); 
  var sheet = ss.getSheetByName(formData.ex + "_comments");
  sheet.appendRow([
    new Date(),
    formData.ex,
     master.ex_name || "", 
    formData.workID,
    formData.workTitle,
    formData.workArtist,
    formData.nickname || "Anonymous",
    Number(formData.isLike === "0" ? 0 : 1),
    formData.comment,
    formData.sessionId || ""
  ]);
  
  return { action: "COUNT", count: getCountForID(formData.ex, formData.workID) };
}

function getCountForID(ex, id) {
  var master = getMasterData(ex);
  var ss = SpreadsheetApp.openById(master.comment_sheet_id);
  var sheet = ss.getSheetByName(ex + "_comments");
  var data = sheet.getDataRange().getValues();
  var headers = data[0];
  var count = 0;
  
  for (var i = 1; i < data.length; i++) {
    if (data[i][colIndex(headers, "ex_code")].toString()   === ex.toString() &&
        data[i][colIndex(headers, "artwork_id")].toString() === id.toString() &&
        data[i][colIndex(headers, "like")].toString()       === "1") {
      count++;
    }
  }
  
  return count;
}

function ansSyncSnsToAll(ex, artistName, snsData) {
  try {
    const master = getMasterData(ex);
    const ss = SpreadsheetApp.openById(master.artwork_sheet_id);
    const sheet = ss.getSheetByName(ex + "_artworks");
    const data = sheet.getDataRange().getValues();
    const headers = data[0];
    
    const targetArtist = artistName.toString().trim();

    for (let i = 1; i < data.length; i++) {
      if (data[i][colIndex(headers, "artist")].toString().trim() === targetArtist) {
        sheet.getRange(i + 1, colIndex(headers, "insta")    + 1).setValue(snsData.insta.trim());
        sheet.getRange(i + 1, colIndex(headers, "x")        + 1).setValue(snsData.x.trim());
        sheet.getRange(i + 1, colIndex(headers, "facebook") + 1).setValue(snsData.fb.trim());
        sheet.getRange(i + 1, colIndex(headers, "web")      + 1).setValue(snsData.web.trim());
        
        var cache = CacheService.getScriptCache();
        var version = getCacheVersion(ex);
        cache.remove("artwork_" + ex + "_" + data[i][colIndex(headers, "artwork_id")] + "_v" + version);
      }
    }
    return { success: true };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

function testDoPost() {
  const e = {
    parameter: {
      action: 'getArtworkData',
      ex: 'ET003',
      id: 'w001',
      key: 'eifkz3ty'
    }
  };
  const result = doPost(e);
  Logger.log(result.getContent());
}