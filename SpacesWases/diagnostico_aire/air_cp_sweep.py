"""Precision de nibble por aire segun el largo del prefijo ciclico (sin cambiar el volumen)."""
import sys

sys.path.insert(0, r"C:\t\repo\mi_version")

import numpy as np
import sounddevice as sd

from spacewases import modem

FS = modem.FS
OUT, INP = 4, 1
GAIN = 0.5
REPS = 12
rng = np.random.default_rng(55)

print("prefijo  periodo(ms)  tasa_bruta(bps)  acierto_alto  acierto_bajo  acierto_byte")
for cp in (0, 256, 512, 1024, 2048, 4096):
    ok_h = ok_l = ok_b = tot = 0
    for _ in range(2):
        highs = np.repeat(np.arange(16), REPS)
        lows = np.repeat(np.arange(16), REPS)
        rng.shuffle(highs)
        rng.shuffle(lows)
        data = bytes(((h << 4) | l) for h, l in zip(highs, lows))
        sig = modem.modulate(data, cp)
        pad = np.zeros(FS, dtype=np.float32)
        x = np.concatenate([pad, sig * GAIN, pad]).astype(np.float32)
        y = sd.playrec(x.reshape(-1, 1), samplerate=FS, channels=1, device=(INP, OUT), dtype="float32")
        sd.wait()
        got = modem.demodulate(y[:, 0], cp) or b""
        n = min(len(got), len(data))
        for i in range(n):
            ok_h += (got[i] >> 4) == (data[i] >> 4)
            ok_l += (got[i] & 15) == (data[i] & 15)
            ok_b += got[i] == data[i]
        tot += len(data)
    period = modem.SYMBOL + cp
    print(f"{cp:7d}  {1000 * period / FS:10.1f}  {8 * FS / period:14.0f}  {ok_h / tot:12.2f}  {ok_l / tot:12.2f}  {ok_b / tot:12.2f}", flush=True)
