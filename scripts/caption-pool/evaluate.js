// evaluate.js — 生成したテンプレ候補を、本物の caption.html の描画で判定する。
// 使用: NODE_PATH=<playwright-core のある node_modules> node scripts/caption-pool/evaluate.js
//   (playwright-core と、Playwright の Chromium が必要。CHROME_PATH で実行ファイルを指定可)
// 入力: out/candidates.json (generate.js)、samples.json。出力: out/results.json
//
// 判定 (1枚ずつ、テンプレの会場に合う見本データを流し込む):
//   - 文字の入りきらない検出: caption.html の autoFitText (最小サイズまで縮めても入らないもの)
//   - カード全体の高さ超過: group 行は autoFitText の対象外で、はみ出すと黙って切れるため自前で見る
//   - QR と文字の重なり
// その会場の典型データ (typical) が1件でも不合格ならテンプレは母集団から落とす。
// 極端なデータ (stress) の合否は「性能のタグ」として記録する (推奨時に実データで絞り込む用)。
'use strict';
const fs = require('fs'), path = require('path'), http = require('http');
const { chromium } = require('playwright-core');

const HERE = __dirname;
const PUBLIC = path.join(HERE, '..', '..', 'public');
const candidates = JSON.parse(fs.readFileSync(path.join(HERE, 'out', 'candidates.json'), 'utf8'));
const samples = JSON.parse(fs.readFileSync(path.join(HERE, 'samples.json'), 'utf8'));
const LIMIT = parseInt(process.env.LIMIT || '0', 10);

function samplesFor(venue) {
  const pick = arr => arr.filter(s => s.venue === venue);
  const typical = pick(samples.typical);
  // 極端なデータ: 同じ会場のもの + 会場を問わない最小データ
  const stress = pick(samples.stress).concat(samples.stress.filter(s => s.id === 's_minimal' && s.venue !== venue));
  return { typical, stress };
}

// テンプレの items (group の中も含む) が、指定した項目のどれかを表示するか
function showsAny(tpl, fields) {
  const names = new Set();
  const walk = it => { if (it.type === 'field') names.add(it.name); (it.children || []).forEach(walk); };
  tpl.items.forEach(walk);
  return (fields || []).some(f => names.has(f));
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.json': 'application/json', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  const f = path.join(PUBLIC, u === '/' ? 'caption.html' : u);
  if (!f.startsWith(PUBLIC) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});

(async () => {
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;
  const exe = process.env.CHROME_PATH || path.join(process.env.LOCALAPPDATA || '', 'ms-playwright', 'chromium-1228', 'chrome-win64', 'chrome.exe');
  const browser = await chromium.launch({ executablePath: exe });
  const page = await browser.newPage();
  page.on('pageerror', e => console.warn('[pageerror]', e.message));
  await page.goto(`http://localhost:${port}/caption.html`);
  await page.waitForFunction(() => typeof buildPrintHtml === 'function' && typeof autoFitText === 'function' && typeof qrcode === 'function');

  const list = LIMIT ? candidates.slice(0, LIMIT) : candidates;
  const results = [];
  const t0 = Date.now();
  for (let i = 0; i < list.length; i++) {
    const tpl = list[i];
    const { typical, stress } = samplesFor(tpl.tags.venue);
    const arts = typical.concat(stress).map(s => Object.assign({}, s, { artwork_id: s.id, qr_code: 'TEST' + String(i).padStart(4, '0') }));
    const r = await page.evaluate(async ({ tpl, arts }) => {
      const ps = tpl.pageSettings;
      const s = {
        paperSize: ps.paperSize, cols: ps.cols, rows: ps.rows, orientation: ps.orientation,
        textAlign: tpl.textAlign, textColor: '#000000', textMarginLeft: ps.textMarginLeft, textMarginRight: ps.textMarginRight,
        qrPosition: tpl.qrPosition, qrOffset: tpl.qrOffset || 0, qrSize: ps.qrSize, qrMarginH: ps.qrMarginH, qrMarginV: ps.qrMarginV,
        fixedText: null, fontFamily: ps.fontFamily, paperMode: 'full', qrStickerLabel: 'artist_id', cardSheet: false, items: tpl.items,
      };
      artworkData = { artworks: arts, headers: Object.keys(FIELD_MAP) };
      const html = buildPrintHtml(s);
      let fr = document.getElementById('__evalFrame');
      if (!fr) {
        fr = document.createElement('iframe'); fr.id = '__evalFrame';
        // A4 縦 (210mm) を 96dpi で描画できる大きさにする
        fr.style.cssText = 'position:fixed;left:-3000px;top:0;width:900px;height:1300px;';
        document.body.appendChild(fr);
      }
      const doc = fr.contentDocument; doc.open(); doc.write(html); doc.close();
      await doc.fonts.ready;
      await Promise.all([...doc.images].map(im => im.complete ? 0 : new Promise(r => { im.onload = im.onerror = r; })));
      const overflow = autoFitText(doc, fr.contentWindow);
      const per = {};
      doc.querySelectorAll('.cap-card').forEach(card => {
        const id = card.dataset.artworkId;
        const reasons = [];
        // caption.html の警告のうち項目単位のもの。カード全体の超過・QR 重なり (cardLevel / qrOverlap) は
        // 下で自前に判定するので重ねて数えない
        const fieldOver = overflow.filter(o => o.artworkId === id && !o.cardLevel && !o.qrOverlap);
        if (fieldOver.length) reasons.push('入りきらない: ' + fieldOver.map(o => o.field).join(','));
        if (card.scrollHeight > card.clientHeight + 2) reasons.push('カードの高さ超過');
        const qr = card.querySelector('img');
        if (qr) {
          const q = qr.getBoundingClientRect();
          const hit = [...card.querySelectorAll('.auto-fit, div[style*="line-height:1.3"]')].some(el => {
            // 行の中の実際の文字の範囲で見る (div は幅いっぱいなので Range で測る)
            const rg = doc.createRange(); rg.selectNodeContents(el);
            return [...rg.getClientRects()].some(t => t.width > 0 && t.left < q.right - 1 && t.right > q.left + 1 && t.top < q.bottom - 1 && t.bottom > q.top + 1);
          });
          if (hit) reasons.push('QRと文字が重なる');
        }
        // 1行にまとめた行 (group) が折り返すと「(b.」「1958)」のように途中で割れて崩れる。
        // group の div は .auto-fit を持たない line-height:1.3 の div。大きさの違う文字が混ざると
        // 下端がずれるので、上下の範囲が重なる文字を同じ行とみなし、行が2つ以上なら折り返し
        const wrapped = [...card.querySelectorAll('div[style*="line-height:1.3"]:not(.auto-fit)')].some(el => {
          const rg = doc.createRange(); rg.selectNodeContents(el);
          const rs = [...rg.getClientRects()].filter(t => t.width > 0).sort((a, b) => a.top - b.top);
          let lines = 0, lineBottom = -Infinity;
          rs.forEach(t => { if (t.top >= lineBottom - 1) { lines++; lineBottom = t.bottom; } else lineBottom = Math.max(lineBottom, t.bottom); });
          return lines > 1;
        });
        if (wrapped) reasons.push('まとめた行が折り返す');
        const sizes = [...card.querySelectorAll('.auto-fit')].map(el => parseFloat(el.style.fontSize) || parseFloat(el.dataset.size));
        per[id] = { ok: reasons.length === 0, reasons, minPt: sizes.length ? Math.min(...sizes) : null };
      });
      return per;
    }, { tpl, arts });
    const typOk = typical.every(s => r[s.id] && r[s.id].ok);
    results.push({
      id: tpl.id, tags: tpl.tags, pass: typOk,
      failedTypical: typical.filter(s => !(r[s.id] && r[s.id].ok)).map(s => ({ id: s.id, reasons: r[s.id] ? r[s.id].reasons : ['描画なし'] })),
      // テンプレが表示しない項目の試験は「対象外 (null)」。表示しない項目は入って当然なので可にしない
      capacity: Object.fromEntries(stress.map(s => [s.id, !showsAny(tpl, s.focus) ? null : !!(r[s.id] && r[s.id].ok)])),
      stressReasons: Object.fromEntries(stress.filter(s => !(r[s.id] && r[s.id].ok)).map(s => [s.id, r[s.id] ? r[s.id].reasons : ['描画なし']])),
    });
    if ((i + 1) % 50 === 0) console.log(`${i + 1}/${list.length} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  }
  fs.writeFileSync(path.join(HERE, 'out', 'results.json'), JSON.stringify(results, null, 1));
  const pass = results.filter(r => r.pass);
  console.log(`\n判定 ${results.length} 件 → 合格 ${pass.length} 件 / 不合格 ${results.length - pass.length} 件 (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  const by = (arr, k) => arr.reduce((m, x) => (m[x.tags[k]] = (m[x.tags[k]] || 0) + 1, m), {});
  console.log('合格・型別', by(pass, 'recipe'));
  console.log('合格・大きさ別', by(pass, 'format'));
  const reasons = {};
  results.filter(r => !r.pass).forEach(r => r.failedTypical.forEach(f => f.reasons.forEach(x => { const k = x.replace(/: .*/, ''); reasons[k] = (reasons[k] || 0) + 1; })));
  console.log('不合格の理由', reasons);
  await browser.close(); server.close();
})().catch(e => { console.error(e); process.exit(1); });
