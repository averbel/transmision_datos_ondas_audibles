"""Interfaz de linea de comandos para codificar y decodificar WAV."""

from __future__ import annotations

import argparse
import os
import sys
import wave

import numpy as np

from . import api, modem


def _write_wav(path: str, signal: np.ndarray) -> None:
    pcm = (np.clip(signal, -1.0, 1.0) * 32767.0).astype("<i2")
    with wave.open(path, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(modem.FS)
        wav.writeframes(pcm.tobytes())


def _read_wav(path: str) -> np.ndarray:
    with wave.open(path, "rb") as wav:
        if wav.getsampwidth() != 2:
            raise ValueError("solo se admiten WAV de 16 bits")
        channels = wav.getnchannels()
        rate = wav.getframerate()
        data = wav.readframes(wav.getnframes())
    pcm = np.frombuffer(data, dtype="<i2").astype(np.float64) / 32768.0
    if channels > 1:
        pcm = pcm.reshape(-1, channels).mean(axis=1)
    if rate != modem.FS:
        raise ValueError("se esperaban %d Hz" % modem.FS)
    return pcm


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="spacewaves")
    sub = parser.add_subparsers(dest="command", required=True)

    enc = sub.add_parser("encode", help="texto a WAV")
    enc.add_argument("text")
    enc.add_argument("out")
    enc.add_argument("--key", default=None)
    enc.add_argument("--profile", default="normal", choices=sorted(api.PROFILES))

    dec = sub.add_parser("decode", help="WAV a texto")
    dec.add_argument("infile")
    dec.add_argument("--key", default=None)

    args = parser.parse_args(argv)
    # La clave puede venir de SPACEWAVES_KEY para no dejarla en el historial ni en la lista de procesos.
    raw_key = args.key if args.key is not None else os.environ.get("SPACEWAVES_KEY")
    key = None if raw_key is None else raw_key.encode("utf-8")
    try:
        if args.command == "encode":
            signal = api.send(args.text.encode("utf-8"), key, args.profile)
            _write_wav(args.out, signal)
            return 0

        signal = _read_wav(args.infile)
    except (ValueError, OSError, wave.Error) as exc:
        print("error: %s" % exc, file=sys.stderr)
        return 1
    message = api.receive(signal, key)
    if message is None:
        print("error: no se pudo decodificar", file=sys.stderr)
        return 1
    sys.stdout.buffer.write(message + b"\n")
    sys.stdout.buffer.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
