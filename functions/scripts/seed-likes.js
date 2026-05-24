// seed-likes.js
// analytics.html / dashboard.html の UI smoke test 用に、対象展覧会の
// likes コレクションへ「現実的なパターンの synthetic data」を投入する。
// すべての doc に seed:true フラグを付けるので、--cleanup で完全削除可能。
//
// Usage:
//   node functions/scripts/seed-likes.js --ex=<exCode> [--visitors=60]
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
  console.error('  node functions/scripts/seed-likes.js --ex=<exCode> --cleanup');
  console.error('');
  console.error('認証は ADC が必要 (`gcloud auth application-default login`)。');
  process.exit(1);
}

const EX_CODE = String(args.ex);
const CLEANUP = !!args.cleanup;
const VISITOR_COUNT = args.visitors ? parseInt(args.visitors, 10) : 60;

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
  const snap = await db.collection('likes')
    .where('exCode', '==', EX_CODE)
    .where('seed', '==', true)
    .get();
  console.log(`Found ${snap.size} seed docs.`);
  if (snap.empty) {
    console.log('Nothing to clean.');
    return;
  }
  const docs = snap.docs;
  let deleted = 0;
  for (let i = 0; i < docs.length; i += 500) {
    const batch = db.batch();
    docs.slice(i, i + 500).forEach(function (d) { batch.delete(d.ref); });
    await batch.commit();
    deleted += Math.min(500, docs.length - i);
    process.stdout.write(`  ${deleted}/${docs.length}\r`);
  }
  console.log(`\nDeleted ${deleted} seed docs.`);
}

async function seed() {
  // 1. Load artworks (status='1' のみ)
  console.log(`Loading artworks for ${EX_CODE}...`);
  const artSnap = await db.collection('artworks')
    .where('exCode', '==', EX_CODE)
    .get();
  if (artSnap.empty) {
    console.error(`No artworks found for ${EX_CODE}.`);
    process.exit(2);
  }
  const artworks = artSnap.docs.map(function (d) { return d.data(); }).filter(function (a) {
    const s = String(a.status || '').trim();
    return s === '1' && a.artwork_id;
  });
  if (artworks.length === 0) {
    console.error(`No registered (status=1) artworks for ${EX_CODE}.`);
    process.exit(2);
  }
  console.log(`Found ${artworks.length} registered artworks.`);

  // 2. Detect group / solo
  const artists = Array.from(new Set(
    artworks.map(function (a) { return String(a.artist || '').trim(); }).filter(Boolean)
  ));
  const isGroup = artists.length > 1;
  console.log(`Artists: ${artists.length} (${isGroup ? 'group' : 'solo'})`);

  // 3. Load exhibition for timing window
  const exSnap = await db.collection('exhibitions').doc(EX_CODE).get();
  if (!exSnap.exists) {
    console.error(`Exhibition ${EX_CODE} not found.`);
    process.exit(2);
  }
  const ex = exSnap.data();
  const startDate = ex.start_date && !isNaN(new Date(ex.start_date).getTime())
    ? new Date(ex.start_date)
    : new Date(Date.now() - 7 * 86400000);
  const endDate = ex.end_date && !isNaN(new Date(ex.end_date).getTime())
    ? new Date(ex.end_date)
    : new Date(startDate.getTime() + 7 * 86400000);
  console.log(`Timing window: ${startDate.toISOString().slice(0, 10)} 〜 ${endDate.toISOString().slice(0, 10)}`);
  console.log(`Exhibition: ${ex.ex_name || EX_CODE}${ex.is_sandbox ? ' (sandbox)' : ''}`);

  // 4. Safety: prevent double-seeding
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
  console.log(`Open:    https://rohei-printer-system.web.app/analytics.html?ex=${EX_CODE}`);
  console.log(`Cleanup: node functions/scripts/seed-likes.js --ex=${EX_CODE} --cleanup`);
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
