// generate.js — キャプションテンプレ母集団の候補を、実在する書き方の型 × 見た目の軸 の組み合わせで生成する。
// 使用: node scripts/caption-pool/generate.js  → scripts/caption-pool/out/candidates.json
// 生成物は caption.html の公式テンプレ (public/data/official-presets.json) と同じ形式。
// 良し悪しの判定は evaluate.js (実際の caption.html の描画で、見本データが収まるかを見る)。
'use strict';
const fs = require('fs'), path = require('path');

// ── 部品 ──
function F(name, size, o) {
  o = o || {};
  return {
    type: 'field', name, size: Math.round(size * 2) / 2,
    bold: !!o.bold, italic: !!o.italic, align: o.align || 'inherit',
    maxLines: o.maxLines == null ? 1 : o.maxLines,
    // 読める下限: タイトル 9pt・その他 7pt (A7 を作品から 5〜10cm で読む想定)。これ以上は縮めない
    minSize: o.minSize || (o.title ? 9 : 7),
    currency: o.currency || '', comma: !!o.comma,
    prefix: o.prefix || '', suffix: o.suffix || '', affixScale: 0.75,
  };
}
const G = (sep, children, align) => {
  // caption.html の buildContent は group の入れ子を描画しない (中身が黙って消える) ので禁止
  if (children.some(c => c.type !== 'field')) throw new Error('group の中には field だけを入れる');
  return { type: 'group', sep, align: align || 'inherit', children };
};
const SP = mm => ({ type: 'spacer', size: mm + 'mm' });
const DIV = { type: 'divider' };

// ── 会場の種類ごとの書き方の型 (recipe) ──
// t = タイトルの基準サイズ (pt)。d = 詳細行、a = 作家名。div = 区切り線を入れるか。
// 項目が見本データに無ければ caption.html 側で行ごと出ない。
const RECIPES = {
  // 国内の個展: 作家名なし (会場全体が1作家)。タイトル → 詳細 → 価格
  jp_solo_basic: { venue: 'gallery_jp_solo', lang: 'ja', label: '個展・基本',
    items: ({ t, d, div }) => [SP(2), F('title', t, { bold: true, maxLines: 2, title: true }), SP(2), ...(div ? [DIV, SP(2)] : []),
      F('year', d), F('technique', d, { maxLines: 2 }), F('size', d), SP(3), F('price', d * 1.1, { currency: '¥', comma: true })] },
  // 国内の個展・詳細1行: 制作年／技法／サイズを1行にまとめる (小さいカード向け)
  jp_solo_oneline: { venue: 'gallery_jp_solo', lang: 'ja', label: '個展・詳細1行',
    items: ({ t, d, div }) => [SP(2), F('title', t, { bold: true, maxLines: 2, title: true }), SP(1.5), ...(div ? [DIV, SP(1.5)] : []),
      G('　', [F('year', d), F('technique', d), F('size', d)]), SP(2), F('price', d * 1.1, { currency: '¥', comma: true })] },
  // 国内の個展・作家コメント入り (Qriine 本番で作家コメントは48%の作品に入っている)。コメントは行数制限なし
  jp_solo_comment: { venue: 'gallery_jp_solo', lang: 'ja', label: '個展・作家コメント入り',
    items: ({ t, d, div }) => [SP(2), F('title', t, { bold: true, maxLines: 2, title: true }), SP(1.5),
      G('　', [F('year', d), F('technique', d), F('size', d)]), F('price', d * 1.1, { currency: '¥', comma: true }), SP(2),
      ...(div ? [DIV, SP(1.5)] : []), F('artist_note', d * 0.95, { maxLines: 0 })] },
  // 国内のグループ展・作品名が先
  jp_group_title_first: { venue: 'gallery_jp_group', lang: 'ja', label: 'グループ展・作品名が先',
    items: ({ t, d, a, div }) => [SP(2), F('title', t, { bold: true, maxLines: 2, title: true }), SP(1.5), F('artist', a),
      SP(2), ...(div ? [DIV, SP(2)] : []), F('year', d), F('technique', d, { maxLines: 2 }), F('size', d), SP(2), F('price', d * 1.1, { currency: '¥', comma: true })] },
  // 国内のグループ展・作家名が先 (枯葉庭園の作例: 作家名(小) → タイトル(最大) → 線 → 詳細 → 価格)
  jp_group_artist_first: { venue: 'gallery_jp_group', lang: 'ja', label: 'グループ展・作家名が先',
    items: ({ t, d, a, div }) => [SP(2), F('artist', a * 0.85), SP(1), F('title', t, { bold: true, maxLines: 2, title: true }), SP(2),
      ...(div ? [DIV, SP(2)] : []), G('　', [F('year', d), F('technique', d)]), F('size', d), SP(2), F('price', d * 1.1, { currency: '¥', comma: true })] },
  // 国内のアートフェア: 日英併記 + 画廊クレジット
  fair_bilingual: { venue: 'art_fair_jp', lang: 'ja+en', label: 'アートフェア・日英',
    items: ({ t, d, a, div }) => [SP(2), F('title', t, { bold: true, maxLines: 2, title: true }), F('title_en', d * 1.05, { italic: true, maxLines: 2 }), SP(1.5),
      G(' / ', [F('artist', a), F('artist_en', a)]), SP(1.5), ...(div ? [DIV, SP(1.5)] : []),
      G(', ', [F('year', d), F('technique', d), F('size', d)]), SP(1.5), F('price', d * 1.1, { currency: '¥', comma: true }), F('courtesy', d * 0.85, { maxLines: 2 })] },
  // 海外の商業画廊: 作家名(生年) → タイトル(斜体), 年 → 素材 → 寸法 → エディション → 価格
  intl_gallery: { venue: 'gallery_intl', lang: 'en', label: '海外画廊',
    items: ({ t, d, a, div }) => [SP(2), G(' ', [F('artist_en', a, { bold: true }), F('birth_year', d, { prefix: '(b. ', suffix: ')' })]), SP(1),
      // 英題は group に入れない (group は自動縮小・はみ出し検出の対象外のため)
      F('title_en', t * 0.85, { italic: true, maxLines: 3, title: true }), F('year', d * 1.1), SP(1.5), ...(div ? [DIV, SP(1.5)] : []),
      F('technique', d, { maxLines: 2 }), F('size', d, { maxLines: 2 }), F('edition', d), SP(2), F('price', d * 1.05)] },
  // 版画・写真: エディションとシート/イメージ寸法
  print_edition: { venue: 'print_photo', lang: 'ja+en', label: '版画・写真',
    items: ({ t, d, a, div }) => [SP(2), F('title', t, { bold: true, maxLines: 2, title: true }), F('title_en', t * 0.8, { italic: true, maxLines: 2, title: true }), SP(1),
      G(' ', [F('artist', a), F('artist_en', a)]), SP(1.5), ...(div ? [DIV, SP(1.5)] : []),
      G('　', [F('year', d), F('technique', d)]), F('size', d, { maxLines: 2 }), G('　', [F('image_size', d, { prefix: 'image ' }), F('sheet_size', d, { prefix: 'sheet ' })]),
      F('edition', d, { prefix: 'ed. ' }), SP(1.5), G('　', [F('price', d * 1.05, { currency: '¥', comma: true }), F('price_framed', d, { prefix: '額装 ', currency: '¥', comma: true })])] },
  // 国内の美術館: 作家名(生没年) → 作品名 → 英題 → 制作年 → 素材 → 寸法 → 所蔵。価格なし
  museum_jp: { venue: 'museum_jp', lang: 'ja+en', label: '美術館・国内',
    // 生没年は別の小さい行 (group の入れ子は caption.html が描画しないので使わない)。存命なら生年だけ出る
    items: ({ t, d, a, div }) => [SP(2), F('artist', a), G('–', [F('birth_year', d * 0.9), F('death_year', d * 0.9)]), SP(1),
      F('title', t, { bold: true, maxLines: 2, title: true }), F('title_en', d * 1.05, { italic: true, maxLines: 2 }), SP(1.5), ...(div ? [DIV, SP(1.5)] : []),
      F('year', d), F('technique', d, { maxLines: 2 }), F('size', d), F('collection', d)] },
  // 海外の美術館: クレジット行。価格なし
  museum_intl: { venue: 'museum_intl', lang: 'en', label: '美術館・海外',
    items: ({ t, d, a, div }) => [SP(2), F('artist_en', a, { bold: true }), G(', ', [F('birthplace', d * 0.9), F('birth_year', d * 0.9, { prefix: 'born ' })]), SP(1.5),
      F('title_en', t * 0.85, { italic: true, maxLines: 3, title: true }), F('year', d * 1.1), SP(1.5), ...(div ? [DIV, SP(1.5)] : []),
      F('technique', d, { maxLines: 3 }), F('size', d, { maxLines: 2 }), SP(1.5), F('courtesy', d * 0.9, { maxLines: 2 }), F('collection', d * 0.9)] },
};

// ── 1枚の大きさ (A4 縦の面数)。t = タイトル基準 pt、qr = QR 一辺 mm ──
// カード寸法は caption.html の印刷 CSS (余白 8mm・間隔 3mm) から: 幅 (194-3(c-1))/c、高さ (281-3(r-1))/r
// QR はユーザー評価 (2026-09-23「全体に大きめ」) で 14〜22mm → 12〜18mm に縮小。短縮 QR は 12mm で実機読み取り確認済み
const FORMATS = {
  L:      { cols: 2, rows: 3, t: 20, qr: 18, label: '大 (約96×92mm・A4に6枚)' },
  A7:     { cols: 2, rows: 4, t: 18, qr: 16, label: 'A7相当 (約96×68mm・8枚)' },
  card:   { cols: 2, rows: 5, t: 15, qr: 15, label: '名刺相当 (約96×54mm・10枚)' },
  small:  { cols: 3, rows: 5, t: 14, qr: 14, label: '小 (約63×54mm・15枚)' },
  xsmall: { cols: 3, rows: 6, t: 12, qr: 12, label: '極小 (約63×44mm・18枚)' },
  tall:   { cols: 4, rows: 4, t: 14, qr: 13, label: '縦長 (約46×68mm・16枚)' },
};
const FONTS = { gothic: 'sans-serif', mincho: "'Yu Mincho', 'Hiragino Mincho ProN', serif" };
const SCALES = { std: 1, large: 1.15 };

// ── 現実に無い組み合わせを除く規則 ──
function allowed(r, fmtKey, font, align, qr) {
  const R = RECIPES[r];
  if (R.lang === 'en' && font === 'mincho') return false;                         // 英語のみを明朝にしない
  if (R.venue.startsWith('museum') && (fmtKey === 'xsmall' || fmtKey === 'small')) return false; // 美術館ラベルは小さくしない
  if ((R.venue === 'art_fair_jp' || R.venue === 'print_photo') && fmtKey === 'xsmall') return false; // 情報量が多い型は極小にしない
  if (r === 'jp_solo_basic' && fmtKey === 'xsmall') return false;                  // 極小は1行まとめ型で
  if (r === 'jp_solo_comment' && !['L', 'A7', 'card'].includes(fmtKey)) return false; // コメント入りは大きめのカードだけ
  if (align === 'center' && qr !== 'bottom-center') return false;                  // 中央揃えは QR も中央下
  if (align === 'left' && qr === 'bottom-center') return false;
  if (fmtKey === 'tall' && qr === 'wrap-bottom-right') return false;                // 幅46mmで回り込みは窮屈
  return true;
}

const out = [];
for (const r in RECIPES) for (const fk in FORMATS) for (const font in FONTS)
  for (const align of ['left', 'center']) for (const qr of ['bottom-right', 'wrap-bottom-right', 'bottom-center'])
    for (const div of [true, false]) for (const sc in SCALES) {
      if (!allowed(r, fk, font, align, qr)) continue;
      const fm = FORMATS[fk], R = RECIPES[r];
      const t = fm.t * SCALES[sc], d = Math.max(7, t * 0.6), a = t * 0.78;
      const id = ['pool', r, fk, font, align, qr.replace('wrap-bottom-right', 'wrap').replace('bottom-', ''), div ? 'div' : 'nodiv', sc].join('_');
      out.push({
        id,
        label: `${R.label} / ${fm.label} / ${font === 'gothic' ? 'ゴシック' : '明朝'} / ${align === 'left' ? '左揃え' : '中央揃え'}${div ? ' / 区切り線' : ''}${sc === 'large' ? ' / 大きめ' : ''}`,
        tags: { recipe: r, venue: R.venue, lang: R.lang, format: fk, cols: fm.cols, rows: fm.rows, font, align, qr, divider: div, scale: sc },
        qrPosition: qr, qrOffset: 0, textAlign: align,
        pageSettings: {
          paperSize: 'A4', orientation: 'portrait', cols: fm.cols, rows: fm.rows,
          qrSize: Math.round(fm.qr * (sc === 'large' ? 1.05 : 1)), qrMarginH: 3, qrMarginV: 3,
          textMarginLeft: align === 'center' ? 4 : 5, textMarginRight: align === 'center' ? 4 : 5, fontFamily: FONTS[font],
        },
        items: R.items({ t, d, a, div }),
      });
    }

fs.mkdirSync(path.join(__dirname, 'out'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'out', 'candidates.json'), JSON.stringify(out));
const by = k => out.reduce((m, x) => (m[x.tags[k]] = (m[x.tags[k]] || 0) + 1, m), {});
console.log('候補', out.length, '件');
console.log('型別', by('recipe'));
console.log('大きさ別', by('format'));
