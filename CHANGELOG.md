# 変更履歴 (Changelog)

このファイルは「展覧会システム」の主催者向け視点の更新履歴です。

バージョン体系: semver-lite
- `v0.x.y` — プレリリース、関係者テスト期
- `v1.0.0` — 公開リリース
- `v1.X.0` — 機能追加
- `v1.X.Y` — バグ修正・軽微な改善
- `v2.0.0+` — 破壊的変更

---

## v0.12.0 — 2026-05-27

### セキュリティ強化 + AI-Native アーキテクチャ整備

利用者から見える機能変更はありませんが、データ保護とサーバ側ルールを大きく整備しました。主催者・運営者の通常操作には影響しません。

#### D-1: 作品画像の上書きを Cloud Function 経由に
従来、`/artworks/` や `/gallery/` の Storage にファイル名さえ分かれば誰でも画像を上書きできる構造でした。Cloud Function (`uploadArtworkImage` / `uploadGalleryImage`) 経由に倒し、Storage Rules を読取り専用に。アップロード時に主催者 / 運営者 / 招待 URL の token が検証されるようになりました。

#### D-2: AI 分類機能 (categorizeArtwork) の権限強化
来場者の認証だけで AI 分類 API を叩ける状態だったのを、主催者 / 運営者のみに限定。Claude API 課金の抜け穴を塞ぎました。

#### D-3: サインインリンク送信に rate limit
任意のメールアドレスに対して大量の招待メールを送れる構造だったのを、5 分以内に同一アドレスへ 3 回までに制限。`email_throttle/{hash}` collection で server-side で管理。

#### D-6: 展覧会卒業 (graduateExhibition) の audit log 記録
展覧会全データを削除する破壊的操作の痕跡を `audit` collection に必ず残すように。`admin/audit.html` から閲覧可能。

#### D-7: inquiries の `from='admin'` 命名意図を明文化
firestore.rules と inquiry.html のコメントを補強。`from='admin'` が「問い合わせスレッドの作成者本人」を指す legacy 命名であることを明示。

#### β-3: 作品データの read 経路を整理 (AI-Native 不変条件の徹底)

`artworks` collection の公開 read を撤去し、3 経路だけに絞り込みました:
- **運営者**: Firebase Auth で常時 read
- **主催者**: 作品 doc に保存された `organizerEmail` と一致する Firebase Auth (denormalize)
- **来場者 (Web 展覧会)**: visitor custom token + 展覧会公開状態 (`_published=true`) + 登録済 (`status='1'`)

それ以外 (QR スキャンで来た来場者・招待 URL から来た作家) は Cloud Function (`getArtwork` / `listArtworksByArtist` / `findEmptyArtworkSlot`) 経由で取得するように変更。

これにより:
- 非公開状態の展覧会の作品データが exhibitionId + artworkId 既知でも漏れない
- LLM / 自動化ツールが Firebase SDK を直接叩いても不変条件を破れない
- 将来の公募展 (審査期間中は秘匿) / アートフェア (フェア前 VIP プレビュー) など、機密性要求の高い機能の土台

web-exhibition.html の「Web 公開設定」保存も Cloud Function (`syncArtworkPublishedFlags`) 経由になり、`gallery_visibility` 変更時に全作品の `_published` flag が一括同期されます。

### マイグレーション

新規展覧会 / 新規作品は自動的に新フィールドが入りますが、既存の作品 doc には `node functions/scripts/backfill-artwork-published.js --all` での一度きりのバックフィルが必要です (`--dry-run` で事前確認可)。

### 撤去された機能 (一時)

- index.html の「同じ展覧会の作家名 autocomplete」(SNS 自動入力に使われていた dropdown)。代替の Cloud Function を Phase 2 で追加すれば復活可能。

---

## v0.11.0 — 2026-05-26

### 新機能: QR のみキャプション (NY ギャラリースタイル)

紙キャプションの代わりに **小さな QR シール** を作品横に貼り、来場者が QR をスキャンすると **スマホでリッチな作品情報** + いいね/コメントが見える運用を追加。NY 系ギャラリーの「作品優先・説明排除」スタイルや、印刷コストを最小化したい主催者向け。

**新しい仕組み**:

- **公式テンプレ「📍 QR のみ (NY スタイル)」** を caption.html のテンプレ一覧に追加
- **paperMode 設定** (Page タブ、全テンプレ共通):
  - `full` (デフォルト): 紙にキャプション + QR (= 従来の挙動、変化なし)
  - `qr_only`: 紙には QR シールだけ、スマホで詳細表示
- どの公式テンプレも paperMode を切替えて「キャプション → QR シール運用」に転用可能 (例: 個展推奨で paperMode='qr_only' を選ぶ)
- **QR シールラベル** (Page タブの 5 択 select、qr_only 時のみ表示):
  - なし (QR のみ、QR をカード中央配置で間延び解消)
  - 作家名 / 作品 ID / 作家 + 作品 ID (default) / タイトル + 作家
- **Custom タブの items[] の意味が paperMode で切替わる**:
  - full モード時: 紙キャプションのデザイン (従来)
  - qr_only モード時: **スマホ画面 (= 来場者が見るキャプション)** のデザイン

**スマホ画面 (index.html caption mode)**:

- URL `?caption=1` (QR-only モードの QR シールに自動付与) で起動
- 画像 + items[] driven の作品情報 + ピンクの「いいね & 感想を送る」カード
- 紙キャプと同じ design language (font-size pt / bold / italic / divider / spacer / group / between 等) でスマホに表示

**preview の UX**:

- preview エリアにタブ追加: 「📄 紙印刷」/「📱 スマホ caption」
- paperMode='full' のときはスマホタブを **非表示** (= 普通の紙キャプ運用者は混乱しない)
- paperMode='qr_only' のときだけ両タブが見えて、デフォルトはスマホ caption

**reports.html ハブカードに「📊 詳細分析」を追加** (v0.10.0 の流れで動線整備)

### 内部変更

- `field-defs.js` に `artwork_id` を `isSystem: true` フィールドとして追加
  - register.html の項目選択グリッドからは除外 (operator は入力しない)
  - caption.html の +Add メニューには表示 (ラベルとして使える)
  - isFieldVisible / PRESETS fallback / adoptTemplate で isSystem を考慮
- cols/rows select の選択肢を拡張 (cols: 1-6 / rows: 2-10) — QR-only の 5×6 等に対応
- `computePrintDims` の perPage に NaN フォールバック (= 二度と「シール 0 枚」事故が起きない安全装置)
- `top-center` qrPosition を新規追加 (上中央配置)
- `center` qrPosition を追加 (QR-only でラベル無しの時の縦横中央配置)
- items[] を render する際、preset / caption_templates の双方で
  `isFieldVisible` が isSystem を許容するよう統一

### バグ修正

- caption.html の getSettings が「タブ active かどうか」で items の source を分岐していたバグ — fieldsGrid に項目があれば常に DOM の現状を真とする
- グループの両端揃え (justify-between) を追加 (= タイトル左 / 作家右 のような同行配置)
- paperMode='qr_only' で cols/rows が select に無い値だったため `select.value=""` → NaN → 紙印刷プレビュー空白だった件

---

## v0.10.0 — 2026-05-25

### 新機能: 詳細分析画面 (`analytics.html`)

リアルタイムダッシュボード (`dashboard.html`) はライブ表示専用 (会場大画面用) として据え置き、深い分析は新規 `analytics.html` に分離。ライブで動く数値と、腰を据えて読む数値を画面ごとに役割分担。

**新規指標**:

- **visitor の質** (V-1〜V-3):
  - コメント率 / 平均コメント長 (中央値)
  - 関与の段階 3 段階併記 — ≥1 like (反応した) / ≥10% カバー (ハマった) / ≥30% カバー (沈み込んだ)
- **滞在の質** (V-4〜V-7):
  - 滞在時間中央値 / 滞在分布 (<1min / 1-5 / 5-30 / 30+)
  - 深い visitor (≥10%×≥15min / ≥30%×≥30min) の 2 段階
  - リピート率 (session 境界 = gap > 2h or 日付跨ぎ)
- **作品単位** (V-8 / V-9 / W-3 / W-4):
  - 作品多様性カバー (90% 超が標準)
  - ロングテール度 — 上位 20% 占有率 + 棒グラフ + 解釈ラベル (「非常にロングテール」「自然な分布」「看板作中心」「1-2 作品に極端集中」)
  - コメント付き作品ランキング 上位 10 件
  - いいね 0 作品リスト (全体カバー率併記)
- **作家別** (G-1/G-3/G-4): グループ展のときだけ自動表示
  - 作家別 unique liker (リーチ) / リーチ率 / 平均深さ
- **時刻フィルタ** (④): `exhibitions.opening_at` をオプショナル設定。会期開始時刻より前のいいねを集計から除外。会期前テスト対策。
- **不審 session 検出** (Y-1〜Y-4): 強い疑い / 中程度 / 参考 のグルーピングで surface、チェック → 「⛔ 除外」「↩ 解除」で集計に反映。手動 sessionId 入力もサポート。

### 設計判断 (memory より)

- 「**作品数で割る**」指標 (打率) は出品スタイル差で歪むので却下
- 自己申告系の汚染除外 UI は採用見送り、代わりにロバスト指標 + opening_at + 異常検知パネルで押し切り
- 集計層 (`public/js/dashboard-metrics.js`) は純粋関数 14 個に独立、AI-Native 原則 ([[CLAUDE.md]]) に整合
- 認可は Cloud Function (`setLikesExcludedFromStats`) で operator / organizer 検証してから admin SDK で書き込み (UI で止めない)

### 検証

- **ユニットテスト**: `functions/scripts/test-metrics.js` で純粋関数を 66 ケース全 pass (境界値・空入力・無効データ含む)
- **UI smoke test**: `functions/scripts/seed-likes.js --bootstrap` で展覧会・作家・作品・likes を一式生成、analytics.html 全機能を `STEST` 展覧会で目視確認 → cleanup 済
- 将来の機能 (visitor account / 公募展 / フェア 等) の検証にも seed 基盤を流用可能

### 改善

- `reports.html` のハブカードに「📊 詳細分析」を追加 (ライブ → 詳細 → データ出力 → Web 展覧会 → 変更履歴 の動線)

---

## v0.9.4 — 2026-05-18

### セキュリティ (重要)

- **作家入力データのストア型 XSS を修正**。`caption.html` のプレビュー / 印刷経路と、`register.html` / `input.html` の作品一覧で、作家が登録した `title` / `artist` 等が HTML エスケープなしで描画されていた。preview iframe (srcdoc) と印刷 popup (`window.open`) は主催者と同一 origin で動くため、作家が `<img onerror=...>` のような payload を仕込めば主催者の Firebase 認証情報が盗まれる stored XSS だった。`escapeHtmlAttr` ヘルパで防御。
- **`issueGalleryToken` の `visibility` 判定を fail-closed に**。`gallery_visibility` が `"closed"` / `"visitor_only"` / `"public"` 以外の未知値だったとき fall-through で public 相当扱いになっていたのを、明示的に拒否するよう変更。

### UX

- **XLSX 一括編集で作家名変更時の警告**。行の `artist` 列を旧→新に書き換えたが、新作家の `artist_en` / `birthplace` 等が空のままアップロードすると、Firestore merge により旧データが残るバグを、dry-run 画面で警告として表示するように。

### 内部整理

- 未使用コードの除去 (`updateTemplateChoiceBanner` / `_savedTemplateName` / `setAsDefaultTemplate` / `adoptOfficialTemplate` / `fieldOptionsHtml` / `keyVal` / `openRowId`)。caption.html を約 90 行縮小。
- `functions/scripts/lint-public.js` (自前の audit ツール) をリポジトリに常駐化。ESLint Linter API で `public/` 配下の inline `<script>` を一括検査。

---

## v0.9.3 — 2026-05-17

### 新機能 (小規模)

- **テキスト色設定**: キャプション本文を「黒 / 濃グレー / 中グレー」から選択 (Page タブ)。「目立たせ過ぎないキャプション」のニーズに対応。QR と固定文ヘッダーは独立。
- **📋 公式 JSON コピーボタン (運営者専用)**: 自分のテンプレを公式テンプレ更新用の JSON 断片に整形してクリップボードへ。公式テンプレを運営者が反復改善するワークフローを軽量化。

### 公式テンプレ

- **🎨 版画・限定版 推奨** を ⭐ 公式に昇格 (旧ベースから移行)
- 公式テンプレ全 8 個 (個展 / グループ展 / 写真展 / 国際展 / シンプル・中央 / 作家コメント入り / 展覧会名ヘッダー / 版画・限定版) の中身を **実運用ベースのフィードバックで一斉刷新**:
  - タイトル / 作家名を大きく
  - セクション間の spacer を増やしてゆったり感
  - 価格を非 bold に統一 (アクセントは別の手段で)
  - グループ表記 (作家・年・技法等) を活用して縦の密度を緩和

### UX 改善

- **選択中テンプレ プレビューを 1.5 倍に拡大**: テンプレカードの thumbnail サイズだとレイアウト評価が辛かったので、選択中だけ大きく表示。
- 「💾 自分のテンプレ」が**運営者ログイン時に見えなかったバグ修正**: 運営者の保存テンプレが officials バケットに振られ、空のスタブ grid に並んで非表示になっていた問題を解消。

### 運用

- マニュアル §5.3 のテンプレ一覧を 12 個 (公式 8 + ベース 4) に更新、§5.4 にテキスト色を追記。

---

## v0.9.2 — 2026-05-16

### 改善

- バージョンフッタの色が薄すぎて気付けなかったので文字色を濃くした (`#aaa` → `#555`)。
  バージョン番号自体は青の bold (`#1a4f9c`) で目立たせ、日付は中グレー。

---

## v0.9.1 — 2026-05-16

### 運用

- 主催者画面のフッタに表示されるバージョン番号が `v0.9.0` → `v0.9.1` に。
  仕組み (CHANGELOG / git tag / フッタ表示の流れ) を確認するための PATCH bump で、
  機能の変更はなし。

---

## v0.9.0 — 2026-05-16

### 新機能

- **XLSX 一括編集** (`admin/exports.html`)
  - 「🎨 Artworks XLSX」ダウンロード → Excel 編集 → 同画面の「📤 Import」セクションでアップロードして反映
  - 未登録の空きスロット行に書き込むだけで新規登録 (作品 ID 列は触らない設計)
  - 1 つでもエラーがあればアップロード全体を拒否する厳格モード
  - 変更が無い行はスキップ (Excel の自動整形でも audit ログを汚さない)
- **変更履歴 (audit log) ビューア** (`admin/audit.html`)
  - 主催者ハブ「🕐 変更履歴」カードから開く
  - 誰が・いつ・どの作品の・どのフィールドを・何から何に変えたかを直近 100 件表示
  - クリックで before → after の差分テーブル展開
- **公式テンプレート 7 つ** (`caption.html`)
  - 個展 / グループ展 / 写真展 / 国際展 (前バージョン)
  - 🎏 シンプル・中央 / 💬 作家コメント入り / 📌 展覧会名ヘッダー (v0.9.0 追加)
  - 採用時にキャプション項目だけでなく Page 設定 (列数 / QR サイズ / 余白 等) も一気に適用
- **固定文 (展覧会名ヘッダー) の背景色・文字色** (`caption.html` Page タブ)
  - 背景: なし / 薄グレー / 濃グレー / 黒
  - 文字: 黒 / 白

### 改善

- **「保存は緩く、確定 (ロック) で厳格」に整理**
  - 主催者の「💾 更新する」: 必須項目チェックなし (画像未登録のままタイトル等を編集して保存できる)
  - 主催者の「🔒 ロック」(個別 / 一括) + 作家の「✓ 提出する": 必須項目に空欄があるとブロック
  - エラー時は具体的にどの項目が空欄か、対象作品 ID も表示
- **価格フィールドが文字入力も受ける**: 「非売品」「要相談」「Price on Request」もそのまま保存。数字なら従来通りカンマ整形
- **キャプションのフィールド単位デフォルト行数**: `title / title_en / note / artist_note` のみ 2 行、それ以外は 1 行 (年・価格などで autoFit による意図しない縮小が起きにくい)
- **テンプレ一覧の整理**: 重複していた「標準」「日英併記」を削除 (公式テンプレと統合)
- **エラーメッセージの友好化**: `register.html` / `Firestore` 等のプログラム用語を画面表示名 (「作品登録/設定」画面 等) に置き換え

### バグ修正

- 個別ロック時に作品の最新データ (artworkCache から取り直し) でチェックするように修正 — 編集直後にロックを押すと古いデータでチェックされるバグ
- 公式テンプレ採用後に他テンプレを採用すると固定文の帯が残り続けるのを修正
- `caption.html` のテンプレカード重複定義 `.template-card h4` を整理
- XLSX Import が CORS エラーで失敗していた問題 — `submitArtwork` CF が `asia-northeast1` にあるのに region 指定なしで `us-central1` を叩いていた

### 運用

- バージョン管理開始: `public/version.js` で APP_VERSION を一元管理、主要画面に小フッタで表示
- このファイル `CHANGELOG.md` を起こした

---

## v0.x 開発期 (2026-04 〜 2026-05-15)

公開リリース前の機能追加・基盤整備期間。主なマイルストーン:

- 認証移行 (パスワード → Email Link → Cloud Function 経由)
- マニュアル公開 (`public/docs/`)
- バーチャル展覧会 (`gallery.html`, SSR via `galleryPage` CF) MVP
- 主催者主導 + 作品ロック (is_locked) モデル
- 画像配信を Hosting CDN 経由に (`imageProxy` CF)
- 監査ログ (Phase E) backend 実装
- 来場者セッション ID の 3 重冗長化
- キャプションメーカーの UX 整理 (テンプレ採用フロー / おすすめの使い方 / プリセット外部 JSON 化)

詳細は git log を参照。
