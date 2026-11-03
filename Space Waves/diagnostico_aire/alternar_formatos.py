"""Compara dos formatos de senal por aire turnando sus mensajes en la misma sesion.

Dos series grabadas una tras otra pueden diferir por el ruido o el volumen de cada momento;
al alternar mensajes, esas condiciones afectan igual a los dos formatos.
Primero se genera cada formato con su propia copia del codigo:
  python alternar_formatos.py generar RUTA_CODIGO CARPETA
Despues se reproducen turnandose; escribe capturas y manifiesto en cada carpeta:
  python alternar_formatos.py sonar SALIDA ENTRADA CARPETA_A CARPETA_B
"""
import sys
from pathlib import Path

import numpy as np

PROFILES = ("robust", "normal", "fast")
GAINS = (0.12, 0.06, 0.03)
TRIALS = 5
MSG_LEN = 16


def name(profile, gain, trial):
    return f"{profile}_{gain}_{trial}"


def generate(code, folder):
    sys.path.insert(0, code)
    from spacewaves import send

    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(20261104)
    for profile in PROFILES:
        for gain in GAINS:
            for trial in range(1, TRIALS + 1):
                msg = bytes(rng.integers(0, 256, MSG_LEN, dtype=np.uint8))
                stem = name(profile, gain, trial)
                send(msg, None, profile).astype(np.float32).tofile(folder / f"{stem}.senal")
                (folder / f"{stem}.hex").write_text(msg.hex())


def play(out, inp, folders):
    import sounddevice as sd

    fs = 48000
    pad = np.zeros(fs, dtype=np.float32)
    folders = [Path(f) for f in folders]
    manifests = [open(f / "manifiesto.csv", "w", encoding="utf-8") for f in folders]
    for manifest in manifests:
        manifest.write("archivo,perfil,ganancia,ensayo,mensaje_hex,pico\n")
    turn = 0
    for profile in PROFILES:
        for gain in GAINS:
            for trial in range(1, TRIALS + 1):
                stem = name(profile, gain, trial)
                # Cambia quien va primero en cada ensayo para no favorecer a ninguno.
                for f in (0, 1) if turn % 2 == 0 else (1, 0):
                    signal = np.fromfile(folders[f] / f"{stem}.senal", dtype=np.float32)
                    x = np.concatenate([pad, signal * gain, pad])
                    y = sd.playrec(x.reshape(-1, 1), samplerate=fs, channels=1, device=(inp, out), dtype="float32")
                    sd.wait()
                    y[:, 0].astype(np.float32).tofile(folders[f] / f"{stem}.f32")
                    hex_msg = (folders[f] / f"{stem}.hex").read_text()
                    manifests[f].write(f"{stem}.f32,{profile},{gain},{trial},{hex_msg},{float(np.abs(y).max()):.4f}\n")
                    manifests[f].flush()
                turn += 1


if sys.argv[1] == "generar":
    generate(sys.argv[2], sys.argv[3])
else:
    play(int(sys.argv[2]), int(sys.argv[3]), sys.argv[4:6])
