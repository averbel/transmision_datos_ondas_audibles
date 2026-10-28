import numpy as np
import pytest

from ondaslink import api, frame, receive, send


def _mensaje(n: int, seed: int = 1) -> bytes:
    rng = np.random.default_rng(seed)
    return bytes(rng.integers(0, 256, n, dtype=np.uint8))


@pytest.mark.parametrize("size", [1, 16, 100, 500])
def test_ida_y_vuelta_sin_ruido(size):
    msg = _mensaje(size)
    signal = send(msg, None, "normal")
    assert receive(signal, None) == msg


@pytest.mark.parametrize("profile", ["robust", "normal", "fast"])
def test_perfiles_sin_ruido(profile):
    msg = _mensaje(16, seed=3)
    assert receive(send(msg, None, profile), None) == msg


def test_robust_a_0_db():
    rng = np.random.default_rng(12345)
    msg = b"0123456789ABCDEF"
    successes = 0
    for _ in range(20):
        signal = send(msg, None, "robust").astype(np.float64)
        power = float(np.mean(signal ** 2))
        noise = rng.normal(0.0, np.sqrt(power), signal.shape)
        noisy = (signal + noise).astype(np.float32)
        if receive(noisy, None) == msg:
            successes += 1
    assert successes >= 18


def test_clave_incorrecta():
    msg = b"mensaje secreto"
    key = b"clave-correcta"
    signal = send(msg, key, "normal")
    assert receive(signal, key) == msg
    assert receive(signal, b"clave-erronea") is None


def test_trama_manipulada():
    key = b"k"
    plain = bytearray(frame.encode_fragment(1, 0, 1, b"datos", key, 1, 48))
    assert frame.parse_frame(bytes(plain), key) is not None
    plain[7] ^= 0x01
    assert frame.parse_frame(bytes(plain), key) is None


def test_stream_manipulado():
    msg = _mensaje(32, seed=5)
    raw = bytearray(frame.pack_message(msg, None, 1, 48, 10))
    for i in range(len(raw) // 2, len(raw) // 2 + 12):
        raw[i] ^= 0x5A
    assert frame.decode_stream(bytes(raw), None, api._PROFILE_ORDER) is None


def test_silencio_y_desplazamiento():
    rng = np.random.default_rng(99)
    msg = _mensaje(16, seed=8)
    signal = send(msg, b"k", "normal")
    before = rng.integers(0, 5000)
    after = rng.integers(0, 5000)
    padded = np.concatenate([
        np.zeros(int(before), dtype=np.float32),
        signal,
        np.zeros(int(after), dtype=np.float32),
    ])
    assert receive(padded, b"k") == msg


def test_reassembler_desordenado_y_duplicado():
    key = b"k"
    total = 3
    chunk = 48
    payloads = [b"AAA", b"BBB", b"CCC"]
    frames = [
        frame.parse_frame(frame.encode_fragment(77, i, total, payloads[i], key, 1, chunk), key)
        for i in range(total)
    ]
    reassembler = frame.Reassembler()
    assert reassembler.push(frames[1]) is None
    assert reassembler.push(frames[0]) is None
    assert reassembler.push(frames[1]) is None
    assert reassembler.push(frames[2]) == b"AAABBBCCC"
