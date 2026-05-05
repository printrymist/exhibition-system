// =========================================================
// 🌟 Inquiries SS index
//
// Firestore の inquiries コレクションを SS にミラーする。
// 書き込みのたびに HTML 側から GAS endpoint を叩いて反映する push 方式。
//
// 提供関数:
//   - appendInquiryToIndex(payload)  : 新規問い合わせ送信時に行追加
//   - updateInquiryInIndex(payload)  : 続報・返信・status 変更時に行更新
//   - recomputeInquiryCountersForEx  : exhibitions の集計列を計算しなおす
// =========================================================

const INQUIRY_INDEX_HEADERS = [
  'created_at',
  'ex_code',
  'ex_name',
  'organizer',
  'email',
  'category',
  'subcategory',
  'subject',
  'status',
  'last_message_at',
  'inquiry_id',
  'inbox_url'
];

const INQUIRY_AGG_COLS = ['open_inquiries', 'last_inquiry_at'];

function getInquiriesIndexSheet() {
  const ss = SpreadsheetApp.openById(MASTER_SS_ID);
  let sheet = ss.getSheetByName('inquiries_index');
  if (!sheet) {
    sheet = ss.insertSheet('inquiries_index');
    sheet.getRange(1, 1, 1, INQUIRY_INDEX_HEADERS.length).setValues([INQUIRY_INDEX_HEADERS]);
    const r = sheet.getRange(1, 1, 1, INQUIRY_INDEX_HEADERS.length);
    r.setBackground('#1a73e8');
    r.setFontColor('#ffffff');
    r.setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function ensureInquiryAggregateColumns() {
  const ss = SpreadsheetApp.openById(MASTER_SS_ID);
  const sheet = ss.getSheetByName('exhibitions');
  if (!sheet) return;
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  INQUIRY_AGG_COLS.forEach(name => {
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

function appendInquiryToIndex(payload) {
  try {
    const sheet = getInquiriesIndexSheet();
    ensureInquiryAggregateColumns();
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const now = Utilities.formatDate(new Date(), 'JST', 'yyyy/MM/dd HH:mm:ss');
    const inboxUrl = payload.inquiry_id
      ? 'https://rohei-printer-system.web.app/inquiry.html?id=' + payload.inquiry_id
      : '';
    // 同じ inquiry_id が既にあれば二重追加しない（idempotent）
    const data = sheet.getDataRange().getValues();
    const idIdx = headers.indexOf('inquiry_id');
    if (idIdx !== -1 && payload.inquiry_id) {
      for (let i = 1; i < data.length; i++) {
        if ((data[i][idIdx] || '').toString().trim() === payload.inquiry_id.toString().trim()) {
          return { success: true, skipped: 'already exists' };
        }
      }
    }
    const row = {
      created_at: payload.created_at || now,
      ex_code: payload.ex_code || '',
      ex_name: payload.ex_name || '',
      organizer: payload.organizer || '',
      email: payload.email || '',
      category: payload.category || '',
      subcategory: payload.subcategory || '',
      subject: payload.subject || '',
      status: payload.status || 'open',
      last_message_at: payload.last_message_at || payload.created_at || now,
      inquiry_id: payload.inquiry_id || '',
      inbox_url: inboxUrl
    };
    const arr = headers.map(h => row[h] !== undefined ? row[h] : '');
    sheet.appendRow(arr);
    if (payload.ex_code) recomputeInquiryCountersForEx(payload.ex_code);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function updateInquiryInIndex(payload) {
  try {
    if (!payload || !payload.inquiry_id) return { success: false, error: 'no inquiry_id' };
    const sheet = getInquiriesIndexSheet();
    const data = sheet.getDataRange().getValues();
    const headers = data[0];
    const idIdx = headers.indexOf('inquiry_id');
    if (idIdx === -1) return { success: false, error: 'no inquiry_id col' };
    const target = payload.inquiry_id.toString().trim();
    let row = -1, exCode = '';
    for (let i = 1; i < data.length; i++) {
      if ((data[i][idIdx] || '').toString().trim() === target) {
        row = i + 1;
        exCode = (data[i][headers.indexOf('ex_code')] || '').toString().trim();
        break;
      }
    }
    if (row === -1) return { success: false, error: 'inquiry not found in index' };
    const updates = [
      ['status', payload.status],
      ['last_message_at', payload.last_message_at]
    ];
    updates.forEach(pair => {
      const col = pair[0];
      const val = pair[1];
      if (val === undefined || val === null) return;
      const idx = headers.indexOf(col);
      if (idx !== -1) sheet.getRange(row, idx + 1).setValue(val);
    });
    if (exCode) recomputeInquiryCountersForEx(exCode);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function recomputeInquiryCountersForEx(exCode) {
  if (!exCode) return;
  ensureInquiryAggregateColumns();
  const idxSheet = getInquiriesIndexSheet();
  const idxData = idxSheet.getDataRange().getValues();
  const idxHeaders = idxData[0];
  const exCodeColIdx = idxHeaders.indexOf('ex_code');
  const statusColIdx = idxHeaders.indexOf('status');
  const lastColIdx = idxHeaders.indexOf('last_message_at');
  const target = exCode.toString().trim();
  let openCount = 0, latest = '';
  for (let i = 1; i < idxData.length; i++) {
    if ((idxData[i][exCodeColIdx] || '').toString().trim() !== target) continue;
    const status = (idxData[i][statusColIdx] || '').toString().trim();
    if (status === 'open') openCount++;
    const ts = (idxData[i][lastColIdx] || '').toString().trim();
    if (ts > latest) latest = ts;
  }
  const ss = SpreadsheetApp.openById(MASTER_SS_ID);
  const exSheet = ss.getSheetByName('exhibitions');
  const exData = exSheet.getDataRange().getValues();
  const exHeaders = exData[0];
  const exExIdx = exHeaders.indexOf('ex_code');
  const openIdx = exHeaders.indexOf('open_inquiries');
  const lastIdx2 = exHeaders.indexOf('last_inquiry_at');
  for (let i = 1; i < exData.length; i++) {
    if ((exData[i][exExIdx] || '').toString().trim() !== target) continue;
    if (openIdx !== -1) exSheet.getRange(i + 1, openIdx + 1).setValue(openCount);
    if (lastIdx2 !== -1) exSheet.getRange(i + 1, lastIdx2 + 1).setValue(latest);
    return;
  }
}
