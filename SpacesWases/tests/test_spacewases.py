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


def test_pbkdf2_vector_compartido_con_js():
    # El mismo vector esta en web/test/roundtrip.mjs: ambas implementaciones deben coincidir.
    assert frame.master_key(b"clave").hex() == (
        "5291958f4436a8226a06d5c96faa7d72e5d1ca4221d7e80cf1e8242d5fda62e3")


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


def test_ventana_de_tiempo(monkeypatch):
    key = b"k"
    profile = api.PROFILES["normal"]
    clock = {"now": 1_000_000.0}
    guard = frame.ReplayGuard(max_age=60, clock=lambda: clock["now"])
    real_session = frame.new_session

    monkeypatch.setattr(frame, "new_session", lambda now=None: real_session(clock["now"] - 3600))
    raw = frame.pack_message(b"viejo", key, *profile)
    assert frame.decode_stream(raw, key, [profile]) == b"viejo"
    assert frame.decode_stream(raw, key, [profile], guard) is None

    monkeypatch.setattr(frame, "new_session", lambda now=None: real_session(clock["now"]))
    raw = frame.pack_message(b"nuevo", key, *profile)
    assert frame.decode_stream(raw, key, [profile], guard) == b"nuevo"
    clock["now"] += 3600
    assert frame.decode_stream(raw, key, [profile], guard) is None


def test_recuperacion_por_fragmento_con_repeticion():
    msg = _mensaje(100, seed=21)
    profile = api.PROFILES["normal"]
    first = sum(frame.block_sizes(len(msg), None, profile[1], profile[2])[0])
    start = frame.LEN_BLOCK + first
    once = bytearray(frame.pack_message(msg, None, *profile))
    twice = bytearray(frame.pack_message(msg, None, *profile, repeat=2))
    for raw in (once, twice):
        for i in range(start + 5, start + 25):
            raw[i] ^= 0xFF
    assert frame.decode_stream(bytes(once), None, [profile]) is None
    assert frame.decode_stream(bytes(twice), None, [profile]) == msg


def test_bloque_de_longitud_danado_se_recupera_de_otra_copia():
    msg = _mensaje(30, seed=23)
    profile = api.PROFILES["fast"]
    raw = bytearray(frame.pack_message(msg, None, *profile, repeat=2))
    for i in range(frame.LEN_BLOCK):
        raw[i] ^= 0x55
    assert frame.decode_stream(bytes(raw), None, [profile]) == msg


@pytest.mark.parametrize("size", [0, 1, 16, 47, 48, 49, 200])
def test_mensajes_cortos_no_se_rellenan(size):
    msg = _mensaje(size, seed=size + 1)
    profile = api.PROFILES["robust"]
    raw = frame.pack_message(msg, None, *profile)
    sizes = frame.block_sizes(size, None, profile[1], profile[2])
    assert len(raw) == frame.LEN_BLOCK + sum(p + r for p, r in sizes)
    assert frame.decode_stream(raw, None, [profile]) == msg


def test_busqueda_de_alineacion_recupera_datos_adelantados():
    """Los datos llegan antes de lo que indica el chirp: el tramo hasta el fin se queda corto."""
    from spacewases import modem
    msg = _mensaje(40, seed=31)
    signal = send(msg, None, "normal")
    # Quita 500 muestras justo despues del chirp: los datos llegan 500 muestras antes.
    early = np.concatenate([signal[:modem.CHIRP_LEN], signal[modem.CHIRP_LEN + 500:]])
    s, data_start, data_end = modem.synchronize(early)
    raw = modem.demodulate_synced((s, data_start, data_end), frames=api.FRAMES["normal"])
    assert frame.decode_stream(raw, None, [api.PROFILES["normal"]]) is None
    # Lo recupera repetir sin el fin de datos, con o sin desplazar la ventana.
    assert receive(early, None, offsets=(0,)) == msg
    assert receive(early, None) == msg


def test_repeat_invalido():
    with pytest.raises(ValueError):
        send(b"x", None, "normal", repeat=0)


def test_repeticion_por_el_aire_con_clave():
    key = b"k"
    msg = _mensaje(100, seed=22)
    guard = frame.ReplayGuard()
    assert receive(send(msg, key, "normal", repeat=2), key, guard) == msg
    assert receive(send(msg, key, "normal", repeat=2), key, guard) == msg


@pytest.mark.parametrize("frames", [2, 3, 6])
def test_simbolos_de_varias_tramas(frames):
    from spacewases import modem
    data = _mensaje(64, seed=40 + frames)
    signal = modem.modulate(data, frames=frames)
    assert len(signal) == 2 * modem.CHIRP_LEN + 2 * modem.GUARD + len(data) * frames * modem.SYMBOL
    assert modem.demodulate(signal, frames=frames) == data


def _con_sala(signal, rt60=0.4, drr_db=0.0, seed=2):
    """Camino directo + cola difusa que decae exponencialmente (modelo simple de sala)."""
    rng = np.random.default_rng(seed)
    n = int(rt60 * 48000)
    t = np.arange(n) / 48000
    tail = rng.normal(size=n) * np.exp(-6.9 * t / rt60)
    tail[:48] = 0.0
    tail *= np.sqrt(10 ** (-drr_db / 10) / np.sum(tail ** 2))
    tail[0] = 1.0
    size = len(signal) + n - 1
    nfft = 1 << (size - 1).bit_length()
    out = np.fft.irfft(np.fft.rfft(signal, nfft) * np.fft.rfft(tail, nfft), nfft)
    return out[:size]


def test_varias_tramas_resisten_reverberacion():
    """Con una cola de sala de 0,4 s, una trama falla y varias tramas aguantan."""
    from spacewases import modem
    data = _mensaje(200, seed=1)

    def errores(frames):
        signal = modem.modulate(data, frames=frames).astype(np.float64)
        got = modem.demodulate(_con_sala(signal), frames=frames)
        got = (got or b"")[:len(data)].ljust(len(data), b"\x00")
        return sum(a != b for a, b in zip(got, data))

    assert errores(1) > 20
    assert errores(3) <= 10
    assert errores(6) == 0


def _con_eco(signal, delay, gain):
    out = np.zeros(len(signal) + delay, dtype=np.float64)
    out[:len(signal)] += signal
    out[delay:] += gain * signal
    return out


def test_prefijo_ciclico_resiste_eco():
    from spacewases import modem
    data = _mensaje(200, seed=31)
    delay, gain = 100, 1.0

    def errores(cp):
        got = modem.demodulate(_con_eco(modem.modulate(data, cp), delay, gain), cp)
        got = (got or b"")[:len(data)].ljust(len(data), b"\x00")
        return sum(a != b for a, b in zip(got, data))

    assert errores(modem.CYCLIC_PREFIX) <= 3
    assert errores(0) > 20


def test_sin_chirp_final_decodifica_por_la_longitud():
    from spacewases import modem
    msg = _mensaje(16, seed=50)
    signal = send(msg, None, "fast")
    assert receive(signal[:-modem.CHIRP_LEN], None) == msg


def test_fin_falso_no_corta_el_mensaje():
    """Un chirp invertido dentro de los datos no debe impedir decodificar."""
    from spacewases import modem
    msg = _mensaje(16, seed=51)
    signal = send(msg, None, "robust").astype(np.float64)[:-modem.CHIRP_LEN]
    falso = modem._chirp()[::-1]
    # Sobre el ultimo tramo de paridad: Reed-Solomon corrige los simbolos que pisa.
    pos = len(signal) - modem.GUARD - 2 * len(falso)
    signal[pos:pos + len(falso)] += 3.0 * falso
    assert modem.synchronize(signal)[2] < pos
    assert receive(signal, None) == msg


def test_chirp_debil_se_detecta_sobre_ruido():
    """Entre el umbral nuevo (0,12) y el anterior (0,25), como los chirps debiles por aire."""
    from spacewases import modem
    rng = np.random.default_rng(52)
    msg = _mensaje(16, seed=52)
    signal = send(msg, None, "robust").astype(np.float64)
    sigma = np.sqrt(np.mean(signal ** 2) * 10 ** (18 / 10))
    noisy = signal + rng.normal(0, sigma, signal.shape)
    score = modem._find_chirp(noisy)[1]
    assert modem.SYNC_THRESHOLD <= score < modem.END_THRESHOLD
    assert receive(noisy, None) == msg


def test_ruido_no_supera_el_umbral_de_inicio():
    from spacewases import modem
    rng = np.random.default_rng(53)
    window = 2 * modem.CHIRP_LEN + 4096
    best = max(modem._find_chirp(rng.normal(0, 0.1, window))[1] for _ in range(50))
    assert best < modem.SYNC_THRESHOLD


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


def _escribe_wav(path, data, channels=1, width=2, rate=48000):
    import wave
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(channels)
        wav.setsampwidth(width)
        wav.setframerate(rate)
        wav.writeframes(data)


@pytest.mark.parametrize("width, rate", [(1, 48000), (2, 44100)])
def test_cli_rechaza_formato(tmp_path, width, rate):
    from spacewases import cli
    path = tmp_path / "x.wav"
    _escribe_wav(path, bytes(2000), width=width, rate=rate)
    assert cli.main(["decode", str(path)]) == 1


def test_cli_lee_wav_estereo(tmp_path, capsysbinary):
    from spacewases import cli
    pcm = (send(b"estereo", None, "fast") * 32767).astype("<i2")
    path = tmp_path / "s.wav"
    _escribe_wav(path, np.stack([pcm, pcm], axis=1).tobytes(), channels=2)
    assert cli.main(["decode", str(path)]) == 0
    assert capsysbinary.readouterr().out == b"estereo\n"


def test_perfil_desconocido():
    with pytest.raises(ValueError):
        send(b"x", None, "ultra")


@pytest.mark.parametrize("kwargs", [
    {"payload": bytes(49)},
    {"msg_id": 256},
    {"frag_total": 0},
    {"frag_idx": 1},
    {"session": b"corta", "key": b"k"},
])
def test_fragmento_invalido(kwargs):
    args = {"msg_id": 1, "frag_idx": 0, "frag_total": 1, "payload": b"x",
            "key": None, "profile_id": 0, "chunk": 48}
    with pytest.raises(ValueError):
        frame.encode_fragment(**{**args, **kwargs})


@pytest.mark.parametrize("plain", [b"", b"\x00" * 20, bytes([frame.MAGIC, 0x31]) + bytes(20),
                                   bytes([frame.MAGIC, 0x10, 1, 0, 1, 200]) + bytes(10)])
def test_trama_invalida(plain):
    assert frame.parse_frame(plain, None) is None


def test_silencio_no_sincroniza():
    from spacewases import modem
    assert modem.demodulate(np.zeros(48000)) is None
    assert modem.synchronize(np.zeros(0)) is None
    assert modem.synchronize(np.zeros(10)) is None
    assert receive(np.zeros(48000), None) is None


def test_modular_vacio_y_datos_uint8():
    from spacewases import modem
    assert modem.demodulate(modem.modulate(b"")) == b""
    data = np.frombuffer(b"\x01\x02\x03", dtype=np.uint8)
    assert modem.demodulate(modem.modulate(data)) == b"\x01\x02\x03"
    with pytest.raises(ValueError):
        modem.modulate(b"x", frames=0)
