"""Graba por aire una serie de mensajes para comparar receptores sobre el mismo audio.

Guarda cada captura como float32 crudo a 48 kHz y un manifiesto CSV; no decodifica.
Uso: python grabar_serie.py SALIDA ENTRADA ENSAYOS CARPETA
El volumen del sistema lo fija quien ejecuta; aqui solo cambia la ganancia digital.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np
import sounddevice as sd

from spacewases import PROFILES, send
from spacewases.modem import FS

OUT, INP, TRIALS, FOLDER = int(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3]), Path(sys.argv[4])
GAINS = [1.0, 0.5, 0.25, 0.12, 0.06, 0.03]
MSG_LEN = 16

FOLDER.mkdir(parents=True, exist_ok=True)
rng = np.random.default_rng(20261101)
pad = np.zeros(FS, dtype=np.float32)
with open(FOLDER / "manifiesto.csv", "w", encoding="utf-8") as manifest:
    manifest.write("archivo,perfil,ganancia,ensayo,mensaje_hex,pico\n")
    for profile in PROFILES:
        for gain in GAINS:
            for trial in range(1, TRIALS + 1):
                msg = bytes(rng.integers(0, 256, MSG_LEN, dtype=np.uint8))
                x = np.concatenate([pad, send(msg, None, profile) * gain, pad]).astype(np.float32)
                y = sd.playrec(x.reshape(-1, 1), samplerate=FS, channels=1, device=(INP, OUT), dtype="float32")
                sd.wait()
                name = f"{profile}_{gain}_{trial}.f32"
                y[:, 0].astype(np.float32).tofile(FOLDER / name)
                manifest.write(f"{name},{profile},{gain},{trial},{msg.hex()},{float(np.abs(y).max()):.4f}\n")
                manifest.flush()
                print(name, flush=True)
