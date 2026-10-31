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


def send(msg: bytes, key: bytes | None = None, profile: str = "normal",
         repeat: int = 1) -> np.ndarray:
    """Genera la senal acustica que transporta msg con el perfil indicado.

    repeat > 1 envia el mensaje varias veces seguidas para tolerar bloques
    danados (cuesta repeat veces el tiempo de aire).
    """
    if profile not in PROFILES:
        raise ValueError("perfil desconocido: %s" % profile)
    profile_id, chunk, parity = PROFILES[profile]
    raw = frame.pack_message(bytes(msg), key, profile_id, chunk, parity,
                             repeat=repeat)
    return modem.modulate(raw)


def receive(signal, key: bytes | None = None,
            guard: frame.ReplayGuard | None = None) -> bytes | None:
    """Demodula y valida la senal; devuelve el mensaje o None.

    Pasa un frame.ReplayGuard (compartido entre llamadas) para rechazar
    repeticiones y mensajes viejos; sin el, no hay proteccion contra repeticion.
    """
    raw = modem.demodulate(signal)
    if raw is None:
        return None
    return frame.decode_stream(raw, key, _PROFILE_ORDER, guard)
