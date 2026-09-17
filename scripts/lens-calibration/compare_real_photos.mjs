// 実際のギャラリー撮影写真で「レンズ補正あり/なし」の直線支持スコア(computeLineSupport)を比較する。
// crop.html (補正あり) と crop_nocorrection_debug.html (補正なし、cameraModel不一致で無効化)
// の両方に同じ写真を投入し、autoDetect後の検出枠のline support meanを比較する。
// 恒久ハーネスではない検証用スクリプト。
import { chromium } from '../crop-eval/node_modules/playwright/index.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOLS_DIR = path.resolve(__dirname, '../../public/tools');
const PHOTO_DIR = process.argv[2];
const N = parseInt(process.argv[3] || '15', 10);

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.onnx': 'application/octet-stream', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'crop.html';
  const fp = path.join(TOOLS_DIR, rel);
  if (!fp.startsWith(TOOLS_DIR) || !fs.existsSync(fp)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
  fs.createReadStream(fp).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const allFiles = fs.readdirSync(PHOTO_DIR).filter(f => /\.jpe?g$/i.test(f)).sort();
const step = Math.max(1, Math.floor(allFiles.length / N));
const sample = [];
for (let i = 0; i < allFiles.length && sample.length < N; i += step) sample.push(allFiles[i]);

async function runOn(pageUrl, files) {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on('dialog', d => d.dismiss().catch(() => {}));
  await page.goto(pageUrl);
  await page.waitForFunction(() => document.getElementById('cvLoading')?.textContent.includes('準備完了'), null, { timeout: 60000 });
  const results = [];
  for (const name of files) {
    await page.evaluate(() => { window.detectBusy = 'pending'; });
    await page.setInputFiles('#file', path.join(PHOTO_DIR, name));
    try {
      await page.waitForFunction(() => window.detectBusy === false, null, { timeout: 60000 });
      const ls = await page.evaluate(() => {
        if (!corners) return null;
        const L = computeLineSupport(corners);
        return L ? L.mean : null;
      });
      results.push({ name, ls });
    } catch (e) {
      results.push({ name, ls: null, error: String(e).slice(0, 80) });
    }
  }
  await browser.close();
  return results;
}

console.log(`sample: ${sample.length} files`);
const withCorr = await runOn(`http://127.0.0.1:${port}/crop.html`, sample);
const noCorr = await runOn(`http://127.0.0.1:${port}/crop_nocorrection_debug.html`, sample);

console.log('name'.padEnd(16), 'no-correction'.padEnd(14), 'with-correction');
let sumA = 0, sumB = 0, nA = 0, nB = 0, better = 0, worse = 0, same = 0;
for (let i = 0; i < sample.length; i++) {
  const a = noCorr[i].ls, b = withCorr[i].ls;
  console.log(sample[i].padEnd(16), String(a).padEnd(14), String(b));
  if (a != null) { sumA += a; nA++; }
  if (b != null) { sumB += b; nB++; }
  if (a != null && b != null) {
    if (b > a) better++; else if (b < a) worse++; else same++;
  }
}
console.log('---');
console.log('平均 line support: 補正なし=', (sumA / nA).toFixed(2), ' 補正あり=', (sumB / nB).toFixed(2));
console.log(`改善=${better} 悪化=${worse} 同点=${same}`);

server.close();
