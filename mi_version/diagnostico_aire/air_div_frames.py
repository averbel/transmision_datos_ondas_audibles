"""Diversidad + simbolos de varias tramas, sin DFE (por aire, sin cambiar el volumen).

Cada simbolo lleva un nibble en los dos grupos de tonos (A y B, mismo indice) y
dura N tramas de 1024 muestras; el receptor suma las tramas 1..N-1 y combina A+B.
Un byte son dos simbolos. Rutas y dispositivos para el PC de la sesion del
2026-10-31; ver LEEME.md.
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
S = modem.SYMBOL
rng = np.random.default_rng(202)
TA = {}
TB = {}

print("tramas  ms/simbolo  bps_brutos  acierto_nibble  acierto_byte(estimado)")
for nframes in (1, 2, 3):
    cp = (nframes - 1) * S
    period = cp + S
    ta = modem._tone_matrix(modem.GROUP_A, cp)
    tb = modem._tone_matrix(modem.GROUP_B, cp)
    env = modem._envelope(period)
    accs = []
    for _ in range(2):
        vals = rng.permutation(np.repeat(np.arange(16), REPS))
        body = ((ta[:, vals] + tb[:, vals]).T * env).reshape(-1)
        chirp = modem._chirp()
        guard = np.zeros(modem.GUARD)
        sig = np.concatenate([chirp, guard, body, guard, chirp[::-1]]).astype(np.float32)
        pad = np.zeros(FS, dtype=np.float32)
        x = np.concatenate([pad, sig * GAIN, pad]).astype(np.float32)
        y = sd.playrec(x.reshape(-1, 1), samplerate=FS, channels=1, device=(INP, OUT), dtype="float32")
        sd.wait()
        y = y[:, 0].astype(np.float64)
        start, _ = modem._find_chirp(y)
        base = start + modem.CHIRP_LEN + modem.GUARD + np.arange(len(vals)) * period
        first = 1 if nframes > 1 else 0
        blocks = sum(y[(base + f * S)[:, None] + np.arange(S)[None, :]] for f in range(first, nframes))
        blocks = blocks - blocks.mean(axis=1, keepdims=True)
        spec = np.abs(np.fft.rfft(blocks, axis=1)) ** 2
        pa = modem._tone_scores(spec, modem.GROUP_A)
        pb = modem._tone_scores(spec, modem.GROUP_B)
        score = pa / pa.sum(1, keepdims=True) + pb / pb.sum(1, keepdims=True)
        accs.append(float((np.argmax(score, 1) == vals).mean()))
    a = float(np.mean(accs))
    print(f"{nframes:6d}  {1000 * period / FS:10.1f}  {4 * FS / period:10.0f}  {a:14.2f}  {a * a:22.2f}", flush=True)
