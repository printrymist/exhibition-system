// crop.html 自動検出の一括評価ハーネス
//
// crop.html を一切変更せず、本番と同一コードの検出結果を測る:
//   画像を file input に投入 → window.detectBusy === false を待つ →
//   「📌 これを正解として記録」を押させる → localStorage.crop_gt から検出四隅を回収。
// 検出経路 (2回目AI / 境目探索 / AI外周 / 従来 / 失敗) は #status の文言から分類する。
//
// 使い方:
//   node run.mjs --gt <crop-gt.json> --images <dir> [--images <dir2> ...] [--tol 0.01] [--out report.json]
//
// 主指標 = 一発OK率: 4隅すべての誤差が「画像長辺 × tol (既定 1%)」以内なら合格。
// 補助指標 = IoU (凸四角形同士の交差面積 / 和面積)。

import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOLS_DIR = path.resolve(__dirname, '../../public/tools');

// ---- 引数 ----
const args = process.argv.slice(2);
function argAll(name) {
  const out = [];
  for (let i = 0; i < args.length; i++) if (args[i] === name && args[i + 1]) out.push(args[++i]);
  return out;
}
const gtPath = argAll('--gt')[0];
const imageDirs = argAll('--images');
const tol = parseFloat(argAll('--tol')[0] || '0.01');
const outPath = argAll('--out')[0] || null;
if (!gtPath || imageDirs.length === 0) {
  console.error('使い方: node run.mjs --gt <crop-gt.json> --images <dir> [--images <dir2>] [--tol 0.01] [--out report.json]');
  process.exit(1);
}

const gt = JSON.parse(fs.readFileSync(gtPath, 'utf-8'));

// GT の各エントリに対応する画像ファイルを探す
const entries = [];
const missing = [];
for (const [name, rec] of Object.entries(gt)) {
  let found = null;
  for (const dir of imageDirs) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) { found = p; break; }
  }
  if (found) entries.push({ name, path: found, gt: rec });
  else missing.push(name);
}

// ---- 幾何: 凸四角形の IoU (Sutherland–Hodgman + shoelace) ----
function area(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(s) / 2;
}
function clip(subject, clipPoly) {
  // clipPoly は凸・一貫した回り方であること (orderCorners 済みの TL,TR,BR,BL は時計回り)
  let out = subject;
  const n = clipPoly.length;
  // 回り方を正規化 (符号付き面積で判定)
  let s = 0;
  for (let i = 0; i < n; i++) { const a = clipPoly[i], b = clipPoly[(i + 1) % n]; s += a[0] * b[1] - b[0] * a[1]; }
  const sign = s > 0 ? 1 : -1;
  for (let i = 0; i < n; i++) {
    const A = clipPoly[i], B = clipPoly[(i + 1) % n];
    const input = out; out = [];
    const side = (p) => sign * ((B[0] - A[0]) * (p[1] - A[1]) - (B[1] - A[1]) * (p[0] - A[0]));
    for (let j = 0; j < input.length; j++) {
      const P = input[j], Q = input[(j + 1) % input.length];
      const sp = side(P), sq = side(Q);
      const inter = () => {
        const t = sp / (sp - sq);
        return [P[0] + t * (Q[0] - P[0]), P[1] + t * (Q[1] - P[1])];
      };
      if (sp >= 0) { out.push(P); if (sq < 0) out.push(inter()); }
      else if (sq >= 0) out.push(inter());
    }
    if (out.length === 0) return [];
  }
  return out;
}
function iou(q1, q2) {
  const inter = area(clip(q1, q2));
  const u = area(q1) + area(q2) - inter;
  return u > 0 ? inter / u : 0;
}

// ---- 検出経路の分類 (#status の文言から) ----
function classifyStage(status) {
  if (status.includes('内側の絵まで検出')) return '2回目AI';
  if (status.includes('絵の縁まで検出')) return '境目探索';
  if (status.includes('自動検出しました（AI）')) return 'AI外周';
  if (status.includes('検出（')) return '従来検出';
  if (status.includes('検出できませんでした')) return '検出失敗';
  return '不明: ' + status.slice(0, 40);
}

// ---- 失敗の向きの分類 ----
function classifyFailure(det, gtq) {
  const aDet = area(det), aGt = area(gtq);
  const inter = area(clip(det, gtq));
  const coverGt = inter / aGt;    // 正解のうち検出枠に入っている割合
  const coverDet = inter / aDet;  // 検出枠のうち正解に重なる割合
  if (coverGt > 0.95 && aDet > aGt * 1.25) return '外側ごと掴んだ';   // 正解を包むが大きすぎ (台紙/マット/額)
  if (coverDet > 0.95 && aDet < aGt * 0.8) return '内側に食い込んだ';  // 正解の内側に潜った
  if (coverGt < 0.5 && coverDet < 0.5) return '別物を掴んだ';
  return '縁ズレ';
}

// ---- 静的サーバ (public/tools を配信。wasm/onnx の MIME を正しく) ----
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.json': 'application/json',
};
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'crop.html';
  const fp = path.join(TOOLS_DIR, rel);
  if (!fp.startsWith(TOOLS_DIR) || !fs.existsSync(fp)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
  fs.createReadStream(fp).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

// ---- 評価本体 ----
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('dialog', d => d.dismiss().catch(() => {}));
await page.goto(`http://127.0.0.1:${port}/crop.html`);
await page.waitForFunction(
  () => document.getElementById('cvLoading')?.textContent.includes('準備完了'),
  null, { timeout: 60000 }
);

const results = [];
let done = 0;
for (const e of entries) {
  process.stderr.write(`[${++done}/${entries.length}] ${e.name}\n`);
  const r = { name: e.name };
  try {
    await page.evaluate(() => { localStorage.removeItem('crop_gt'); window.detectBusy = 'pending'; });
    await page.setInputFiles('#file', e.path);
    // 初回はモデル読込 (最大12秒待ち) を含むので長めに待つ
    await page.waitForFunction(() => window.detectBusy === false, null, { timeout: 120000 });
    r.status = await page.$eval('#status', el => el.textContent);
    r.stage = classifyStage(r.status);
    if (r.stage === '検出失敗') {
      r.pass = false; r.iou = 0; r.errPct = null; r.failure = '検出失敗';
    } else {
      await page.click('#recordGt');
      const store = await page.evaluate(() => JSON.parse(localStorage.getItem('crop_gt') || '{}'));
      const rec = store[e.name];
      if (!rec) throw new Error('検出四隅を回収できませんでした (localStorage に記録なし)');
      if (rec.w !== e.gt.w || rec.h !== e.gt.h) {
        throw new Error(`画像サイズが GT と不一致 (GT ${e.gt.w}x${e.gt.h} / 今回 ${rec.w}x${rec.h})`);
      }
      const det = rec.corners, gtq = e.gt.corners;
      const long = Math.max(e.gt.w, e.gt.h);
      const errs = det.map((p, i) => Math.hypot(p[0] - gtq[i][0], p[1] - gtq[i][1]));
      r.maxErrPx = Math.max(...errs);
      r.errPct = r.maxErrPx / long * 100;
      r.iou = iou(det, gtq);
      r.pass = r.maxErrPx <= long * tol;
      r.failure = r.pass ? null : classifyFailure(det, gtq);
      r.det = det;
    }
  } catch (err) {
    r.pass = false; r.iou = 0; r.errPct = null;
    r.stage = r.stage || 'エラー';
    r.failure = 'ハーネスエラー: ' + err.message;
  }
  results.push(r);
}
await browser.close();
server.close();

// ---- レポート ----
const passN = results.filter(r => r.pass).length;
const ious = results.map(r => r.iou);
const mean = ious.reduce((s, v) => s + v, 0) / (ious.length || 1);
const median = ious.slice().sort((a, b) => a - b)[ious.length >> 1] ?? 0;

console.log('');
console.log(`=== crop.html 一発切り出し評価 (tol = 長辺の${tol * 100}%) ===`);
console.log(`GT ${Object.keys(gt).length} 件 / 画像あり ${entries.length} 件 / 画像なし ${missing.length} 件`);
console.log('');
const W = (s, n) => String(s).padEnd(n);
console.log(W('結果', 4) + W('誤差%', 7) + W('IoU', 7) + W('経路', 10) + '失敗分類  ファイル');
for (const r of results.slice().sort((a, b) => (a.errPct ?? 999) - (b.errPct ?? 999))) {
  console.log(
    W(r.pass ? '✅' : '❌', 4) +
    W(r.errPct == null ? '—' : r.errPct.toFixed(2), 7) +
    W(r.iou.toFixed(3), 7) +
    W(r.stage, 10) +
    W(r.failure || '', 10) + r.name
  );
}
console.log('');
console.log(`一発OK率: ${passN}/${results.length} (${(passN / results.length * 100).toFixed(0)}%)`);
console.log(`IoU 平均 ${mean.toFixed(3)} / 中央値 ${median.toFixed(3)}`);
console.log('');
console.log('経路別:');
const byStage = {};
for (const r of results) {
  byStage[r.stage] = byStage[r.stage] || { n: 0, pass: 0 };
  byStage[r.stage].n++; if (r.pass) byStage[r.stage].pass++;
}
for (const [k, v] of Object.entries(byStage)) console.log(`  ${k}: ${v.pass}/${v.n} 合格`);
console.log('');
console.log('失敗分類:');
const byFail = {};
for (const r of results) if (!r.pass) { byFail[r.failure] = (byFail[r.failure] || 0) + 1; }
for (const [k, v] of Object.entries(byFail)) console.log(`  ${k}: ${v} 件`);
if (missing.length) {
  console.log('');
  console.log('画像が見つからなかった GT: ' + missing.join(', '));
}

if (outPath) {
  fs.writeFileSync(outPath, JSON.stringify({ tol, results, summary: { pass: passN, total: results.length, meanIoU: mean, medianIoU: median } }, null, 2));
  console.log('\n詳細を書き出しました: ' + outPath);
}
