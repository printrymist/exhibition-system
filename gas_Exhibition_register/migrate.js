// =========================================================
// 🌟 Master SS Schema Migration (Phase A)
//
// 実行手順:
//   1. GAS エディタで migrateExhibitionsSchemaA を選んで実行
//   2. ログを確認（行数・ヘッダー・バックアップ名）
//   3. exhibitions シートを開いて目視確認
//
// 何をするか:
//   - exhibitions シートの列を整理（識別→連絡先→リソース→設定→ログ→memo の順）
//   - applications から organizer / email / venue / start_date を転記
//   - 旧 memo 列に timestamp が紛れ込んでいたら created_at に移す
//   - status, updated_at の列を新設し、既存行の status は 'active' で初期化
//
// 冪等性: 何度実行しても同じ結果になる（差分のある列だけ埋まる）
// =========================================================

const TARGET_COLUMNS = [
  'ex_code',
  'ex_name',
  'status',
  'artworks_registered',
  'artworks_total',
  'last_artwork_update_at',
  'organizer',
  'email',
  'venue',
  'start_date',
  'password',
  'image_folder_id',
  'artwork_sheet_id',
  'comment_sheet_id',
  'registration_fields',
  'caption_fields',
  'created_at',
  'updated_at',
  'memo'
];

function migrateExhibitionsSchemaA() {
  const ss = SpreadsheetApp.openById(MASTER_SS_ID);
  const sheet = ss.getSheetByName('exhibitions');
  if (!sheet) throw new Error('exhibitions sheet not found');

  // --- 0. バックアップ作成 ---
  const stamp = Utilities.formatDate(new Date(), 'JST', 'yyyyMMdd_HHmmss');
  const backupName = 'exhibitions_backup_' + stamp;
  sheet.copyTo(ss).setName(backupName);
  console.log('バックアップ作成: ' + backupName);

  // --- 1. 現在のデータをスナップショット ---
  const data = sheet.getDataRange().getValues();
  const oldHeaders = data[0].map(h => h.toString().trim());
  const rows = data.slice(1);
  console.log('旧ヘッダー: ' + JSON.stringify(oldHeaders));
  console.log('行数: ' + rows.length);

  const oldIdx = {};
  oldHeaders.forEach((h, i) => { if (h) oldIdx[h] = i; });

  // --- 2. applications を ex_code → row でインデックス化 ---
  const appSheet = ss.getSheetByName('applications');
  const appByCode = {};
  let appHeaders = [];
  if (appSheet) {
    const appData = appSheet.getDataRange().getValues();
    if (appData.length > 0) {
      appHeaders = appData[0].map(h => h.toString().trim());
      const aExIdx = appHeaders.indexOf('ex_code');
      if (aExIdx !== -1) {
        // 同じ ex_code が複数ある場合、後勝ち（既存の getInquiryContext と同挙動）
        for (let i = 1; i < appData.length; i++) {
          const code = (appData[i][aExIdx] || '').toString().trim();
          if (code) appByCode[code] = appData[i];
        }
      }
    }
  }
  function appVal(code, name) {
    const r = appByCode[code];
    if (!r) return '';
    const i = appHeaders.indexOf(name);
    if (i === -1) return '';
    const v = r[i];
    return v === undefined || v === null ? '' : v;
  }

  // --- 3. 新行を組み立て ---
  function pickOld(row, name) {
    const i = oldIdx[name];
    return i === undefined ? '' : (row[i] === undefined || row[i] === null ? '' : row[i]);
  }
  function isTimestampish(v) {
    const s = (v === null || v === undefined) ? '' : v.toString().trim();
    if (!s) return false;
    if (v instanceof Date) return true;
    return /^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(s);
  }

  const newRows = rows.map(r => {
    const exCode = pickOld(r, 'ex_code').toString().trim();

    // memo に timestamp が紛れ込んでいた歴史的事情を救済
    const oldMemo = pickOld(r, 'memo');
    const oldCreated = pickOld(r, 'created_at');
    const createdAt = oldCreated || (isTimestampish(oldMemo) ? oldMemo : '');
    const memo = isTimestampish(oldMemo) ? '' : oldMemo;

    const o = {
      ex_code: exCode,
      ex_name: pickOld(r, 'ex_name'),
      status: pickOld(r, 'status') || 'active',
      organizer: pickOld(r, 'organizer') || appVal(exCode, 'organizer'),
      email: pickOld(r, 'email') || appVal(exCode, 'email'),
      venue: pickOld(r, 'venue') || appVal(exCode, 'venue'),
      start_date: pickOld(r, 'start_date') || appVal(exCode, 'start_date'),
      password: pickOld(r, 'password'),
      image_folder_id: pickOld(r, 'image_folder_id'),
      artwork_sheet_id: pickOld(r, 'artwork_sheet_id'),
      comment_sheet_id: pickOld(r, 'comment_sheet_id'),
      registration_fields: pickOld(r, 'registration_fields'),
      caption_fields: pickOld(r, 'caption_fields'),
      created_at: createdAt,
      updated_at: pickOld(r, 'updated_at'),
      memo: memo
    };
    return o;
  });

  // --- 4. シートをクリアして新スキーマで書き直し ---
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow > 0 && lastCol > 0) {
    sheet.getRange(1, 1, lastRow, lastCol).clearContent();
    sheet.getRange(1, 1, lastRow, lastCol).clearFormat();
  }

  sheet.getRange(1, 1, 1, TARGET_COLUMNS.length).setValues([TARGET_COLUMNS]);

  if (newRows.length > 0) {
    const out = newRows.map(o => TARGET_COLUMNS.map(c => o[c] === undefined ? '' : o[c]));
    sheet.getRange(2, 1, out.length, TARGET_COLUMNS.length).setValues(out);
  }

  // ヘッダー装飾
  const headerRange = sheet.getRange(1, 1, 1, TARGET_COLUMNS.length);
  headerRange.setBackground('#1a73e8');
  headerRange.setFontColor('#ffffff');
  headerRange.setFontWeight('bold');
  sheet.setFrozenRows(1);

  // 余分な列があれば削除（左に寄せた後の右側）
  const maxCol = sheet.getMaxColumns();
  if (maxCol > TARGET_COLUMNS.length) {
    sheet.deleteColumns(TARGET_COLUMNS.length + 1, maxCol - TARGET_COLUMNS.length);
  }

  // --- 5. キャッシュ無効化（Exhibition_register 側） ---
  newRows.forEach(o => { if (o.ex_code) clearAllCache(o.ex_code); });

  console.log('migration 完了: ' + newRows.length + ' 行を ' + TARGET_COLUMNS.length + ' 列に整形しました。');
  console.log('バックアップ: ' + backupName + ' （問題なければ手動で削除してください）');
  console.log('※ Caption Maker 側のキャッシュは SCHEMA_VERSION のバンプで自動的に無効化されます。');

  return {
    success: true,
    rowCount: newRows.length,
    columns: TARGET_COLUMNS,
    backup: backupName
  };
}
