# 実戦形式評価: v36 の検出四隅を出発点に corner_net で磨き、GT誤差の変化を測る (検証=辻個展42枚)
import json, os
import numpy as np
import torch
from PIL import Image, ImageOps
from netdef import Net

HERE = os.path.dirname(os.path.abspath(__file__))
SP = os.path.dirname(HERE)
gt = json.load(open('C:/Users/rymis/Downloads/辻個展作品/crop-gt (3).json', encoding='utf-8'))
rep = json.load(open(os.path.join(SP, 'crop-eval-report-v36-full84.json'), encoding='utf-8'))['results']
DIRS = ['C:/Users/rymis/Downloads/辻個展作品', 'C:/Users/rymis/Downloads/春陽会大阪展', 'C:/Users/rymis/Downloads']
WIN_FRAC = 0.06; PATCH = 96

net = Net()
net.load_state_dict(torch.load(os.path.join(HERE, 'corner_net.pt'), map_location='cpu'))
net.eval()
net_f = Net()
net_f.load_state_dict(torch.load(os.path.join(HERE, 'corner_net_fine.pt'), map_location='cpu'))
net_f.eval()

def find(name):
    for d in DIRS:
        p = os.path.join(d, name)
        if os.path.exists(p): return p

def patch_at(img_np, cx, cy, half, rot):
    H, W, _ = img_np.shape
    xs = np.clip(np.arange(int(round(cx - half)), int(round(cx + half))), 0, W - 1)
    ys = np.clip(np.arange(int(round(cy - half)), int(round(cy + half))), 0, H - 1)
    p = img_np[np.ix_(ys, xs)]
    p = np.asarray(Image.fromarray(p).resize((PATCH, PATCH), Image.BILINEAR))
    if rot: p = np.rot90(p, k=rot)
    return p

def apply_net(model, img_np, out, half):
    batch = np.stack([patch_at(img_np, out[i][0], out[i][1], half, i) for i in range(4)])
    with torch.no_grad():
        pred = model(torch.from_numpy(batch.astype(np.float32).transpose(0, 3, 1, 2) / 127.5 - 1)).numpy()
    for i in range(4):
        ox, oy = pred[i]
        for _ in range((4 - i) % 4):   # TL正規化の逆回転
            ox, oy = oy, -ox
        out[i][0] += ox * half; out[i][1] += oy * half

def refine(img_np, corners, long, iters=2):
    out = [list(c) for c in corners]
    apply_net(net_f, img_np, out, long * 0.02)    # 精 (±0.7%対応)
    apply_net(net_f, img_np, out, long * 0.02)
    return out

before, after = [], []
img_before, img_after = [], []
for x in rep:
    if not x['name'].startswith('PXL_20260716') or not x.get('det'): continue
    g = gt[x['name']]; long = max(g['w'], g['h'])
    img = ImageOps.exif_transpose(Image.open(find(x['name']))).convert('RGB')
    img_np = np.asarray(img)
    ref = refine(img_np, x['det'], long)
    eb = [np.hypot(x['det'][i][0] - g['corners'][i][0], x['det'][i][1] - g['corners'][i][1]) / long * 100 for i in range(4)]
    ea = [np.hypot(ref[i][0] - g['corners'][i][0], ref[i][1] - g['corners'][i][1]) / long * 100 for i in range(4)]
    before += eb; after += ea
    img_before.append(max(eb)); img_after.append(max(ea))

def stats(v, label):
    v = np.array(v)
    print(label, '中央値', round(float(np.median(v)), 3), '% / <=0.25%:', round(float((v <= 0.25).mean() * 100)), '% / <=1%:', round(float((v <= 1).mean() * 100)), '%')

stats(before, '隅誤差 v36     :')
stats(after,  '隅誤差 v36+モデル:')
ib, ia = np.array(img_before), np.array(img_after)
print('一発OK (4隅<=1%): v36', int((ib <= 1).sum()), '/42 → v36+モデル', int((ia <= 1).sum()), '/42')
