// window.confirm() / alert() / prompt() は、スマホの一部内蔵ブラウザ (Android WebView で
// ホストアプリが WebChromeClient.onJsConfirm 等を実装していないケース。Gmail/LINE等の
// アプリ内ブラウザで起こり得る) だと、ダイアログを一切出さずに即座に false を返す
// (Android の公式な既定動作)。confirm() を「提出してよいか」等の関門に使っていると、
// 該当ブラウザでは常に false = キャンセル扱いになり、ボタンを押しても何も起きない。
// 2026-09-20、operator-auth.js の window.prompt() 問題 (ログインできない) と同根の
// 問題として発覚。画面内モーダルに置き換えて、どのブラウザでも確実に動くようにする。
window.showConfirmModal = function (message, opts) {
  opts = opts || {};
  return new Promise(function (resolve) {
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

    var cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.textContent = opts.cancelLabel || 'キャンセル';
    cancelBtn.style.cssText = 'padding:10px 18px;background:#eee;color:#555;border:none;'
      + 'border-radius:6px;font-size:14px;cursor:pointer;';

    var okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.textContent = opts.okLabel || 'OK';
    okBtn.style.cssText = 'padding:10px 18px;background:#1a73e8;color:#fff;border:none;'
      + 'border-radius:6px;font-size:14px;font-weight:bold;cursor:pointer;';

    row.appendChild(cancelBtn);
    row.appendChild(okBtn);
    card.appendChild(msgEl);
    card.appendChild(row);
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    function done(v) {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      resolve(v);
    }
    okBtn.addEventListener('click', function () { done(true); });
    cancelBtn.addEventListener('click', function () { done(false); });
  });
};
