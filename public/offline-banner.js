// =========================================================
// オフライン時の画面上部バナー (画面共通)
// register.html の B-3 として最初に register に入ったロジックを切り出したもの。
// 使い方: 各 HTML の <body> 内 (どこでも可) に
//   <script src="offline-banner.js"></script>                          ← 主催者向けデフォルト文言
//   <script src="offline-banner.js" data-message="..."></script>       ← 画面別文言
// を 1 行追加するだけ。banner DOM の自動注入と navigator.onLine 監視を行う。
//
// メモ:
// - 既に id="offlineBanner" の要素があるページではそれを再利用する (二重生成しない)
// - position:sticky で画面上部に貼り付き、オンライン時は display:none
// - 各画面の navigator.onLine 事前チェック (saveXxx 内) は banner と独立に機能する
// - data-message が無い場合のデフォルトは主催者向け文言 (register/caption/web-exhibition で使う想定)
// =========================================================
(function () {
  // <script src="offline-banner.js" data-message="..."> の文言を IIFE 同期実行中に取得
  const myScript = document.currentScript;
  const customMessage = myScript && myScript.dataset && myScript.dataset.message;
  const DEFAULT_MESSAGE = '⚠ オフラインです。保存・同期は接続復帰後に行ってください。';
  const message = customMessage || DEFAULT_MESSAGE;

  function ensureBanner() {
    let banner = document.getElementById('offlineBanner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'offlineBanner';
      banner.textContent = message;
      banner.style.cssText = [
        'display:none',
        'position:sticky',
        'top:0',
        'z-index:900',
        'padding:8px 14px',
        'background:#fff3e0',
        'border-bottom:1px solid #ffb74d',
        'color:#a85700',
        'font-size:0.88em',
        'text-align:center',
      ].join(';');
      // body 先頭に挿入 (sticky で画面上部に貼り付く)
      if (document.body.firstChild) {
        document.body.insertBefore(banner, document.body.firstChild);
      } else {
        document.body.appendChild(banner);
      }
    }
    return banner;
  }

  function update() {
    const banner = ensureBanner();
    banner.style.display = navigator.onLine ? 'none' : 'block';
  }

  window.addEventListener('online', update);
  window.addEventListener('offline', update);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', update);
  } else {
    update();
  }
})();
