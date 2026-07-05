// クライアント診断バッファ。
// エラー(未捕捉/Promise/handled)とページ文脈を localStorage に貯め、
// 問い合わせ送信時に getDiagnostics() で回収する。
// ねらい: 主催者が「動かない/おかしい」と報告したとき、どの画面で何のエラーが
// 出ていたかを運営者(inbox)が見て再現できるようにする。
// 全ページの <head> でなるべく早く読み込む (後続スクリプトのエラーも拾うため)。
(function () {
  'use strict';

  var KEY = 'qriine_diag_errors_v1';
  var MAX = 10;          // 直近何件まで保持するか
  var MSG_MAX = 300;     // 1 件のメッセージ最大長
  var STACK_MAX = 1200;  // 1 件のスタック最大長

  function nowIso() { try { return new Date().toISOString(); } catch (_e) { return ''; } }

  // URL から機微なクエリ値を伏字化する。診断は support ログに保存されるため、
  // メールサインインの oobCode / apiKey / 作家・来場者アクセスの sig・exp などの
  // 認証情報を絶対に残さない。キー名に下記パターンを含むものは値を *** にする。
  var SENSITIVE_KEY = /(oob|token|sig|key|secret|pass|auth|cred|code|exp|session)/i;
  function sanitizeUrl(u) {
    try {
      u = String(u == null ? '' : u);
      var hash = '', hi = u.indexOf('#');
      if (hi >= 0) { hash = u.slice(hi); u = u.slice(0, hi); }
      var qi = u.indexOf('?');
      if (qi < 0) return u + hash;
      var base = u.slice(0, qi);
      var out = u.slice(qi + 1).split('&').map(function (pair) {
        var eq = pair.indexOf('=');
        var k = eq >= 0 ? pair.slice(0, eq) : pair;
        return SENSITIVE_KEY.test(k) ? (k + '=***') : pair;
      }).join('&');
      return base + '?' + out + hash;
    } catch (_e) { return ''; }
  }
  window.diagSanitizeUrl = sanitizeUrl;

  function pageId() { try { return sanitizeUrl(location.pathname + location.search); } catch (_e) { return ''; } }
  function truncate(s, n) {
    s = String(s == null ? '' : s);
    return s.length > n ? s.slice(0, n) + '…' : s;
  }
  function readBuf() {
    try { var s = localStorage.getItem(KEY); return s ? JSON.parse(s) : []; }
    catch (_e) { return []; }
  }
  function writeBuf(arr) {
    try { localStorage.setItem(KEY, JSON.stringify(arr.slice(-MAX))); } catch (_e) {}
  }
  function push(entry) {
    if (!entry || !entry.msg) return;
    var buf = readBuf();
    var last = buf[buf.length - 1];
    // 直近と同じメッセージ+ページの連続重複は畳んで件数だけ増やす (ループ暴発対策)
    if (last && last.msg === entry.msg && last.page === entry.page) {
      last.n = (last.n || 1) + 1;
      last.t = entry.t;
    } else {
      buf.push(entry);
    }
    writeBuf(buf);
  }

  // handled エラー (try/catch で friendlyError 表示に回した分) を明示的に記録する。
  window.diagLogError = function (ctx, err) {
    try {
      var code = err && err.code ? (err.code + ': ') : '';
      var body = (err && (err.message)) ? err.message : (err == null ? '' : String(err));
      var msg = (ctx ? '[' + ctx + '] ' : '') + code + body;
      push({ t: nowIso(), page: pageId(), type: 'handled',
             msg: truncate(msg, MSG_MAX), stack: truncate((err && err.stack) || '', STACK_MAX) });
    } catch (_e) {}
  };

  window.addEventListener('error', function (e) {
    try {
      var err = e && e.error;
      var msg = (e && e.message) || (err && err.message) || 'error';
      var where = (e && e.filename) ? (e.filename + ':' + (e.lineno || '') + ':' + (e.colno || '')) : '';
      push({ t: nowIso(), page: pageId(), type: 'uncaught',
             msg: truncate(msg + (where ? ' @ ' + where : ''), MSG_MAX),
             stack: truncate((err && err.stack) || '', STACK_MAX) });
    } catch (_e) {}
  });

  window.addEventListener('unhandledrejection', function (e) {
    try {
      var r = e && e.reason;
      var code = r && r.code ? (r.code + ': ') : '';
      var body = (r && r.message) ? r.message : (r == null ? '' : String(r));
      push({ t: nowIso(), page: pageId(), type: 'promise',
             msg: truncate(code + body, MSG_MAX), stack: truncate((r && r.stack) || '', STACK_MAX) });
    } catch (_e) {}
  });

  // 問い合わせ送信時に呼ぶ。バージョン・画面・端末・直近エラーをまとめて返す。
  window.getDiagnostics = function () {
    var d = {};
    try { d.version = window.APP_VERSION || ''; } catch (_e) {}
    try { d.url = sanitizeUrl(location.href); } catch (_e) {}
    try {
      var m = (location.search || '').match(/[?&]ex=([A-Za-z0-9_-]+)/);
      d.ex = m ? m[1] : '';
    } catch (_e) {}
    try { d.viewport = { w: window.innerWidth || 0, h: window.innerHeight || 0, dpr: window.devicePixelRatio || 1 }; } catch (_e) {}
    try { d.ua = navigator.userAgent || ''; } catch (_e) {}
    try { d.platform = navigator.platform || ''; } catch (_e) {}
    try { d.lang = navigator.language || ''; } catch (_e) {}
    try { d.errors = readBuf(); } catch (_e) { d.errors = []; }
    d.captured_at = nowIso();
    return d;
  };

  // 報告済みのエラーは畳んでよい (送信成功後に呼ぶ)。
  window.clearDiagnosticsErrors = function () { try { localStorage.removeItem(KEY); } catch (_e) {} };
})();
