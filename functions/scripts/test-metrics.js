// test-metrics.js
// dashboard-metrics.js (純粋関数群) のユニットテスト。
// 使用: `node functions/scripts/test-metrics.js`
// 終了コード: 失敗数 (CI で失敗を検出可能)
//
// dashboard-metrics.js は browser-format の IIFE だが、CommonJS 経由で
// require すると this = module.exports が global parameter に渡るので
// module.exports.DashboardMetrics として参照できる。

'use strict';
const path = require('path');
const M = require(path.join(__dirname, '..', '..', 'public', 'js', 'dashboard-metrics.js'));
const DM = M.DashboardMetrics;

if (!DM) {
  console.error('FATAL: DashboardMetrics not loaded from dashboard-metrics.js');
  process.exit(99);
}

// ─────────────────────────────────────────────────────────────
// テスト基盤
// ─────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (e) {
    failed++;
    failures.push({ name, error: e });
    console.error('  ✗ ' + name);
    console.error('    ' + (e.stack || e.message || e));
  }
}
function group(name, fn) {
  console.log('\n# ' + name);
  fn();
}
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error((msg ? msg + ': ' : '') + 'expected ' + e + ', got ' + a);
  }
}
function close(actual, expected, epsilon, msg) {
  epsilon = epsilon === undefined ? 0.0001 : epsilon;
  if (Math.abs(actual - expected) > epsilon) {
    throw new Error((msg ? msg + ': ' : '') + 'expected ' + expected + ' ± ' + epsilon + ', got ' + actual);
  }
}
function truthy(v, msg) {
  if (!v) throw new Error((msg || 'expected truthy') + ', got ' + JSON.stringify(v));
}

// ─────────────────────────────────────────────────────────────
// fixture ヘルパ
// ─────────────────────────────────────────────────────────────
function like(o) {
  // 既定: isLike=true, source='gallery'
  return Object.assign({
    isLike: true,
    source: 'gallery',
    comment: '',
    nickname: '',
  }, o);
}
function artwork(id, artist, status) {
  return {
    artwork_id: id,
    exCode: 'TEST',
    title: 'Title ' + id,
    artist: artist || '作家 ' + id,
    status: status === undefined ? '1' : status,
  };
}
function isoMin(baseIso, addMinutes) {
  return new Date(new Date(baseIso).getTime() + addMinutes * 60000).toISOString();
}

// ─────────────────────────────────────────────────────────────
// テスト本体
// ─────────────────────────────────────────────────────────────

group('filterByOpeningAt', () => {
  test('空配列 → 空配列', () => {
    eq(DM.filterByOpeningAt([], '2026-05-01T10:00:00Z'), []);
  });
  test('openingAt 未設定 → そのまま返す', () => {
    const likes = [like({ sessionId: 'a', timestamp: '2026-05-01T10:00:00Z' })];
    eq(DM.filterByOpeningAt(likes, '').length, 1);
    eq(DM.filterByOpeningAt(likes, null).length, 1);
  });
  test('openingAt より前を除外', () => {
    const likes = [
      like({ sessionId: 'a', timestamp: '2026-04-30T10:00:00Z' }), // 前
      like({ sessionId: 'a', timestamp: '2026-05-01T10:00:00Z' }), // 同時刻
      like({ sessionId: 'a', timestamp: '2026-05-01T11:00:00Z' }), // 後
    ];
    const filtered = DM.filterByOpeningAt(likes, '2026-05-01T10:00:00Z');
    eq(filtered.length, 2, '後 2 件のみ');
  });
  test('無効 timestamp は除外', () => {
    const likes = [
      like({ sessionId: 'a', timestamp: 'invalid' }),
      like({ sessionId: 'a', timestamp: '2026-05-01T11:00:00Z' }),
    ];
    const filtered = DM.filterByOpeningAt(likes, '2026-05-01T10:00:00Z');
    eq(filtered.length, 1);
  });
});

group('filterExcluded', () => {
  test('excluded_from_stats=true を除外', () => {
    const likes = [
      like({ sessionId: 'a', excluded_from_stats: true }),
      like({ sessionId: 'b' }),
      like({ sessionId: 'c', excluded_from_stats: false }),
    ];
    eq(DM.filterExcluded(likes).length, 2);
  });
});

group('computeCommentRate (V-1)', () => {
  test('likes 無し → 0', () => {
    const r = DM.computeCommentRate([]);
    eq(r, { likerCount: 0, commenterCount: 0, rate: 0 });
  });
  test('1 人が like のみ → rate 0、liker 1', () => {
    const r = DM.computeCommentRate([like({ sessionId: 'a' })]);
    eq(r.likerCount, 1);
    eq(r.commenterCount, 0);
    eq(r.rate, 0);
  });
  test('1 人が like + コメント → rate 1', () => {
    const r = DM.computeCommentRate([like({ sessionId: 'a', comment: 'いいね' })]);
    eq(r.rate, 1);
    eq(r.commenterCount, 1);
  });
  test('同一 visitor の複数コメントは 1 人扱い', () => {
    const r = DM.computeCommentRate([
      like({ sessionId: 'a', comment: 'first' }),
      like({ sessionId: 'a', comment: 'second' }),
    ]);
    eq(r.commenterCount, 1);
    eq(r.likerCount, 1);
  });
  test('空白のみのコメントは無視', () => {
    const r = DM.computeCommentRate([like({ sessionId: 'a', comment: '   ' })]);
    eq(r.commenterCount, 0);
  });
  test('3 人中 1 人コメント → rate ≈ 0.333', () => {
    const r = DM.computeCommentRate([
      like({ sessionId: 'a', comment: '良い' }),
      like({ sessionId: 'b' }),
      like({ sessionId: 'c' }),
    ]);
    close(r.rate, 1 / 3);
  });
});

group('computeMedianCommentLength (V-2)', () => {
  test('コメント無し → 0', () => {
    eq(DM.computeMedianCommentLength([]), { median: 0, count: 0 });
  });
  test('1 件のコメント → 中央値 = それ自身', () => {
    const r = DM.computeMedianCommentLength([like({ comment: 'あいう' })]);
    eq(r, { median: 3, count: 1 });
  });
  test('絵文字 1 字としてカウント', () => {
    const r = DM.computeMedianCommentLength([like({ comment: '🎨🎉' })]);
    eq(r.median, 2);
  });
  test('前後空白は trim', () => {
    const r = DM.computeMedianCommentLength([like({ comment: '  ab  ' })]);
    eq(r.median, 2);
  });
  test('内側の空白は保持', () => {
    const r = DM.computeMedianCommentLength([like({ comment: 'a b' })]);
    eq(r.median, 3);
  });
  test('偶数件の中央値 = 平均', () => {
    const r = DM.computeMedianCommentLength([
      like({ comment: 'a' }),    // 1
      like({ comment: 'abc' }),  // 3
    ]);
    eq(r.median, 2);
  });
  test('奇数件の中央値 = 中央', () => {
    const r = DM.computeMedianCommentLength([
      like({ comment: 'a' }),
      like({ comment: 'abcde' }),
      like({ comment: 'abc' }),
    ]);
    eq(r.median, 3);
  });
});

group('computeEngagementTiers (V-3 カバー率 3 段階)', () => {
  test('visitor 無し → all 0', () => {
    const r = DM.computeEngagementTiers([], 30);
    eq(r.tier1, 0); eq(r.tier2, 0); eq(r.tier3, 0);
  });
  test('30 作品中 1 visitor が 2 件 (6.7%) → tier1 のみ', () => {
    const likes = [
      like({ sessionId: 'a', workId: 'w1' }),
      like({ sessionId: 'a', workId: 'w2' }),
    ];
    const r = DM.computeEngagementTiers(likes, 30);
    eq(r.tier1, 1); eq(r.tier2, 0); eq(r.tier3, 0);
  });
  test('30 作品中 1 visitor が 3 件 ぴったり = 10% → tier2 達成', () => {
    // 3/30 = 0.10 ぴったり、≥10% → tier2 達成
    const r = DM.computeEngagementTiers(
      Array(3).fill().map((_, i) => like({ sessionId: 'a', workId: 'w' + i })),
      30
    );
    eq(r.tier2, 1);
    eq(r.tier3, 0);
  });
  test('30 作品中 1 visitor が 8 件 (26.7%) → tier2 のみ', () => {
    const r = DM.computeEngagementTiers(
      Array(8).fill().map((_, i) => like({ sessionId: 'a', workId: 'w' + i })),
      30
    );
    eq(r.tier2, 1);
    eq(r.tier3, 0);
  });
  test('30 作品中 1 visitor が 9 件 ぴったり = 30% → tier3 達成', () => {
    // 9/30 = 0.30 ぴったり、≥30% → tier3
    const r = DM.computeEngagementTiers(
      Array(9).fill().map((_, i) => like({ sessionId: 'a', workId: 'w' + i })),
      30
    );
    eq(r.tier3, 1);
  });
  test('artworkCount=0 → tier2/3 = 0', () => {
    const r = DM.computeEngagementTiers([like({ sessionId: 'a' })], 0);
    eq(r.tier1, 1); eq(r.tier2, 0); eq(r.tier3, 0);
  });
  test('isLike=false は除外', () => {
    const r = DM.computeEngagementTiers([like({ sessionId: 'a', isLike: false })], 30);
    eq(r.tier1, 0);
  });
});

group('countRegisteredArtworks', () => {
  test('status=1 のみカウント', () => {
    const arr = [
      artwork('a1', 'x', '1'),
      artwork('a2', 'x', '0'),
      artwork('a3', 'x', ''),
      artwork('a4', 'x', '1'),
    ];
    eq(DM.countRegisteredArtworks(arr), 2);
  });
});

group('computeSessionsByVisitor (1-A: 2h gap + 日付跨ぎ)', () => {
  test('単一いいね → 1 session', () => {
    const r = DM.computeSessionsByVisitor([
      like({ sessionId: 'a', timestamp: '2026-05-01T10:00:00Z' })
    ]);
    eq(r.a.length, 1);
    eq(r.a[0].count, 1);
  });
  test('1 時間以内の連続は同一 session', () => {
    const r = DM.computeSessionsByVisitor([
      like({ sessionId: 'a', timestamp: '2026-05-01T10:00:00Z' }),
      like({ sessionId: 'a', timestamp: isoMin('2026-05-01T10:00:00Z', 30) }),
      like({ sessionId: 'a', timestamp: isoMin('2026-05-01T10:00:00Z', 90) }),
    ]);
    eq(r.a.length, 1);
    eq(r.a[0].count, 3);
  });
  test('2 時間以上の gap で分割', () => {
    const r = DM.computeSessionsByVisitor([
      like({ sessionId: 'a', timestamp: '2026-05-01T10:00:00Z' }),
      like({ sessionId: 'a', timestamp: isoMin('2026-05-01T10:00:00Z', 130) }),
    ]);
    eq(r.a.length, 2);
  });
  test('2 時間ちょうどは同一 session (> なので)', () => {
    const r = DM.computeSessionsByVisitor([
      like({ sessionId: 'a', timestamp: '2026-05-01T10:00:00Z' }),
      like({ sessionId: 'a', timestamp: isoMin('2026-05-01T10:00:00Z', 120) }),
    ]);
    eq(r.a.length, 1);
  });
  test('日付跨ぎで分割 (gap < 2h でも)', () => {
    const r = DM.computeSessionsByVisitor([
      like({ sessionId: 'a', timestamp: '2026-05-01T23:30:00+09:00' }),
      like({ sessionId: 'a', timestamp: '2026-05-02T00:30:00+09:00' }),
    ]);
    eq(r.a.length, 2, '日付跨ぎ');
  });
  test('isLike=false は無視', () => {
    const r = DM.computeSessionsByVisitor([
      like({ sessionId: 'a', timestamp: '2026-05-01T10:00:00Z', isLike: false })
    ]);
    eq(r.a, undefined);
  });
});

group('computeMedianSessionDwell (V-4)', () => {
  test('session 無し → 0', () => {
    eq(DM.computeMedianSessionDwell({}), { median: 0, count: 0 });
  });
  test('1 件 session の dwell 中央値', () => {
    const visitors = {
      a: [{ start: 0, end: 600000, count: 2 }], // 10 分
    };
    eq(DM.computeMedianSessionDwell(visitors), { median: 10, count: 1 });
  });
  test('複数 session の中央値', () => {
    const visitors = {
      a: [{ start: 0, end: 60000, count: 2 }],         // 1 min
      b: [{ start: 0, end: 600000, count: 2 }],        // 10 min
      c: [{ start: 0, end: 1800000, count: 2 }],       // 30 min
    };
    eq(DM.computeMedianSessionDwell(visitors).median, 10);
  });
});

group('computeDwellDistribution (V-5)', () => {
  test('境界値の振り分け (<1, 1-5, 5-30, 30+)', () => {
    const visitors = {
      a: [
        { start: 0, end: 30000, count: 2 },         // 0.5 min → lt1
        { start: 0, end: 60000, count: 2 },         // 1.0 min → b1to5
        { start: 0, end: 240000, count: 2 },        // 4 min → b1to5
        { start: 0, end: 300000, count: 2 },        // 5 min → b5to30
        { start: 0, end: 1740000, count: 2 },       // 29 min → b5to30
        { start: 0, end: 1800000, count: 2 },       // 30 min → gte30
        { start: 0, end: 3600000, count: 2 },       // 60 min → gte30
      ]
    };
    const r = DM.computeDwellDistribution(visitors);
    eq(r.buckets, { lt1: 1, b1to5: 2, b5to30: 2, gte30: 2 });
    eq(r.total, 7);
  });
});

group('computeDeepVisitors (V-6)', () => {
  test('artworkCount=0 → all 0', () => {
    const visitors = { a: [{ start: 0, end: 1000000, count: 5 }] };
    const r = DM.computeDeepVisitors(visitors, 0);
    eq(r.engagedCount, 0); eq(r.sunkCount, 0);
  });
  test('30 作品中 3 件 × 15 min ぴったり → engaged', () => {
    const visitors = { a: [{ start: 0, end: 15 * 60000, count: 3 }] };
    const r = DM.computeDeepVisitors(visitors, 30);
    eq(r.engagedCount, 1);
    eq(r.sunkCount, 0);
  });
  test('30 作品中 9 件 × 30 min → sunk + engaged 両方', () => {
    const visitors = { a: [{ start: 0, end: 30 * 60000, count: 9 }] };
    const r = DM.computeDeepVisitors(visitors, 30);
    eq(r.engagedCount, 1);
    eq(r.sunkCount, 1);
  });
  test('カバー率は累計、dwell はベスト session', () => {
    // 2 session: 短いが累計で 30% カバー、ベスト session は 35 分
    const visitors = {
      a: [
        { start: 0, end: 35 * 60000, count: 5 },        // 35 min / 5 likes
        { start: 100000000, end: 100000001, count: 4 }, // 短い / 4 likes
      ]
    };
    const r = DM.computeDeepVisitors(visitors, 30);
    // total likes = 9 → coverage 30%、best dwell = 35 min → both 達成
    eq(r.engagedCount, 1);
    eq(r.sunkCount, 1);
  });
});

group('computeCommentRanking (W-3)', () => {
  test('コメント数で降順、空コメントは除外', () => {
    const likes = [
      like({ workId: 'w1', comment: 'hi' }),
      like({ workId: 'w1', comment: 'good' }),
      like({ workId: 'w2', comment: 'wow' }),
      like({ workId: 'w3', comment: '   ' }),  // 空白のみ → 除外
      like({ workId: 'w3' }),                   // コメント無し
    ];
    const r = DM.computeCommentRanking(likes);
    eq(r.length, 2);
    eq(r[0], { artworkId: 'w1', commentCount: 2 });
    eq(r[1], { artworkId: 'w2', commentCount: 1 });
  });
});

group('findZeroLikeArtworks (W-4)', () => {
  test('いいね無しの status=1 のみ', () => {
    const artworks = [
      artwork('a1', 'x', '1'),
      artwork('a2', 'x', '1'),
      artwork('a3', 'x', '0'),  // 出展してない
    ];
    const likes = [
      like({ workId: 'a1', isLike: true }),
    ];
    const r = DM.findZeroLikeArtworks(artworks, likes);
    eq(r.length, 1);
    eq(r[0].artwork_id, 'a2');
  });
});

group('computeRepeatRate (V-7)', () => {
  test('複数 session の visitor の比率', () => {
    const visitors = {
      a: [{ start: 0, end: 100, count: 1 }, { start: 1000, end: 2000, count: 2 }],
      b: [{ start: 0, end: 100, count: 1 }],
      c: [{ start: 0, end: 100, count: 1 }, { start: 1000, end: 2000, count: 2 }],
      d: [{ start: 0, end: 100, count: 1 }],
    };
    const r = DM.computeRepeatRate(visitors);
    eq(r.repeatCount, 2);
    eq(r.totalVisitors, 4);
    eq(r.rate, 0.5);
  });
});

group('computeCoverageRate (V-8)', () => {
  test('30 作品中 27 いいね → 90%', () => {
    const artworks = Array(30).fill().map((_, i) => artwork('w' + i, 'x', '1'));
    const likes = Array(27).fill().map((_, i) => like({ workId: 'w' + i }));
    const r = DM.computeCoverageRate(artworks, likes);
    eq(r.covered, 27);
    eq(r.total, 30);
    close(r.rate, 0.9);
  });
  test('status=0 の作品は対象外', () => {
    const artworks = [artwork('w1', 'x', '0'), artwork('w2', 'x', '1')];
    const r = DM.computeCoverageRate(artworks, [like({ workId: 'w2' })]);
    eq(r.total, 1);
    eq(r.rate, 1);
  });
});

group('computeLongTailIndex (V-9 上位 20% 占有率)', () => {
  test('完全均等 → topShare = 上位 20% / 全 = 20%', () => {
    // 10 作品 × 1 like each = 10 likes total
    // top 20% = 2 作品 = 2 likes / 10 = 20%
    const artworks = Array(10).fill().map((_, i) => artwork('w' + i, 'x', '1'));
    const likes = Array(10).fill().map((_, i) => like({ workId: 'w' + i }));
    const r = DM.computeLongTailIndex(artworks, likes);
    close(r.topShare, 0.2);
    eq(r.topN, 2);
  });
  test('完全集中 → topShare = 100%', () => {
    // 10 作品中 1 作品にだけ全 likes
    const artworks = Array(10).fill().map((_, i) => artwork('w' + i, 'x', '1'));
    const likes = Array(20).fill().map(() => like({ workId: 'w0' }));
    const r = DM.computeLongTailIndex(artworks, likes);
    close(r.topShare, 1.0);
  });
  test('上位 1 作品が 50%、残り均等 → 中庸', () => {
    // 10 作品 / w0=10 likes, w1..w9=1 like each → total=19
    // top 20% = 2 → w0(10) + w1(1) = 11/19
    const artworks = Array(10).fill().map((_, i) => artwork('w' + i, 'x', '1'));
    const likes = Array(10).fill().map(() => like({ workId: 'w0' }))
      .concat(Array(9).fill().map((_, i) => like({ workId: 'w' + (i + 1) })));
    const r = DM.computeLongTailIndex(artworks, likes);
    eq(r.topN, 2);
    close(r.topShare, 11 / 19);
  });
  test('topN は最低 1 (= 5 作品でも上位 20% = ceil(1) = 1)', () => {
    const artworks = Array(5).fill().map((_, i) => artwork('w' + i, 'x', '1'));
    const r = DM.computeLongTailIndex(artworks, []);
    eq(r.topN, 1);
  });
  test('total likes = 0 → topShare = 0', () => {
    const artworks = [artwork('w1', 'x', '1')];
    const r = DM.computeLongTailIndex(artworks, []);
    eq(r.topShare, 0);
  });
  test('sortedCounts は降順', () => {
    const artworks = [
      artwork('w1', 'x', '1'),
      artwork('w2', 'x', '1'),
      artwork('w3', 'x', '1'),
    ];
    const likes = [
      like({ workId: 'w2' }), like({ workId: 'w2' }),
      like({ workId: 'w1' }),
    ];
    const r = DM.computeLongTailIndex(artworks, likes);
    eq(r.sortedCounts.map(x => x.count), [2, 1, 0]);
  });
});

group('detectExhibitionKind', () => {
  test('1 作家 → solo', () => {
    eq(DM.detectExhibitionKind([artwork('a1', '山田', '1')]), 'solo');
  });
  test('複数作家 → group', () => {
    eq(DM.detectExhibitionKind([
      artwork('a1', '山田', '1'),
      artwork('a2', '鈴木', '1'),
    ]), 'group');
  });
  test('status=0 は無視', () => {
    eq(DM.detectExhibitionKind([
      artwork('a1', '山田', '1'),
      artwork('a2', '鈴木', '0'),
    ]), 'solo');
  });
  test('空 → solo (作家 0 人)', () => {
    eq(DM.detectExhibitionKind([]), 'solo');
  });
});

group('computeArtistReach (G-1/G-3/G-4)', () => {
  test('作家ごとの unique liker と reachRate', () => {
    const artworks = [
      artwork('a1', '山田', '1'),
      artwork('a2', '山田', '1'),
      artwork('a3', '鈴木', '1'),
    ];
    const likes = [
      like({ sessionId: 'v1', workId: 'a1' }),
      like({ sessionId: 'v1', workId: 'a2' }),  // 山田 を 2 件
      like({ sessionId: 'v2', workId: 'a1' }),  // 山田を別 visitor
      like({ sessionId: 'v3', workId: 'a3' }),  // 鈴木
    ];
    const r = DM.computeArtistReach(artworks, likes);
    eq(r.totalVisitorCount, 3);
    eq(r.artists.length, 2);
    // 山田: uniqueLiker=2 (v1, v2), totalLikes=3, avgDepth=1.5
    const yamada = r.artists.find(x => x.artist === '山田');
    eq(yamada.uniqueLiker, 2);
    close(yamada.reachRate, 2 / 3);
    close(yamada.avgDepth, 1.5);
    eq(yamada.totalLikes, 3);
    // 鈴木: uniqueLiker=1
    const suzuki = r.artists.find(x => x.artist === '鈴木');
    eq(suzuki.uniqueLiker, 1);
  });
  test('降順ソート', () => {
    const artworks = [
      artwork('a1', '山田', '1'),
      artwork('a2', '鈴木', '1'),
      artwork('a3', '佐藤', '1'),
    ];
    const likes = [
      like({ sessionId: 'v1', workId: 'a1' }),
      like({ sessionId: 'v2', workId: 'a1' }),
      like({ sessionId: 'v3', workId: 'a1' }),  // 山田 3 人
      like({ sessionId: 'v4', workId: 'a2' }),  // 鈴木 1 人
      like({ sessionId: 'v5', workId: 'a3' }),
      like({ sessionId: 'v6', workId: 'a3' }),  // 佐藤 2 人
    ];
    const r = DM.computeArtistReach(artworks, likes);
    eq(r.artists.map(x => x.artist), ['山田', '佐藤', '鈴木']);
  });
});

group('detectSuspectSessions (Y-1 〜 Y-4)', () => {
  test('Y-1: 出展 ≥10 で 50%+ カバー → 検出', () => {
    const artworks = Array(20).fill().map((_, i) => artwork('w' + i, '山田', '1'));
    const likes = Array(15).fill().map((_, i) => like({
      sessionId: 'op', workId: 'w' + i, timestamp: isoMin('2026-05-01T10:00:00Z', i)
    }));
    const r = DM.detectSuspectSessions(likes, artworks, {});
    eq(r.length, 1);
    eq(r[0].sessionId, 'op');
    const rules = r[0].rules.map(x => x.rule);
    truthy(rules.indexOf('Y-1') !== -1, 'Y-1 含む');
  });
  test('Y-1: 出展 <10 では検出しない', () => {
    const artworks = Array(5).fill().map((_, i) => artwork('w' + i, '山田', '1'));
    const likes = Array(4).fill().map((_, i) => like({
      sessionId: 'op', workId: 'w' + i, timestamp: isoMin('2026-05-01T10:00:00Z', i)
    }));
    const r = DM.detectSuspectSessions(likes, artworks, {});
    // 80% coverage だが artworkCount=5 < 10 で Y-1 適用外、他ルールも該当しない
    eq(r.length, 0);
  });
  test('Y-2: 5 分以内に 10 件以上 → 検出', () => {
    const artworks = Array(20).fill().map((_, i) => artwork('w' + i, '山田', '1'));
    // 10 likes within 4 minutes
    const likes = Array(10).fill().map((_, i) => like({
      sessionId: 'fast', workId: 'w' + i, timestamp: isoMin('2026-05-01T10:00:00Z', i * 0.4)
    }));
    const r = DM.detectSuspectSessions(likes, artworks, {});
    const rules = r[0].rules.map(x => x.rule);
    truthy(rules.indexOf('Y-2') !== -1, 'Y-2 含む');
  });
  test('Y-2 + Y-1 両方 → severity strong', () => {
    const artworks = Array(20).fill().map((_, i) => artwork('w' + i, '山田', '1'));
    const likes = Array(15).fill().map((_, i) => like({
      sessionId: 'op', workId: 'w' + i, timestamp: isoMin('2026-05-01T10:00:00Z', i * 0.2)
    }));
    const r = DM.detectSuspectSessions(likes, artworks, {});
    eq(r[0].severity, 'strong');
  });
  test('Y-3: グループ展で 1 作家のみ ≥3 件 → 検出', () => {
    const artworks = [
      artwork('w1', '山田', '1'), artwork('w2', '山田', '1'), artwork('w3', '山田', '1'),
      artwork('w4', '鈴木', '1'),
    ];
    const likes = [
      like({ sessionId: 'fan', workId: 'w1', timestamp: '2026-05-01T10:00:00Z' }),
      like({ sessionId: 'fan', workId: 'w2', timestamp: '2026-05-01T10:01:00Z' }),
      like({ sessionId: 'fan', workId: 'w3', timestamp: '2026-05-01T10:02:00Z' }),
    ];
    const r = DM.detectSuspectSessions(likes, artworks, { isGroupShow: true });
    const rules = r[0].rules.map(x => x.rule);
    truthy(rules.indexOf('Y-3') !== -1, 'Y-3 含む');
  });
  test('Y-3: solo 展では検出しない', () => {
    const artworks = [
      artwork('w1', '山田', '1'), artwork('w2', '山田', '1'), artwork('w3', '山田', '1'),
    ];
    const likes = [
      like({ sessionId: 'fan', workId: 'w1', timestamp: '2026-05-01T10:00:00Z' }),
      like({ sessionId: 'fan', workId: 'w2', timestamp: '2026-05-01T10:01:00Z' }),
      like({ sessionId: 'fan', workId: 'w3', timestamp: '2026-05-01T10:02:00Z' }),
    ];
    const r = DM.detectSuspectSessions(likes, artworks, { isGroupShow: false });
    // group ではないので Y-3 該当せず、他にも該当無し
    eq(r.length, 0);
  });
  test('Y-4: opening_at より前のいいね → informational', () => {
    const artworks = [artwork('w1', '山田', '1')];
    const likes = [
      like({ sessionId: 'op', workId: 'w1', timestamp: '2026-05-01T08:00:00Z' }),
    ];
    const r = DM.detectSuspectSessions(likes, artworks, {
      openingAt: '2026-05-01T10:00:00Z'
    });
    eq(r.length, 1);
    eq(r[0].severity, 'info');
    const rules = r[0].rules.map(x => x.rule);
    truthy(rules.indexOf('Y-4') !== -1, 'Y-4 含む');
  });
  test('該当ルール無し → 検出されない', () => {
    const artworks = Array(20).fill().map((_, i) => artwork('w' + i, '山田', '1'));
    const likes = [
      like({ sessionId: 'normal', workId: 'w1', timestamp: '2026-05-01T10:00:00Z' }),
      like({ sessionId: 'normal', workId: 'w2', timestamp: '2026-05-01T10:30:00Z' }),
    ];
    const r = DM.detectSuspectSessions(likes, artworks, {});
    eq(r.length, 0);
  });
  test('excluded_from_stats=true の現状を rows に含める', () => {
    const artworks = Array(20).fill().map((_, i) => artwork('w' + i, '山田', '1'));
    const likes = Array(15).fill().map((_, i) => like({
      sessionId: 'op', workId: 'w' + i,
      timestamp: isoMin('2026-05-01T10:00:00Z', i),
      excluded_from_stats: true,
    }));
    const r = DM.detectSuspectSessions(likes, artworks, {});
    eq(r.length, 1);
    eq(r[0].excluded, true);
  });
});

// ─────────────────────────────────────────────────────────────
// レポート
// ─────────────────────────────────────────────────────────────
console.log('\n────────────────────────────');
console.log('Tests:  ' + (passed + failed));
console.log('Passed: ' + passed);
console.log('Failed: ' + failed);
console.log('────────────────────────────');
if (failed > 0) {
  console.error('\n失敗テスト:');
  failures.forEach((f, i) => {
    console.error('  ' + (i + 1) + '. ' + f.name);
    console.error('     ' + (f.error.message || f.error));
  });
}
process.exit(failed > 0 ? 1 : 0);
