// contact.js — 合格したテンプレの代表を、本物の caption.html の描画で画像にして一覧 HTML を作る (目視確認用)。
// 使用: NODE_PATH=<playwright-core のある node_modules> node scripts/caption-pool/contact.js
// 出力: out/contact/index.html (画像は data URI で埋め込み、1ファイルで開ける)
// 代表の選び方: 型 (recipe) × 大きさ (format) ごとに、合格テンプレから見た目の軸がばらけるよう最大 PER 件。
'use strict';
const fs = require('fs'), path = require('path'), http = require('http');
const { chromium } = require('playwright-core');
const HERE = __dirname, PUBLIC = path.join(HERE, '..', '..', 'public');
const cands = JSON.parse(fs.readFileSync(path.join(HERE, 'out', 'candidates.json'), 'utf8'));
const results = JSON.parse(fs.readFileSync(path.join(HERE, 'out', 'results.json'), 'utf8'));
const samples = JSON.parse(fs.readFileSync(path.join(HERE, 'samples.json'), 'utf8'));
const PER = parseInt(process.env.PER || '2', 10);
const byId = Object.fromEntries(cands.map(c => [c.id, c]));

const passed = results.filter(r => r.pass);
const groups = {};
passed.forEach(r => { const k = r.tags.recipe + '|' + r.tags.format; (groups[k] = groups[k] || []).push(r); });
const picks = [];
for (const k in groups) {
  const g = groups[k];
  // 軸をばらす: ゴシック左 → 明朝中央 → … の順に1件ずつ
  const order = [['gothic', 'left'], ['serif', 'left'], ['mincho', 'center'], ['mincho', 'left'], ['serif', 'center'], ['gothic', 'center']];
  for (const [font, align] of order) {
    const hit = g.find(r => r.tags.font === font && r.tags.align === align && !picks.includes(r));
    if (hit) picks.push(hit);
    if (picks.filter(p => p.tags.recipe + '|' + p.tags.format === k).length >= PER) break;
  }
}

const server = http.createServer((req, res) => {
  const f = path.join(PUBLIC, decodeURIComponent(req.url.split('?')[0]));
  if (!f.startsWith(PUBLIC) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': f.endsWith('.js') ? 'application/javascript' : f.endsWith('.json') ? 'application/json' : 'text/html; charset=utf-8' });
  fs.createReadStream(f).pipe(res);
});
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

(async () => {
  await new Promise(r => server.listen(0, r));
  const exe = process.env.CHROME_PATH || path.join(process.env.LOCALAPPDATA || '', 'ms-playwright', 'chromium-1228', 'chrome-win64', 'chrome.exe');
  const browser = await chromium.launch({ executablePath: exe });
  const page = await browser.newPage({ deviceScaleFactor: 2 });
  await page.goto(`http://localhost:${server.address().port}/caption.html`);
  await page.waitForFunction(() => typeof buildPrintHtml === 'function' && typeof qrcode === 'function');
  const rows = [];
  for (const r of picks) {
    const tpl = byId[r.id];
    const typ = samples.typical.filter(s => s.venue === tpl.tags.venue).slice(0, 2);
    const arts = typ.map((s, i) => Object.assign({}, s, { artwork_id: s.id, qr_code: 'DEMO' + i }));
    await page.evaluate(async ({ tpl, arts }) => {
      const ps = tpl.pageSettings;
      const s = { paperSize: ps.paperSize, cols: ps.cols, rows: ps.rows, orientation: ps.orientation, textAlign: tpl.textAlign, textColor: '#000000',
        textMarginLeft: ps.textMarginLeft, textMarginRight: ps.textMarginRight, qrPosition: tpl.qrPosition, qrOffset: 0, qrSize: ps.qrSize,
        qrMarginH: ps.qrMarginH, qrMarginV: ps.qrMarginV, fixedText: null, fontFamily: ps.fontFamily, paperMode: 'full',
        qrStickerLabel: 'artist_id', cardSheet: false, items: tpl.items };
      artworkData = { artworks: arts, headers: Object.keys(FIELD_MAP) };
      let fr = document.getElementById('__c');
      if (!fr) { fr = document.createElement('iframe'); fr.id = '__c'; fr.style.cssText = 'position:absolute;left:0;top:0;width:900px;height:1300px;border:0;'; document.body.appendChild(fr); }
      const doc = fr.contentDocument; doc.open(); doc.write(buildPrintHtml(s)); doc.close();
      await doc.fonts.ready;
      await Promise.all([...doc.images].map(im => im.complete ? 0 : new Promise(r => { im.onload = im.onerror = r; })));
      autoFitText(doc, fr.contentWindow);
    }, { tpl, arts });
    const shots = [];
    const cards = page.frameLocator('#__c').locator('.cap-card');
    for (let i = 0; i < arts.length; i++) shots.push((await cards.nth(i).screenshot()).toString('base64'));
    rows.push({ tpl, r, shots });
  }
  const cap = r => Object.entries(r.capacity).filter(([, v]) => v !== null).map(([k, v]) => `<span class="${v ? 'ok' : 'ng'}">${v ? '✓' : '✗'} ${esc(k.replace(/^s_/, ''))}</span>`).join(' ');
  const html = `<!doctype html><meta charset="utf-8"><title>キャプション母集団 一覧</title>
<style>body{font-family:sans-serif;margin:16px;background:#f4f4f4}h1{font-size:18px}.row{background:#fff;margin:0 0 14px;padding:10px 12px;border-radius:8px}
.lbl{font-size:13px;font-weight:bold;margin-bottom:4px}.tag{font-size:11px;color:#666;margin-bottom:6px}.ok{color:#188038}.ng{color:#c5221f}
.cards{display:flex;gap:12px;flex-wrap:wrap;align-items:flex-start}.cards img{border:1px solid #ddd;background:#fff;max-width:100%}</style>
<h1>キャプション母集団 — 合格テンプレの代表 ${rows.length} 件 (全合格 ${passed.length} / 候補 ${results.length})</h1>
<p style="font-size:12px;color:#555">見本データ (samples.json の typical) を本物の caption.html の描画で流し込んだもの。✓✗ は極端なデータが入るか (性能のタグ)。</p>
${rows.map(({ tpl, r, shots }) => `<div class="row"><div class="lbl">${esc(tpl.label)}</div><div class="tag">${esc(tpl.id)}　${cap(r)}</div>
<div class="cards">${shots.map(b => `<img src="data:image/png;base64,${b}">`).join('')}</div></div>`).join('\n')}`;
  fs.mkdirSync(path.join(HERE, 'out', 'contact'), { recursive: true });
  fs.writeFileSync(path.join(HERE, 'out', 'contact', 'index.html'), html);
  console.log('代表', rows.length, '件 → out/contact/index.html');
  await browser.close(); server.close();
})().catch(e => { console.error(e); process.exit(1); });
