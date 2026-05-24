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
  // Session 境界による分割 (1-A 確定ルール: gap > 2h or 日付跨ぎ)
  // ─────────────────────────────────────────────────────────────
  // 戻り値: { [sessionId]: [ { start, end, count }, ... ] }
  //   start/end = timestamp (ms)、count = そのセッション内のいいね数
  // isLike=true のみカウント、無効 timestamp は無視。
  const SESSION_GAP_MS = 2 * 60 * 60 * 1000; // 2 時間

  function _dateKey(ts) {
    const d = new Date(ts);
    return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate();
  }

  function computeSessionsByVisitor(likes) {
    const timesBySession = {};
    likes.forEach(function (l) {
      if (!l || !l.sessionId || !l.isLike) return;
      const t = l.timestamp ? new Date(l.timestamp).getTime() : NaN;
      if (!isFinite(t)) return;
      if (!timesBySession[l.sessionId]) timesBySession[l.sessionId] = [];
      timesBySession[l.sessionId].push(t);
    });
    const visitors = {};
    Object.keys(timesBySession).forEach(function (sid) {
      const times = timesBySession[sid].slice().sort(function (a, b) { return a - b; });
      const sessions = [];
      let current = null;
      times.forEach(function (t) {
        if (!current) {
          current = { start: t, end: t, count: 1 };
          return;
        }
        const gap = t - current.end;
        const prevDate = _dateKey(current.end);
        const curDate = _dateKey(t);
        if (gap > SESSION_GAP_MS || prevDate !== curDate) {
          sessions.push(current);
          current = { start: t, end: t, count: 1 };
        } else {
          current.end = t;
          current.count++;
        }
      });
      if (current) sessions.push(current);
      visitors[sid] = sessions;
    });
    return visitors;
  }

  // ─────────────────────────────────────────────────────────────
  // V-4 滞在時間中央値
  // ─────────────────────────────────────────────────────────────
  // 各 session の dwell (= end - start) の中央値。単位は分。
  // いいね 1 件のみの session は dwell = 0 → 「< 1 分」扱いで含める
  // (見えない visitor を作らない方針)。
  function computeMedianSessionDwell(visitors) {
    const dwells = [];
    Object.keys(visitors).forEach(function (sid) {
      visitors[sid].forEach(function (s) {
        dwells.push((s.end - s.start) / 60000);
      });
    });
    if (dwells.length === 0) return { median: 0, count: 0 };
    dwells.sort(function (a, b) { return a - b; });
    const mid = Math.floor(dwells.length / 2);
    const median = dwells.length % 2 === 0
      ? (dwells[mid - 1] + dwells[mid]) / 2
      : dwells[mid];
    return { median: median, count: dwells.length };
  }

  // ─────────────────────────────────────────────────────────────
  // V-5 滞在分布
  // ─────────────────────────────────────────────────────────────
  // session 単位の分布: <1min / 1-5min / 5-30min / 30min+
  function computeDwellDistribution(visitors) {
    const buckets = { lt1: 0, b1to5: 0, b5to30: 0, gte30: 0 };
    let total = 0;
    Object.keys(visitors).forEach(function (sid) {
      visitors[sid].forEach(function (s) {
        const m = (s.end - s.start) / 60000;
        if (m < 1) buckets.lt1++;
        else if (m < 5) buckets.b1to5++;
        else if (m < 30) buckets.b5to30++;
        else buckets.gte30++;
        total++;
      });
    });
    return { buckets: buckets, total: total };
  }

  // ─────────────────────────────────────────────────────────────
  // V-6 深い visitor (2 段階併記、likes はカバー率、時間は絶対値)
  // ─────────────────────────────────────────────────────────────
  // engaged: 累計カバー率 ≥10% かつ best session dwell ≥15min
  // sunk:    累計カバー率 ≥30% かつ best session dwell ≥30min
  //   - 同じ visitor が複数 session 持つ場合、best (= 最長の) session の dwell を採用
  //   - 累計カバー率は visitor が押した全 likes / 出展数 (複数 session 合算)
  function computeDeepVisitors(visitors, artworkCount) {
    const ids = Object.keys(visitors);
    const visitorCount = ids.length;
    if (visitorCount === 0 || artworkCount === 0) {
      return {
        engagedCount: 0, sunkCount: 0,
        engagedRate: 0, sunkRate: 0,
        visitorCount: visitorCount, artworkCount: artworkCount,
      };
    }
    let engaged = 0;
    let sunk = 0;
    ids.forEach(function (sid) {
      const sessions = visitors[sid];
      let totalLikes = 0;
      let bestDwell = 0;
      sessions.forEach(function (s) {
        totalLikes += s.count;
        const m = (s.end - s.start) / 60000;
        if (m > bestDwell) bestDwell = m;
      });
      const coverage = totalLikes / artworkCount;
      if (coverage >= 0.10 && bestDwell >= 15) engaged++;
      if (coverage >= 0.30 && bestDwell >= 30) sunk++;
    });
    return {
      engagedCount: engaged,
      sunkCount: sunk,
      engagedRate: engaged / visitorCount,
      sunkRate: sunk / visitorCount,
      visitorCount: visitorCount,
      artworkCount: artworkCount,
    };
  }

  // ─────────────────────────────────────────────────────────────
  // W-3 コメント付き作品ランキング
  // ─────────────────────────────────────────────────────────────
  // 作品ごとのコメント数 (空でないもの) をカウント、降順ソート。
  function computeCommentRanking(likes) {
    const counts = {};
    likes.forEach(function (l) {
      if (!l || !l.workId) return;
      if (l.comment && String(l.comment).trim()) {
        counts[l.workId] = (counts[l.workId] || 0) + 1;
      }
    });
    return Object.keys(counts).map(function (id) {
      return { artworkId: id, commentCount: counts[id] };
    }).sort(function (a, b) { return b.commentCount - a.commentCount; });
  }

  // ─────────────────────────────────────────────────────────────
  // W-4 いいね 0 作品リスト
  // ─────────────────────────────────────────────────────────────
  // status='1' (出展中) かつ likes コレクションに isLike=true レコードが
  // 1 件も無い作品を抽出。作家への正直なフィードバック。
  function findZeroLikeArtworks(artworks, likes) {
    const liked = {};
    likes.forEach(function (l) {
      if (!l || !l.workId || !l.isLike) return;
      liked[l.workId] = true;
    });
    return (artworks || []).filter(function (a) {
      if (!a) return false;
      const s = String(a.status == null ? '' : a.status).trim();
      if (s !== '1') return false;
      return !liked[a.artwork_id];
    });
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
    computeSessionsByVisitor: computeSessionsByVisitor,
    computeMedianSessionDwell: computeMedianSessionDwell,
    computeDwellDistribution: computeDwellDistribution,
    computeDeepVisitors: computeDeepVisitors,
    computeCommentRanking: computeCommentRanking,
    findZeroLikeArtworks: findZeroLikeArtworks,
  };
})(typeof window !== 'undefined' ? window : this);
