// seed-likes.js
// analytics.html / dashboard.html の UI smoke test 用に、synthetic data
// を Firestore へ投入する。すべての doc に seed:true フラグを付けるので
// --cleanup で完全削除可能 (本番データは触らない)。
//
// Usage:
//   # 既存展覧会 (artworks がすでにある) に likes だけ追加
//   node functions/scripts/seed-likes.js --ex=<exCode> [--visitors=60]
//
//   # 展覧会・作家・作品・likes をゼロから一式 bootstrap
//   node functions/scripts/seed-likes.js --ex=<exCode> --bootstrap \
//       [--artists=5] [--artworks=25] [--visitors=60]
//
//   # 全消去 (likes / artworks / exhibition、seed:true のものだけ)
//   node functions/scripts/seed-likes.js --ex=<exCode> --cleanup
//
// 認証:
//   Application Default Credentials が必要。
//     gcloud auth application-default login
//   または GOOGLE_APPLICATION_CREDENTIALS=<service-account.json>
//
// 生成パターン (60 visitor の場合):
//   15% single-like quick visitor (1 件、滞在 0)
//   40% mid (3-6 件、5-25 分)
//   20% deep (8-20 件、30-90 分)
//   15% comment-heavy (2-5 件、コメント率 90%)
//   10% repeat visitor (別日にもう一度来る)
//
// Y 検出用 special cases:
//   - Y-1+Y-2: operator-test (70% カバー × 8s 連打) ※ 出展 ≥10 のとき
//   - Y-3: fan (1 作家のみ 5 件) ※ group exhibition のとき
//   - Y-4: pre-opening (会期開始前 2 session × 1-3 件)

'use strict';
const admin = require('firebase-admin');

// ─── Args ─────────────────────────────────────────────────
const args = {};
process.argv.slice(2).forEach(function (arg) {
  if (arg.startsWith('--')) {
    const eq = arg.indexOf('=');
    if (eq === -1) {
      args[arg.slice(2)] = true;
    } else {
      args[arg.slice(2, eq)] = arg.slice(eq + 1);
    }
  }
});

if (!args.ex) {
  console.error('Usage:');
  console.error('  node functions/scripts/seed-likes.js --ex=<exCode> [--visitors=60]');
  console.error('  node functions/scripts/seed-likes.js --ex=<exCode> --bootstrap [--artists=5] [--artworks=25]');
  console.error('  node functions/scripts/seed-likes.js --ex=<exCode> --cleanup');
  console.error('');
  console.error('認証は ADC が必要 (`gcloud auth application-default login`)。');
  process.exit(1);
}

if (!/^[A-Za-z0-9_-]+$/.test(args.ex)) {
  console.error('exCode は英数 / - / _ のみ使えます: ' + args.ex);
  process.exit(1);
}

const EX_CODE = String(args.ex);
const CLEANUP = !!args.cleanup;
const BOOTSTRAP = !!args.bootstrap;
const VISITOR_COUNT = args.visitors ? parseInt(args.visitors, 10) : 60;
const ARTIST_COUNT = args.artists ? parseInt(args.artists, 10) : 5;
const ARTWORK_COUNT = args.artworks ? parseInt(args.artworks, 10) : 25;

// ─── Firebase Admin init ──────────────────────────────────
admin.initializeApp({ projectId: 'rohei-printer-system' });
const db = admin.firestore();

// ─── Main ─────────────────────────────────────────────────
async function main() {
  if (CLEANUP) {
    await cleanup();
  } else {
    await seed();
  }
}

async function cleanup() {
  console.log(`Cleaning up seed data for ${EX_CODE}...`);

  // 1. likes (seed:true)
  const likeSnap = await db.collection('likes')
    .where('exCode', '==', EX_CODE)
    .where('seed', '==', true)
    .get();
  await _batchDelete('likes', likeSnap.docs);

  // 2. artworks (seed:true)
  const artSnap = await db.collection('artworks')
    .where('exCode', '==', EX_CODE)
    .where('seed', '==', true)
    .get();
  await _batchDelete('artworks', artSnap.docs);

  // 3. exhibitions doc (seed:true のときだけ)
  const exDoc = await db.collection('exhibitions').doc(EX_CODE).get();
  if (exDoc.exists && exDoc.data().seed === true) {
    await db.collection('exhibitions').doc(EX_CODE).delete();
    console.log(`  exhibitions doc ${EX_CODE} deleted.`);
  } else if (exDoc.exists) {
    console.log(`  exhibitions doc ${EX_CODE} は seed=true ではないので保持`);
  }
  console.log('Cleanup done.');
}

async function _batchDelete(label, docs) {
  if (!docs || docs.length === 0) {
    console.log(`  ${label}: 0 件 (なし)`);
    return;
  }
  let deleted = 0;
  for (let i = 0; i < docs.length; i += 500) {
    const batch = db.batch();
    docs.slice(i, i + 500).forEach(function (d) { batch.delete(d.ref); });
    await batch.commit();
    deleted += Math.min(500, docs.length - i);
    process.stdout.write(`  ${label}: ${deleted}/${docs.length}\r`);
  }
  console.log(`  ${label}: ${deleted} 件削除`);
}

async function seed() {
  // 0. Bootstrap mode: 展覧会 + 作家 + 作品を一気に作る
  let artworks;
  let ex;
  if (BOOTSTRAP) {
    const result = await bootstrap();
    artworks = result.artworks;
    ex = result.exhibition;
  } else {
    // 既存の展覧会を読み込む
    console.log(`Loading artworks for ${EX_CODE}...`);
    const artSnap = await db.collection('artworks')
      .where('exCode', '==', EX_CODE)
      .get();
    if (artSnap.empty) {
      console.error(`No artworks found for ${EX_CODE}.`);
      console.error(`(--bootstrap で一式 generate できます)`);
      process.exit(2);
    }
    artworks = artSnap.docs.map(function (d) { return d.data(); }).filter(function (a) {
      const s = String(a.status || '').trim();
      return s === '1' && a.artwork_id;
    });
    if (artworks.length === 0) {
      console.error(`No registered (status=1) artworks for ${EX_CODE}.`);
      process.exit(2);
    }
    console.log(`Found ${artworks.length} registered artworks.`);

    const exSnap = await db.collection('exhibitions').doc(EX_CODE).get();
    if (!exSnap.exists) {
      console.error(`Exhibition ${EX_CODE} not found.`);
      process.exit(2);
    }
    ex = exSnap.data();
  }

  // 2. Detect group / solo
  const artists = Array.from(new Set(
    artworks.map(function (a) { return String(a.artist || '').trim(); }).filter(Boolean)
  ));
  const isGroup = artists.length > 1;
  console.log(`Artists: ${artists.length} (${isGroup ? 'group' : 'solo'})`);

  // 3. Timing window
  const startDate = ex.start_date && !isNaN(new Date(ex.start_date).getTime())
    ? new Date(ex.start_date)
    : new Date(Date.now() - 7 * 86400000);
  const endDate = ex.end_date && !isNaN(new Date(ex.end_date).getTime())
    ? new Date(ex.end_date)
    : new Date(startDate.getTime() + 7 * 86400000);
  console.log(`Timing window: ${startDate.toISOString().slice(0, 10)} 〜 ${endDate.toISOString().slice(0, 10)}`);
  console.log(`Exhibition: ${ex.ex_name || EX_CODE}${ex.is_sandbox ? ' (sandbox)' : ''}`);

  // 4. Safety: prevent double-seeding (bootstrap 直後はスキップ)
  if (!BOOTSTRAP) {
    const existingSeed = await db.collection('likes')
      .where('exCode', '==', EX_CODE)
      .where('seed', '==', true)
      .limit(1)
      .get();
    if (!existingSeed.empty) {
      console.error('');
      console.error('Seed docs already exist for this exhibition.');
      console.error(`Run cleanup first:  node functions/scripts/seed-likes.js --ex=${EX_CODE} --cleanup`);
      process.exit(3);
    }
  }

  // 5. Generate
  console.log(`\nGenerating ${VISITOR_COUNT} regular visitors + special cases...`);
  const docs = [];
  for (let i = 0; i < VISITOR_COUNT; i++) {
    docs.push.apply(docs, generateRegularVisitor(i, artworks, startDate, endDate));
  }
  if (artworks.length >= 10) {
    docs.push.apply(docs, generateOperatorTest(artworks, startDate));
    console.log('  + operator-test pattern (Y-1 + Y-2 + Y-4)');
  }
  if (isGroup) {
    docs.push.apply(docs, generateFanPattern(artworks, artists, startDate));
    console.log('  + fan pattern (Y-3, single-artist focus)');
  }
  docs.push.apply(docs, generatePreOpening(artworks, startDate));
  console.log('  + pre-opening sessions (Y-4)');

  // 6. Write batches
  console.log(`\nWriting ${docs.length} docs in batches...`);
  let written = 0;
  for (let i = 0; i < docs.length; i += 500) {
    const batch = db.batch();
    docs.slice(i, i + 500).forEach(function (doc) {
      batch.set(db.collection('likes').doc(), doc);
    });
    await batch.commit();
    written += Math.min(500, docs.length - i);
    process.stdout.write(`  ${written}/${docs.length}\r`);
  }
  console.log('');
  console.log(`Done. ${written} seed docs written for ${EX_CODE}.`);
  console.log('');
  console.log(`Open:    https://qriine.com/analytics.html?ex=${EX_CODE}`);
  console.log(`Cleanup: node functions/scripts/seed-likes.js --ex=${EX_CODE} --cleanup`);
}

// ─── Bootstrap (展覧会 + 作家 + 作品 を一式作る) ────────────

const FAKE_ARTISTS = [
  '山田 太郎', '鈴木 花子', '佐藤 健一', '田中 美穂', '高橋 翔',
  '伊藤 さくら', '渡辺 拓海', '中村 結衣', '小林 大輔', '加藤 詩織',
];

const TECHNIQUES = [
  '油彩・キャンバス', 'アクリル・パネル', '水彩・紙', 'インクジェット印刷',
  '銅版画', 'シルクスクリーン', '陶器', '木彫', '混合技法', '写真',
];

const TITLE_THEMES = [
  '記憶', '光', '彼方', '余白', '残響', '輪郭', '気配', '森', '海',
  '時間の層', '夜想', '対話', '静寂', '断片', '揺らぎ',
];

function _pickArtists(n) {
  // FAKE_ARTISTS から n 件を抜き出し (n が多ければ番号を付ける)
  if (n <= FAKE_ARTISTS.length) {
    return FAKE_ARTISTS.slice(0, n);
  }
  const out = FAKE_ARTISTS.slice();
  for (let i = FAKE_ARTISTS.length; i < n; i++) {
    out.push('作家 ' + (i + 1));
  }
  return out;
}

function _distributeArtworks(artworkCount, artists) {
  // 各作家にやや不均等に振り分け (V-9 ロングテール度のテスト用)
  const result = [];
  let remaining = artworkCount;
  for (let i = 0; i < artists.length; i++) {
    if (i === artists.length - 1) {
      result.push(remaining);
    } else {
      // 残りを (作家数 - i) で割って、±1 のばらつき
      const avg = Math.floor(remaining / (artists.length - i));
      const n = Math.max(1, avg + (Math.random() < 0.5 ? 0 : 1));
      result.push(n);
      remaining -= n;
    }
  }
  return result; // [count for each artist]
}

async function bootstrap() {
  console.log(`Bootstrap: 展覧会 + ${ARTIST_COUNT} 作家 + ${ARTWORK_COUNT} 作品 を生成中...`);
  // 既存の exhibition が seed:true でなければ拒否 (本番上書き防止)
  const existing = await db.collection('exhibitions').doc(EX_CODE).get();
  if (existing.exists && existing.data().seed !== true) {
    console.error('');
    console.error(`Exhibition ${EX_CODE} は既に存在し、seed:true ではありません。`);
    console.error('別の exCode を使うか、本番展覧会を上書きしない範囲で慎重に。');
    process.exit(4);
  }
  if (existing.exists && existing.data().seed === true) {
    console.error('');
    console.error(`Exhibition ${EX_CODE} は既に seed 済 (前回の bootstrap が残ってる)。`);
    console.error(`Run cleanup first:  node functions/scripts/seed-likes.js --ex=${EX_CODE} --cleanup`);
    process.exit(3);
  }

  // 期間: 過去 5 日 〜 今日 + 2 日 (= 7 日間)
  const now = Date.now();
  const startDate = new Date(now - 5 * 86400000);
  const endDate = new Date(now + 2 * 86400000);

  // 1. exhibitions doc
  await db.collection('exhibitions').doc(EX_CODE).set({
    ex_code: EX_CODE,
    ex_name: 'シードテスト用 (' + EX_CODE + ')',
    email: 'rymist1@gmail.com',
    start_date: startDate.toISOString().slice(0, 10),
    end_date: endDate.toISOString().slice(0, 10),
    is_sandbox: true,
    seed: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  console.log('  exhibitions doc 作成');

  // 2. 作家・作品分配
  const artists = _pickArtists(ARTIST_COUNT);
  const distribution = _distributeArtworks(ARTWORK_COUNT, artists);

  // 3. artworks 生成
  const artworks = [];
  let idx = 0;
  for (let ai = 0; ai < artists.length; ai++) {
    const artistName = artists[ai];
    const n = distribution[ai];
    for (let k = 0; k < n; k++) {
      idx++;
      const aid = 'A' + String(idx).padStart(3, '0');
      artworks.push({
        artwork_id: aid,
        artworkId: aid,
        exCode: EX_CODE,
        title: randomChoice(TITLE_THEMES) + ' #' + (k + 1),
        artist: artistName,
        year: '2026',
        technique: randomChoice(TECHNIQUES),
        size: (Math.round(20 + Math.random() * 60) * 10) + ' × ' +
              (Math.round(15 + Math.random() * 50) * 10) + ' mm',
        price: '',
        note: '',
        status: '1',
        security_key: 'seed-' + Math.random().toString(36).slice(2, 10),
        seed: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }
  }

  // 4. batch write artworks (doc ID = exCode + '_' + artwork_id)
  let written = 0;
  for (let i = 0; i < artworks.length; i += 500) {
    const batch = db.batch();
    artworks.slice(i, i + 500).forEach(function (a) {
      const docId = EX_CODE + '_' + a.artwork_id;
      batch.set(db.collection('artworks').doc(docId), a);
    });
    await batch.commit();
    written += Math.min(500, artworks.length - i);
    process.stdout.write(`  artworks: ${written}/${artworks.length}\r`);
  }
  console.log(`  artworks: ${written} 件作成 (${artists.length} 作家)`);

  return {
    artworks: artworks,
    exhibition: {
      ex_code: EX_CODE,
      ex_name: 'シードテスト用 (' + EX_CODE + ')',
      start_date: startDate.toISOString().slice(0, 10),
      end_date: endDate.toISOString().slice(0, 10),
      is_sandbox: true,
    },
  };
}

// ─── Visitor pattern generators ───────────────────────────

const COMMENTS = [
  '色使いが綺麗',
  'タイトルが印象的',
  'この技法、面白いですね',
  '何度も見たくなる',
  '構図が好み',
  '光の表現がいい',
  '記憶に残る作品',
  'シリーズで欲しくなる',
  'よく作られてる',
  'もう一度じっくり見たい',
  '見るたびに違う発見がある',
  '展示の中でも一際目を引きました。',
  'タイトルと作品の関係が深い。考えさせられる。',
  '質感の表現に唸らされた',
  'モチーフ選びが好み',
  '🎨', '👍', '❤️', '✨',
];

const NICKNAMES = ['通りすがり', '初訪問', '匿名', 'ファン', 'ART好き', '美術部', ''];

function randomSessionId() {
  return 'seed-s' + Math.random().toString(36).slice(2, 14);
}
function randomChoice(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randomInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function randomDate(start, end) {
  return new Date(start.getTime() + Math.random() * (end.getTime() - start.getTime()));
}
function adjustToGalleryHours(date) {
  const d = new Date(date);
  d.setHours(10 + Math.floor(Math.random() * 8));
  d.setMinutes(Math.floor(Math.random() * 60));
  d.setSeconds(Math.floor(Math.random() * 60));
  return d;
}
function randomDistinct(arr, n) {
  if (n >= arr.length) return arr.slice();
  const indices = {};
  const out = [];
  while (out.length < n) {
    const i = Math.floor(Math.random() * arr.length);
    if (indices[i]) continue;
    indices[i] = true;
    out.push(arr[i]);
  }
  return out;
}

function makeLike(workId, sid, time, opts) {
  opts = opts || {};
  return {
    exCode: EX_CODE,
    workId: workId,
    sessionId: sid,
    isLike: true,
    nickname: opts.nickname || '',
    comment: opts.comment || '',
    source: opts.source || 'gallery',
    timestamp: time.toISOString(),
    seed: true,
  };
}

function generateRegularVisitor(i, artworks, startDate, endDate) {
  const sid = randomSessionId();
  const docs = [];
  const visitStart = adjustToGalleryHours(randomDate(startDate, endDate));
  const r = Math.random();
  let likeCount, durationMin, commentProb, isRepeat = false;
  if (r < 0.15) {
    likeCount = 1; durationMin = 0; commentProb = 0.1;
  } else if (r < 0.55) {
    likeCount = randomInt(3, 6);
    durationMin = randomInt(5, 25);
    commentProb = 0.3;
  } else if (r < 0.75) {
    likeCount = randomInt(8, Math.min(20, artworks.length));
    durationMin = randomInt(30, 90);
    commentProb = 0.5;
  } else if (r < 0.90) {
    likeCount = randomInt(2, 5);
    durationMin = randomInt(10, 30);
    commentProb = 0.9;
  } else {
    likeCount = randomInt(2, 5);
    durationMin = randomInt(10, 25);
    commentProb = 0.4;
    isRepeat = true;
  }
  const picked = randomDistinct(artworks, likeCount);
  picked.forEach(function (art, idx) {
    const offsetMin = likeCount === 1
      ? 0
      : (idx / Math.max(1, likeCount - 1)) * durationMin;
    const jitterMin = (Math.random() - 0.5) * (durationMin / Math.max(1, likeCount));
    const t = new Date(visitStart.getTime() + (offsetMin + jitterMin) * 60000);
    docs.push(makeLike(art.artwork_id, sid, t, {
      nickname: randomChoice(NICKNAMES),
      comment: Math.random() < commentProb ? randomChoice(COMMENTS) : '',
      source: Math.random() < 0.4 ? 'gallery' : undefined,
    }));
  });
  if (isRepeat) {
    const daysLater = randomInt(1, 5);
    const secondStart = adjustToGalleryHours(
      new Date(visitStart.getTime() + daysLater * 86400000));
    if (secondStart <= endDate) {
      const repickCount = randomInt(1, 3);
      const repicked = randomDistinct(artworks, repickCount);
      repicked.forEach(function (art, idx) {
        const t = new Date(secondStart.getTime() + idx * randomInt(2, 8) * 60000);
        docs.push(makeLike(art.artwork_id, sid, t, {
          nickname: '',
          comment: Math.random() < 0.3 ? randomChoice(COMMENTS) : '',
          source: Math.random() < 0.4 ? 'gallery' : undefined,
        }));
      });
    }
  }
  return docs;
}

function generateOperatorTest(artworks, startDate) {
  // 70% カバー、8 秒間隔で連打 → Y-1 + Y-2
  // 会期開始の 6 時間前 → Y-4 も併発
  const sid = 'seed-operator-test';
  const docs = [];
  const t0 = new Date(startDate.getTime() - 6 * 3600000);
  const coverageCount = Math.ceil(artworks.length * 0.7);
  for (let i = 0; i < coverageCount; i++) {
    const t = new Date(t0.getTime() + i * 8 * 1000);
    docs.push(makeLike(artworks[i].artwork_id, sid, t, {
      nickname: '',
      source: 'gallery',
    }));
  }
  return docs;
}

function generateFanPattern(artworks, artists, startDate) {
  const targetArtist = artists[0];
  const theirWorks = artworks.filter(function (a) {
    return String(a.artist || '').trim() === targetArtist;
  });
  if (theirWorks.length < 3) return [];
  const sid = 'seed-fan-test';
  const docs = [];
  const t0 = adjustToGalleryHours(new Date(startDate.getTime() + 2 * 86400000));
  theirWorks.slice(0, Math.min(5, theirWorks.length)).forEach(function (art, i) {
    const t = new Date(t0.getTime() + i * randomInt(2, 4) * 60000);
    docs.push(makeLike(art.artwork_id, sid, t, {
      nickname: '◯◯ファン',
      comment: i === 0 ? targetArtist + ' さんの作品大好きです！' : '',
      source: 'gallery',
    }));
  });
  return docs;
}

function generatePreOpening(artworks, startDate) {
  const docs = [];
  for (let s = 0; s < 2; s++) {
    const sid = 'seed-pre-opening-' + s;
    const t0 = new Date(startDate.getTime() - (1 + s) * 86400000);
    const count = randomInt(1, 3);
    for (let i = 0; i < count; i++) {
      const t = new Date(t0.getTime() + i * 60000);
      docs.push(makeLike(artworks[i % artworks.length].artwork_id, sid, t, {
        nickname: '',
        source: undefined,
      }));
    }
  }
  return docs;
}

// ─── Run ──────────────────────────────────────────────────
main().then(function () {
  process.exit(0);
}).catch(function (err) {
  console.error('Error:', err && err.message ? err.message : err);
  if (err && err.stack) console.error(err.stack);
  process.exit(1);
});
