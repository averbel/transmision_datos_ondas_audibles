"""Benchmark de tasa de exito frente a SNR para los tres perfiles."""

from __future__ import annotations

import sys

import numpy as np

from spacewases import PROFILES, receive, send
from spacewases.modem import FS

SEED = 20261028
SNRS = list(range(-26, 13, 2))
TRIALS = 100
MSG_LEN = 16


def add_awgn(signal: np.ndarray, snr_db: float, rng: np.random.Generator) -> np.ndarray:
    """Anade ruido blanco gaussiano con la SNR de potencia indicada."""
    power = float(np.mean(signal.astype(np.float64) ** 2))
    noise_power = power / (10.0 ** (snr_db / 10.0))
    noise = rng.normal(0.0, np.sqrt(noise_power), signal.shape)
    return (signal.astype(np.float64) + noise).astype(np.float32)


def main() -> None:
    rng = np.random.default_rng(SEED)
    print("profile,snr_db,trials,success")
    bps: dict[str, float] = {}

    for profile in PROFILES:
        sample = send(bytes(rng.integers(0, 256, MSG_LEN, dtype=np.uint8)), None, profile)
        duration = len(sample) / FS
        bps[profile] = MSG_LEN * 8 / duration
        for snr in SNRS:
            ok = 0
            for _ in range(TRIALS):
                msg = bytes(rng.integers(0, 256, MSG_LEN, dtype=np.uint8))
                sig = send(msg, None, profile)
                noisy = add_awgn(sig, snr, rng)
                if receive(noisy, None) == msg:
                    ok += 1
            print(f"{profile},{snr},{TRIALS},{ok}")

    # Segunda tabla por stderr para que stdout siga siendo un CSV valido.
    print("profile,bps_netos", file=sys.stderr)
    for profile, value in bps.items():
        print(f"{profile},{value:.3f}", file=sys.stderr)


if __name__ == "__main__":
    main()
