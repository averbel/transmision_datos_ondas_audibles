"""Diversidad en frecuencia por aire: el mismo nibble en los dos grupos de tonos.

Se transmiten bytes con nibble alto == bajo (v, v). Se compara decodificar con el
grupo A solo, el B solo, y la combinacion A+B (suma de potencia y suma de log),
con y sin DFE. No cambia el volumen.
"""
import sys

sys.path.insert(0, r"C:\t\repo\mi_version")

import numpy as np
import sounddevice as sd

from spacewases import modem

FS = modem.FS
OUT, INP = 4, 1
GAIN = 0.5
REPS = 12
GAMMA = 0.4
rng = np.random.default_rng(77)
period = modem.SYMBOL + modem.CYCLIC_PREFIX


def capture():
    vals = np.repeat(np.arange(16), REPS)
    rng.shuffle(vals)
    data = bytes((v << 4) | v for v in vals)
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
    return (modem._tone_scores(spec, modem.GROUP_A),
            modem._tone_scores(spec, modem.GROUP_B), vals)


def dfe(p, gamma):
    q = p.copy()
    q[1:] = p[1:] - gamma * p[:-1]
    return q


def acc(score, want):
    return float((np.argmax(score, axis=1) == want).mean())


runs = [capture() for _ in range(4)]
labels = ["A solo", "B solo", "A+B potencia", "A+B log", "A+B potencia (por rangos)"]


def evaluate(gamma):
    out = np.zeros(len(labels))
    for pa, pb, want in runs:
        qa, qb = dfe(pa, gamma), dfe(pb, gamma)
        qa = np.maximum(qa, 1e-12)
        qb = np.maximum(qb, 1e-12)
        # normaliza cada simbolo para que A y B pesen igual
        na = qa / qa.sum(axis=1, keepdims=True)
        nb = qb / qb.sum(axis=1, keepdims=True)
        out += np.array([
            acc(qa, want), acc(qb, want),
            acc(na + nb, want),
            acc(np.log(qa) + np.log(qb), want),
            acc(np.argsort(np.argsort(qa, axis=1), axis=1) + np.argsort(np.argsort(qb, axis=1), axis=1), want),
        ])
    return out / len(runs)


for gamma in (0.0, GAMMA):
    res = evaluate(gamma)
    print(f"DFE gamma={gamma}")
    for name, a in zip(labels, res):
        print(f"  {name:28s} acierto de nibble {a:.2f}  (de 4 bits)")
