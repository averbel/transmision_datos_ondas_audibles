"""Barrido del desplazamiento de la ventana de analisis sobre capturas reales por aire.

Si la precision depende mucho del desplazamiento, el problema es de sincronia
temporal; si los errores copian al simbolo vecino, es interferencia entre simbolos.
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
rng = np.random.default_rng(21)
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
    return data, y[:, 0].astype(np.float64)


def decode_at(y, start, nsym, offset):
    data_start = start + modem.CHIRP_LEN + modem.GUARD
    idx = data_start + modem.CYCLIC_PREFIX + offset + np.arange(nsym) * period
    idx = idx[(idx >= 0) & (idx + modem.SYMBOL <= len(y))]
    blocks = y[idx[:, None] + np.arange(modem.SYMBOL)[None, :]]
    blocks = blocks - blocks.mean(axis=1, keepdims=True)
    spec = np.abs(np.fft.rfft(blocks, axis=1)) ** 2
    hi = np.argmax(modem._tone_scores(spec, modem.GROUP_A), axis=1)
    lo = np.argmax(modem._tone_scores(spec, modem.GROUP_B), axis=1)
    return hi, lo


caps = []
for i in range(2):
    data, y = capture()
    start, score = modem._find_chirp(y)
    caps.append((data, y, start))
    print(f"captura {i + 1}: inicio del chirp en muestra {start} sync={score:.2f}", flush=True)

offsets = [-512, -384, -256, -192, -128, -64, -32, 0, 32, 64, 128, 192, 256, 384, 512]
print("desplaz  acierto_alto  acierto_bajo   (promedio de 2 capturas, 192 simbolos cada una)")
best = None
for off in offsets:
    ok_h = ok_l = tot = 0
    for data, y, start in caps:
        hi, lo = decode_at(y, start, len(data), off)
        n = min(len(hi), len(data))
        want_h = np.array([b >> 4 for b in data[:n]])
        want_l = np.array([b & 15 for b in data[:n]])
        ok_h += int((hi[:n] == want_h).sum())
        ok_l += int((lo[:n] == want_l).sum())
        tot += n
    print(f"{off:7d}  {ok_h / tot:12.2f}  {ok_l / tot:12.2f}")
    if best is None or ok_h + ok_l > best[1]:
        best = (off, ok_h + ok_l)
print("mejor desplazamiento:", best[0])

# errores que copian al simbolo vecino (con desplazamiento 0)
same_prev = same_next = wrong = 0
for data, y, start in caps:
    hi, lo = decode_at(y, start, len(data), 0)
    want = [b >> 4 for b in data]
    for i in range(1, min(len(hi), len(want)) - 1):
        if hi[i] != want[i]:
            wrong += 1
            same_prev += int(hi[i] == want[i - 1])
            same_next += int(hi[i] == want[i + 1])
print(f"errores del nibble alto: {wrong}; copian al simbolo anterior {same_prev}, al siguiente {same_next} "
      f"(azar esperado: ~{wrong / 15:.0f} cada uno)")
