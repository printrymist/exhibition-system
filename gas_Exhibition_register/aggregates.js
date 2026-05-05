// =========================================================
// 🌟 Aggregates on exhibitions sheet
//
// exhibitions シートに集計列(artworks_total / artworks_registered /
// last_artwork_update_at)を載せる。書き込み時に増減する方式。
//
// 提供関数:
//   - recountAllArtworks()       : 全展覧会の現状を再集計（一発実行用）
//   - bumpArtworkCount(ex, dT, dR): 増減（runSetup / saveArtwork 等から呼ぶ）
//   - ensureAggregateColumns(sh) : 必要な列が無ければ右端に追加
// =========================================================

const AGG_COLS = ['artworks_total', 'artworks_registered', 'last_artwork_update_at'];

function ensureAggregateColumns(sheet) {
  const last = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, last).getValues()[0];
  AGG_COLS.forEach(name => {
    if (headers.indexOf(name) === -1) {
      const col = sheet.getLastColumn() + 1;
      sheet.getRange(1, col).setValue(name);
      const r = sheet.getRange(1, col);
      r.setBackground('#1a73e8');
      r.setFontColor('#ffffff');
      r.setFontWeight('bold');
    }
  });
}

// 全展覧会の現状を artwork SS から数え直して exhibitions に書き戻す
function recountAllArtworks() {
  const ss = SpreadsheetApp.openById(MASTER_SS_ID);
  const sheet = ss.getSheetByName('exhibitions');
  if (!sheet) throw new Error('exhibitions sheet not found');

  ensureAggregateColumns(sheet);

  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const exIdx = headers.indexOf('ex_code');
  const artSheetIdIdx = headers.indexOf('artwork_sheet_id');
  const totalIdx = headers.indexOf('artworks_total');
  const regIdx = headers.indexOf('artworks_registered');
  const lastIdx = headers.indexOf('last_artwork_update_at');

  const results = [];
  for (let i = 1; i < data.length; i++) {
    const exCode = (data[i][exIdx] || '').toString().trim();
    const artSheetId = (data[i][artSheetIdIdx] || '').toString().trim();
    if (!exCode) continue;
    if (!artSheetId) {
      results.push(exCode + ': artwork_sheet_id 未設定 -> skip');
      continue;
    }
    try {
      const artSS = SpreadsheetApp.openById(artSheetId);
      const artSheet = artSS.getSheetByName(exCode + '_artworks');
      if (!artSheet) {
        results.push(exCode + ': シート ' + exCode + '_artworks 無し -> skip');
        continue;
      }
      const aData = artSheet.getDataRange().getValues();
      const aHeaders = aData[0];
      const aIdIdx = aHeaders.indexOf('artwork_id');
      const aStatusIdx = aHeaders.indexOf('status');
      let total = 0, reg = 0;
      for (let j = 1; j < aData.length; j++) {
        const id = (aData[j][aIdIdx] || '').toString().trim();
        if (!id) continue;
        total++;
        const status = (aData[j][aStatusIdx] || '').toString().trim();
        if (status === '1') reg++;
      }
      sheet.getRange(i + 1, totalIdx + 1).setValue(total);
      sheet.getRange(i + 1, regIdx + 1).setValue(reg);
      results.push(exCode + ': ' + reg + '/' + total);
    } catch (e) {
      results.push(exCode + ': ERROR ' + e.message);
    }
  }
  console.log('recountAllArtworks 完了:\n' + results.join('\n'));
  return { success: true, results: results };
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
