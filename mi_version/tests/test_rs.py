import random

import pytest

from spacewases import rs


def test_roundtrip_sin_errores():
    data = bytes(range(40))
    block = rs.encode(data, 8)
    assert rs.decode(block, 8) == data


def test_corrige_hasta_el_limite():
    rng = random.Random(7)
    data = bytes(rng.randrange(256) for _ in range(40))
    parity = 8
    block = bytearray(rs.encode(data, parity))
    positions = rng.sample(range(len(block)), parity // 2)
    for pos in positions:
        block[pos] ^= rng.randrange(1, 256)
    assert rs.decode(bytes(block), parity) == data


def test_falla_por_encima_del_limite():
    rng = random.Random(9)
    data = bytes(rng.randrange(256) for _ in range(40))
    parity = 8
    block = bytearray(rs.encode(data, parity))
    positions = rng.sample(range(len(block)), parity // 2 + 1)
    for pos in positions:
        block[pos] ^= rng.randrange(1, 256)
    with pytest.raises(ValueError):
        rs.decode(bytes(block), parity)


def test_bloque_largo_invalido():
    with pytest.raises(ValueError):
        rs.encode(bytes(250), 8)
