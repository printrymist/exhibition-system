// crop.html にレンズ歪み補正を組み込んだ後の動作確認 (手動デバッグ用、恒久スクリプトではない)。
import { chromium } from '../crop-eval/node_modules/playwright/index.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOLS_DIR = path.resolve(__dirname, '../../public/tools');
const IMG = process.argv[2] || 'c:/Users/rymis/Downloads/DSC00198.JPG';

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

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', msg => { if (msg.type() === 'error') errors.push('console.error: ' + msg.text()); });
page.on('dialog', d => { errors.push('dialog: ' + d.message()); d.dismiss().catch(() => {}); });

await page.goto(`http://127.0.0.1:${port}/crop.html`);
await page.waitForFunction(() => document.getElementById('cvLoading')?.textContent.includes('準備完了'), null, { timeout: 60000 });

await page.evaluate(() => { window.detectBusy = 'pending'; });
await page.setInputFiles('#file', IMG);
await page.waitForFunction(() => window.detectBusy === false, null, { timeout: 60000 });

const lensStat = await page.$eval('#lensStat', el => el.textContent);
const status = await page.$eval('#status', el => el.textContent);
console.log('lensStat:', lensStat);
console.log('status:', status);
console.log('errors:', errors.length ? errors : 'none');

await page.screenshot({ path: path.join(__dirname, 'browser_test_screenshot.png'), fullPage: false });

// 実際に crop.html の中で補正されたフル解像度画像そのものを取り出す (imgEl は
// classic <script> のトップレベル let なので page.evaluate から直接参照できる)。
// これを保存して Python 側で改めてコーナー検出→直線性を測れば、
// 「JSの実装が本当にPython側の想定通り動いているか」の end-to-end 検証になる。
const dataUrl = await page.evaluate(() => (typeof imgEl !== 'undefined' && imgEl && imgEl.toDataURL) ? imgEl.toDataURL('image/png') : null);
if (dataUrl) {
  const b64 = dataUrl.replace(/^data:image\/png;base64,/, '');
  fs.writeFileSync(path.join(__dirname, 'browser_corrected_output.png'), Buffer.from(b64, 'base64'));
  console.log('saved corrected full-res output: browser_corrected_output.png');
} else {
  console.log('imgEl is not a canvas (no lens correction applied to this image)');
}

await browser.close();
server.close();
