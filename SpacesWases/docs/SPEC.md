# Tarea: modem acústico propio "spacewases" (Python 3.11, numpy, pytest)
Escribe TODO desde cero (no copies código de ggwave). Sólo numpy + stdlib (hmac, hashlib, zlib).
Carpeta de trabajo: esta (SpacesWases/). Crea el paquete `spacewases/` y `tests/`.

## Módulos
1. `spacewases/rs.py`: Reed-Solomon GF(256) (poly 0x11d) propio: `encode(data:bytes, nparity:int)->bytes`, `decode(block:bytes, nparity:int)->bytes` (corrige hasta nparity//2 bytes; lanza `ValueError` si no puede).
2. `spacewases/modem.py`: MFSK. fs=48000, símbolo=1024 muestras, 96 bins espaciados 46.875 Hz desde 1875 Hz (perfil audible); cada símbolo = 2 nibbles→ 2 tonos de 16 (ó 6 tonos/3 bytes: libre, documenta). Envolvente suavizada. Detección con Goertzel/FFT por ventana. Sincronización con preámbulo chirp lineal (1.5–6 kHz, 150 ms) detectado por correlación, y chirp final. `modulate(bits_or_bytes)->np.float32` y `demodulate(signal)->bytes|None`.
3. `spacewases/frame.py`: trama = magic(1) | version/flags(1) | msg_id(1) | frag_idx(1) | frag_total(1) | len(1) | payload | HMAC-SHA256 truncado 4 bytes (clave opcional) ; todo protegido con RS (parity adaptable). Fragmentación de mensajes >N bytes y reensamblado con `Reassembler` (tolera fragmentos desordenados/duplicados).
4. `spacewases/api.py`: `send(msg:bytes, key:bytes|None, profile:str)->np.ndarray` y `receive(signal, key)->bytes|None`; perfiles "robust" (parity alto), "normal", "fast". Si la clave no coincide, receive devuelve None.
5. `spacewases/cli.py`: `python -m spacewases.cli encode "texto" out.wav [--key K] [--profile P]` y `decode in.wav [--key K]` (escribe/lee WAV con módulo wave, 16 bit).
6. `bench.py`: tasa de éxito vs SNR (AWGN, -12..+12 dB paso 2, 100 pruebas, mensaje 16 B) para los 3 perfiles; imprime CSV `profile,snr_db,trials,success` y bps netos. Fijar semilla.

## Pruebas (pytest) deben pasar
- RS corrige errores hasta el límite y falla fuera.
- Ida y vuelta sin ruido para mensajes de 1, 16, 100 y 500 bytes (fragmentación).
- Con 0 dB SNR y perfil robust recupera 16 B en ≥90 % de 20 intentos.
- Clave incorrecta → None; trama manipulada → None.
- Señal con silencio y desplazamiento aleatorio antes/después se decodifica.

## Reglas
Código claro, docstrings cortos en español, sin dependencias extra. Ejecuta `pytest -q` y corrige hasta que pase. No toques nada fuera de SpacesWases/. Al terminar imprime un resumen de 10 líneas con resultados de pytest y de bench.
