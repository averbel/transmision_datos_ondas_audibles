"""Precision por indice de tono por aire (sin cambiar el volumen).

Transmite todos los valores de nibble repetidos y mide, para cada indice de
tono 0-15, que fraccion se recibe bien y que se recibe cuando falla.
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
rng = np.random.default_rng(5)

hi_total = np.zeros(16)
hi_ok = np.zeros(16)
lo_total = np.zeros(16)
lo_ok = np.zeros(16)
wrong_hi = []
wrong_lo = []
for trial in range(3):
    # cada byte: nibble alto y bajo independientes; todos los valores aparecen REPS veces
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
    got = modem.demodulate(y[:, 0]) or b""
    n = min(len(got), len(data))
    for i in range(n):
        eh, el = data[i] >> 4, data[i] & 15
        gh, gl = got[i] >> 4, got[i] & 15
        hi_total[eh] += 1
        lo_total[el] += 1
        if gh == eh:
            hi_ok[eh] += 1
        else:
            wrong_hi.append(gh)
        if gl == el:
            lo_ok[el] += 1
        else:
            wrong_lo.append(gl)
    print(f"ensayo {trial + 1}: bytes recibidos {len(got)}/{len(data)} pico={np.abs(y).max():.3f}", flush=True)

print("indice  tono_A(Hz)  acierto_alto   tono_B(Hz)  acierto_bajo")
for k in range(16):
    fa = modem.GROUP_A[k] * modem.BIN_HZ
    fb = modem.GROUP_B[k] * modem.BIN_HZ
    print(f"{k:5d}  {fa:9.0f}  {hi_ok[k] / max(hi_total[k], 1):11.2f}   {fb:9.0f}  {lo_ok[k] / max(lo_total[k], 1):11.2f}")
print("cuando falla, indice recibido (alto):", np.bincount(wrong_hi, minlength=16).tolist())
print("cuando falla, indice recibido (bajo):", np.bincount(wrong_lo, minlength=16).tolist())
