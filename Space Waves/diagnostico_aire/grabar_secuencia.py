"""Graba por aire tres mensajes seguidos (fast, normal, robust) para probar el receptor en flujo.

Guarda la captura como float32 crudo a 48 kHz. Uso:
python grabar_secuencia.py SALIDA ENTRADA GANANCIA archivo.f32
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np
import sounddevice as sd

from spacewaves import send
from spacewaves.modem import FS

OUT, INP, GAIN, PATH = int(sys.argv[1]), int(sys.argv[2]), float(sys.argv[3]), sys.argv[4]
MESSAGES = [(b"hola fast", "fast"), (b"mensaje normal", "normal"), (b"robusto por aire", "robust")]

parts = [np.zeros(FS, dtype=np.float32)]
for text, profile in MESSAGES:
    parts += [send(text, None, profile) * GAIN, np.zeros(2 * FS, dtype=np.float32)]
x = np.concatenate(parts).astype(np.float32)
print(f"emitiendo {len(x) / FS:.1f} s", flush=True)
y = sd.playrec(x.reshape(-1, 1), samplerate=FS, channels=1, device=(INP, OUT), dtype="float32")
sd.wait()
y[:, 0].astype(np.float32).tofile(PATH)
print(f"guardado {PATH}, pico {np.abs(y).max():.3f}")
