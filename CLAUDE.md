# Rohei Printer System — Claude Code 作業指針

## 設計原則 (AI-Native Architecture)

詳細は `docs/architecture/AI-Native-Architecture-Notes.md` を参照。要点:

1. **不変条件 (invariant) は Firestore Security Rules / Cloud Functions 層に置く** — UI のバリデーションは親切心、ルールの本体は奥に置く二重構造
2. **新機能を作るときは「UI / API / LLM のどこから呼ばれても破られてはいけないか」を最初に確認** — YES なら API/DB 層に実装。UI 実装より先に Rules / CF を整える
3. **課金・上限・権限関連は必ず Cloud Functions で再検証** — UI だけで止めない
4. **LLM 機能は既存 API のクライアントとして実装** — 専用 UI に固有ロジックを作り込まない (UI と AI の能力差を作らない)
5. **UI 中心で良い領域 (印刷物・バーチャル展示等) は例外** — この原則に縛られなくて良い

### 留保

「UI = 単なる見せ方」という修辞は強すぎる。本プロジェクトでは キャプション
印刷の物理レイアウト・gallery.html のような UI 自体に価値がある領域もある。
原則と現実のバランスを取る。

## 詳細メモ

invariant 候補・チェックリスト・既存実装の整理は memory に保存:
`~/.claude/projects/C--Users-rymis-my-art-fair/memory/feedback_ai_native_invariants.md`
