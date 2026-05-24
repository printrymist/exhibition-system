// dashboard-metrics.js
// 純粋関数群: likes / artworks / exhibitions の配列 + 設定オブジェクトを入力に取り、
// 計算結果オブジェクトを返す。DOM 描画はしない。テスタブル / 再利用可能。
// dashboard.html / analytics.html / reports.html 等の複数 client から呼ぶ。
//
// 設計方針:
// - 入力 like / artwork の構造はそのまま (Firestore からの素データ)
// - すべての関数は副作用なし (グローバル変更なし)
// - 設定値 (opening_at, session 境界等) は引数で渡す
// - エラーや欠損データは「結果に 0 や空配列を返す」で対応 (throw しない)
//
// 採用方針 (詳細は memory project_dashboard_metrics):
// - 時間軸は絶対値 (15min, 30min)
// - likes 軸はカバー率 (10%, 30%) — 出展数に依存しない比較を可能にする
// - session 境界は gap > 2h or 日付跨ぎ
(function (global) {
  'use strict';

  // ─────────────────────────────────────────────────────────────
  // 共通フィルタ
  // ─────────────────────────────────────────────────────────────

  // opening_at より前のいいねを除外。openingAt が空なら全て通す。
  function filterByOpeningAt(likes, openingAt) {
    if (!openingAt) return likes.slice();
    const cutoff = new Date(openingAt).getTime();
    if (!isFinite(cutoff)) return likes.slice();
    return likes.filter(function (l) {
      const t = l && l.timestamp ? new Date(l.timestamp).getTime() : NaN;
      return isFinite(t) && t >= cutoff;
    });
  }

  // 運営者・作家として除外フラグ付きの likes を除外。
  function filterExcluded(likes) {
    return likes.filter(function (l) {
      return !l || !l.excluded_from_stats;
    });
  }

  // ─────────────────────────────────────────────────────────────
  // V-1 コメント率
  // ─────────────────────────────────────────────────────────────
  // = ユニークコメンター数 / ユニーク liker 数
  // 「いいねを押した人のうち、言葉も残した割合」
  function computeCommentRate(likes) {
    const likers = new Set();
    const commenters = new Set();
    likes.forEach(function (l) {
      if (!l || !l.sessionId) return;
      if (l.isLike) likers.add(l.sessionId);
      if (l.comment && String(l.comment).trim()) commenters.add(l.sessionId);
    });
    const likerCount = likers.size;
    const commenterCount = commenters.size;
    return {
      likerCount: likerCount,
      commenterCount: commenterCount,
      rate: likerCount === 0 ? 0 : commenterCount / likerCount,
    };
  }

  // ─────────────────────────────────────────────────────────────
  // V-2 平均コメント長 (中央値)
  // ─────────────────────────────────────────────────────────────
  // 計算方法: Array.from(s.trim()).length
  //   - 絵文字 1 字として数える
  //   - 前後の空白は除外
  //   - 内側の空白・改行は保持
  function computeMedianCommentLength(likes) {
    const lengths = [];
    likes.forEach(function (l) {
      if (!l || !l.comment) return;
      const t = String(l.comment).trim();
      if (!t) return;
      lengths.push(Array.from(t).length);
    });
    if (lengths.length === 0) return { median: 0, count: 0 };
    lengths.sort(function (a, b) { return a - b; });
    const mid = Math.floor(lengths.length / 2);
    const median = lengths.length % 2 === 0
      ? (lengths[mid - 1] + lengths[mid]) / 2
      : lengths[mid];
    return { median: median, count: lengths.length };
  }

  // ─────────────────────────────────────────────────────────────
  // V-3 関与の段階 (3 段階併記、likes 軸はカバー率)
  // ─────────────────────────────────────────────────────────────
  // tier1 = ≥1 like         (反応した)
  // tier2 = ≥10% カバー     (ハマった)
  // tier3 = ≥30% カバー     (沈み込んだ)
  //
  // カバー率 = visitor の押したいいね数 / 出展作品数
  // 出展数 < 1 のときは tier2/tier3 は計算不能 → 0 を返す
  function computeEngagementTiers(likes, artworkCount) {
    const likesByVisitor = {};
    likes.forEach(function (l) {
      if (!l || !l.isLike || !l.sessionId) return;
      likesByVisitor[l.sessionId] = (likesByVisitor[l.sessionId] || 0) + 1;
    });
    const visitorIds = Object.keys(likesByVisitor);
    const visitorCount = visitorIds.length;
    if (visitorCount === 0) {
      return {
        tier1: 0, tier2: 0, tier3: 0,
        tier1Rate: 0, tier2Rate: 0, tier3Rate: 0,
        visitorCount: 0,
        artworkCount: artworkCount,
      };
    }
    let tier1 = 0, tier2 = 0, tier3 = 0;
    visitorIds.forEach(function (sid) {
      const count = likesByVisitor[sid];
      if (count >= 1) tier1++;
      if (artworkCount > 0) {
        const coverage = count / artworkCount;
        if (coverage >= 0.10) tier2++;
        if (coverage >= 0.30) tier3++;
      }
    });
    return {
      tier1: tier1,
      tier2: tier2,
      tier3: tier3,
      tier1Rate: tier1 / visitorCount,
      tier2Rate: tier2 / visitorCount,
      tier3Rate: tier3 / visitorCount,
      visitorCount: visitorCount,
      artworkCount: artworkCount,
    };
  }

  // ─────────────────────────────────────────────────────────────
  // 出展数の判定: status='1' のみカウント (空きスロット除外)
  // ─────────────────────────────────────────────────────────────
  function countRegisteredArtworks(artworks) {
    let n = 0;
    (artworks || []).forEach(function (a) {
      if (!a) return;
      const s = String(a.status == null ? '' : a.status).trim();
      if (s === '1') n++;
    });
    return n;
  }

  // ─────────────────────────────────────────────────────────────
  // export
  // ─────────────────────────────────────────────────────────────
  global.DashboardMetrics = {
    filterByOpeningAt: filterByOpeningAt,
    filterExcluded: filterExcluded,
    computeCommentRate: computeCommentRate,
    computeMedianCommentLength: computeMedianCommentLength,
    computeEngagementTiers: computeEngagementTiers,
    countRegisteredArtworks: countRegisteredArtworks,
  };
})(typeof window !== 'undefined' ? window : this);
