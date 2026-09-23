/**
 * progress-assistant.js — 進捗アシスタント (右下のポップアップ)
 *
 * 主催者画面 (register / caption / reports / setup 完了画面) の右下に「準備 n/4」ボタンを置き、
 * 押すと準備状況と「次はこれ」を示すパネルを開く。判定は js/progress-core.js (純粋関数) に任せ、
 * ここはデータ取得と描画だけを担う。パネルは ヘッダ / 本文 / フッタ の枠になっており、
 * 将来アシスタント機能 (質問応答など) を足すときは本文を差し替えられる。
 *
 * 別ウィンドウは使わず同一ページ内のオーバーレイで出す (スマホ内蔵ブラウザで不安定なため)。
 *
 * 使い方:
 *   QriineProgress.attach({ exCode, navigate })  … 展覧会の表示・認証が済んだら呼ぶ
 *     navigate(action) が true を返したら画面内で処理済み (例: register のタブ切替)。
 *     false ならリンク先 (action.href) へ遷移する。
 *   QriineProgress.refresh()  … 保存・印刷などの後に呼ぶ。ステップが済んだ直後ならパネルを開く。
 *
 * 自動で開くのは2場面だけ: (1) 何も済んでいない展覧会を開いた最初の1回 (タブごと)
 * (2) ステップが済んだ直後。
 */
(function () {
  'use strict';

  const CSS = `
#qpFab{position:fixed;right:16px;bottom:16px;z-index:900;display:flex;align-items:center;gap:6px;
  padding:9px 14px;border:none;border-radius:999px;background:#1a73e8;color:#fff;font-size:14px;font-weight:bold;
  box-shadow:0 2px 8px rgba(0,0,0,.25);cursor:pointer;font-family:inherit}
#qpFab .qp-dot{width:8px;height:8px;border-radius:50%;background:#ffb300}
#qpFab.qp-alldone{background:#188038}
#qpPanel{position:fixed;right:16px;bottom:68px;z-index:901;width:340px;max-height:calc(100vh - 100px);
  display:none;flex-direction:column;background:#fff;border:1px solid #dadce0;border-radius:12px;
  box-shadow:0 6px 24px rgba(0,0,0,.2);font-size:14px;color:#202124;overflow:hidden}
#qpPanel.qp-open{display:flex}
#qpPanel .qp-head{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid #eee;background:#f8fafd}
#qpPanel .qp-title{font-weight:bold;flex:1}
#qpPanel .qp-days{font-size:12px;color:#5f6368}
#qpPanel .qp-close{border:none;background:none;font-size:20px;line-height:1;cursor:pointer;color:#5f6368;padding:0 2px}
#qpPanel .qp-body{padding:12px 14px;overflow-y:auto}
#qpPanel .qp-foot:empty{display:none}
#qpPanel .qp-justdone{background:#e6f4ea;color:#137333;border-radius:6px;padding:6px 10px;margin-bottom:10px;font-size:13px}
#qpPanel ol{list-style:none;margin:0 0 12px;padding:0}
#qpPanel li{display:flex;gap:8px;padding:5px 0;align-items:flex-start}
#qpPanel .qp-mark{width:20px;flex:none;text-align:center;font-weight:bold}
#qpPanel .qp-done .qp-mark{color:#188038}
#qpPanel .qp-partial .qp-mark{color:#e37400}
#qpPanel .qp-todo .qp-mark,#qpPanel .qp-unknown .qp-mark{color:#9aa0a6}
#qpPanel .qp-done .qp-label{color:#5f6368}
#qpPanel .qp-detail{font-size:12px;color:#5f6368}
#qpPanel .qp-warn{font-size:12px;color:#b06000}
#qpPanel .qp-next{background:#e8f0fe;border-radius:8px;padding:10px 12px;margin-bottom:10px}
#qpPanel .qp-next-h{font-size:12px;color:#1a73e8;font-weight:bold;margin-bottom:6px}
#qpPanel .qp-next-d{font-size:12px;color:#3c4043;margin-bottom:8px}
#qpPanel .qp-btn{display:block;width:100%;padding:9px 12px;border:none;border-radius:6px;background:#1a73e8;color:#fff;
  font-size:14px;font-weight:bold;cursor:pointer;font-family:inherit;text-align:center}
#qpPanel .qp-alt{display:block;margin-top:8px;background:none;border:none;color:#1a73e8;font-size:13px;cursor:pointer;
  text-decoration:underline;padding:0;font-family:inherit}
#qpPanel details{border-top:1px solid #eee;padding-top:8px}
#qpPanel summary{cursor:pointer;font-size:13px;color:#5f6368}
#qpPanel .qp-opt{display:flex;justify-content:space-between;gap:8px;padding:5px 0;font-size:13px}
#qpPanel .qp-opt a{color:#1a73e8}
#qpPanel .qp-opt span{color:#5f6368}
@media (max-width:600px){
  #qpPanel{left:0;right:0;bottom:0;width:auto;max-height:80vh;border-radius:14px 14px 0 0}
}
@media print{#qpFab,#qpPanel{display:none !important}}
`;

  const MARK = { done: '✓', partial: '●', todo: '○', unknown: '–' };
  let opts = null;
  let lastResult = null;
  let fab = null, panel = null;
  let loading = false;
  let pending = false;  // 読み込み中に refresh が来たら終わってからもう一度読む

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function ensureDom() {
    if (fab) return;
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    fab = document.createElement('button');
    fab.type = 'button';
    fab.id = 'qpFab';
    fab.setAttribute('aria-controls', 'qpPanel');
    fab.addEventListener('click', () => (isOpen() ? close() : open()));
    document.body.appendChild(fab);

    panel = document.createElement('div');
    panel.id = 'qpPanel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', '準備状況');
    panel.innerHTML = '<div class="qp-head"><span class="qp-title">準備状況</span><span class="qp-days"></span>'
      + '<button type="button" class="qp-close" aria-label="閉じる">×</button></div>'
      + '<div class="qp-body"></div><div class="qp-foot"></div>';
    panel.querySelector('.qp-close').addEventListener('click', close);
    panel.addEventListener('click', onPanelClick);
    document.body.appendChild(panel);
    // 右下ボタンがページ最下部の操作を隠さないよう余白を足す
    document.body.style.paddingBottom = Math.max(parseInt(getComputedStyle(document.body).paddingBottom, 10) || 0, 64) + 'px';
  }

  function isOpen() { return !!(panel && panel.classList.contains('qp-open')); }
  function open() { if (panel) { panel.classList.add('qp-open'); fab.setAttribute('aria-expanded', 'true'); } }
  function close() { if (panel) { panel.classList.remove('qp-open'); fab.setAttribute('aria-expanded', 'false'); } }

  function onPanelClick(e) {
    const btn = e.target.closest('[data-qp-step]');
    if (!btn || !lastResult) return;
    const step = lastResult.steps.find(s => s.key === btn.getAttribute('data-qp-step'));
    if (!step) return;
    const action = btn.hasAttribute('data-qp-alt') ? step.altAction : step.action;
    if (!action) return;
    close();
    let handled = false;
    try { handled = !!(opts.navigate && opts.navigate(action)); } catch (err) { console.warn('progress navigate failed:', err); }
    if (!handled) window.location.href = action.href;
  }

  function render(result, justDone) {
    ensureDom();
    fab.innerHTML = esc('準備 ' + result.doneCount + '/' + result.total) + (result.allDone ? '' : '<span class="qp-dot"></span>');
    fab.classList.toggle('qp-alldone', result.allDone);
    fab.setAttribute('aria-label', '準備状況: ' + result.total + ' 件中 ' + result.doneCount + ' 件完了');

    const d = result.daysToStart;
    panel.querySelector('.qp-days').textContent =
      d == null ? '' : d > 0 ? '会期まであと ' + d + ' 日' : d === 0 ? '今日から会期' : '会期中・会期後';

    let html = '';
    if (justDone.length) {
      html += '<div class="qp-justdone">✓ ' + esc(justDone.map(s => s.label).join('・')) + ' が済みました</div>';
    }
    if (result.next) {
      const n = result.next;
      html += '<div class="qp-next"><div class="qp-next-h">次はこれ</div>';
      if (n.detail && n.state !== 'partial') html += '<div class="qp-next-d">' + esc(n.detail) + '</div>';
      html += '<button type="button" class="qp-btn" data-qp-step="' + esc(n.key) + '">' + esc(n.action.label) + ' →</button>';
      if (n.altAction) {
        html += '<button type="button" class="qp-alt" data-qp-step="' + esc(n.key) + '" data-qp-alt="1">または ' + esc(n.altAction.label) + '</button>';
      }
      html += '</div>';
    } else if (result.allDone) {
      html += '<div class="qp-next"><div class="qp-next-h">準備はすべて済みました</div>'
        + '<div class="qp-next-d" style="margin:0">作品を追加・修正したら、キャプションを印刷し直してください。</div></div>';
    }
    html += '<ol>' + result.steps.map(s =>
      '<li class="qp-' + s.state + '"><span class="qp-mark">' + MARK[s.state] + '</span><div>'
      + '<div class="qp-label">' + esc(s.label) + '</div>'
      + (s.detail && s.state !== 'todo' ? '<div class="qp-detail">' + esc(s.detail) + '</div>' : '')
      + (s.warning ? '<div class="qp-warn">⚠ ' + esc(s.warning) + '</div>' : '')
      + '</div></li>').join('') + '</ol>';
    html += '<details><summary>必要に応じて (やらなくても展示できます)</summary>'
      + result.optional.map(o => '<div class="qp-opt"><a href="' + esc(o.href) + '">' + esc(o.label) + '</a><span>' + esc(o.status) + '</span></div>').join('')
      + '</details>';
    panel.querySelector('.qp-body').innerHTML = html;
  }

  async function fetchInput(exCode) {
    const db = firebase.firestore();
    const snap = await db.collection('exhibitions').doc(exCode).get();
    if (!snap.exists) return null;
    const ex = snap.data() || {};
    const user = firebase.auth().currentUser;
    const email = ((user && user.email) || '').trim().toLowerCase();
    const isOp = !!(email && window.operatorAuth && window.operatorAuth.isOperatorEmail(email));

    let artworks = null;
    if (Array.isArray(opts.artworks)) {
      artworks = opts.artworks;
    } else if (email) {
      try {
        // Rules は filter ではないので主催者は organizerEmail の where が必須
        let q = db.collection('artworks').where('exCode', '==', exCode);
        if (!isOp) q = q.where('organizerEmail', '==', email);
        const as = await q.get();
        artworks = as.docs.map(doc => doc.data());
      } catch (e) { console.warn('progress: artworks read failed:', e); }
    }

    let hasPastExhibitions = false;
    const exEmail = ((ex.email || '') + '').trim().toLowerCase();
    if (email && exEmail && !ex.fields_confirmed_at) {
      try {
        const ps = await db.collection('exhibitions').where('email', '==', exEmail).limit(5).get();
        hasPastExhibitions = ps.docs.some(doc => doc.id !== exCode);
      } catch (e) { console.warn('progress: exhibitions list failed:', e); }
    }
    return { ex, exCode, artworks, hasPastExhibitions };
  }

  async function refresh() {
    if (!opts || !opts.exCode) return;
    if (loading) { pending = true; return; }
    if (!window.firebase || !window.QriineProgressCore) return;
    loading = true;
    try {
      const input = await fetchInput(opts.exCode);
      if (!input) return;
      const result = window.QriineProgressCore.computeProgress(input);
      const prev = (lastResult && lastResult.exCode === result.exCode) ? lastResult : null;
      // 「今済んだ」= 前回が未着手/途中で今回済み (前回データ未取得 unknown からの変化は数えない)
      const justDone = prev ? result.steps.filter(s => {
        const before = (prev.steps.find(p => p.key === s.key) || {}).state;
        return s.state === 'done' && (before === 'todo' || before === 'partial');
      }) : [];
      lastResult = result;
      render(result, justDone);

      if (justDone.length) {
        open();
      } else if (!prev && result.doneCount === 0) {
        // 何も済んでいない展覧会を開いた最初の1回だけ自動で開く。
        // sessionStorage (タブ単位) なので共用端末で次の人に焼き付かない。
        const key = 'qp_auto_' + result.exCode;
        let seen = false;
        try { seen = sessionStorage.getItem(key) === '1'; sessionStorage.setItem(key, '1'); } catch (e) { /* 無効でも動く */ }
        if (!seen) open();
      }
    } catch (e) {
      console.warn('progress refresh failed:', e);
    } finally {
      loading = false;
      if (pending) { pending = false; refresh(); }
    }
  }

  function attach(options) {
    const changed = !opts || opts.exCode !== options.exCode;
    opts = Object.assign({}, opts || {}, options);
    if (changed) lastResult = null;
    return refresh();
  }

  window.QriineProgress = { attach, refresh, open, close };
})();
