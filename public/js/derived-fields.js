/**
 * derived-fields.js — 他の項目から自動で組み立てる「表示用の項目」
 *
 * 作家が入力する項目ではなく、キャプションに載せるときに既存の項目から値を作る。
 * 例: 生没年 (lifespan) は 生年・没年 から「1931–2008」「1948年生」を作る。
 * キャプションの描画はキャプション画面 (caption.html) と来場者のスマホ表示 (index.html) の
 * 2か所にあるので、組み立て方をここに1つだけ置いて両方から使う。
 * 項目の定義 (ラベル・元になる項目) は field-defs.js の isDerived / sources。
 */
(function (root) {
  'use strict';

  // 「1965年」「 1965 」のような入力も年だけにそろえる
  function year(v) {
    return (v == null ? '' : String(v)).trim().replace(/年$/, '').trim();
  }

  function lifespan(art, en) {
    const b = year(art.birth_year), d = year(art.death_year);
    if (b && d) return b + '–' + d;
    if (b) return en ? 'b. ' + b : b + '年生';
    if (d) return en ? 'd. ' + d : d + '年没';
    return '';
  }

  const DERIVED = {
    lifespan: art => lifespan(art, false),
    lifespan_en: art => lifespan(art, true),
  };

  // 表示用の項目なら組み立てた値 (空なら '')、そうでなければ null を返す
  function resolve(art, name) {
    return Object.prototype.hasOwnProperty.call(DERIVED, name) ? DERIVED[name](art || {}) : null;
  }

  const api = { resolve, names: Object.keys(DERIVED) };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.QriineDerived = api;
})(typeof window !== 'undefined' ? window : this);
