import torch
import torch.nn as nn

class Net(nn.Module):
    def __init__(self):
        super().__init__()
        def blk(i, o): return [nn.Conv2d(i, o, 3, 2, 1), nn.BatchNorm2d(o), nn.ReLU()]
        self.f = nn.Sequential(
            *blk(3, 24), *blk(24, 48), *blk(48, 96), *blk(96, 192), *blk(192, 256),
            nn.AdaptiveAvgPool2d(1), nn.Flatten(),
            nn.Linear(256, 64), nn.ReLU(), nn.Linear(64, 2), nn.Tanh())
    def forward(self, x): return self.f(x)

