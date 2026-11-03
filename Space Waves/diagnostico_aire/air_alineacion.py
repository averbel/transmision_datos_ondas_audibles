"""Por aire: exito de decodificacion con y sin busqueda de alineacion, sobre las mismas grabaciones.

Uso: python air_alineacion.py SALIDA ENTRADA ENSAYOS
No cambia el volumen; varia la ganancia digital como prueba_aire.py.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np
import sounddevice as sd

from spacewaves import api, send
from spacewaves.modem import FS

OUT, INP, TRIALS = int(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3])
GAINS = [1.0, 0.5, 0.25]
rng = np.random.default_rng(20261031)

print("profile,gain,trial,ok_sin_busqueda,ok_con_busqueda")
for profile in api.PROFILES:
    for gain in GAINS:
        for t in range(TRIALS):
            msg = bytes(rng.integers(0, 256, 16, dtype=np.uint8))
            pad = np.zeros(FS, dtype=np.float32)
            x = np.concatenate([pad, send(msg, None, profile) * gain, pad]).astype(np.float32)
            y = sd.playrec(x.reshape(-1, 1), samplerate=FS, channels=1, device=(INP, OUT), dtype="float32")
            sd.wait()
            y = y[:, 0]
            plain = int(api.receive(y, None, offsets=(0,)) == msg)
            search = int(api.receive(y, None) == msg)
            print(f"{profile},{gain},{t + 1},{plain},{search}", flush=True)
