// 練習モード (sandbox) のバッジ・バナー表示ヘルパ
// 使い方:
//   <div id="sandboxBadge"></div>
//   <script src="js/sandbox-badge.js"></script>
//   <script>
//     // 第 4 引数で幅を指定可。指定なしなら親要素一杯まで広がる。
//     window.sandboxBadge.render('sandboxBadge', exhibitionData, 'operator', { maxWidth: '660px' });
//   </script>

(function () {
  'use strict';

  function daysUntil(dateLike) {
    if (!dateLike) return null;
    var d = (typeof dateLike.toDate === 'function') ? dateLike.toDate() : new Date(dateLike);
    if (isNaN(d.getTime())) return null;
    var diffMs = d.getTime() - Date.now();
    return Math.ceil(diffMs / (1000 * 60 * 60 * 24));
  }

  function render(elIdOrEl, exhibitionData, role, opts) {
    var el = (typeof elIdOrEl === 'string') ? document.getElementById(elIdOrEl) : elIdOrEl;
    if (!el) return;
    if (!exhibitionData || !exhibitionData.is_sandbox) {
      el.style.display = 'none';
      el.innerHTML = '';
      return;
    }
    var days = daysUntil(exhibitionData.expire_at);
    var text;
    if (role === 'visitor' || role === 'artist') {
      text = '🧪 これは練習用展覧会です。投稿データは後日削除されます。';
    } else {
      // 運営者向け
      if (days != null && days >= 0) {
        text = '🧪 練習モード — 残り ' + days + ' 日で自動削除';
      } else if (days != null && days < 0) {
        text = '🧪 練習モード — 削除予定日を過ぎています';
      } else {
        text = '🧪 練習モード';
      }
    }
    var maxWidth = (opts && opts.maxWidth) ? opts.maxWidth : '';
    var styles = [
      'background:#fff8e1',
      'color:#7a5500',
      'padding:10px 14px',
      'border:1px solid #ffd54f',
      'border-radius:8px',
      'font-size:0.92em',
      'font-weight:bold',
      'margin:10px auto',
      'text-align:center',
    ];
    if (maxWidth) styles.push('max-width:' + maxWidth);
    el.style.cssText = styles.join(';');
    el.textContent = text;
    el.style.display = 'block';
  }

  window.sandboxBadge = {
    render: render,
    daysUntil: daysUntil,
  };
})();
