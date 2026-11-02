"""Prueba de concepto: normalizar cada tono con su respuesta medida por aire.

Captura 3 ensayos con todos los nibbles balanceados. Entrena (ganancia y piso
de ruido por tono) con el ensayo 1 y decodifica los ensayos 2 y 3 con y sin
normalizacion. Es evidencia fuera de linea, no cambia el modem.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np
import sounddevice as sd

from spacewases import modem

FS = modem.FS
OUT, INP = 4, 1
GAIN = 0.5
REPS = 12
rng = np.random.default_rng(11)


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
    return data, y[:, 0].astype(np.float64)


def tone_powers(y, nsym):
    start, _ = modem._find_chirp(y)
    data_start = start + modem.CHIRP_LEN + modem.GUARD
    period = modem.SYMBOL + modem.CYCLIC_PREFIX
    idx = data_start + modem.CYCLIC_PREFIX + np.arange(nsym) * period
    idx = idx[idx + modem.SYMBOL <= len(y)]
    blocks = y[idx[:, None] + np.arange(modem.SYMBOL)[None, :]]
    blocks = blocks - blocks.mean(axis=1, keepdims=True)
    spec = np.abs(np.fft.rfft(blocks, axis=1)) ** 2
    return (modem._tone_scores(spec, modem.GROUP_A),
            modem._tone_scores(spec, modem.GROUP_B))


def train(data, pa, pb):
    n = len(pa)
    hi = np.array([b >> 4 for b in data[:n]])
    lo = np.array([b & 15 for b in data[:n]])
    gains = []
    for p, sym in ((pa, hi), (pb, lo)):
        active = np.array([p[sym == k, k].mean() for k in range(16)])
        floor = np.array([p[sym != k, k].mean() for k in range(16)])
        gains.append((active, floor))
    return gains


def accuracy(data, pa, pb, model=None):
    n = len(pa)
    ok_h = ok_l = 0
    for p, shift, which in ((pa, 4, 0), (pb, 0, 1)):
        q = p
        if model is not None:
            active, floor = model[which]
            q = (p - floor) / np.maximum(active - floor, 1e-12)
        got = np.argmax(q, axis=1)
        want = np.array([(b >> shift) & 15 for b in data[:n]])
        if which == 0:
            ok_h = int((got == want).sum())
        else:
            ok_l = int((got == want).sum())
    return ok_h, ok_l, n


runs = []
for i in range(3):
    data, y = capture()
    pa, pb = tone_powers(y, len(data))
    runs.append((data, pa, pb))
    print(f"capturado ensayo {i + 1}: simbolos {len(pa)}/{len(data)}", flush=True)

model = train(*runs[0])
for i in (1, 2):
    data, pa, pb = runs[i]
    base = accuracy(data, pa, pb)
    norm = accuracy(data, pa, pb, model)
    print(f"ensayo {i + 1}: sin normalizar alto {base[0]}/{base[2]} bajo {base[1]}/{base[2]} | "
          f"normalizado (entrenado en ensayo 1) alto {norm[0]}/{norm[2]} bajo {norm[1]}/{norm[2]}")
