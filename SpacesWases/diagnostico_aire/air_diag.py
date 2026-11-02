"""Diagnostico por aire: rutas de audio, respuesta en frecuencia y errores de byte.

No cambia el volumen. Uso: python air_diag.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np
import sounddevice as sd

from spacewases import api, frame, modem

FS = modem.FS
ROUTES = [
    ("MME", 4, 1),
    ("DirectSound", 10, 7),
    ("WASAPI", 13, 15),
]
GAIN = 0.5
TRIALS = 3
profile_id, chunk, parity = api.PROFILES["robust"]
rng = np.random.default_rng(4242)


def play_rec(sig, out, inp):
    pad = np.zeros(FS, dtype=np.float32)
    x = np.concatenate([pad, sig * GAIN, pad]).astype(np.float32)
    y = sd.playrec(x.reshape(-1, 1), samplerate=FS, channels=1,
                   device=(inp, out), dtype="float32")
    sd.wait()
    return x[:, 0] if x.ndim > 1 else x, y[:, 0]


def sweep(seconds=2.0, f0=500.0, f1=8000.0):
    t = np.arange(int(seconds * FS)) / FS
    k = np.log(f1 / f0) / seconds
    phase = 2 * np.pi * f0 * (np.exp(k * t) - 1) / k
    env = np.minimum(1.0, np.minimum(t, seconds - t) / 0.05)
    return (0.5 * np.sin(phase) * env).astype(np.float32)


def band_response(x, y, edges):
    n = 1 << int(np.ceil(np.log2(len(x))))
    fx = np.abs(np.fft.rfft(x, n)) ** 2
    fy = np.abs(np.fft.rfft(y, n)) ** 2
    f = np.fft.rfftfreq(n, 1 / FS)
    out = []
    for lo, hi in zip(edges[:-1], edges[1:]):
        m = (f >= lo) & (f < hi)
        out.append(10 * np.log10((fy[m].sum() + 1e-18) / (fx[m].sum() + 1e-18)))
    return out


edges = [500, 1000, 1500, 2000, 3000, 4000, 5000, 6000, 8000]
print("bandas Hz:", edges)
for name, out, inp in ROUTES:
    print(f"--- {name} salida={out} entrada={inp} ---", flush=True)
    try:
        sw = sweep()
        x, y = play_rec(sw, out, inp)
        resp = band_response(x, y, edges)
        rel = [r - max(resp) for r in resp]
        print("respuesta relativa dB:", " ".join(f"{r:6.1f}" for r in rel), flush=True)
        print(f"pico captura barrido: {np.abs(y).max():.3f}", flush=True)
        for t in range(TRIALS):
            msg = bytes(rng.integers(0, 256, 16, dtype=np.uint8))
            raw = frame.pack_message(msg, None, profile_id, chunk, parity)
            _, y = play_rec(modem.modulate(raw), out, inp)
            found = modem._find_chirp(y.astype(np.float64))
            score = found[1] if found else 0.0
            got = modem.demodulate(y) or b""
            n = min(len(got), len(raw))
            bad = sum(a != b for a, b in zip(got[:n], raw[:n])) + abs(len(raw) - len(got))
            ok = frame.decode_stream(got, None, [api.PROFILES["robust"]]) == msg
            print(f"  ensayo {t + 1}: sync={score:.2f} bytes_mal={bad}/{len(raw)} ok={int(ok)} pico={np.abs(y).max():.3f}", flush=True)
    except Exception as exc:
        print(f"  ruta no disponible: {exc}", flush=True)
