// アプリのバージョン定数。各画面が <script src="version.js"> で読む。
// バージョン体系 (semver-lite):
//   v0.x.y   — プレリリース、関係者テスト期
//   v1.0.0   — 公開リリース
//   v1.X.0   — 機能追加 (X が増える)
//   v1.X.Y   — バグ修正 / 軽微な改善 (Y が増える)
//   v2.0.0+  — 破壊的変更
// 詳細な変更履歴はリポジトリ root の CHANGELOG.md を参照。
window.APP_VERSION = 'v0.9.4';
window.APP_RELEASED_AT = '2026-05-18';
window.APP_NAME = '展覧会システム';

// 任意の親要素にバージョンフッタを差し込むヘルパ。
// usage: <div id="versionFooter"></div> を置いて、ページ末尾で
//        renderVersionFooter('versionFooter') を呼ぶ。
window.renderVersionFooter = function (containerId) {
  var el = document.getElementById(containerId || 'versionFooter');
  if (!el) return;
  el.style.cssText = 'text-align:center;font-size:0.82em;color:#555;margin-top:32px;padding:12px 8px;border-top:1px solid #e0e0e0;';
  el.innerHTML =
    window.APP_NAME + ' <strong style="font-variant-numeric:tabular-nums;color:#1a4f9c;">' +
    window.APP_VERSION + '</strong> <span style="color:#888;">(' +
    window.APP_RELEASED_AT + ')</span>';
};

// お問い合わせリンク (主催者の主要画面: caption / register / reports のみ呼ぶ)。
// バージョンフッタの直上にボタン風で配置する想定。
// 現在のページの ex= があれば inquiry.html?ex=… に引き継ぐ。
window.renderInquiryLink = function (containerId) {
  var el = document.getElementById(containerId || 'inquiryLink');
  if (!el) return;
  var ex = '';
  try { ex = new URLSearchParams(window.location.search).get('ex') || ''; } catch (_e) {}
  var href = '/inquiry.html' + (ex && /^[A-Za-z0-9_-]+$/.test(ex) ? '?ex=' + encodeURIComponent(ex) : '');
  el.style.cssText = 'text-align:center;margin-top:24px;';
  el.innerHTML =
    '<a href="' + href + '" style="display:inline-block;padding:8px 18px;background:#e8f0fe;' +
    'color:#1a73e8;border:1px solid #1a73e8;border-radius:6px;font-size:0.9em;' +
    'font-weight:bold;text-decoration:none;">✉ お問い合わせ</a>';
};
