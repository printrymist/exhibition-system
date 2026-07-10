// エラー表示の共通ヘルパ。
// 英語の内部エラー (JavaScript / 通信ライブラリの生例外) を画面に出さず、日本語に統一する。
// サーバー (Cloud Function / HttpsError) の理由は日本語化済みなので、そのまま表示する。
//
// 使い方:
//   try { ... } catch (e) { alert(friendlyError(e, '保存')); }
//   → CF の日本語理由があればそれを、無ければ「保存に失敗しました。…」を返す。
//   詳細 (英語含む) は console.error にだけ残す。
(function () {
  'use strict';

  // 画面の役割に応じた既定の連絡先案内 (再試行しても解決しないときの出口)。
  // ページ初期化時に一度だけ宣言する: friendly-error.js の直後で
  //   <script>setFriendlyErrorContact('organizer');</script>
  // organizer = 主催者画面 (✉ お問い合わせボタンが画面下にあること)
  // artist    = 作家画面 (窓口は主催者)
  // 宣言しない画面 (来場者向け等) は従来どおり案内なし。
  var CONTACT_HINTS = {
    organizer: '解決しないときは画面下の「✉ お問い合わせ」からご連絡ください。',
    artist: '解決しないときは主催者にご連絡ください。'
  };
  var defaultContactHint = '';
  window.setFriendlyErrorContact = function (role) {
    defaultContactHint = CONTACT_HINTS[role] || '';
  };

  // contactHint: 任意。再試行系の汎用エラーのときだけ末尾に添える連絡先の案内
  //   (例: '解決しないときは主催者にご連絡ください。')。省略時はページの既定
  //   (setFriendlyErrorContact) を使う。不慣れな利用者向けの出口。
  function friendlyError(err, actionLabel, contactHint) {
    var label = actionLabel || '処理';
    try { console.error(label + ' failed:', err); } catch (_e) {}
    // 診断バッファにも記録 (問い合わせ時に発生エラーとして回収するため)。
    try { if (window.diagLogError) window.diagLogError(label, err); } catch (_e) {}

    var code = err && err.code;
    var msg = err && err.message;

    // Cloud Function (HttpsError) の message は日本語化済みなので見せてよい。
    // 例: code = 'functions/permission-denied', message = 'この作品はロックされています'
    // (業務上の理由なので連絡先ヒントは添えない)
    // ただし通信断などでは SDK 自身が同じ functions/ コードで英語 message
    // ('internal' 等) を作るため、日本語 (非 ASCII) を含むときだけ素通しする。
    if (typeof code === 'string' && code.indexOf('functions/') === 0 && msg && /[^\x00-\x7F]/.test(msg)) {
      return msg;
    }

    // それ以外 (JavaScript / Firestore 等の英語例外) は日本語の汎用文に統一する。
    var base = label + 'に失敗しました。通信環境を確認して、もう一度お試しください。';
    var hint = contactHint || defaultContactHint;
    return hint ? base + hint : base;
  }

  window.friendlyError = friendlyError;
})();
