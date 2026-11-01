"""Prueba de concepto fuera de linea: restar la cola del simbolo anterior (DFE de potencia).

score'_t = P_t - gamma * P_{t-1}. gamma se elige con la captura 1 y se evalua en la 2 y 3.
"""
import sys

sys.path.insert(0, r"C:\t\repo\SpacesWases")

import numpy as np
import sounddevice as sd

from spacewases import modem

FS = modem.FS
OUT, INP = 4, 1
GAIN = 0.5
REPS = 12
rng = np.random.default_rng(33)
period = modem.SYMBOL + modem.CYCLIC_PREFIX


def capture():
    highs = np.repeat(np.arange(16), REPS)
    lows = np.repeat(np.arange(16), REPS)
    rng.shuffle(highs)
    rng.shuffle(lows)
    data = bytes(((h << 4) | l) for h, l in zip(highs, lows))
    sig = modem.modulate(data)
    pad = np.zeros(FS, dtype=np.float32)
    x = np.concatenate([pad, sig * GAIN, pad]).astype(np.float32)
    y = sd.playrec(x.reshape(-1, 1), samplerate=FS, channels=1, device=(INP, OUT), dtype="float32")
    sd.wait()
    y = y[:, 0].astype(np.float64)
    start, _ = modem._find_chirp(y)
    data_start = start + modem.CHIRP_LEN + modem.GUARD
    idx = data_start + modem.CYCLIC_PREFIX - 64 + np.arange(len(data)) * period
    blocks = y[idx[:, None] + np.arange(modem.SYMBOL)[None, :]]
    blocks = blocks - blocks.mean(axis=1, keepdims=True)
    spec = np.abs(np.fft.rfft(blocks, axis=1)) ** 2
    pa = modem._tone_scores(spec, modem.GROUP_A)
    pb = modem._tone_scores(spec, modem.GROUP_B)
    want_h = np.array([b >> 4 for b in data])
    want_l = np.array([b & 15 for b in data])
    return pa, pb, want_h, want_l


def acc(p, want, gamma):
    q = p.copy()
    q[1:] = p[1:] - gamma * p[:-1]
    return float((np.argmax(q, axis=1) == want).mean())


caps = [capture() for _ in range(3)]
print("gamma   captura1(alto,bajo)   captura2        captura3")
for gamma in (0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.8, 1.0):
    cells = []
    for pa, pb, wh, wl in caps:
        cells.append(f"{acc(pa, wh, gamma):.2f},{acc(pb, wl, gamma):.2f}")
    print(f"{gamma:5.1f}   {cells[0]:16s} {cells[1]:14s} {cells[2]}")

best = max((0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.8, 1.0),
           key=lambda g: acc(caps[0][0], caps[0][2], g) + acc(caps[0][1], caps[0][3], g))
print("gamma elegido con la captura 1:", best)
for i in (1, 2):
    pa, pb, wh, wl = caps[i]
    print(f"captura {i + 1}: sin DFE {acc(pa, wh, 0):.2f}/{acc(pb, wl, 0):.2f} -> con DFE {acc(pa, wh, best):.2f}/{acc(pb, wl, best):.2f}")
