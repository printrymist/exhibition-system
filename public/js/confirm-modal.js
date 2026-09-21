// window.confirm() / alert() / prompt() は、スマホの一部内蔵ブラウザ (Android WebView で
// ホストアプリが WebChromeClient.onJsConfirm 等を実装していないケース。Gmail/LINE等の
// アプリ内ブラウザで起こり得る) だと、ダイアログを一切出さずに即座に false/undefined を
// 返す (Android の公式な既定動作)。confirm() を「実行してよいか」の関門に使っていると
// 該当ブラウザでは常にキャンセル扱いになり無反応に見え、alert() をエラー通知に使っていると
// 何が起きたか利用者に一切伝わらないまま処理だけが終わる (どちらも「使えているように
// 見えない」という同じ結果を来場者・作家に与える)。2026-09-20〜21 に発覚、画面内モーダルに
// 置き換えてどのブラウザでも確実に動くようにする。

(function () {
  // 共通の見た目 (カード+背景) を組み立てて、ボタン行だけ呼び出し側で用意する。
  function buildModalShell(message) {
    var overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:99999;'
      + 'display:flex;align-items:center;justify-content:center;padding:16px;'
      + 'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;';

    var card = document.createElement('div');
    card.style.cssText = 'background:#fff;border-radius:10px;padding:20px;max-width:400px;'
      + 'width:100%;box-shadow:0 4px 24px rgba(0,0,0,.25);';

    var msgEl = document.createElement('div');
    msgEl.style.cssText = 'font-size:0.92em;color:#333;white-space:pre-wrap;line-height:1.6;margin-bottom:18px;';
    msgEl.textContent = message;

    var row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';

    card.appendChild(msgEl);
    card.appendChild(row);
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    function remove() {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }
    return { overlay: overlay, row: row, remove: remove };
  }

  function makeButton(label, primary) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    btn.style.cssText = primary
      ? 'padding:10px 18px;background:#1a73e8;color:#fff;border:none;border-radius:6px;font-size:14px;font-weight:bold;cursor:pointer;'
      : 'padding:10px 18px;background:#eee;color:#555;border:none;border-radius:6px;font-size:14px;cursor:pointer;';
    return btn;
  }

  // 「実行してよいか」の確認。OK/キャンセルを選ばせ、選んだ結果を bool で返す。
  window.showConfirmModal = function (message, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var m = buildModalShell(message);
      var cancelBtn = makeButton(opts.cancelLabel || 'キャンセル', false);
      var okBtn = makeButton(opts.okLabel || 'OK', true);
      m.row.appendChild(cancelBtn);
      m.row.appendChild(okBtn);
      okBtn.addEventListener('click', function () { m.remove(); resolve(true); });
      cancelBtn.addEventListener('click', function () { m.remove(); resolve(false); });
    });
  };

  // エラー・注意事項など「必ず読んで一度確認してほしい」通知。OK ボタン1つだけ。
  // トースト通知 (showTopToast 等) と違い、利用者がボタンを押すまで消えない。
  window.showAlertModal = function (message, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var m = buildModalShell(message);
      var okBtn = makeButton(opts.okLabel || 'OK', true);
      m.row.appendChild(okBtn);
      okBtn.addEventListener('click', function () { m.remove(); resolve(); });
    });
  };
})();
