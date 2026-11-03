"""Dos senales a la vez por aire, una en cada mitad de la banda.

Imita recibir mientras se emite: una senal fuerte en una mitad y otra debil en la otra,
por el mismo altavoz. Mide el acierto de la debil sola y junto a la fuerte, con un
desnivel de 0, 20 y 30 dB. Uso: python air_duplex.py SALIDA ENTRADA ENSAYOS > duplex.csv
No mide el camino altavoz-microfono de un mismo equipo, que puede saturar el microfono.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np
import sounddevice as sd

from spacewases.modem import CHIRP_LEN, FS, GUARD, SYMBOL, _chirp, _envelope, _find_chirp

OUT, INP, TRIALS = int(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3])
SYMBOLS, FRAMES = 40, 6
AMP = 0.16
LOW = [[40 + 16 * g + k for k in range(16)] for g in range(3)]
HIGH = [[88 + 16 * g + k for k in range(16)] for g in range(3)]


def data_signal(nibbles, bins):
    period = FRAMES * SYMBOL
    n = np.arange(-SYMBOL, period - SYMBOL)
    env = _envelope(period)
    body = np.zeros(len(nibbles) * period)
    for s, row in enumerate(nibbles):
        tone = sum(np.sin(2 * np.pi * n * group[v] / SYMBOL) for group, v in zip(bins, row))
        body[s * period:(s + 1) * period] = AMP * tone * env
    return body


def accuracy(y, start, sent, bins):
    period = FRAMES * SYMBOL
    hits = 0
    for s, row in enumerate(sent):
        base = start + s * period + SYMBOL
        block = sum(y[base + f * SYMBOL:base + (f + 1) * SYMBOL] for f in range(FRAMES - 1))
        power = np.abs(np.fft.rfft(block - block.mean())) ** 2
        hits += sum(int(np.argmax(power[group])) == v for group, v in zip(bins, row))
    return hits / (len(sent) * len(bins))


rng = np.random.default_rng(20261103)
pad = np.zeros(FS // 2)
print("caso,desnivel_db,ensayo,acierto_nibble_debil,acierto_nibble_fuerte,pico")
for level_db in (0, 20, 30):
    weak_gain = 10 ** (-level_db / 20)
    for case in ("sola", "junto"):
        for trial in range(1, TRIALS + 1):
            weak = rng.integers(0, 16, (SYMBOLS, 3))
            strong = rng.integers(0, 16, (SYMBOLS, 3))
            # El chirp solo marca el tiempo: va con el nivel de la senal debil en ambos casos.
            body = weak_gain * data_signal(weak, HIGH)
            if case == "junto":
                body = body + data_signal(strong, LOW)
            guard = np.zeros(GUARD)
            x = np.concatenate([pad, _chirp(), guard, body, guard, pad]).astype(np.float32)
            y = sd.playrec(x.reshape(-1, 1), samplerate=FS, channels=1, device=(INP, OUT), dtype="float32")
            sd.wait()
            y = y[:, 0].astype(np.float64)
            start = _find_chirp(y)[0] + CHIRP_LEN + GUARD
            acc_weak = accuracy(y, start, weak, HIGH)
            acc_strong = accuracy(y, start, strong, LOW) if case == "junto" else float("nan")
            print(f"{case},{level_db},{trial},{acc_weak:.3f},{acc_strong:.3f},{float(np.abs(y).max()):.3f}", flush=True)
