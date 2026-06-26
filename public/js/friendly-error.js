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

  // contactHint: 任意。再試行系の汎用エラーのときだけ末尾に添える連絡先の案内
  //   (例: '解決しないときは主催者にご連絡ください。')。不慣れな利用者向けの出口。
  function friendlyError(err, actionLabel, contactHint) {
    var label = actionLabel || '処理';
    try { console.error(label + ' failed:', err); } catch (_e) {}

    var code = err && err.code;
    var msg = err && err.message;

    // Cloud Function (HttpsError) の message は日本語化済みなので見せてよい。
    // 例: code = 'functions/permission-denied', message = 'この作品はロックされています'
    // (業務上の理由なので連絡先ヒントは添えない)
    if (typeof code === 'string' && code.indexOf('functions/') === 0 && msg) {
      return msg;
    }

    // それ以外 (JavaScript / Firestore 等の英語例外) は日本語の汎用文に統一する。
    var base = label + 'に失敗しました。通信環境を確認して、もう一度お試しください。';
    return contactHint ? base + contactHint : base;
  }

  window.friendlyError = friendlyError;
})();
