"""Tramas fragmentadas con cabecera, HMAC truncado y proteccion Reed-Solomon.

Version 1 (sin clave): HMAC de 4 bytes con clave vacia; solo detecta errores,
cualquiera puede fabricar tramas validas y el payload viaja en claro.

Version 2 (con clave): la cabecera lleva una sesion de 10 bytes (marca de
tiempo de 4 bytes + nonce aleatorio de 6), el payload se cifra con un flujo
HMAC-SHA256 en modo contador y la etiqueta de 8 bytes cubre cabecera y texto
cifrado (cifrar y luego autenticar). La clave del usuario pasa por
PBKDF2-HMAC-SHA256 (600 000 iteraciones, sal fija PBKDF2_SALT) para frenar los
ataques de diccionario, y de esa clave maestra se derivan las de cifrado y de
etiqueta. La sal es fija porque una sal por sesion obligaria a derivar en cada
intento de decodificacion; el costo es que una frase debil sigue siendo debil. Un receptor con clave rechaza tramas v1
(sin degradacion) y uno sin clave no acepta v2. La proteccion contra
repeticion es del receptor: ReplayGuard recuerda las sesiones vistas y su
antiguedad; sin guardia, receive() es sin estado y acepta una trama grabada.

La transmision empieza con un bloque de longitud y sigue con los fragmentos, sin
relleno; cada bloque se valida por separado y, con repeat, los fragmentos buenos
de cualquier copia completan el mensaje.
"""

from __future__ import annotations

import hashlib
import hmac
import math
import random
import struct
import time
from functools import lru_cache

from . import rs

MAGIC = 0xA5
VERSION = 1
VERSION_KEYED = 2
HEADER_LEN = 6
HMAC_LEN = 4
SESSION_LEN = 10
HEADER_LEN_V2 = HEADER_LEN + SESSION_LEN
HMAC_LEN_V2 = 8
PBKDF2_SALT = b"spacewases-pbkdf2-v1"
PBKDF2_ITERATIONS = 600_000

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


@lru_cache(maxsize=16)
def master_key(key: bytes) -> bytes:
    """Clave maestra de 32 bytes: PBKDF2-HMAC-SHA256 de la clave del usuario."""
    return hashlib.pbkdf2_hmac("sha256", key, PBKDF2_SALT, PBKDF2_ITERATIONS)


def _subkey(key: bytes, label: bytes) -> bytes:
    return hmac.new(master_key(bytes(key)), b"spacewases-v2-" + label, hashlib.sha256).digest()


def new_session(now: float | None = None) -> bytes:
    """Sesion nueva: marca de tiempo (s, 4 bytes) + nonce aleatorio de 6 bytes."""
    stamp = int(time.time() if now is None else now) & 0xFFFFFFFF
    return struct.pack(">I", stamp) + _rng.randbytes(SESSION_LEN - 4)


def _keystream(enc_key: bytes, session: bytes, msg_id: int, frag_idx: int,
               length: int) -> bytes:
    out = bytearray()
    counter = 0
    while len(out) < length:
        block = session + bytes([msg_id, frag_idx]) + struct.pack(">I", counter)
        out += hmac.new(enc_key, block, hashlib.sha256).digest()
        counter += 1
    return bytes(out[:length])


def _xor(data: bytes, stream: bytes) -> bytes:
    return bytes(a ^ b for a, b in zip(data, stream))


def encode_fragment(msg_id: int, frag_idx: int, frag_total: int,
                    payload: bytes, key: bytes | None,
                    profile_id: int, chunk: int,
                    session: bytes | None = None) -> bytes:
    """Devuelve el bloque en claro, sin relleno.

    Con clave genera una trama v2 cifrada; todos los fragmentos de un mensaje
    deben compartir session (pack_message la crea).
    """
    if len(payload) > chunk:
        raise ValueError("fragmento demasiado grande")
    if not 0 <= msg_id <= 255 or not 1 <= frag_total <= 255:
        raise ValueError("identificadores fuera de rango")
    if not 0 <= frag_idx < frag_total:
        raise ValueError("indice de fragmento fuera de rango")
    keyed = key is not None
    version = VERSION_KEYED if keyed else VERSION
    flags = (version << 4) | (profile_id & 0x0F)
    header = bytes([MAGIC, flags, msg_id, frag_idx, frag_total, len(payload)])
    if keyed:
        if session is None:
            session = new_session()
        if len(session) != SESSION_LEN:
            raise ValueError("sesion invalida")
        stream = _keystream(_subkey(key, b"enc"), session, msg_id, frag_idx,
                            len(payload))
        body = header + session + _xor(payload, stream)
        plain = body + hmac.new(_subkey(key, b"mac"), body,
                                hashlib.sha256).digest()[:HMAC_LEN_V2]
    else:
        body = header + payload
        plain = body + _tag(body, None)
    return plain


def parse_frame(plain: bytes, key: bytes | None) -> dict | None:
    """Valida cabecera y etiqueta; devuelve los campos (payload en claro) o None."""
    if len(plain) < HEADER_LEN + HMAC_LEN or plain[0] != MAGIC:
        return None
    keyed = key is not None
    if (plain[1] >> 4) != (VERSION_KEYED if keyed else VERSION):
        return None
    length = plain[5]
    head = HEADER_LEN_V2 if keyed else HEADER_LEN
    tag_len = HMAC_LEN_V2 if keyed else HMAC_LEN
    if head + length + tag_len > len(plain):
        return None
    body = plain[:head + length]
    tag = plain[head + length:head + length + tag_len]
    session = None
    if keyed:
        expected = hmac.new(_subkey(key, b"mac"), body,
                            hashlib.sha256).digest()[:HMAC_LEN_V2]
        if not hmac.compare_digest(tag, expected):
            return None
        session = plain[HEADER_LEN:HEADER_LEN_V2]
        stream = _keystream(_subkey(key, b"enc"), session, plain[2], plain[3],
                            length)
        payload = _xor(plain[head:head + length], stream)
    else:
        if not hmac.compare_digest(tag, _tag(body, None)):
            return None
        payload = plain[head:head + length]
    return {
        "msg_id": plain[2],
        "frag_idx": plain[3],
        "frag_total": plain[4],
        "len": length,
        "payload": payload,
        "profile_id": plain[1] & 0x0F,
        "session": session,
    }


def parse_fragment(plain: bytes, key: bytes | None,
                   profile_id: int, chunk: int) -> dict | None:
    """Como parse_frame pero exige el perfil y el tamano de bloque esperados."""
    frame = parse_frame(plain, key)
    if frame is None or frame["profile_id"] != profile_id or frame["len"] > chunk:
        return None
    return frame


class ReplayGuard:
    """Rechaza mensajes con clave ya vistos o demasiado viejos.

    max_age: segundos de tolerancia entre la marca de tiempo del emisor y el
    reloj del receptor (ambos relojes deben estar razonablemente sincronizados).
    Recuerda las sesiones vistas dentro de esa ventana.
    """

    def __init__(self, max_age: float = 120.0, clock=time.time):
        self.max_age = max_age
        self._clock = clock
        self._seen: dict[bytes, float] = {}

    def accept(self, session: bytes | None) -> bool:
        """True si la sesion es nueva y reciente; la registra."""
        if session is None:
            return True
        now = self._clock()
        stamp = struct.unpack(">I", session[:4])[0]
        if abs(now - stamp) > self.max_age:
            return False
        self._seen = {k: t for k, t in self._seen.items()
                      if abs(now - t) <= self.max_age}
        if session in self._seen:
            return False
        self._seen[session] = float(stamp)
        return True


class Reassembler:
    """Reensambla fragmentos desordenados o duplicados."""

    def __init__(self, key: bytes | None = None):
        self.key = key
        self._pending: dict[tuple, dict] = {}

    def reset(self) -> None:
        self._pending.clear()

    def push(self, frame: dict) -> bytes | None:
        msg_id = (frame["msg_id"], frame.get("session"))
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


# Cada transmision empieza con un bloque de longitud: perfil y longitud total del
# mensaje, protegidos por su propio Reed-Solomon (idea tomada de ggwave). Con eso el
# receptor conoce el tamano de cada bloque y el ultimo fragmento no se rellena.
LEN_MAGIC = 0xB0
LEN_DATA = 3
LEN_PARITY = 6
LEN_BLOCK = LEN_DATA + LEN_PARITY
MAX_MESSAGE = 0xFFFF


def block_sizes(length: int, key: bytes | None, chunk: int, parity: int) -> list[tuple[int, int]]:
    """(bytes en claro, paridad) de cada fragmento de un mensaje de length bytes.

    La paridad es la del perfil aunque el bloque sea corto: por aire, escalarla
    con el tamano del bloque bajo el exito de normal y fast (106/180 frente a
    142/180), porque el relleno de ceros que se quito casi nunca fallaba.
    """
    head, tag = (HEADER_LEN_V2, HMAC_LEN_V2) if key is not None else (HEADER_LEN, HMAC_LEN)
    count = max(1, math.ceil(length / chunk))
    sizes = []
    for idx in range(count):
        payload = min(chunk, length - idx * chunk)
        sizes.append((head + payload + tag, parity))
    return sizes


def _sequence_length(length: int, key: bytes | None, chunk: int, parity: int) -> int:
    return LEN_BLOCK + sum(p + r for p, r in block_sizes(length, key, chunk, parity))


def pack_message(msg: bytes, key: bytes | None, profile_id: int,
                 chunk: int, parity: int, msg_id: int | None = None,
                 repeat: int = 1) -> bytes:
    """Bloque de longitud + fragmentos protegidos con RS, listos para el modem.

    Con repeat > 1 la secuencia completa se envia varias veces (misma sesion):
    el receptor reensambla con los fragmentos buenos de cualquier copia.
    """
    if repeat < 1:
        raise ValueError("repeat debe ser >= 1")
    if chunk <= 0 or chunk > 230:
        raise ValueError("chunk invalido")
    if len(msg) > MAX_MESSAGE or math.ceil(len(msg) / chunk) > 255:
        raise ValueError("mensaje demasiado largo")
    ident = _next_msg_id() if msg_id is None else (msg_id & 0xFF)
    session = new_session() if key is not None else None
    header = bytes([LEN_MAGIC | (profile_id & 0x0F), len(msg) >> 8, len(msg) & 0xFF])
    blocks = [rs.encode(header, LEN_PARITY)]
    sizes = block_sizes(len(msg), key, chunk, parity)
    for idx, (_, block_parity) in enumerate(sizes):
        payload = msg[idx * chunk:(idx + 1) * chunk]
        plain = encode_fragment(ident, idx, len(sizes), payload, key, profile_id,
                                chunk, session)
        blocks.append(rs.encode(plain, block_parity))
    return b"".join(blocks) * repeat


def _read_length(raw: bytes, offset: int, profile_id: int) -> int | None:
    """Longitud del mensaje si el bloque de longitud en offset es valido para el perfil."""
    block = raw[offset:offset + LEN_BLOCK]
    if len(block) < LEN_BLOCK:
        return None
    try:
        header = rs.decode(block, LEN_PARITY)
    except ValueError:
        return None
    if header[0] != LEN_MAGIC | (profile_id & 0x0F):
        return None
    return (header[1] << 8) | header[2]


def decode_stream(raw: bytes, key: bytes | None,
                  profiles: list[tuple[int, int, int]],
                  guard: ReplayGuard | None = None) -> bytes | None:
    """Prueba los perfiles (id, chunk, parity) y devuelve el mensaje completo.

    Con guard, un mensaje con clave repetido o fuera de ventana devuelve None.
    """
    for profile_id, chunk, parity in profiles:
        # Si el bloque de longitud de la primera copia esta danado, prueba el de
        # las demas suponiendo que raw son k copias exactas.
        length = None
        for k in (1, 2, 3):
            part = len(raw) // k
            if k > 1 and len(raw) % k:
                continue
            for copy in range(k):
                found = _read_length(raw, copy * part, profile_id)
                if found is not None and (k == 1 or _sequence_length(found, key, chunk, parity) == part):
                    length = found
                    break
            if length is not None:
                break
        if length is None:
            continue
        seq = _sequence_length(length, key, chunk, parity)
        sizes = block_sizes(length, key, chunk, parity)

        # Cada bloque se valida por separado: uno danado no descarta al resto, y
        # si el mensaje se envio repetido los fragmentos buenos de cualquier
        # copia completan los que faltan.
        reassembler = Reassembler()
        for copy in range(max(1, len(raw) // seq)):
            offset = copy * seq + LEN_BLOCK
            for plain_len, block_parity in sizes:
                block = raw[offset:offset + plain_len + block_parity]
                offset += plain_len + block_parity
                if len(block) < plain_len + block_parity:
                    break
                try:
                    plain = rs.decode(block, block_parity)
                except ValueError:
                    continue
                fragment = parse_fragment(plain, key, profile_id, chunk)
                if fragment is None:
                    continue
                result = reassembler.push(fragment)
                if result is not None:
                    if guard is not None and not guard.accept(fragment["session"]):
                        return None
                    return result
    return None
