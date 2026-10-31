import numpy as np
import pytest

from spacewases import api, frame, receive, send


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
    session = frame.new_session()
    frames = [
        frame.parse_frame(
            frame.encode_fragment(77, i, total, payloads[i], key, 1, chunk, session), key)
        for i in range(total)
    ]
    reassembler = frame.Reassembler()
    assert reassembler.push(frames[1]) is None
    assert reassembler.push(frames[0]) is None
    assert reassembler.push(frames[1]) is None
    assert reassembler.push(frames[2]) == b"AAABBBCCC"


def test_payload_cifrado_en_el_aire():
    key = b"k"
    plain = frame.encode_fragment(1, 0, 1, b"texto secreto", key, 1, 48)
    assert b"texto secreto" not in plain
    assert frame.parse_frame(plain, key)["payload"] == b"texto secreto"


def test_v1_rechazada_con_clave_y_v2_sin_clave():
    v1 = frame.encode_fragment(1, 0, 1, b"hola", None, 1, 48)
    v2 = frame.encode_fragment(1, 0, 1, b"hola", b"k", 1, 48)
    assert frame.parse_frame(v1, b"k") is None
    assert frame.parse_frame(v2, None) is None


def test_repeticion_rechazada_con_guardia():
    key = b"k"
    signal = send(b"abrir puerta", key, "normal")
    guard = frame.ReplayGuard()
    assert receive(signal, key, guard) == b"abrir puerta"
    assert receive(signal, key, guard) is None
    assert receive(send(b"abrir puerta", key, "normal"), key, guard) == b"abrir puerta"


def test_sin_guardia_no_hay_proteccion():
    signal = send(b"x", b"k", "normal")
    assert receive(signal, b"k") == b"x"
    assert receive(signal, b"k") == b"x"


def test_ventana_de_tiempo():
    key = b"k"
    clock = {"now": 1_000_000.0}
    guard = frame.ReplayGuard(max_age=60, clock=lambda: clock["now"])
    session_viejo = frame.new_session(now=clock["now"] - 3600)
    plain = frame.encode_fragment(1, 0, 1, b"viejo", key, 1, 48, session_viejo)
    raw = frame.rs.encode(plain, 10)
    assert frame.decode_stream(raw, key, [api.PROFILES["normal"]], guard) is None
    fresh = frame.encode_fragment(1, 0, 1, b"nuevo", key, 1, 48,
                                  frame.new_session(now=clock["now"]))
    raw = frame.rs.encode(fresh, 10)
    assert frame.decode_stream(raw, key, [api.PROFILES["normal"]], guard) == b"nuevo"
    clock["now"] += 3600
    assert frame.decode_stream(raw, key, [api.PROFILES["normal"]], guard) is None


def test_mensaje_vacio():
    assert receive(send(b"", None, "normal"), None) == b""


def test_as_bytes_no_reinterpreta_ceros_y_unos():
    from spacewases import modem
    assert modem._as_bytes([0, 1]) == b"\x00\x01"
    assert modem._as_bytes([1, 0, 1]) == b"\x01\x00\x01"


def test_perfil_que_no_coincide():
    raw = frame.pack_message(b"hola", None, 1, 48, 10)
    assert frame.decode_stream(raw, None, [api.PROFILES["fast"]]) is None


def test_senal_int16():
    msg = _mensaje(16, seed=11)
    pcm = (send(msg, None, "normal") * 32767).astype(np.int16)
    assert receive(pcm, None) == msg


def test_cli_ida_y_vuelta(tmp_path, capsysbinary):
    from spacewases import cli
    wav = str(tmp_path / "t.wav")
    assert cli.main(["encode", "hola mundo", wav, "--key", "K"]) == 0
    assert cli.main(["decode", wav, "--key", "K"]) == 0
    assert capsysbinary.readouterr().out == b"hola mundo\n"
    assert cli.main(["decode", wav, "--key", "MAL"]) == 1


def test_cli_wav_invalido(tmp_path):
    from spacewases import cli
    assert cli.main(["decode", str(tmp_path / "no_existe.wav")]) == 1
