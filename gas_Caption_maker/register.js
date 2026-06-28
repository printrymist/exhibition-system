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
    const updatedAtIdx = headers.indexOf('updated_at');

    // 行番号を特定して一発書き込み
    for (let i = 1; i < data.length; i++) {
      if (data[i][headers.indexOf('ex_code')].toString().trim() === ex.toString().trim()) {
        sheet.getRange(i + 1, colIdx + 1).setValue(fieldsJson);
        if (updatedAtIdx !== -1) {
          sheet.getRange(i + 1, updatedAtIdx + 1)
            .setValue(Utilities.formatDate(new Date(), 'JST', 'yyyy/MM/dd HH:mm:ss'));
        }
        clearAllCache(ex);
        return { success: true };
      }
    }
    return { success: false, error: '展覧会が見つかりません。' };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

// Phase 7-A1 (2026-05-07): caption_fields は Firestore (exhibitions/{ex}.caption_fields) に
// 一本化したため getCaptionFields / saveCaptionFields は撤去。caption.html は
// fsSaveCaptionFields (Firestore set merge) で直接書き込む。

// Phase 6d-6e (2026-05-06) 撤去: saveArtwork / updateArtwork / getArtworkList /
// getArtistList / getArtworksByArtist / deleteArtwork は、作品の読み書きを
// Firestore 直読み + Cloud Function submitArtwork に移行したため到達不能になっていた
// 死にコードだった (doPost dispatcher に未配線。register.html/input.html の同名関数は
// クライアント側 Firestore 実装で別物)。2026-06-21 に定義ごと削除。
// これらが参照していた {ex}_artworks SS は addArtworks (作品枠の採番) で現役。

// =========================================================
// 🌟 作家向け案内メール送信
//   ex_code に紐づく管理者メールアドレス宛にメールを送る。
//   本文は呼び出し側（register.html）で組み立てたものをそのまま使う。
//   管理者は受信したメールをそのまま作家に転送できる。
// =========================================================
function sendArtistGuide(ex, subject, body) {
  try {
    if (!ex || !subject || !body) {
      return { success: false, error: 'パラメータが不足しています。' };
    }
    const adminEmail = getAdminEmail(ex);
    if (!adminEmail) {
      return { success: false, error: '管理者メールアドレスが見つかりません。' };
    }
    GmailApp.sendEmail(adminEmail, subject, body, {
      name: 'Qriine',
      replyTo: 'Qriine <ryohei.miyagawa.art@gmail.com>',
      from: 'noreply.rohei.printer@gmail.com'
    });
    return { success: true, to: adminEmail };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

// =========================================================
// 🌟 ex_code から管理者メールアドレスを取得
//   applications シートを ex_code で引く。
//   同じ ex_code が複数行ある場合は最後の行を採用。
// =========================================================
function getAdminEmail(ex) {
  const ctx = getInquiryContext(ex);
  return ctx ? ctx.email : null;
}

// =========================================================
// 🌟 ex_code から問い合わせ用コンテキスト（ex_name/organizer/email）を取得
//   inquiry.html がフォーム表示と Firestore 書き込み時のスナップショットに使う。
//   exhibitions シートを参照（移行前データ用に applications フォールバック付き）。
// =========================================================
function getInquiryContext(ex) {
  try {
    if (!ex) return null;
    const target = ex.toString().trim();
    const ss = SpreadsheetApp.openById(MASTER_SS_ID);

    // 1. exhibitions を優先
    const exSheet = ss.getSheetByName('exhibitions');
    if (exSheet) {
      const data = exSheet.getDataRange().getValues();
      const headers = data[0];
      const exIdx = headers.indexOf('ex_code');
      if (exIdx !== -1) {
        for (let i = 1; i < data.length; i++) {
          if ((data[i][exIdx] || '').toString().trim() !== target) continue;
          const get = (col) => {
            const idx = headers.indexOf(col);
            return idx !== -1 && data[i][idx] !== undefined ? data[i][idx].toString().trim() : '';
          };
          const email = get('email');
          if (email) {
            return {
              ex_code: target,
              ex_name: get('ex_name'),
              organizer: get('organizer'),
              email: email
            };
          }
          break; // exhibitions に該当行はあるが email 未設定 → applications にフォールバック
        }
      }
    }

    // 2. applications フォールバック（移行前データ用）
    const appSheet = ss.getSheetByName('applications');
    if (!appSheet) return null;
    const data = appSheet.getDataRange().getValues();
    const headers = data[0];
    const exIdx = headers.indexOf('ex_code');
    const emailIdx = headers.indexOf('email');
    const orgIdx = headers.indexOf('organizer');
    const nameIdx = headers.indexOf('ex_name');
    if (exIdx === -1 || emailIdx === -1) return null;
    let row = null;
    for (let i = 1; i < data.length; i++) {
      if ((data[i][exIdx] || '').toString().trim() === target) row = data[i];
    }
    if (!row) return null;
    return {
      ex_code: target,
      ex_name: nameIdx !== -1 ? (row[nameIdx] || '').toString().trim() : '',
      organizer: orgIdx !== -1 ? (row[orgIdx] || '').toString().trim() : '',
      email: (row[emailIdx] || '').toString().trim()
    };
  } catch (e) {
    return null;
  }
}

// =========================================================
// 🌟 問い合わせ通知メール送信（運営者宛）
//   inquiry.html から呼ばれる。Firestore 書き込み完了後に呼ぶ想定。
//   payload: { inquiryId, exCode, exName, organizer, email, category, subcategory, subject, body, pageUrl, userAgent }
// =========================================================
function sendInquiryNotification(payload) {
  try {
    if (!payload || !payload.subject || !payload.body) {
      return { success: false, error: 'パラメータが不足しています。' };
    }
    const operatorEmail = 'ryohei.miyagawa.art@gmail.com';
    const cat = payload.category || '';
    const sub = payload.subcategory ? ` / ${payload.subcategory}` : '';
    const exLabel = payload.exName ? `${payload.exName} (${payload.exCode || ''})` : (payload.exCode || '');

    const mailSubject = `[問い合わせ][${cat}${sub}] ${payload.subject} - ${exLabel}`;
    const mailBody =
`新しい問い合わせが届きました。

━━━━━━━━━━━━━━━━━━━━━━━━
展覧会     : ${exLabel}
管理者     : ${payload.organizer || '(不明)'}
連絡先     : ${payload.email || '(不明)'}
カテゴリ   : ${cat}${sub}
件名       : ${payload.subject}
━━━━━━━━━━━━━━━━━━━━━━━━

【本文】
${payload.body}

━━━━━━━━━━━━━━━━━━━━━━━━
【参考情報】
発生画面: ${payload.pageUrl || '(なし)'}
環境    : ${payload.userAgent || '(なし)'}
ID      : ${payload.inquiryId || '(なし)'}
━━━━━━━━━━━━━━━━━━━━━━━━

Inbox から内容確認・返信してください。
`;
    GmailApp.sendEmail(operatorEmail, mailSubject, mailBody, {
      name: 'Qriine',
      replyTo: payload.email || 'Qriine <ryohei.miyagawa.art@gmail.com>',
      from: 'noreply.rohei.printer@gmail.com'
    });
    return { success: true };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

// =========================================================
// 🌟 問い合わせへの返信メール送信（管理者宛）
//   inbox.html から呼ばれる。messages サブコレクションへの書き込みは
//   クライアント側（Firestore 直書き）で実施し、本関数は通知メール送信のみ。
//   payload: { toEmail, exName, subject, body, inquiryId }
// =========================================================
// =========================================================
// 🌟 管理者からの follow-up 通知（運営者宛）
//   inquiry.html?id=... のスレッドモードで管理者が follow-up を送ったときに呼ばれる。
//   payload: { inquiryId, exCode, exName, organizer, email, originalSubject, body }
// =========================================================
function sendAdminFollowupNotification(payload) {
  try {
    if (!payload || !payload.body || !payload.inquiryId) {
      return { success: false, error: 'パラメータが不足しています。' };
    }
    const operatorEmail = 'ryohei.miyagawa.art@gmail.com';
    const exLabel = payload.exName ? `${payload.exName} (${payload.exCode || ''})` : (payload.exCode || '');
    const mailSubject = `[問い合わせ・続報] ${payload.originalSubject || ''} - ${exLabel}`;
    const mailBody =
`既存の問い合わせに続報が届きました。

━━━━━━━━━━━━━━━━━━━━━━━━
展覧会     : ${exLabel}
管理者     : ${payload.organizer || '(不明)'}
連絡先     : ${payload.email || '(不明)'}
元の件名   : ${payload.originalSubject || ''}
━━━━━━━━━━━━━━━━━━━━━━━━

【続報の本文】
${payload.body}

━━━━━━━━━━━━━━━━━━━━━━━━
ID      : ${payload.inquiryId}
━━━━━━━━━━━━━━━━━━━━━━━━

Inbox から該当スレッドを確認・返信してください。
https://rohei-printer-system.web.app/inbox.html
`;
    GmailApp.sendEmail(operatorEmail, mailSubject, mailBody, {
      name: 'Qriine',
      replyTo: payload.email || 'Qriine <ryohei.miyagawa.art@gmail.com>',
      from: 'noreply.rohei.printer@gmail.com'
    });
    return { success: true };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

function sendInquiryReply(payload) {
  try {
    if (!payload || !payload.toEmail || !payload.body) {
      return { success: false, error: 'パラメータが不足しています。' };
    }
    const exLabel = payload.exName ? `（${payload.exName}）` : '';
    const mailSubject = `Re: ${payload.subject || 'お問い合わせ'} ${exLabel}`;
    const threadUrl = payload.inquiryId
      ? `https://rohei-printer-system.web.app/inquiry.html?id=${payload.inquiryId}`
      : 'https://rohei-printer-system.web.app/inquiry.html';
    const newUrl = payload.exCode
      ? `https://rohei-printer-system.web.app/inquiry.html?ex=${payload.exCode}`
      : 'https://rohei-printer-system.web.app/inquiry.html';
    const mailBody =
`お問い合わせいただきありがとうございました。
以下の通りご回答いたします。

━━━━━━━━━━━━━━━━━━━━━━━━
${payload.body}
━━━━━━━━━━━━━━━━━━━━━━━━

▼ この問い合わせの続きを書く（同じスレッドに追加されます）
${threadUrl}

▼ 別件で新しく問い合わせる
${newUrl}

Qriine
`;
    GmailApp.sendEmail(payload.toEmail, mailSubject, mailBody, {
      name: 'Qriine',
      replyTo: 'Qriine <ryohei.miyagawa.art@gmail.com>',
      from: 'noreply.rohei.printer@gmail.com'
    });
    return { success: true };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}