// =========================================================
// 🌟 一括パージ（Drive + exhibitions シート）
//
// 実行手順:
//   1. purgeExhibitionsDryRun を実行して削除対象を確認
//   2. 問題なければ purgeExhibitionsConfirmed を実行
//   3. Firestore 側はブラウザコンソールから別途削除
//
// 設計:
//   - 1 件処理して終わったら SS を読み直して次の未処理を探す
//   - 途中で死んでも、再実行すれば残りを安全に処理する（idempotent）
//   - すでに trashed のファイル / 不在のフォルダはスキップ
//
// モード:
//   - REMOVE_CODES が空 → KEEP_CODES に無いもの全部を削除（従来）
//   - REMOVE_CODES に何か入っている → その指定 ex_code だけを削除（KEEP_CODES 無視）
// =========================================================

const KEEP_CODES = []; // 空 → 全件削除モード
const REMOVE_CODES = []; // 例: ['TEX01', 'TE006'] と入れると、これだけを削除する

function _shouldDelete(code) {
  if (!code) return false;
  if (REMOVE_CODES && REMOVE_CODES.length > 0) {
    return REMOVE_CODES.map(c => c.toString().trim()).indexOf(code) !== -1;
  }
  return KEEP_CODES.map(c => c.toString().trim()).indexOf(code) === -1;
}

function _purgeMode() {
  return (REMOVE_CODES && REMOVE_CODES.length > 0) ? 'REMOVE_CODES' : 'KEEP_CODES';
}

function purgeExhibitionsDryRun() {
  const ss = SpreadsheetApp.openById(MASTER_SS_ID);
  const sheet = ss.getSheetByName('exhibitions');
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const exIdx = headers.indexOf('ex_code');
  const targets = [];
  for (let i = 1; i < data.length; i++) {
    const code = (data[i][exIdx] || '').toString().trim();
    if (!_shouldDelete(code)) continue;
    targets.push(code);
  }
  console.log('=== DRY RUN ===');
  console.log('mode: ' + _purgeMode());
  if (_purgeMode() === 'REMOVE_CODES') {
    console.log('REMOVE_CODES: ' + REMOVE_CODES.join(', '));
  } else {
    console.log('KEEP_CODES: ' + (KEEP_CODES.length ? KEEP_CODES.join(', ') : '(なし → 全件削除)'));
  }
  console.log('削除予定 ' + targets.length + ' 件:');
  targets.forEach(c => console.log('  - ' + c));
  console.log('問題なければ purgeExhibitionsConfirmed を実行してください。');
  return { dryRun: true, count: targets.length, targets: targets, mode: _purgeMode() };
}

function purgeExhibitionsConfirmed() {
  const ss = SpreadsheetApp.openById(MASTER_SS_ID);
  const sheet = ss.getSheetByName('exhibitions');
  if (!sheet) throw new Error('exhibitions sheet not found');

  const masterFile = DriveApp.getFileById(MASTER_SS_ID);
  const parentFolder = masterFile.getParents().next();

  console.log('mode: ' + _purgeMode());

  let processed = 0;
  const errors = [];
  const doneCodes = [];
  const MAX_ITER = 100; // 念のため無限ループ防止

  for (let iter = 0; iter < MAX_ITER; iter++) {
    // 毎回 SS を読み直して未処理の先頭を探す
    const data = sheet.getDataRange().getValues();
    const headers = data[0];
    const exIdx = headers.indexOf('ex_code');
    const artIdx = headers.indexOf('artwork_sheet_id');
    const cmtIdx = headers.indexOf('comment_sheet_id');

    let target = null, targetRow = -1;
    for (let i = 1; i < data.length; i++) {
      const code = (data[i][exIdx] || '').toString().trim();
      if (!_shouldDelete(code)) continue;
      target = {
        ex_code: code,
        artwork_sheet_id: (data[i][artIdx] || '').toString().trim(),
        comment_sheet_id: (data[i][cmtIdx] || '').toString().trim()
      };
      targetRow = i + 1;
      break;
    }
    if (!target) break;

    console.log('[' + (processed + 1) + '] ' + target.ex_code + ' を処理中...');

    let stepOk = true;

    // Drive 1: artwork SS
    stepOk = _safeTrashFileById(target.artwork_sheet_id, target.ex_code + ' artworks SS') && stepOk;
    Utilities.sleep(150);

    // Drive 2: comment SS
    stepOk = _safeTrashFileById(target.comment_sheet_id, target.ex_code + ' comments SS') && stepOk;
    Utilities.sleep(150);

    // Drive 3: WorkSpace folder
    try {
      const folders = parentFolder.getFoldersByName(target.ex_code + '_WorkSpace');
      if (folders.hasNext()) {
        const folder = folders.next();
        if (!folder.isTrashed()) {
          folder.setTrashed(true);
          console.log('  WorkSpace folder -> trash');
        } else {
          console.log('  WorkSpace folder 既に trash 済み');
        }
      } else {
        console.log('  WorkSpace folder 見つからず（既に消去済み？）');
      }
    } catch (e) {
      console.warn('  WorkSpace folder エラー: ' + e.message);
      stepOk = false;
    }
    Utilities.sleep(150);

    // SS 行削除
    try {
      sheet.deleteRow(targetRow);
      console.log('  row ' + targetRow + ' を削除');
    } catch (e) {
      console.error('  row 削除失敗: ' + e.message);
      errors.push({ ex_code: target.ex_code, error: 'row delete: ' + e.message });
      // 行が消せないと無限ループになるので停止
      break;
    }

    // キャッシュクリア
    try { clearAllCache(target.ex_code); } catch (e) {}

    if (!stepOk) errors.push({ ex_code: target.ex_code, error: 'partial drive cleanup' });
    doneCodes.push(target.ex_code);
    processed++;
    Utilities.sleep(200);
  }

  console.log('=== purge 完了 ===');
  console.log('処理: ' + processed + ' 件');
  console.log('処理した ex_code: ' + doneCodes.join(', '));
  if (errors.length > 0) {
    console.log('エラー / 部分失敗: ' + errors.length + ' 件');
    errors.forEach(e => console.log('  - ' + e.ex_code + ': ' + e.error));
  }
  console.log('次に Firestore 側を消去してください（ブラウザコンソールから）。');
  return { processed: processed, errors: errors, doneCodes: doneCodes };
}

// =========================================================
// 🌟 孤児フォルダ検出・削除
//   親フォルダ（master SS の親）にある *_WorkSpace のうち、
//   exhibitions シートに ex_code が無いものを孤児として検出する。
// =========================================================

function findOrphanWorkSpaces() {
  return _findOrphans();
}

function trashOrphanWorkSpaces() {
  const orphans = _findOrphans();
  if (orphans.length === 0) {
    console.log('孤児なし。何もしません。');
    return { count: 0, orphans: [] };
  }
  console.log('=== 孤児フォルダを trash します ===');
  orphans.forEach(o => {
    try {
      DriveApp.getFolderById(o.id).setTrashed(true);
      console.log('  ' + o.name + ' -> trash');
    } catch (e) {
      console.warn('  ' + o.name + ' エラー: ' + e.message);
    }
  });
  return { count: orphans.length, orphans: orphans };
}

function _findOrphans() {
  const ss = SpreadsheetApp.openById(MASTER_SS_ID);
  const sheet = ss.getSheetByName('exhibitions');
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const exIdx = headers.indexOf('ex_code');
  const known = new Set();
  for (let i = 1; i < data.length; i++) {
    const code = (data[i][exIdx] || '').toString().trim();
    if (code) known.add(code);
  }

  const masterFile = DriveApp.getFileById(MASTER_SS_ID);
  const parentFolder = masterFile.getParents().next();
  const folders = parentFolder.getFolders();
  const orphans = [];
  while (folders.hasNext()) {
    const f = folders.next();
    if (f.isTrashed()) continue;
    const name = f.getName();
    const m = /^(.+)_WorkSpace$/.exec(name);
    if (!m) continue;
    const code = m[1];
    if (!known.has(code)) {
      orphans.push({ name: name, id: f.getId(), ex_code: code });
    }
  }

  console.log('SS にある ex_code: ' + Array.from(known).join(', '));
  console.log('孤児 *_WorkSpace: ' + orphans.length + ' 件');
  orphans.forEach(o => console.log('  - ' + o.name));
  return orphans;
}

function _safeTrashFileById(fileId, label) {
  if (!fileId) {
    console.log('  ' + label + ' (id 無し、skip)');
    return true;
  }
  try {
    const f = DriveApp.getFileById(fileId);
    if (f.isTrashed()) {
      console.log('  ' + label + ' 既に trash 済み');
    } else {
      f.setTrashed(true);
      console.log('  ' + label + ' -> trash');
    }
    return true;
  } catch (e) {
    console.warn('  ' + label + ' エラー: ' + e.message);
    return false;
  }
}
