"""Simbolos largos con integracion de varias tramas, como ggwave (por aire, sin cambiar el volumen).

Simbolo de N tramas de 1024 muestras (modulate con cp=(N-1)*1024: el tono es
periodico en 1024, asi que el simbolo es N tramas identicas). Receptores:
  ultima: solo la ultima trama (lo que hacia el barrido de prefijo)
  suma:   suma coherente de las tramas 1..N-1 (descarta la primera, donde
          esta la cola del simbolo anterior)
  suma+dfe: lo anterior con DFE gamma=0.4
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
S = modem.SYMBOL
rng = np.random.default_rng(123)


def scores_from(blocks):
    blocks = blocks - blocks.mean(axis=1, keepdims=True)
    spec = np.abs(np.fft.rfft(blocks, axis=1)) ** 2
    return modem._tone_scores(spec, modem.GROUP_A), modem._tone_scores(spec, modem.GROUP_B)


def dfe(p, g):
    q = p.copy()
    q[1:] = p[1:] - g * p[:-1]
    return q


print("tramas  ms/simbolo  bps_brutos   ultima   suma   suma+dfe   (acierto de byte)")
for nframes in (1, 2, 3, 6):
    cp = (nframes - 1) * S
    period = cp + S
    acc = {"ultima": [], "suma": [], "suma+dfe": []}
    for _ in range(2):
        highs = rng.permutation(np.repeat(np.arange(16), REPS))
        lows = rng.permutation(np.repeat(np.arange(16), REPS))
        data = bytes(((h << 4) | l) for h, l in zip(highs, lows))
        sig = modem.modulate(data, cp)
        pad = np.zeros(FS, dtype=np.float32)
        x = np.concatenate([pad, sig * GAIN, pad]).astype(np.float32)
        y = sd.playrec(x.reshape(-1, 1), samplerate=FS, channels=1, device=(INP, OUT), dtype="float32")
        sd.wait()
        y = y[:, 0].astype(np.float64)
        start, _ = modem._find_chirp(y)
        base = start + modem.CHIRP_LEN + modem.GUARD + np.arange(len(data)) * period
        last = y[(base + cp)[:, None] + np.arange(S)[None, :]]
        first = 1 if nframes > 1 else 0
        summed = sum(y[(base + f * S)[:, None] + np.arange(S)[None, :]] for f in range(first, nframes))
        for name, blocks, g in (("ultima", last, 0.0), ("suma", summed, 0.0), ("suma+dfe", summed, 0.4)):
            pa, pb = scores_from(blocks)
            hi = np.argmax(dfe(pa, g), axis=1)
            lo = np.argmax(dfe(pb, g), axis=1)
            acc[name].append(float(((hi == highs) & (lo == lows)).mean()))
    print(f"{nframes:6d}  {1000 * period / FS:10.1f}  {8 * FS / period:9.0f}   "
          f"{np.mean(acc['ultima']):6.2f}  {np.mean(acc['suma']):5.2f}  {np.mean(acc['suma+dfe']):8.2f}", flush=True)
