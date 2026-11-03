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

# Tramas de 1024 muestras por simbolo. Medido por aire en un equipo y sala con 3 bytes
# por simbolo (Space Waves/diagnostico_aire/air_tonos.py): 6 tramas ~0,86 de acierto de
# byte, 3 tramas ~0,80. normal y fast usan el mismo simbolo; normal lleva mas paridad (corrige
# hasta 16 de 90 bytes) y fast menos (10 de 78), a cambio de bloques mas cortos.
FRAMES: dict[str, int] = {
    "robust": 6,
    "normal": 3,
    "fast": 3,
}

_PROFILE_ORDER = [PROFILES["robust"], PROFILES["normal"], PROFILES["fast"]]
_RECEIVE_ORDER = ["robust", "normal", "fast"]

# Desplazamientos (muestras) de la ventana de analisis que se prueban si la
# posicion estimada por el chirp no decodifica. Los negativos caen dentro de la
# trama de guarda; el positivo cubre un chirp detectado antes de tiempo.
ALIGN_OFFSETS = (0, -256, -512, 256)


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
            guard: frame.ReplayGuard | None = None,
            offsets: tuple[int, ...] = ALIGN_OFFSETS) -> bytes | None:
    """Demodula y valida la senal; devuelve el mensaje o None.

    Como cada perfil usa un largo de simbolo distinto, prueba a demodular con
    cada uno, y para cada perfil prueba los desplazamientos de offsets hasta
    que Reed-Solomon y la etiqueta acepten un mensaje. Pasa un frame.ReplayGuard (compartido entre llamadas) para
    rechazar repeticiones y mensajes viejos; sin el, no hay proteccion contra
    repeticion.

    Si un fin de datos falso corto el mensaje, repite sin el: el bloque de longitud
    ya delimita los fragmentos.
    """
    sync = modem.synchronize(signal)
    if sync is None:
        return None
    s, data_start, data_end = sync
    for end in dict.fromkeys((data_end, len(s))):
        for name in _RECEIVE_ORDER:
            for offset in offsets:
                raw = modem.demodulate_synced((s, data_start, end), frames=FRAMES[name], offset=offset)
                result = frame.decode_stream(raw, key, [PROFILES[name]], guard)
                if result is not None:
                    return result
    return None
