"""API de alto nivel: send y receive con perfiles de robustez."""

from __future__ import annotations

import numpy as np

from . import frame, modem

# (id, chunk, paridad RS) de la capa de trama.
PROFILES: dict[str, tuple[int, int, int]] = {
    "robust": (0, 48, 20),
    "normal": (1, 48, 32),
    "fast": (2, 48, 20),
}

# Tramas de 1024 muestras por simbolo. Medido por aire en un equipo y sala
# (mi_version/diagnostico_aire): 6 tramas ~0,94 de acierto de byte, 3 tramas
# ~0,86. normal y fast usan el mismo simbolo; normal lleva mas paridad (corrige
# hasta 16 de 90 bytes) y fast menos (10 de 78), a cambio de bloques mas cortos.
FRAMES: dict[str, int] = {
    "robust": 6,
    "normal": 3,
    "fast": 3,
}

_PROFILE_ORDER = [PROFILES["robust"], PROFILES["normal"], PROFILES["fast"]]
_RECEIVE_ORDER = ["robust", "normal", "fast"]


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
    return modem.modulate(raw, frames=FRAMES[profile])


def receive(signal, key: bytes | None = None,
            guard: frame.ReplayGuard | None = None) -> bytes | None:
    """Demodula y valida la senal; devuelve el mensaje o None.

    Como cada perfil usa un largo de simbolo distinto, prueba a demodular con
    cada uno. Pasa un frame.ReplayGuard (compartido entre llamadas) para
    rechazar repeticiones y mensajes viejos; sin el, no hay proteccion contra
    repeticion.
    """
    for name in _RECEIVE_ORDER:
        raw = modem.demodulate(signal, frames=FRAMES[name])
        if raw is None:
            return None
        result = frame.decode_stream(raw, key, [PROFILES[name]], guard)
        if result is not None:
            return result
    return None
