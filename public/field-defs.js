// =========================================================
// 作品データのフィールド定義カタログ — 主催者画面共通の唯一のソース
// register.html / input.html / caption.html の 3 画面が <script src> で同一の定義を読む。
// 派生定数 (FIELD_MAP / ARTIST_FIELDS / SNS_FIELDS / GRID_FIELDS / DEFAULT_FIELDS /
// ARTIST_LABELS / SNS_PLACEHOLDERS / FORM_FIELD_DEFS) はここで一括導出するので、
// 各画面では再定義しない。
// このファイルを classic <script> として読むと、トップレベルの const は同一ドキュメント内の
// 後続スクリプトから名前で参照できる (window 経由の必要はない)。
// =========================================================
//
// 順序メモ: register.html の従来 FIELD_DEFS 並び順を踏襲 (作品 → 作家 → 価格 → 備考 → SNS)。
// caption.html の旧 FORM_FIELD_DEFS は title→title_en→artist→... の順だったが、
// 統一に伴い register.html の並びへ寄せる (フォーム設定タブのレイアウトが変わる)。

const FIELD_DEFS = [
  // 作品基本情報
  { name: 'image_url',   label: '作品画像',         desc: '作品の写真（JPEG/PNG）',                              textarea: false, type: 'image', isDefault: true },
  { name: 'title',       label: 'タイトル',         desc: '作品名（日本語）',                                    textarea: false, isDefault: true, isCaptionRequired: true },
  { name: 'title_en',    label: 'タイトル（英語）', desc: '作品名（英語）',                                      textarea: false },
  { name: 'year',        label: '制作年',           desc: '制作された年（例：2024）',                            textarea: false, isDefault: true },
  { name: 'series',      label: 'シリーズ名',       desc: '連作・シリーズのタイトル',                            textarea: false },
  { name: 'technique',   label: '技法',             desc: '制作技法（例：油彩、版画）',                          textarea: false, isDefault: true },
  { name: 'material',    label: '素材・支持体',     desc: '使用素材や支持体',                                    textarea: false },
  { name: 'size',        label: 'サイズ',           desc: '作品の寸法（例：530×455mm）',                         textarea: false, isDefault: true },
  { name: 'sheet_size',  label: 'シートサイズ',     desc: '版画等の紙寸法（例：530×455mm）',                     textarea: false },
  { name: 'image_size',  label: 'イメージサイズ',   desc: '版画等の刷り部分の寸法（例：300×220mm）',             textarea: false },
  { name: 'edition',     label: 'エディション',     desc: '版画等のエディション番号（例：3/30）',                textarea: false },

  // 写真展用フィールド (公式テンプレ「📷 写真展 推奨」が使用)
  { name: 'shooting_location', label: '撮影地',     desc: '撮影した場所（例：北アルプス・常念岳）',              textarea: false },
  { name: 'shooting_year',     label: '撮影年',     desc: '撮影した年',                                          textarea: false },
  { name: 'camera',            label: 'カメラ・印画', desc: '使用カメラ・印画方式（例：SONY α7R IV、ジクレー）', textarea: false },

  // 作家情報 (作品ではなく作家単位で同じ値を共有)
  { name: 'artist',      label: '作家名',           desc: '作家名（日本語）',                                    textarea: false, isArtist: true, isDefault: true },
  { name: 'artist_en',   label: '作家名（英語）',   desc: '作家名（英語）',                                      textarea: false, isArtist: true },
  { name: 'birth_year',  label: '生年',             desc: '作家の生まれ年（例：1965）',                          textarea: false, isArtist: true },
  { name: 'death_year',  label: '没年',             desc: '作家の没年。存命の場合は空欄',                        textarea: false, isArtist: true },
  { name: 'birthplace',  label: '出身地',           desc: '作家の出身地（例：東京都、Paris）',                   textarea: false, isArtist: true },

  // 価格・販売情報
  { name: 'price',       label: '価格',             desc: '税込価格（数字のみ）',                                textarea: false, isDefault: true },
  { name: 'price_framed',label: '額装価格',         desc: '額装込みの価格。数字なら自動でカンマ整形、「別途注文」等の文言もそのまま保存', textarea: false },
  { name: 'certificate', label: '証明書',           desc: '真贋証明書・保証書の有無や種類',                      textarea: false },

  // 来歴・クレジット・備考
  { name: 'collection',  label: 'コレクション',     desc: '所蔵先・コレクション名',                              textarea: false },
  { name: 'courtesy',    label: 'クレジット',       desc: '画廊・提供元のクレジット表記',                        textarea: false },
  { name: 'note',        label: '備考',             desc: 'キャプションに表示するその他の情報',                  textarea: true  },
  { name: 'artist_note', label: '作家コメント',     desc: '作家自身によるコメント・ステートメント',              textarea: true  },

  // 作家リンク (web 展覧会で外部発信用)
  // 順序は旧 SNS_FIELDS = [insta, x, facebook, web, shop_url] に合わせている。
  // 純 SNS (insta/x/facebook/web) は caption フォーム設定 / register グリッドから除外、
  // shop_url は購入リンク用途で caption / グリッド両方に残す。
  { name: 'insta',       label: 'Instagram',        desc: '@username',                                           textarea: false, isArtist: true, isSnsSection: true, isPureSns: true },
  { name: 'x',           label: 'X (Twitter)',      desc: '@username',                                           textarea: false, isArtist: true, isSnsSection: true, isPureSns: true },
  { name: 'facebook',    label: 'Facebook',         desc: 'URLまたはユーザー名',                                 textarea: false, isArtist: true, isSnsSection: true, isPureSns: true },
  { name: 'web',         label: 'Web',              desc: 'https://...',                                         textarea: false, isArtist: true, isSnsSection: true, isPureSns: true },
  { name: 'shop_url',    label: '販売 / ショップ',  desc: 'BASE / minne / Creema 等のショップ URL（作家単位、web 展覧会で使用）', textarea: false, isArtist: true, isSnsSection: true },
];

// name → def の map (object lookup)
const FIELD_MAP = Object.fromEntries(FIELD_DEFS.map(d => [d.name, d]));

// 作家情報フィールド (SNS セクション以外)
const ARTIST_FIELDS = FIELD_DEFS.filter(d => d.isArtist && !d.isSnsSection).map(d => d.name);

// 入力フォームの「SNS / Web」セクションに出すフィールド (pure SNS + shop_url)
const SNS_FIELDS = FIELD_DEFS.filter(d => d.isSnsSection).map(d => d.name);

// 作家単位のフィールド全部 (artist info + SNS セクション)
const ALL_ARTIST_FIELDS = FIELD_DEFS.filter(d => d.isArtist).map(d => d.name);

// register.html の項目設定グリッドに出すフィールド (pure SNS を除外: 常時表示のため選択不要)
const GRID_FIELDS = FIELD_DEFS.filter(d => !d.isPureSns);

// 新規展覧会の項目設定で初期 ON にするフィールド
const DEFAULT_FIELDS = FIELD_DEFS.filter(d => d.isDefault).map(d => d.name);

// 作家系フィールドの label 辞書 (UI ラベル直引き用)
const ARTIST_LABELS = Object.fromEntries(FIELD_DEFS.filter(d => d.isArtist).map(d => [d.name, d.label]));

// SNS 入力欄の placeholder (= desc を流用)
const SNS_PLACEHOLDERS = Object.fromEntries(FIELD_DEFS.filter(d => d.isSnsSection).map(d => [d.name, d.desc]));

// caption.html フォーム設定タブの候補リスト (画像と pure SNS は除外、shop_url は残す)
const FORM_FIELD_DEFS = FIELD_DEFS
  .filter(d => d.type !== 'image' && !d.isPureSns)
  .map(d => ({ name: d.name, label: d.label, required: !!d.isCaptionRequired }));
