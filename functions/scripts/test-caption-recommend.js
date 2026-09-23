// test-caption-recommend.js — public/js/caption-recommend.js (おすすめの絞り込み・純粋関数) のユニットテスト
// 使用: node functions/scripts/test-caption-recommend.js   (母集団 public/data/caption-pool.json も使う)
'use strict';
const path = require('path');
const assert = require('assert');
const R = require(path.join(__dirname, '..', '..', 'public', 'js', 'caption-recommend.js'));
const pool = require(path.join(__dirname, '..', '..', 'public', 'data', 'caption-pool.json'));

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + e.message); }
}
const solo = [{ artwork_id: 'a1', title: '朝', year: '2025', technique: '油彩', size: 'F4', price: '30000' },
  { artwork_id: 'a2', title: '夜の港で', year: '2025', technique: '油彩・キャンバス', size: 'F8', price: '50000' }];
const group = [{ artwork_id: 'g1', title: '川', artist: '森川', price: '1' }, { artwork_id: 'g2', title: '山', artist: '佐伯' }];

console.log('チップの推定');
test('作家が1人以下なら個展', () => assert.strictEqual(R.inferChips(R.profile(solo)).mode, 'solo'));
test('作家が複数ならグループ展', () => assert.strictEqual(R.inferChips(R.profile(group)).mode, 'group'));
test('英題があれば日英併記', () => assert.ok(R.inferChips(R.profile([{ title: '光', title_en: 'Light' }])).bilingual));
test('英語だけの展示は日英併記にしない (英語の型へ)', () => {
  const p = R.profile([{ title: 'Ghost', artist_en: 'S. K.', title_en: 'Ghost' }]);
  assert.ok(p.enOnly); assert.ok(!R.inferChips(p).bilingual); assert.deepStrictEqual(R.recipesFor(R.inferChips(p), p), ['intl_gallery']);
});
test('価格が1件も無ければ価格を出さない', () => assert.strictEqual(R.inferChips(R.profile([{ title: 'x' }])).price, false));
test('作品が0件なら価格は出す側 (見本)', () => assert.strictEqual(R.inferChips(R.profile([])).price, true));
test('所蔵があれば美術館風', () => assert.ok(R.inferChips(R.profile([{ title: 'x', collection: '市立美術館蔵' }])).museum));

console.log('型の絞り込み');
test('個展 + 作家コメントありならコメント型を先頭に', () => {
  const p = R.profile([{ title: '朝', artist_note: 'こめんと' }]);
  assert.strictEqual(R.recipesFor(R.inferChips(p), p)[0], 'jp_solo_comment');
});
test('欧文タイトルでも技法が和文なら国内の型 (英語だけと誤判定しない)', () => {
  const p = R.profile([{ title: 'Untitled', technique: '油彩' }]);
  assert.ok(!p.enOnly); assert.ok(R.recipesFor(R.inferChips(p), p)[0].startsWith('jp_solo'));
});
test('エディションがあれば版画・写真の型を足す', () => {
  const p = R.profile([{ title: '夜', edition: '3/30' }]);
  assert.ok(R.recipesFor(R.inferChips(p), p).includes('print_edition'));
});
test('チップで美術館風にすると美術館の型だけ', () => {
  const p = R.profile(solo);
  assert.deepStrictEqual(R.recipesFor(Object.assign(R.inferChips(p), { museum: true }), p), ['museum_jp']);
});

console.log('候補の並べ方');
test('個展の候補は個展の型だけ・18件', () => {
  const p = R.profile(solo), list = R.shortlist(pool, R.inferChips(p), p);
  assert.strictEqual(list.length, 18);
  assert.ok(list.every(t => t.tags.recipe.startsWith('jp_solo')));
});
test('最初の数件は大きさ×書体×揃えがすべて違う', () => {
  const p = R.profile(solo), list = R.shortlist(pool, R.inferChips(p), p);
  const keys = list.slice(0, 6).map(t => [t.tags.format, t.tags.font, t.tags.align].join('|'));
  assert.strictEqual(new Set(keys).size, 6);
});
test('価格を出さない指定なら価格の行が消える (group の中も)', () => {
  const p = R.profile(group), chips = Object.assign(R.inferChips(p), { price: false });
  const names = t => t.items.flatMap(i => i.type === 'group' ? i.children.map(c => c.name) : [i.name]);
  R.shortlist(pool, chips, p).forEach(t => assert.ok(!names(t).includes('price') && !names(t).includes('price_framed'), t.id));
});
test('作家コメントがあれば QR が中央下の型を後ろに回す (消さない)', () => {
  const p = R.profile([{ title: '朝', artist_note: 'こめんと', price: '1' }]);
  const list = R.shortlist(pool, R.inferChips(p), p, 40);
  const firstCenter = list.findIndex(t => t.tags.qr === 'bottom-center');
  assert.ok(list.slice(0, 6).every(t => t.tags.qr !== 'bottom-center'), '上位6件に中央下が無い');
  assert.ok(firstCenter === -1 || firstCenter >= 6);
});
test('作家コメントが無ければ中央下も上位に出る', () => {
  const p = R.profile(solo), list = R.shortlist(pool, R.inferChips(p), p);
  assert.ok(list.slice(0, 6).some(t => t.tags.qr === 'bottom-center'));
});
test('元の母集団は書き換えない', () => {
  const before = JSON.stringify(pool.templates[0]);
  R.shortlist(pool, { mode: 'solo', bilingual: false, price: false, museum: false }, R.profile(solo));
  assert.strictEqual(JSON.stringify(pool.templates[0]), before);
});

console.log('収まり確認用の作品・保存形式');
test('項目ごとに一番長い作品を重複なく集める', () => {
  const h = R.heaviest(solo).map(a => a.artwork_id);
  assert.ok(h.includes('a2'));            // タイトル・技法が最長
  assert.strictEqual(new Set(h).size, h.length);
});
test('保存テンプレの形 (settingsJson) に変換', () => {
  const s = R.toSettings(pool.templates[0]);
  ['paperSize', 'cols', 'rows', 'qrSize', 'fontFamily', 'items', 'textAlign', 'qrPosition'].forEach(k => assert.ok(k in s, k));
  assert.strictEqual(s.paperMode, 'full');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed);
