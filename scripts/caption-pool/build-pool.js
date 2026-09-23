// build-pool.js — 判定に合格したテンプレを、アプリが読む母集団データ public/data/caption-pool.json に書き出す。
// 使用: generate.js → evaluate.js の後に node scripts/caption-pool/build-pool.js
// 母集団は画面の一覧には出さず、キャプション画面の「おすすめ」(js/caption-recommend.js) の材料にだけ使う。
'use strict';
const fs = require('fs'), path = require('path');
const HERE = __dirname;
const cands = JSON.parse(fs.readFileSync(path.join(HERE, 'out', 'candidates.json'), 'utf8'));
const results = JSON.parse(fs.readFileSync(path.join(HERE, 'out', 'results.json'), 'utf8'));
const pass = new Map(results.filter(r => r.pass).map(r => [r.id, r]));

const templates = cands.filter(c => pass.has(c.id)).map(c => ({
  id: c.id,
  label: c.label,
  tags: c.tags,
  // 極端なデータの試験結果: true=入る / false=入らない / null=その項目を表示しない型
  capacity: pass.get(c.id).capacity,
  qrPosition: c.qrPosition,
  qrOffset: c.qrOffset,
  textAlign: c.textAlign,
  pageSettings: c.pageSettings,
  items: c.items,
}));

const out = { version: 1, generatedAt: new Date().toISOString(), count: templates.length, templates };
const dest = path.join(HERE, '..', '..', 'public', 'data', 'caption-pool.json');
fs.writeFileSync(dest, JSON.stringify(out));
console.log('母集団', templates.length, '件 →', path.relative(process.cwd(), dest), (fs.statSync(dest).size / 1024).toFixed(0) + 'KB');
