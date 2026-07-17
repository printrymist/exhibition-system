# 四隅精密モデル (corner_net_fine.onnx) の学習パイプライン

crop.html の最終仕上げ段で使う「隅パッチ → 真の角へのオフセット」回帰モデル。
人間には自明な「どの線が作品の縁か」の意味判断を、ルールでなくデータから学習する。

- `extract_fine.py` — GT (crop-gt json) から隅パッチを抽出 (窓=長辺2%を96px、乱れ±0.7%、TL型に回転正規化)。GT のパスは冒頭の定数を編集
- `train.py` / `train_fine.py` — 小型CNN (5conv+GAP) を回帰学習。学習=春陽会側42枚 / 検証=辻個展42枚の完全分離
- `eval_e2e.py` — 実戦形式評価 (自動検出の結果にモデルを2回適用 → GT誤差)
- ONNX 書き出しは train 後に torch.onnx.export (opset17, dynamic batch)。public/tools/corner_net_fine.onnx に配置

初版成績 (2026-07-17, v37): 検証セット隅誤差中央値 0.48%→0.19% (Python) / 0.215% (ブラウザ実測)。
粗モデル (窓6%) は精度床0.6%で実戦では逆効果 → 不採用 (精密のみ×2回で運用)。
GT を増やしたら extract→train→eval→export を再実行して差し替える。
