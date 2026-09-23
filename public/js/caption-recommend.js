/**
 * caption-recommend.js — キャプションテンプレ母集団 (data/caption-pool.json) から「おすすめ」を選ぶ (純粋関数)
 *
 * 流れ: 作品データ → 特徴 (profile) → チップの初期値 (inferChips) → 型の絞り込み + 並べ替え (shortlist)
 *       → キャプション画面が実データで収まりを確かめて、上から N 件を見せる。
 * チップ = データからは分からない主催者の意図 (個展/グループ展・日英併記・価格を出すか・美術館風)。
 * データから推定した値を初期選択にして、主催者がワンタップで直せる (2026-09-23 合意)。
 * 表示する項目があるか・収まるかは常にデータで判定し、チップでは変えない。
 * DOM・Firebase に触らない。将来 AI アシスタントも同じ関数で推奨する (設計原則4)。
 */
(function (root) {
  'use strict';

  const has = v => v != null && String(v).trim() !== '';
  const hasJa = s => /[぀-ヿ一-鿿]/.test(String(s || ''));

  // 作品データ (入力済みの作品の配列) の特徴
  function profile(artworks) {
    const arts = Array.isArray(artworks) ? artworks : [];
    const artists = new Set(arts.map(a => String(a.artist || a.artist_en || '').trim()).filter(Boolean));
    const count = f => arts.filter(a => has(a[f])).length;
    const titled = arts.filter(a => has(a.title) || has(a.title_en));
    // 英語だけの展示: タイトル・作家名・技法・作家コメントのどこにも和文が無い。
    // タイトルだけで見ると「Untitled」等の欧文タイトルの国内展 (Qriine 実データで約2割) を海外向けと誤判定する
    const enOnly = titled.length > 0 && arts.every(a => !['title', 'artist', 'technique', 'artist_note'].some(f => hasJa(a[f])));
    const fields = new Set();
    arts.forEach(a => Object.keys(a).forEach(k => { if (has(a[k])) fields.add(k); }));
    return {
      count: arts.length,
      artistCount: artists.size,
      enOnly,
      hasEnglish: count('title_en') > 0 || count('artist_en') > 0,
      hasPrice: count('price') > 0,
      hasEdition: count('edition') > 0,
      hasMuseum: count('collection') > 0,
      hasNote: count('artist_note') > 0,
      fields,
    };
  }

  // データから推定したチップの初期値
  function inferChips(p) {
    return {
      mode: p.artistCount > 1 ? 'group' : 'solo',
      bilingual: p.hasEnglish && !p.enOnly,
      price: p.count === 0 ? true : p.hasPrice,
      museum: p.hasMuseum,
    };
  }

  // チップとデータから、使う書き方の型 (generate.js の recipe) を決める
  function recipesFor(chips, p) {
    const out = [];
    if (chips.museum) out.push(p.enOnly ? 'museum_intl' : 'museum_jp');
    else if (p.enOnly) out.push('intl_gallery');
    else if (chips.bilingual) out.push('fair_bilingual');
    else if (chips.mode === 'group') out.push('jp_group_title_first', 'jp_group_artist_first');
    else {
      out.push('jp_solo_basic', 'jp_solo_oneline');
      if (p.hasNote) out.unshift('jp_solo_comment');
    }
    // 版画・写真はエディションの有無で自動 (チップにしない)
    if (p.hasEdition && !chips.museum) out.push('print_edition');
    return out;
  }

  // 価格を出さない指定なら価格の行を外す (group の中も)。空になった group は消す
  const PRICE_FIELDS = ['price', 'price_framed'];
  function applyChips(tpl, chips) {
    const t = JSON.parse(JSON.stringify(tpl));
    if (!chips.price) {
      t.items = t.items
        .map(it => it.type === 'group' ? Object.assign(it, { children: it.children.filter(c => !PRICE_FIELDS.includes(c.name)) }) : it)
        .filter(it => !(it.type === 'field' && PRICE_FIELDS.includes(it.name)) && !(it.type === 'group' && it.children.length === 0));
    }
    return t;
  }

  function shownFields(tpl) {
    const s = new Set();
    tpl.items.forEach(it => {
      if (it.type === 'field') s.add(it.name);
      (it.children || []).forEach(c => s.add(c.name));
    });
    return s;
  }

  // 母集団から候補を選んで並べる。見た目の軸 (大きさ・書体・揃え) がばらけるよう、
  // まだ出ていない組み合わせを優先して上から取る。limit は収まり確認に回す件数 (見せる件数より多め)
  function shortlist(pool, chips, p, limit) {
    limit = limit || 18;
    const recipes = recipesFor(chips, p);
    const cands = (pool.templates || pool).filter(t => recipes.includes(t.tags.recipe));
    // データにある項目を多く表示できる型を上に (型の並びは recipes の順を優先)
    const score = t => {
      const shown = shownFields(t);
      let s = 0;
      p.fields.forEach(f => { if (shown.has(f)) s += 1; });
      // 作家コメントがある展示では、QR が中央下の型を後ろに回す (コメントの下に QR が割り込むより
      // 端に寄せたほうが読みやすい、2026-09-23 ユーザー評価)。消さずに順位だけ下げる
      const qrPenalty = (p.hasNote && t.tags.qr === 'bottom-center') ? 1000 : 0;
      return s * 10 - recipes.indexOf(t.tags.recipe) - qrPenalty;
    };
    const sorted = cands.map(t => ({ t, s: score(t) })).sort((a, b) => b.s - a.s || (a.t.id < b.t.id ? -1 : 1)).map(x => x.t);
    // 型ごとの列に分け、型を順番に回しながら1件ずつ取る (1つの型が上位を独占しないように)。
    // 各型の中では、まだ出ていない見た目の組み合わせ (大きさ×書体×揃え) を優先する
    const byRecipe = recipes.map(r => sorted.filter(t => t.tags.recipe === r)).filter(l => l.length);
    const picked = [];
    const seen = new Set();
    const key = t => [t.tags.format, t.tags.font, t.tags.align].join('|');
    let progress = true;
    while (picked.length < limit && progress) {
      progress = false;
      for (const list of byRecipe) {
        if (picked.length >= limit) break;
        const t = list.find(x => !picked.includes(x) && !seen.has(key(x))) || list.find(x => !picked.includes(x));
        if (t) { picked.push(t); seen.add(key(t)); progress = true; }
      }
    }
    return picked.map(t => applyChips(t, chips));
  }

  // 収まり確認に使う作品: 項目ごとに一番長いものを集める (重複は除く)
  function heaviest(artworks, fields) {
    const arts = Array.isArray(artworks) ? artworks : [];
    const pick = new Map();
    (fields || ['title', 'title_en', 'artist', 'technique', 'size', 'artist_note', 'courtesy', 'collection']).forEach(f => {
      let best = null, len = 0;
      arts.forEach(a => { const l = String(a[f] || '').length; if (l > len) { len = l; best = a; } });
      if (best) pick.set(best.artwork_id || best, best);
    });
    return [...pick.values()];
  }

  // 保存テンプレ (caption.html の settingsJson と同じ形) に変換
  function toSettings(t) {
    const ps = t.pageSettings || {};
    return {
      paperSize: ps.paperSize || 'A4', cols: ps.cols, rows: ps.rows, orientation: ps.orientation || 'portrait',
      textAlign: t.textAlign, textColor: '#000000', textMarginLeft: ps.textMarginLeft, textMarginRight: ps.textMarginRight,
      qrPosition: t.qrPosition, qrOffset: t.qrOffset || 0, qrSize: ps.qrSize, qrMarginH: ps.qrMarginH, qrMarginV: ps.qrMarginV,
      fixedText: null, fontFamily: ps.fontFamily || 'sans-serif', paperMode: 'full', qrStickerLabel: 'artist_id', cardSheet: false,
      items: t.items,
    };
  }

  const api = { profile, inferChips, recipesFor, applyChips, shortlist, heaviest, toSettings };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.QriineCaptionRecommend = api;
})(typeof window !== 'undefined' ? window : this);
