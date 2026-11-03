"""Prueba por aire de spacewaves: altavoz -> aire -> microfono, con el volumen del sistema fijo.

Uso: python prueba_aire.py SALIDA ENTRADA ENSAYOS [GANANCIAS] > aire.csv
El volumen del sistema y la distancia los fija quien ejecuta; aqui solo se
varia la ganancia digital, que cambia la SNR acustica medida en cada ensayo.
"""

from __future__ import annotations

import sys

import numpy as np
import sounddevice as sd

from spacewaves import PROFILES, receive, send
from spacewaves.modem import FS

OUT, INP, TRIALS = int(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3])
GAINS = [float(g) for g in sys.argv[4].split(",")] if len(sys.argv) > 4 else [1.0, 0.5, 0.25, 0.12, 0.06, 0.03]
MSG_LEN = 16
rng = np.random.default_rng(20261029)


def play_rec(sig: np.ndarray, gain: float) -> np.ndarray:
    pad = np.zeros(FS, dtype=np.float32)
    x = np.concatenate([pad, sig * gain, pad]).astype(np.float32)
    y = sd.playrec(x.reshape(-1, 1), samplerate=FS, channels=1, device=(INP, OUT), dtype="float32")
    sd.wait()
    return y[:, 0]


def noise_power() -> float:
    n = sd.rec(int(1.5 * FS), samplerate=FS, channels=1, device=INP, dtype="float32")
    sd.wait()
    return float(np.mean(n.astype(np.float64) ** 2))


def acoustic_snr_db(y: np.ndarray, width: int, pn: float) -> float:
    """SNR del tramo mas energetico de la captura frente al ruido medido justo antes."""
    e = np.cumsum(np.concatenate([[0.0], y.astype(np.float64) ** 2]))
    ps = float(((e[width:] - e[:-width]) / width).max())
    return 10.0 * np.log10(max(ps - pn, 1e-14) / max(pn, 1e-14))


print("profile,gain,trial,snr_db,ok,peak")
for profile in PROFILES:
    for gain in GAINS:
        for t in range(TRIALS):
            msg = bytes(rng.integers(0, 256, MSG_LEN, dtype=np.uint8))
            sig = send(msg, None, profile)
            pn = noise_power()
            y = play_rec(sig, gain)
            ok = int(receive(y, None) == msg)
            snr = acoustic_snr_db(y, len(sig), pn)
            print(f"{profile},{gain},{t + 1},{snr:.1f},{ok},{float(np.max(np.abs(y))):.3f}", flush=True)
