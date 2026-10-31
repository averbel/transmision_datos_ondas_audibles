"""Patron de error por aire: posicion de los bytes malos y deriva de reloj. Sin cambiar el volumen."""
import sys

sys.path.insert(0, r"C:\t\repo\mi_version")

import numpy as np
import sounddevice as sd

from spacewases import api, frame, modem

FS = modem.FS
OUT, INP = 4, 1
GAIN = 0.5
profile_id, chunk, parity = api.PROFILES["robust"]
rng = np.random.default_rng(99)

for t in range(4):
    msg = bytes(rng.integers(0, 256, 16, dtype=np.uint8))
    raw = frame.pack_message(msg, None, profile_id, chunk, parity)
    sig = modem.modulate(raw)
    pad = np.zeros(FS, dtype=np.float32)
    x = np.concatenate([pad, sig * GAIN, pad]).astype(np.float32)
    y = sd.playrec(x.reshape(-1, 1), samplerate=FS, channels=1, device=(INP, OUT), dtype="float32")
    sd.wait()
    y = y[:, 0].astype(np.float64)

    start = modem._find_chirp(y)
    end = modem._find_chirp(y[start[0]:], reverse=True)
    observed = end[0]
    expected = len(sig) - modem.CHIRP_LEN
    drift = observed - expected

    got = modem.demodulate(y) or b""
    n = min(len(got), len(raw))
    bad = [i for i in range(n) if got[i] != raw[i]]
    sym = modem.SYMBOL + modem.CYCLIC_PREFIX
    hist = np.histogram(bad, bins=6, range=(0, len(raw)))[0] if bad else np.zeros(6, int)
    hi_ok = sum((got[i] >> 4) == (raw[i] >> 4) for i in range(n))
    lo_ok = sum((got[i] & 15) == (raw[i] & 15) for i in range(n))
    print(f"ensayo {t + 1}: sync_ini={start[1]:.2f} sync_fin={end[1]:.2f} "
          f"deriva={drift:+d} muestras en {expected} ({1e6 * drift / expected:+.0f} ppm) "
          f"bytes_malos_por_sexto={hist.tolist()} nibble_alto_ok={hi_ok}/{n} nibble_bajo_ok={lo_ok}/{n} len_rx={len(got)}/{len(raw)}", flush=True)
