"""Tramas fragmentadas con cabecera, HMAC truncado y proteccion Reed-Solomon."""

from __future__ import annotations

import hashlib
import hmac
import math
import random

from . import rs

MAGIC = 0xA5
VERSION = 1
HEADER_LEN = 6
HMAC_LEN = 4

_rng = random.SystemRandom()
_last_id = -1


def _next_msg_id() -> int:
    global _last_id
    _last_id = (_last_id + 1) & 0xFF
    if _last_id == 0:
        _last_id = _rng.randrange(1, 256)
    return _last_id


def _tag(body: bytes, key: bytes | None) -> bytes:
    secret = b"" if key is None else key
    return hmac.new(secret, body, hashlib.sha256).digest()[:HMAC_LEN]


def encode_fragment(msg_id: int, frag_idx: int, frag_total: int,
                    payload: bytes, key: bytes | None,
                    profile_id: int, chunk: int) -> bytes:
    """Devuelve el bloque en claro, rellenado a un tamano fijo."""
    if len(payload) > chunk:
        raise ValueError("fragmento demasiado grande")
    if not 0 <= msg_id <= 255 or not 1 <= frag_total <= 255:
        raise ValueError("identificadores fuera de rango")
    if not 0 <= frag_idx < frag_total:
        raise ValueError("indice de fragmento fuera de rango")
    flags = (VERSION << 4) | (profile_id & 0x0F)
    header = bytes([MAGIC, flags, msg_id, frag_idx, frag_total, len(payload)])
    body = header + payload
    plain = body + _tag(body, key)
    return plain + b"\x00" * (HEADER_LEN + chunk + HMAC_LEN - len(plain))


def parse_frame(plain: bytes, key: bytes | None) -> dict | None:
    """Valida cabecera y HMAC; devuelve los campos o None."""
    if len(plain) < HEADER_LEN + HMAC_LEN:
        return None
    if plain[0] != MAGIC or (plain[1] >> 4) != VERSION:
        return None
    length = plain[5]
    if HEADER_LEN + length + HMAC_LEN > len(plain):
        return None
    payload = plain[HEADER_LEN:HEADER_LEN + length]
    body = plain[:HEADER_LEN + length]
    tag = plain[HEADER_LEN + length:HEADER_LEN + length + HMAC_LEN]
    if not hmac.compare_digest(tag, _tag(body, key)):
        return None
    return {
        "msg_id": plain[2],
        "frag_idx": plain[3],
        "frag_total": plain[4],
        "len": length,
        "payload": payload,
        "profile_id": plain[1] & 0x0F,
    }


def parse_fragment(plain: bytes, key: bytes | None,
                   profile_id: int, chunk: int) -> dict | None:
    """Como parse_frame pero exige el perfil y el tamano de bloque esperados."""
    frame = parse_frame(plain, key)
    if frame is None or frame["profile_id"] != profile_id or frame["len"] > chunk:
        return None
    return frame


class Reassembler:
    """Reensambla fragmentos desordenados o duplicados."""

    def __init__(self, key: bytes | None = None):
        self.key = key
        self._pending: dict[int, dict] = {}

    def reset(self) -> None:
        self._pending.clear()

    def push(self, frame: dict) -> bytes | None:
        msg_id = frame["msg_id"]
        total = frame["frag_total"]
        state = self._pending.get(msg_id)
        if state is None or state["total"] != total:
            state = {"total": total, "parts": {}}
            self._pending[msg_id] = state
        idx = frame["frag_idx"]
        if 0 <= idx < total and idx not in state["parts"]:
            state["parts"][idx] = frame["payload"]
        if len(state["parts"]) != total:
            return None
        if any(i not in state["parts"] for i in range(total)):
            return None
        message = b"".join(state["parts"][i] for i in range(total))
        del self._pending[msg_id]
        return message

    def push_bytes(self, plain: bytes, key: bytes | None = None) -> bytes | None:
        frame = parse_frame(plain, self.key if key is None else key)
        if frame is None:
            return None
        return self.push(frame)


def pack_message(msg: bytes, key: bytes | None, profile_id: int,
                 chunk: int, parity: int, msg_id: int | None = None) -> bytes:
    """Fragmenta, protege con RS y concatena los bloques listos para el modem."""
    if chunk <= 0 or chunk > 249:
        raise ValueError("chunk invalido")
    total = max(1, math.ceil(len(msg) / chunk))
    if total > 255:
        raise ValueError("mensaje demasiado largo")
    ident = _next_msg_id() if msg_id is None else (msg_id & 0xFF)
    blocks = []
    for idx in range(total):
        payload = msg[idx * chunk:(idx + 1) * chunk]
        plain = encode_fragment(ident, idx, total, payload, key, profile_id, chunk)
        blocks.append(rs.encode(plain, parity))
    return b"".join(blocks)


def decode_stream(raw: bytes, key: bytes | None,
                  profiles: list[tuple[int, int, int]]) -> bytes | None:
    """Prueba los perfiles (id, chunk, parity) y devuelve el mensaje completo."""
    for profile_id, chunk, parity in profiles:
        data_len = HEADER_LEN + chunk + HMAC_LEN
        block_len = data_len + parity
        max_blocks = len(raw) // block_len
        if max_blocks == 0:
            continue
        for nblocks in range(max_blocks, 0, -1):
            frames = []
            valid = True
            for i in range(nblocks):
                block = raw[i * block_len:(i + 1) * block_len]
                try:
                    plain = rs.decode(block, parity)
                except ValueError:
                    valid = False
                    break
                if len(plain) != data_len:
                    valid = False
                    break
                frame = parse_fragment(plain, key, profile_id, chunk)
                if frame is None:
                    valid = False
                    break
                frames.append(frame)
            if not valid:
                continue
            reassembler = Reassembler()
            result = None
            for frame in frames:
                result = reassembler.push(frame)
            if result is not None:
                return result
    return None
