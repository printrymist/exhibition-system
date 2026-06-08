// backfill-artwork-published.js
// β-3 移行用のバックフィル。既存 artworks doc に server-managed フィールドを書き込む:
//   - _published: bool (exhibitions.gallery_visibility が public/visitor_only なら true)
//   - organizerEmail: string (exhibitions.email を denormalize)
//
// これらは firestore.rules の新条件で operator/organizer/visitor の read 判定に
// 使われる。submitArtwork は create 時にこれらをセットするが、既存の artwork doc
// (= 移行前に作られた seed や TEST exhibitions) には欠落しているので一度埋める。
//
// Usage:
//   # 単一展覧会だけ
//   node functions/scripts/backfill-artwork-published.js --ex=<exCode>
//
//   # 全展覧会一括 (オペレータが自分の全 ex を一度に処理)
//   node functions/scripts/backfill-artwork-published.js --all
//
//   # dry run (Firestore に書き込まず差分だけ表示)
//   node functions/scripts/backfill-artwork-published.js --all --dry-run
//
// 認証:
//   Application Default Credentials が必要。
//     gcloud auth application-default login
//   または GOOGLE_APPLICATION_CREDENTIALS=<service-account.json>

'use strict';
const admin = require('firebase-admin');

const args = {};
process.argv.slice(2).forEach(function (arg) {
  if (arg.startsWith('--')) {
    const eq = arg.indexOf('=');
    if (eq === -1) args[arg.slice(2)] = true;
    else args[arg.slice(2, eq)] = arg.slice(eq + 1);
  }
});

if (!args.ex && !args.all) {
  console.error('Usage: backfill-artwork-published.js --ex=<exCode> | --all [--dry-run]');
  process.exit(1);
}

const dryRun = !!args['dry-run'];

admin.initializeApp({ projectId: 'rohei-printer-system' });
const db = admin.firestore();

async function backfillOneExhibition(exCode) {
  const exSnap = await db.collection('exhibitions').doc(exCode).get();
  if (!exSnap.exists) {
    console.error('  exhibition not found:', exCode);
    return { exCode, scanned: 0, updated: 0, skipped: 0 };
  }
  const exData = exSnap.data() || {};
  const visibility = String(exData.gallery_visibility || 'closed').trim();
  const organizerEmail = String(exData.email || '').trim().toLowerCase();
  const published = (visibility === 'public' || visibility === 'visitor_only');

  console.log('  ex:', exCode, 'visibility:', visibility, '→ published:', published, '/ organizer:', organizerEmail || '(none)');

  const snap = await db.collection('artworks').where('exCode', '==', exCode).get();
  let updated = 0;
  let skipped = 0;
  let batch = db.batch();
  let pending = 0;
  for (const doc of snap.docs) {
    const data = doc.data() || {};
    const needsPublished = (data._published === undefined);
    const needsOrganizer = (!data.organizerEmail || data.organizerEmail === '');
    if (!needsPublished && !needsOrganizer) {
      skipped++;
      continue;
    }
    const patch = {};
    if (needsPublished) patch._published = published;
    if (needsOrganizer) patch.organizerEmail = organizerEmail;
    if (!dryRun) {
      batch.update(doc.ref, patch);
      pending++;
      if (pending >= 400) {
        await batch.commit();
        batch = db.batch();
        pending = 0;
      }
    }
    updated++;
  }
  if (!dryRun && pending > 0) await batch.commit();

  console.log('  scanned:', snap.size, '/ updated:', updated, '/ skipped:', skipped, dryRun ? '(dry-run)' : '');
  return { exCode, scanned: snap.size, updated, skipped };
}

(async () => {
  let exCodes = [];
  if (args.all) {
    const allSnap = await db.collection('exhibitions').get();
    exCodes = allSnap.docs.map((d) => d.id);
    console.log('found', exCodes.length, 'exhibitions');
  } else {
    exCodes = [String(args.ex).trim()];
  }

  const results = [];
  for (const ex of exCodes) {
    console.log('processing', ex);
    results.push(await backfillOneExhibition(ex));
  }

  const totalScanned = results.reduce((s, r) => s + r.scanned, 0);
  const totalUpdated = results.reduce((s, r) => s + r.updated, 0);
  console.log('\n=== summary ===');
  console.log('exhibitions:', results.length);
  console.log('artworks scanned:', totalScanned);
  console.log('artworks updated:', totalUpdated, dryRun ? '(dry-run)' : '');
  process.exit(0);
})().catch((err) => {
  console.error('failed:', err);
  process.exit(1);
});
