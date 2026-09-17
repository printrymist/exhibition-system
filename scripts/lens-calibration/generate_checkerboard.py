"""
A4 印刷用チェッカーボードパターン生成。
crop.html のレンズ歪み補正 (Sony α6000 + SEL20F28 用プロファイル) を
OpenCV camera calibration で作るためのキャリブレーション用紙。

内部コーナー数 9x6 (マス目 10x7)、1マス 25mm、300dpi、A4横向き。
印刷時は「実サイズ / 100%」で、用紙に合わせる拡大縮小をオフにすること。
"""
import numpy as np
import cv2

DPI = 300
MM_PER_IN = 25.4
PX_PER_MM = DPI / MM_PER_IN

SQUARE_MM = 25
COLS = 10  # マス目 (横)
ROWS = 7   # マス目 (縦)

A4_W_MM, A4_H_MM = 297, 210  # 横向き

def mm2px(mm):
    return int(round(mm * PX_PER_MM))

def main():
    canvas_w, canvas_h = mm2px(A4_W_MM), mm2px(A4_H_MM)
    img = np.full((canvas_h, canvas_w), 255, dtype=np.uint8)

    board_w_mm, board_h_mm = COLS * SQUARE_MM, ROWS * SQUARE_MM
    ox = mm2px((A4_W_MM - board_w_mm) / 2)
    oy = mm2px((A4_H_MM - board_h_mm) / 2)
    sq = mm2px(SQUARE_MM)

    for r in range(ROWS):
        for c in range(COLS):
            if (r + c) % 2 == 0:
                y0, y1 = oy + r * sq, oy + (r + 1) * sq
                x0, x1 = ox + c * sq, ox + (c + 1) * sq
                img[y0:y1, x0:x1] = 0

    # 実寸確認用のマーカー (左下に基準線 25mm)
    ruler_y = oy + ROWS * sq + mm2px(8)
    cv2.line(img, (ox, ruler_y), (ox + sq, ruler_y), 0, 3)
    cv2.putText(img, "25mm", (ox, ruler_y - 8), cv2.FONT_HERSHEY_SIMPLEX, 0.7, 0, 2, cv2.LINE_AA)
    cv2.putText(img, f"checkerboard {COLS}x{ROWS} squares / inner corners {COLS-1}x{ROWS-1} / {SQUARE_MM}mm/sq",
                (ox, oy - mm2px(6)), cv2.FONT_HERSHEY_SIMPLEX, 0.6, 0, 1, cv2.LINE_AA)

    out_path = r"C:\Users\rymis\Downloads\checkerboard_A4.png"
    cv2.imwrite(out_path, img)
    print(f"saved: {out_path} ({canvas_w}x{canvas_h}px, {DPI}dpi)")
    print(f"inner corners = {COLS-1}x{ROWS-1}, square = {SQUARE_MM}mm")

if __name__ == "__main__":
    main()
