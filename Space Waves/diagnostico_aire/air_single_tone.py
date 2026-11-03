"""Separa diversidad de interferencia entre tonos simultaneos (por aire, sin cambiar el volumen).

Variantes, mismo formato de chirps y prefijo ciclico:
  indep: diseno actual, nibble alto en A y bajo en B, independientes
  igual: el mismo nibble en A y en B (diversidad)
  solo:  un unico tono del grupo A por simbolo, a doble amplitud (misma potencia)
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np
import sounddevice as sd

from spacewaves import modem

FS = modem.FS
OUT, INP = 4, 1
GAIN = 0.5
REPS = 12
GAMMA = 0.4
cp = modem.CYCLIC_PREFIX
period = modem.SYMBOL + cp
rng = np.random.default_rng(91)
TA = modem._tone_matrix(modem.GROUP_A, cp)
TB = modem._tone_matrix(modem.GROUP_B, cp)
ENV = modem._envelope(period)


def build(hi, lo, mode):
    if mode == "solo":
        body = (np.sqrt(2.0) * TA[:, hi]).T * ENV
    else:
        body = (TA[:, hi] + TB[:, lo]).T * ENV
    chirp = modem._chirp()
    guard = np.zeros(modem.GUARD)
    return np.concatenate([chirp, guard, body.reshape(-1), guard, chirp[::-1]]).astype(np.float32)


def powers(y, n):
    start, _ = modem._find_chirp(y)
    data_start = start + modem.CHIRP_LEN + modem.GUARD
    idx = data_start + cp - 64 + np.arange(n) * period
    blocks = y[idx[:, None] + np.arange(modem.SYMBOL)[None, :]]
    blocks = blocks - blocks.mean(axis=1, keepdims=True)
    spec = np.abs(np.fft.rfft(blocks, axis=1)) ** 2
    return modem._tone_scores(spec, modem.GROUP_A), modem._tone_scores(spec, modem.GROUP_B)


def dfe(p, g):
    q = p.copy()
    q[1:] = p[1:] - g * p[:-1]
    return np.maximum(q, 1e-12)


results = {m: {0.0: [], GAMMA: []} for m in ("indep", "igual", "solo")}
for rep in range(3):
    for mode in ("indep", "igual", "solo"):
        hi = np.repeat(np.arange(16), REPS)
        rng.shuffle(hi)
        lo = hi.copy() if mode == "igual" else rng.permutation(np.repeat(np.arange(16), REPS))
        sig = build(hi, lo, mode)
        pad = np.zeros(FS, dtype=np.float32)
        x = np.concatenate([pad, sig * GAIN, pad]).astype(np.float32)
        y = sd.playrec(x.reshape(-1, 1), samplerate=FS, channels=1, device=(INP, OUT), dtype="float32")
        sd.wait()
        pa, pb = powers(y[:, 0].astype(np.float64), len(hi))
        for g in (0.0, GAMMA):
            qa, qb = dfe(pa, g), dfe(pb, g)
            if mode == "igual":
                s = qa / qa.sum(1, keepdims=True) + qb / qb.sum(1, keepdims=True)
                results[mode][g].append(float((np.argmax(s, 1) == hi).mean()))
            else:
                results[mode][g].append(float((np.argmax(qa, 1) == hi).mean()))
    print(f"ronda {rep + 1} lista", flush=True)

print("variante  bits/simbolo  acierto_A_sin_DFE  acierto_con_DFE   (media de 3 rondas, 192 simbolos)")
for mode, bits in (("indep", 8), ("igual", 4), ("solo", 4)):
    print(f"{mode:8s}  {bits:12d}  {np.mean(results[mode][0.0]):17.2f}  {np.mean(results[mode][GAMMA]):15.2f}")
