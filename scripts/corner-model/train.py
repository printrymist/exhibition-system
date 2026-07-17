# 四隅オフセット回帰の小型CNN学習
# 入力 96x96x3 (TL型に正規化済) → 出力 (dx,dy) [-1,1] (窓半径=長辺6%で正規化)
import os, time
import numpy as np
import torch
import torch.nn as nn

HERE = os.path.dirname(os.path.abspath(__file__))
d = np.load(os.path.join(HERE, 'dataset.npz'))
X_tr, Y_tr, X_va, Y_va = d['X_tr'], d['Y_tr'], d['X_va'], d['Y_va']
meta = [m.split('|') for m in d['meta_va']]
long_va = np.array([float(m[2]) for m in meta], dtype=np.float32)
HALF_FRAC = 0.06

device = 'cpu'
torch.manual_seed(0)

class Net(nn.Module):
    def __init__(self):
        super().__init__()
        def blk(i, o): return [nn.Conv2d(i, o, 3, 2, 1), nn.BatchNorm2d(o), nn.ReLU()]
        self.f = nn.Sequential(
            *blk(3, 24), *blk(24, 48), *blk(48, 96), *blk(96, 192), *blk(192, 256),
            nn.AdaptiveAvgPool2d(1), nn.Flatten(),
            nn.Linear(256, 64), nn.ReLU(), nn.Linear(64, 2), nn.Tanh())
    def forward(self, x): return self.f(x)

net = Net().to(device)
opt = torch.optim.AdamW(net.parameters(), lr=1e-3, weight_decay=1e-4)
EPOCHS = 40
sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, EPOCHS)
lossf = nn.SmoothL1Loss(beta=0.05)

def to_t(x):  # NHWC uint8 -> NCHW float [-1,1]
    return torch.from_numpy(x.astype(np.float32).transpose(0, 3, 1, 2) / 127.5 - 1.0)

Xva_t = to_t(X_va); Yva_t = torch.from_numpy(Y_va)
N = len(X_tr); B = 64
best = 1e9
rng = np.random.default_rng(1)
for ep in range(EPOCHS):
    net.train(); t0 = time.time(); perm = rng.permutation(N); tot = 0.0
    for b0 in range(0, N, B):
        idx = perm[b0:b0 + B]
        xb = X_tr[idx].copy(); yb = Y_tr[idx].copy()
        # 増強: 対角反転 (TL型を保つ) + 明るさ/コントラスト
        flip = rng.random(len(idx)) < 0.5
        xb[flip] = xb[flip].transpose(0, 2, 1, 3)      # x/y 入替
        yb[flip] = yb[flip][:, ::-1]
        gain = rng.uniform(0.7, 1.3, (len(idx), 1, 1, 1)).astype(np.float32)
        bias = rng.uniform(-25, 25, (len(idx), 1, 1, 1)).astype(np.float32)
        xb = np.clip(xb.astype(np.float32) * gain + bias, 0, 255).astype(np.uint8)
        xt, yt = to_t(xb), torch.from_numpy(yb.astype(np.float32))
        opt.zero_grad()
        loss = lossf(net(xt), yt)
        loss.backward(); opt.step()
        tot += loss.item() * len(idx)
    sched.step()
    net.eval()
    with torch.no_grad():
        pv = net(Xva_t).numpy()
    err_norm = np.hypot(*(pv - Y_va).T)                    # 窓半径単位
    err_px = err_norm * long_va * HALF_FRAC                # フル解像度 px
    err_pct = err_px / long_va * 100                       # 長辺%
    med = float(np.median(err_pct)); ok = float((err_pct <= 0.25).mean())
    if med < best:
        best = med
        torch.save(net.state_dict(), os.path.join(HERE, 'corner_net.pt'))
    print(f'ep{ep+1:02d} loss {tot/N:.4f}  val median {med:.3f}%長辺  ≤0.25%率 {ok*100:.0f}%  ({time.time()-t0:.0f}s)')
print('best val median:', round(best, 3), '%長辺')
