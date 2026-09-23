// test-progress.js
// progress-core.js (進捗アシスタントの判定・純粋関数) のユニットテスト。
// 使用: `node functions/scripts/test-progress.js`
// 終了コード: 失敗数

'use strict';
const path = require('path');
const assert = require('assert');
const P = require(path.join(__dirname, '..', '..', 'public', 'js', 'progress-core.js'));

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + e.message); }
}

const NEW = '2026-10-01T00:00:00.000Z';   // 記録開始後に作成
const OLD = '2026-06-01T00:00:00.000Z';   // 記録開始前に作成
const GAS_INIT = JSON.stringify(['title', 'year', 'technique', 'size', 'price'].map(n => ({ name: n, required: n === 'title' })));
const SEVEN = JSON.stringify(['image_url', 'title', 'year', 'technique', 'size', 'artist', 'price'].map(n => ({ name: n })));
const slots = (entered, total, withImage) => Array.from({ length: total }, (_, i) => ({
  status: i < entered ? '1' : '0', image_url: (i < entered && i < (withImage == null ? entered : withImage)) ? 'x' : '',
}));
const run = (ex, extra) => P.computeProgress(Object.assign({ exCode: 'EX1', ex: ex, artworks: [], now: new Date('2026-10-05T03:00:00Z') }, extra || {}));
const step = (r, k) => r.steps.find(s => s.key === k);

console.log('項目設定の判定');
test('新規展覧会: 初期値のままなら未確認', () => {
  assert.strictEqual(step(run({ createdAt: NEW, registration_fields: GAS_INIT }), 'fields').state, 'todo');
});
test('新規展覧会: テンプレ採用で項目が変わっただけでは未確認のまま', () => {
  assert.strictEqual(step(run({ createdAt: NEW, registration_fields: SEVEN }), 'fields').state, 'todo');
});
test('新規展覧会: fields_confirmed_at があれば確認済み', () => {
  assert.strictEqual(step(run({ createdAt: NEW, registration_fields: GAS_INIT, fields_confirmed_at: NEW }), 'fields').state, 'done');
});
test('既存展覧会: 初期値から変わっていれば確認済み', () => {
  assert.strictEqual(step(run({ createdAt: OLD, registration_fields: SEVEN }), 'fields').state, 'done');
});
test('既存展覧会: 初期値のままなら未確認', () => {
  assert.strictEqual(step(run({ createdAt: OLD, registration_fields: GAS_INIT }), 'fields').state, 'todo');
});
test('createdAt の無い古い展覧会は既存扱い', () => {
  assert.strictEqual(step(run({ registration_fields: SEVEN }), 'fields').state, 'done');
});
test('過去の展覧会があれば複製の案内を出す', () => {
  const s = step(run({ createdAt: NEW }, { hasPastExhibitions: true }), 'fields');
  assert.ok(s.altAction && s.altAction.openImport);
});
test('確認済みなら複製の案内は出さない', () => {
  assert.ok(!step(run({ createdAt: NEW, fields_confirmed_at: NEW }, { hasPastExhibitions: true }), 'fields').altAction);
});
test('作品入力済みで未確認なら空欄の注意を出す', () => {
  assert.ok(step(run({ createdAt: NEW }, { artworks: slots(1, 3) }), 'fields').warning);
});

console.log('作品入力の判定');
test('空の作品枠だけなら未着手', () => {
  const s = step(run({}, { artworks: slots(0, 5) }), 'artworks');
  assert.strictEqual(s.state, 'todo'); assert.strictEqual(s.detail, '0 / 5 点');
});
test('一部入力なら途中', () => {
  const s = step(run({}, { artworks: slots(3, 5) }), 'artworks');
  assert.strictEqual(s.state, 'partial'); assert.strictEqual(s.count.entered, 3);
});
test('全枠入力なら済み', () => {
  assert.strictEqual(step(run({}, { artworks: slots(5, 5) }), 'artworks').state, 'done');
});
test('画像なしの作品数を数える', () => {
  const s = step(run({}, { artworks: slots(4, 5, 1) }), 'artworks');
  assert.strictEqual(s.count.noImage, 3); assert.ok(s.warning);
});
test('作品未取得なら unknown で、次の一手にしない', () => {
  const r = run({ createdAt: NEW, fields_confirmed_at: NEW }, { artworks: null });
  assert.strictEqual(step(r, 'artworks').state, 'unknown');
  assert.strictEqual(r.next.key, 'caption');
});

console.log('キャプション・印刷・次の一手');
test('何もしていなければ次は項目設定', () => {
  assert.strictEqual(run({ createdAt: NEW }, { artworks: slots(0, 5) }).next.key, 'fields');
});
test('項目済みなら次は作品入力', () => {
  assert.strictEqual(run({ createdAt: NEW, fields_confirmed_at: NEW }, { artworks: slots(0, 5) }).next.key, 'artworks');
});
test('作品が途中でも、未着手のキャプションを先に案内する', () => {
  assert.strictEqual(run({ createdAt: NEW, fields_confirmed_at: NEW }, { artworks: slots(2, 5) }).next.key, 'caption');
});
test('未着手が無ければ途中のステップを案内する', () => {
  const r = run({ createdAt: NEW, fields_confirmed_at: NEW, caption_template_id: 'preset:x', caption_printed_at: NEW }, { artworks: slots(2, 5) });
  assert.strictEqual(r.next.key, 'artworks'); assert.strictEqual(r.next.action.label, '作品の入力を続ける');
});
test('全部済みなら next は null・allDone', () => {
  const r = run({ createdAt: NEW, fields_confirmed_at: NEW, caption_template_id: 'saved:x', caption_printed_at: '2026-10-03T01:00:00Z' }, { artworks: slots(5, 5) });
  assert.strictEqual(r.next, null); assert.ok(r.allDone); assert.strictEqual(r.doneCount, 4);
  assert.strictEqual(step(r, 'print').detail, '印刷済み (10/3)');
});
test('リンクは展覧会コードをエンコードしタブを指定する', () => {
  const r = P.computeProgress({ exCode: 'A&B', ex: {}, artworks: [] });
  assert.strictEqual(step(r, 'artworks').action.href, 'register.html?ex=A%26B&tab=artworks');
});

console.log('任意項目・会期');
test('練習モードなら本番切替を任意項目に出す', () => {
  assert.ok(run({ is_sandbox: true }).optional.some(o => o.key === 'graduate'));
  assert.ok(!run({ is_sandbox: false }).optional.some(o => o.key === 'graduate'));
});
test('Web展覧会の公開状態', () => {
  assert.strictEqual(run({ gallery_visibility: 'public' }).optional[0].status, '公開中');
  assert.strictEqual(run({}).optional[0].status, '未公開');
});
test('会期までの日数 (YYYY/MM/DD)', () => {
  assert.strictEqual(run({ start_date: '2026/10/10' }).daysToStart, 5);
});
test('会期までの日数 (JST 0時の ISO)', () => {
  assert.strictEqual(run({ start_date: '2026-10-09T15:00:00.000Z' }).daysToStart, 5);
});
test('開始日なし・読めない値は null', () => {
  assert.strictEqual(run({}).daysToStart, null);
  assert.strictEqual(run({ start_date: '未定' }).daysToStart, null);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed);
