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


def test_sin_paridad_devuelve_lo_mismo():
    assert rs.encode(b"abc", 0) == b"abc"
    assert rs.decode(b"abc", 0) == b"abc"


@pytest.mark.parametrize("block, parity", [(b"abc", -1), (bytes(256), 8), (bytes(8), 8)])
def test_decode_invalido(block, parity):
    with pytest.raises(ValueError):
        rs.decode(block, parity)


def test_encode_paridad_negativa():
    with pytest.raises(ValueError):
        rs.encode(b"abc", -1)


def test_inverso_de_cero():
    with pytest.raises(ZeroDivisionError):
        rs.gf_inv(0)
