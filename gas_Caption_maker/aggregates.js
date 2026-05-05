// =========================================================
// 🌟 Aggregates on exhibitions sheet (Caption Maker 側)
//
// gas_Exhibition_register 側の aggregates.js と同じ bump ヘルパー。
// プロジェクト間で関数共有できないため duplicate。
// 仕様変更時は両方を必ず揃えること。
// =========================================================

// exhibitions シートのカウンタを絶対値で書き込む（recount から呼ぶ）
function setArtworkCount(exCode, total, registered) {
  try {
    if (!exCode) return { success: false, error: 'no exCode' };
    const ss = SpreadsheetApp.openById(MASTER_SS_ID);
    const sheet = ss.getSheetByName('exhibitions');
    if (!sheet) return { success: false, error: 'no exhibitions sheet' };
    const data = sheet.getDataRange().getValues();
    const headers = data[0];
    const exIdx = headers.indexOf('ex_code');
    const totalIdx = headers.indexOf('artworks_total');
    const regIdx = headers.indexOf('artworks_registered');
    const lastIdx = headers.indexOf('last_artwork_update_at');
    if (exIdx === -1) return { success: false, error: 'no ex_code col' };
    const target = exCode.toString().trim();
    for (let i = 1; i < data.length; i++) {
      if ((data[i][exIdx] || '').toString().trim() !== target) continue;
      if (totalIdx !== -1 && total != null) sheet.getRange(i + 1, totalIdx + 1).setValue(total);
      if (regIdx !== -1 && registered != null) sheet.getRange(i + 1, regIdx + 1).setValue(registered);
      if (lastIdx !== -1) sheet.getRange(i + 1, lastIdx + 1)
        .setValue(Utilities.formatDate(new Date(), 'JST', 'yyyy/MM/dd HH:mm:ss'));
      return { success: true };
    }
    return { success: false, error: 'ex_code not found in sheet' };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// exhibitions シートのカウンタを増減する
//   deltaTotal: artworks_total の増減（addArtworks で +N、特にない場合 0）
//   deltaRegistered: artworks_registered の増減（saveArtwork で +1, deleteArtwork で -1）
function bumpArtworkCount(exCode, deltaTotal, deltaRegistered) {
  try {
    if (!exCode) return;
    const ss = SpreadsheetApp.openById(MASTER_SS_ID);
    const sheet = ss.getSheetByName('exhibitions');
    if (!sheet) return;
    const data = sheet.getDataRange().getValues();
    const headers = data[0];
    const exIdx = headers.indexOf('ex_code');
    const totalIdx = headers.indexOf('artworks_total');
    const regIdx = headers.indexOf('artworks_registered');
    const lastIdx = headers.indexOf('last_artwork_update_at');
    if (exIdx === -1) return;
    const target = exCode.toString().trim();
    for (let i = 1; i < data.length; i++) {
      if ((data[i][exIdx] || '').toString().trim() !== target) continue;
      if (deltaTotal && totalIdx !== -1) {
        const cur = parseInt(data[i][totalIdx]) || 0;
        sheet.getRange(i + 1, totalIdx + 1).setValue(cur + deltaTotal);
      }
      if (deltaRegistered && regIdx !== -1) {
        const cur = parseInt(data[i][regIdx]) || 0;
        const next = Math.max(0, cur + deltaRegistered);
        sheet.getRange(i + 1, regIdx + 1).setValue(next);
      }
      if (lastIdx !== -1) {
        sheet.getRange(i + 1, lastIdx + 1)
          .setValue(Utilities.formatDate(new Date(), 'JST', 'yyyy/MM/dd HH:mm:ss'));
      }
      return;
    }
  } catch (e) {
    console.warn('bumpArtworkCount failed for ' + exCode + ': ' + e.message);
  }
}
