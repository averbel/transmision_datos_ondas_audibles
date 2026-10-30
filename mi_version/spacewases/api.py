"""API de alto nivel: send y receive con perfiles de robustez."""

from __future__ import annotations

import numpy as np

from . import frame, modem

PROFILES: dict[str, tuple[int, int, int]] = {
    "robust": (0, 48, 20),
    "normal": (1, 48, 10),
    "fast": (2, 48, 6),
}

_PROFILE_ORDER = [PROFILES["robust"], PROFILES["normal"], PROFILES["fast"]]


def send(msg: bytes, key: bytes | None = None, profile: str = "normal") -> np.ndarray:
    """Genera la senal acustica que transporta msg con el perfil indicado."""
    if profile not in PROFILES:
        raise ValueError("perfil desconocido: %s" % profile)
    profile_id, chunk, parity = PROFILES[profile]
    raw = frame.pack_message(bytes(msg), key, profile_id, chunk, parity)
    return modem.modulate(raw)


def receive(signal, key: bytes | None = None) -> bytes | None:
    """Demodula y valida la senal; devuelve el mensaje o None."""
    raw = modem.demodulate(signal)
    if raw is None:
        return None
    return frame.decode_stream(raw, key, _PROFILE_ORDER)
