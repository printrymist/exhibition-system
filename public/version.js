// アプリのバージョン定数。各画面が <script src="version.js"> で読む。
// バージョン体系 (semver-lite):
//   v0.x.y   — プレリリース、関係者テスト期
//   v1.0.0   — 公開リリース
//   v1.X.0   — 機能追加 (X が増える)
//   v1.X.Y   — バグ修正 / 軽微な改善 (Y が増える)
//   v2.0.0+  — 破壊的変更
// 詳細な変更履歴はリポジトリ root の CHANGELOG.md を参照。
window.APP_VERSION = 'v0.9.0';
window.APP_RELEASED_AT = '2026-05-16';
window.APP_NAME = '展覧会システム';

// 任意の親要素にバージョンフッタを差し込むヘルパ。
// usage: <div id="versionFooter"></div> を置いて、ページ末尾で
//        renderVersionFooter('versionFooter') を呼ぶ。
window.renderVersionFooter = function (containerId) {
  var el = document.getElementById(containerId || 'versionFooter');
  if (!el) return;
  el.style.cssText = 'text-align:center;font-size:0.72em;color:#aaa;margin-top:32px;padding:10px 8px;border-top:1px solid #f0f0f0;';
  el.innerHTML =
    window.APP_NAME + ' <span style="font-variant-numeric:tabular-nums;">' +
    window.APP_VERSION + '</span> <span style="color:#ccc;">(' +
    window.APP_RELEASED_AT + ')</span>';
};
