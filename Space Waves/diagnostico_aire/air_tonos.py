"""Acierto por aire segun los tonos por simbolo: 1, 2 o 3 bytes por simbolo.

Compara el diseno actual con mas tonos simultaneos, juntos en la banda (como ggwave)
o repartidos por toda ella. No usa Reed-Solomon: mide el acierto antes de corregir.
Uso: python air_tonos.py SALIDA ENTRADA ENSAYOS > tonos.csv
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np
import sounddevice as sd

from spacewaves.modem import CHIRP_LEN, FS, GUARD, SYMBOL, _chirp, _envelope, _find_chirp

OUT, INP, TRIALS = int(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3])
SYMBOLS = 50
PEAK = 0.96  # Suma de amplitudes de los tonos: nunca satura.


def groups(offsets, step=6):
    return [[40 + g + step * k for k in range(16)] for g in offsets]


# nombre: (grupos de tonos, amplitud por tono, bins vecinos sumados al puntuar)
LAYOUTS = {
    "actual_1B": (groups((0, 3)), 0.36, 1),
    "repartido_2B": (groups((0, 2, 3, 5)), PEAK / 4, 0),
    "repartido_3B": (groups(range(6)), PEAK / 6, 0),
    "juntos_3B": ([[40 + 16 * g + k for k in range(16)] for g in range(6)], PEAK / 6, 0),
}


def modulate(nibbles, bins, amp, frames):
    period = frames * SYMBOL
    n = np.arange(-SYMBOL, period - SYMBOL)
    env = _envelope(period)
    body = np.zeros(len(nibbles) * period)
    for s, row in enumerate(nibbles):
        tone = sum(np.sin(2 * np.pi * n * group[v] / SYMBOL) for group, v in zip(bins, row))
        body[s * period:(s + 1) * period] = amp * tone * env
    guard = np.zeros(GUARD)
    return np.concatenate([_chirp(), guard, body, guard, _chirp()[::-1]])


def demodulate(y, count, bins, wide, frames):
    found = _find_chirp(y)
    start = found[0] + CHIRP_LEN + GUARD
    period = frames * SYMBOL
    out = np.zeros((count, len(bins)), dtype=int)
    for s in range(count):
        base = start + s * period + SYMBOL
        block = sum(y[base + f * SYMBOL:base + (f + 1) * SYMBOL] for f in range(frames - 1))
        power = np.abs(np.fft.rfft(block - block.mean())) ** 2
        for g, group in enumerate(bins):
            out[s, g] = int(np.argmax([power[b - wide:b + wide + 1].sum() for b in group]))
    return out, found[1]


rng = np.random.default_rng(20261102)
pad = np.zeros(FS // 2)
print("disposicion,tramas,ganancia,ensayo,bytes_por_simbolo,acierto_nibble,acierto_byte,chirp,pico")
for name, (bins, amp, wide) in LAYOUTS.items():
    for frames in (3, 6):
        for gain in (1.0, 0.25):
            for trial in range(1, TRIALS + 1):
                sent = rng.integers(0, 16, (SYMBOLS, len(bins)))
                x = np.concatenate([pad, modulate(sent, bins, amp, frames) * gain, pad]).astype(np.float32)
                y = sd.playrec(x.reshape(-1, 1), samplerate=FS, channels=1, device=(INP, OUT), dtype="float32")
                sd.wait()
                y = y[:, 0].astype(np.float64)
                got, score = demodulate(y, SYMBOLS, bins, wide, frames)
                ok = got == sent
                pairs = ok[:, ::2] & ok[:, 1::2]
                print(f"{name},{frames},{gain},{trial},{len(bins) // 2},{ok.mean():.3f},{pairs.mean():.3f},"
                      f"{score:.3f},{float(np.abs(y).max()):.3f}", flush=True)
