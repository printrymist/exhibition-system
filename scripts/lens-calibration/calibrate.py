"""
crop.html 用レンズ歪みプロファイル算出 (Sony alpha6000 + SEL20F28)。

generate_checkerboard.py で作った 9x6 内部コーナー / 25mm 四方のボードを
撮影した写真群から camera matrix + distortion coefficients を求める。

Usage: python calibrate.py <写真フォルダ>
"""
import sys
import glob
import os
import json
import numpy as np
import cv2

PATTERN_COLS = 9  # 内部コーナー数 (横)
PATTERN_ROWS = 6  # 内部コーナー数 (縦)
SQUARE_MM = 25.0

def find_corners(gray):
    # 6000x4000 のようなフル解像度では旧来の findChessboardCorners は失敗しやすい。
    # findChessboardCornersSB (sector-based, サブピクセル精度込み) を使う。
    flags = cv2.CALIB_CB_EXHAUSTIVE | cv2.CALIB_CB_ACCURACY
    ok, corners = cv2.findChessboardCornersSB(gray, (PATTERN_COLS, PATTERN_ROWS), flags)
    if not ok:
        return None
    return corners

def main():
    if len(sys.argv) < 2:
        print("usage: python calibrate.py <folder>")
        sys.exit(1)
    folder = sys.argv[1]
    paths = sorted(set(glob.glob(os.path.join(folder, "*.JPG")) + glob.glob(os.path.join(folder, "*.jpg"))))
    if not paths:
        print("no jpg files found in", folder)
        sys.exit(1)

    objp = np.zeros((PATTERN_ROWS * PATTERN_COLS, 3), np.float32)
    objp[:, :2] = np.mgrid[0:PATTERN_COLS, 0:PATTERN_ROWS].T.reshape(-1, 2) * SQUARE_MM

    objpoints = []
    imgpoints = []
    img_size = None
    used = []

    for p in paths:
        img = cv2.imread(p)
        if img is None:
            print(f"  skip (read fail): {p}")
            continue
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        if img_size is None:
            img_size = (gray.shape[1], gray.shape[0])
        corners = find_corners(gray)
        if corners is None:
            print(f"  skip (corners not found): {os.path.basename(p)}")
            continue
        objpoints.append(objp)
        imgpoints.append(corners)
        used.append(os.path.basename(p))
        print(f"  ok: {os.path.basename(p)}")

    if len(objpoints) < 3:
        print(f"\ncalibration に使える写真が {len(objpoints)} 枚しかありません (最低3枚、できれば10枚以上推奨)。")
        if len(objpoints) == 0:
            sys.exit(1)

    # 枚数が少ない/ポーズが似ていると高次項 (k2,k3,p1,p2) が暴れて過学習するため、
    # k1のみ+zero-tangent (旧方式) は写真4枚(似た正面構図)では fx と k1 が打ち消し合い
    # 過小決定になっていた (2026-09-16 判明: fxが物理的な期待値と28%も乖離・列方向の歪みが
    # 半分残る等)。21枚(四隅・端・斜め構図を追加)で再検証した結果、k1,k2,p1,p2 を解放し
    # k3 のみ固定するのが RMS・行列歪み残差ともに安定して良い (k3 解放は数値上ほぼ無改善)。
    calib_flags = cv2.CALIB_FIX_K3
    ret, camera_matrix, dist_coeffs, rvecs, tvecs = cv2.calibrateCamera(
        objpoints, imgpoints, img_size, None, None, flags=calib_flags
    )

    print(f"\n使用写真: {len(used)}/{len(paths)} 枚 -> {used}")
    print(f"画像サイズ: {img_size}")
    print(f"再投影誤差 (RMS, px): {ret:.4f}")
    print("camera matrix:\n", camera_matrix)
    print("dist coeffs (k1,k2,p1,p2,k3):\n", dist_coeffs.ravel())

    # 物理的な焦点距離の概算とのズレを表示 (fxとk1が打ち消し合う過小決定の目安。
    # 20〜30%もズレていたら撮影構図の多様性 (四隅・端・斜め) が足りていない兆候)
    expected_fx = 20.0 * (img_size[0] / 23.5)  # 20mmレンズ, APS-C実効幅23.5mm換算 (概算)
    print(f"fx物理概算との比較: 実測{camera_matrix[0,0]:.0f} / 概算{expected_fx:.0f} "
          f"(比 {camera_matrix[0,0]/expected_fx:.2f})")

    # 検出済みコーナーは平面市松模様の行・列=本来まっすぐな3D直線の投影なので、
    # 歪みが無ければ画像上でも直線のはず。undistortPoints後にどれだけ直線に
    # 戻ったかを見るのが「見た目」でなく数値でのアンディストート検証になる
    # (2026-09-16: 写真4枚だけの旧キャリブレーションはこれで見た目チェックだけでは
    #  気づけなかった「列方向の歪みが半分残る」欠陥が発覚した)。
    def line_residual(pts):
        pts = np.asarray(pts, dtype=np.float64)
        d = pts - pts.mean(axis=0)
        _, _, vt = np.linalg.svd(d)
        normal = np.array([-vt[0][1], vt[0][0]])
        return np.max(np.abs(d @ normal))

    row_raw, col_raw, row_fix, col_fix = [], [], [], []
    for corners in imgpoints:
        grid = corners.reshape(PATTERN_ROWS, PATTERN_COLS, 2)
        und = cv2.undistortPoints(corners.reshape(-1, 1, 2), camera_matrix, dist_coeffs,
                                   P=camera_matrix).reshape(PATTERN_ROWS, PATTERN_COLS, 2)
        row_raw.append(max(line_residual(grid[r, :, :]) for r in range(PATTERN_ROWS)))
        col_raw.append(max(line_residual(grid[:, c, :]) for c in range(PATTERN_COLS)))
        row_fix.append(max(line_residual(und[r, :, :]) for r in range(PATTERN_ROWS)))
        col_fix.append(max(line_residual(und[:, c, :]) for c in range(PATTERN_COLS)))
    print(f"行の曲がり(px): 補正前 平均{np.mean(row_raw):.2f}/最大{np.max(row_raw):.2f} "
          f"-> 補正後 平均{np.mean(row_fix):.2f}/最大{np.max(row_fix):.2f}")
    print(f"列の曲がり(px): 補正前 平均{np.mean(col_raw):.2f}/最大{np.max(col_raw):.2f} "
          f"-> 補正後 平均{np.mean(col_fix):.2f}/最大{np.max(col_fix):.2f}")

    # 焦点距離を画像幅に対する比で正規化して保存 (別解像度の写真にも同じプロファイルを適用できるように)
    w, h = img_size
    profile = {
        "camera": "Sony ILCE-6000",
        "lens": "E 20mm F2.8 (SEL20F28)",
        "calibratedImageSize": [w, h],
        "fx_over_w": float(camera_matrix[0, 0] / w),
        "fy_over_w": float(camera_matrix[1, 1] / w),
        "cx_over_w": float(camera_matrix[0, 2] / w),
        "cy_over_h": float(camera_matrix[1, 2] / h),
        "distCoeffs": dist_coeffs.ravel().tolist(),
        "rmsReprojectionError": float(ret),
        "numImagesUsed": len(used),
        "numImagesTotal": len(paths),
    }

    out_path = os.path.join(os.path.dirname(__file__), "sony_a6000_sel20f28_profile.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(profile, f, ensure_ascii=False, indent=2)
    print(f"\nprofile saved: {out_path}")

    # 検証用: 使った写真のうち1枚をアンディストートして並べて保存
    if used:
        sample_path = os.path.join(folder, used[0])
        sample = cv2.imread(sample_path)
        new_cm, roi = cv2.getOptimalNewCameraMatrix(camera_matrix, dist_coeffs, img_size, 1, img_size)
        undist = cv2.undistort(sample, camera_matrix, dist_coeffs, None, new_cm)
        preview_path = os.path.join(os.path.dirname(__file__), "preview_undistorted.jpg")
        side_by_side = np.hstack([
            cv2.resize(sample, (sample.shape[1] // 3, sample.shape[0] // 3)),
            cv2.resize(undist, (undist.shape[1] // 3, undist.shape[0] // 3)),
        ])
        cv2.imwrite(preview_path, side_by_side)
        print(f"preview saved (left=original, right=undistorted): {preview_path}")

if __name__ == "__main__":
    main()
