"""Capa fisica MFSK: dos tonos por simbolo (un byte), con chirps de sincronia.

La banda audible dispone de 96 bins de 46.875 Hz desde 1875 Hz. Se usan dos
grupos de 16 tonos separados 6 bins (grupo A en 40+6k, grupo B en 43+6k).
Cada simbolo transmite un nibble por grupo, es decir, un byte. La alternativa
de 6 tonos por simbolo (3 bytes) se descarta para mantener baja la interferencia
entre grupos.

Cada simbolo va precedido de un prefijo ciclico de CYCLIC_PREFIX muestras: como
cada tono completa un numero entero de ciclos en SYMBOL muestras, el prefijo es
la continuacion periodica del tono. El receptor analiza solo las SYMBOL muestras
posteriores, asi un eco de sala con retardo menor que el prefijo (unos 5 ms,
1.8 m de diferencia de camino) cae dentro del prefijo y no contamina el simbolo.
"""

from __future__ import annotations

from functools import lru_cache

import numpy as np

FS = 48000
SYMBOL = 1024
CYCLIC_PREFIX = 256
BIN_HZ = FS / SYMBOL
BASE_BIN = 40
N_TONES = 16
TONE_STEP = 6

GROUP_A = [BASE_BIN + TONE_STEP * k for k in range(N_TONES)]
GROUP_B = [BASE_BIN + 3 + TONE_STEP * k for k in range(N_TONES)]

CHIRP_MS = 150.0
CHIRP_LEN = int(FS * CHIRP_MS / 1000.0)
CHIRP_F0 = 1500.0
CHIRP_F1 = 6000.0
GUARD = 384
SYMBOL_RAMP = 64
TONE_AMP = 0.36
SYNC_THRESHOLD = 0.25

_CHIRP: np.ndarray | None = None


def _make_chirp() -> np.ndarray:
    n = CHIRP_LEN
    t = np.arange(n, dtype=np.float64) / FS
    duration = n / FS
    phase = 2.0 * np.pi * (CHIRP_F0 * t + (CHIRP_F1 - CHIRP_F0) * t * t / (2.0 * duration))
    chirp = np.sin(phase)
    ramp = int(0.01 * FS)
    env = np.ones(n)
    r = np.arange(ramp, dtype=np.float64) / max(ramp - 1, 1)
    edge = 0.5 * (1.0 - np.cos(np.pi * r))
    env[:ramp] = edge
    env[-ramp:] = edge[::-1]
    return chirp * env


def _chirp() -> np.ndarray:
    global _CHIRP
    if _CHIRP is None:
        _CHIRP = _make_chirp()
    return _CHIRP


def _envelope(n: int) -> np.ndarray:
    env = np.ones(n)
    ramp = min(SYMBOL_RAMP, n // 2)
    r = np.arange(ramp, dtype=np.float64) / max(ramp - 1, 1)
    edge = 0.5 * (1.0 - np.cos(np.pi * r))
    env[:ramp] = edge
    env[-ramp:] = edge[::-1]
    return env


def _as_bytes(data) -> bytes:
    if isinstance(data, (bytes, bytearray, memoryview)):
        return bytes(data)
    if isinstance(data, np.ndarray) and data.dtype == np.uint8:
        return data.tobytes()
    return bytes(int(v) for v in data)


def _tone_matrix(bins: list[int], cp: int) -> np.ndarray:
    """Tonos de cp + SYMBOL muestras; la fase del cuerpo arranca en la muestra cp."""
    n = np.arange(-cp, SYMBOL, dtype=np.float64)[:, None]
    freqs = np.asarray(bins, dtype=np.float64)[None, :]
    return TONE_AMP * np.sin(2.0 * np.pi * n * freqs / SYMBOL)


def modulate(data_in, cp: int = CYCLIC_PREFIX) -> np.ndarray:
    """Convierte bytes (o una secuencia de enteros 0-255) en una senal float32."""
    data = _as_bytes(data_in)
    symbols = np.frombuffer(data, dtype=np.uint8)
    high = symbols >> 4
    low = symbols & 0x0F

    if len(symbols):
        tones_a = _tone_matrix(GROUP_A, cp)
        tones_b = _tone_matrix(GROUP_B, cp)
        matrix = (tones_a[:, high] + tones_b[:, low]).T * _envelope(cp + SYMBOL)[None, :]
        body = matrix.reshape(-1)
    else:
        body = np.zeros(0, dtype=np.float64)

    chirp = _chirp()
    guard = np.zeros(GUARD, dtype=np.float64)
    out = np.concatenate([chirp, guard, body, guard, chirp[::-1]])
    return out.astype(np.float32)


@lru_cache(maxsize=8)
def _template_fft(reverse: bool, nfft: int) -> np.ndarray:
    template = _chirp()[::-1] if reverse else _chirp()
    return np.fft.rfft(template[::-1], nfft)


def _find_chirp(signal: np.ndarray, reverse: bool = False):
    template = _chirp()[::-1] if reverse else _chirp()
    n = len(signal)
    length = len(template)
    if n < length:
        return None
    nfft = 1 << (n + length - 2).bit_length()
    corr = np.fft.irfft(np.fft.rfft(signal, nfft) * _template_fft(reverse, nfft), nfft)
    corr = corr[length - 1:n]
    csum = np.concatenate(([0.0], np.cumsum(signal * signal)))
    energy = csum[length:] - csum[:-length]
    denom = np.sqrt(np.maximum(energy, 0.0) * float(np.dot(template, template))) + 1e-12
    score = np.abs(corr) / denom
    k = int(np.argmax(score))
    return k, float(score[k])


def _tone_scores(spec: np.ndarray, bins: list[int]) -> np.ndarray:
    out = np.zeros((spec.shape[0], len(bins)))
    for i, b in enumerate(bins):
        lo = max(b - 1, 0)
        hi = b + 2
        out[:, i] = spec[:, lo:hi].sum(axis=1)
    return out


def demodulate(signal, cp: int = CYCLIC_PREFIX) -> bytes | None:
    """Recupera los bytes de una senal; devuelve None si no hay sincronia."""
    s = np.asarray(signal, dtype=np.float64).ravel()
    if s.size == 0:
        return None
    chirp = _chirp()
    found = _find_chirp(s)
    if found is None:
        return None
    start, score = found
    if score < SYNC_THRESHOLD:
        return None

    period = cp + SYMBOL
    data_start = start + len(chirp) + GUARD
    if data_start >= len(s):
        return b""

    end_found = _find_chirp(s[data_start:], reverse=True)
    if end_found is not None and end_found[1] >= SYNC_THRESHOLD:
        end_start = data_start + end_found[0]
        count = max(0, (end_start - GUARD - data_start) // period)
    else:
        count = max(0, (len(s) - data_start) // period)

    if count == 0:
        return b""
    idx = data_start + cp + np.arange(count) * period
    idx = idx[idx + SYMBOL <= len(s)]
    if len(idx) == 0:
        return b""
    blocks = s[idx[:, None] + np.arange(SYMBOL)[None, :]]
    blocks = blocks - blocks.mean(axis=1, keepdims=True)
    spec = np.abs(np.fft.rfft(blocks, axis=1)) ** 2
    high = np.argmax(_tone_scores(spec, GROUP_A), axis=1)
    low = np.argmax(_tone_scores(spec, GROUP_B), axis=1)
    return bytes(((high << 4) | low).astype(np.uint8).tolist())
