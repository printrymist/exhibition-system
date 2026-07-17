# 四隅パッチデータセット抽出
# GT の各隅に乱れ (±JITTER% 長辺) を与えた中心でパッチを切り、真の角へのオフセットを教師にする。
# 4隅は90°回転で TL 型に正規化。train=既存42枚 / val=辻個展42枚 (展示単位の完全分離)。
import json, os, sys
import numpy as np
from PIL import Image, ImageOps

GT_PATH = 'C:/Users/rymis/Downloads/辻個展作品/crop-gt (3).json'
DIRS = ['C:/Users/rymis/Downloads/辻個展作品', 'C:/Users/rymis/Downloads/春陽会大阪展', 'C:/Users/rymis/Downloads']
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'dataset.npz')

WIN_FRAC = 0.06     # パッチ窓の半径 = 長辺の6%
PATCH = 96          # 入力解像度
JITTER = 0.025      # 中心の乱れ = 長辺の±2.5%
K_TRAIN = 20        # 1隅あたりのサンプル数 (train)
K_VAL = 6           # (val)
rng = np.random.default_rng(42)

gt = json.load(open(GT_PATH, encoding='utf-8'))

def find(name):
    for d in DIRS:
        p = os.path.join(d, name)
        if os.path.exists(p): return p
    return None

def extract_patch(img_np, cx, cy, half):
    # 画像外は端の複製で埋める (境界隅対応)
    H, W, _ = img_np.shape
    x0, x1 = int(round(cx - half)), int(round(cx + half))
    y0, y1 = int(round(cy - half)), int(round(cy + half))
    xs = np.clip(np.arange(x0, x1), 0, W - 1)
    ys = np.clip(np.arange(y0, y1), 0, H - 1)
    patch = img_np[np.ix_(ys, xs)]
    im = Image.fromarray(patch).resize((PATCH, PATCH), Image.BILINEAR)
    return np.asarray(im, dtype=np.uint8)

def rot_for_corner(i):
    # TL=0: そのまま / TR=1: 反時計90 (右上→左上) / BR=2: 180 / BL=3: 時計90
    return i

X_tr, Y_tr, X_va, Y_va, meta_va = [], [], [], [], []
names = list(gt.keys())
for n, name in enumerate(names):
    rec = gt[name]
    p = find(name)
    if not p:
        print('SKIP (画像なし):', name); continue
    img = ImageOps.exif_transpose(Image.open(p)).convert('RGB')
    if img.size != (rec['w'], rec['h']):
        print('SKIP (寸法不一致):', name, img.size, (rec['w'], rec['h'])); continue
    img_np = np.asarray(img)
    long = max(rec['w'], rec['h'])
    half = long * WIN_FRAC
    is_val = name.startswith('PXL_20260716')
    K = K_VAL if is_val else K_TRAIN
    for i, (gx, gy) in enumerate(rec['corners']):
        for k in range(K):
            jx, jy = rng.uniform(-JITTER, JITTER, 2) * long
            cx, cy = gx + jx, gy + jy
            patch = extract_patch(img_np, cx, cy, half)
            # 教師 = パッチ座標系での真の角の位置 (中心からのオフセット、half で正規化 [-1,1])
            ox, oy = (gx - cx) / half, (gy - cy) / half
            # 隅タイプを TL 型に回転正規化 (画像も教師も同じ回転)
            r = rot_for_corner(i)
            if r:
                patch = np.rot90(patch, k=r)          # 反時計 r*90°
                for _ in range(r):
                    ox, oy = oy, -ox                   # 反時計90°: (x,y)→(y,-x)
            if is_val:
                X_va.append(patch); Y_va.append([ox, oy]); meta_va.append((name, i, long))
            else:
                X_tr.append(patch); Y_tr.append([ox, oy])
    if (n + 1) % 10 == 0:
        print(f'{n+1}/{len(names)}')

X_tr = np.stack(X_tr); Y_tr = np.array(Y_tr, dtype=np.float32)
X_va = np.stack(X_va); Y_va = np.array(Y_va, dtype=np.float32)
np.savez_compressed(OUT, X_tr=X_tr, Y_tr=Y_tr, X_va=X_va, Y_va=Y_va,
                    meta_va=np.array([f'{a}|{b}|{c}' for a, b, c in meta_va]))
print('train:', X_tr.shape, 'val:', X_va.shape, '->', OUT)
