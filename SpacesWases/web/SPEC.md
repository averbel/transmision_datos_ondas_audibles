# Tarea: web de SpaceWases (como la demo web de ggwave)

Carpeta de trabajo: esta (web/). Sin dependencias ni build: HTML + JS ES modules, abrible con un servidor estático.
Python de referencia (fuente de la verdad, léelo entero): ../spacewases/rs.py, modem.py, frame.py, api.py.

## 1. `spacewases.js` (módulo ES, funciona en navegador y en Node >= 18)
Port EXACTO del Python, interoperable bit a bit:
- Reed-Solomon GF(256) poly 0x11d (encode/decode con Berlekamp-Massey, Chien, Forney por sistema Vandermonde como en rs.py).
- Módem MFSK: mismas constantes (FS 48000, SYMBOL 1024, BASE_BIN 40, N_TONES 16, TONE_STEP 6, grupos A y B, chirp 1500->6000 Hz 150 ms con rampa de 10 ms, GUARD 384, rampa de símbolo 64 con coseno elevado, TONE_AMP 0.36). Sincronía por correlación normalizada vía FFT (implementa tu FFT radix-2 propia), umbral 0.25, chirp final invertido, detección de tonos sumando 3 bins.
- Tramas: magic 0xA5, flags=(1<<4)|profile_id, msg_id, frag_idx, frag_total, len, payload, HMAC-SHA256 truncado a 4 bytes (crypto.subtle, por eso send/receive son async), relleno con ceros, RS por bloque. Perfiles: robust (0,48,20), normal (1,48,10), fast (2,48,6).
- API: `async send(bytes, keyBytes|null, profile) -> Float32Array`, `async receive(Float32Array, keyBytes|null) -> Uint8Array|null`, `PROFILES`, `FS`, y `findChirp(...)` exportada para escucha en vivo.
- Función `wavEncode(Float32Array)->Uint8Array` (WAV 16 bit mono 48000) y `wavDecode(bytes)`.

## 2. `index.html` + `app.js` + `style.css`
Interfaz en español, una sola página, diseño propio sobrio (nada de degradados azul-violeta, ni tarjetas idénticas, ni emojis):
- Panel Enviar: textarea, selector de perfil, clave opcional, botón "Emitir" (reproduce con AudioContext {sampleRate:48000}), botón "Descargar WAV", duración estimada.
- Panel Recibir: botón "Escuchar" (getUserMedia con echoCancellation/noiseSuppression/autoGainControl en false; captura con AudioWorklet o ScriptProcessor en anillo de ~25 s; cada ~700 ms busca chirp inicial y final y llama receive), muestra mensajes recibidos con hora, estado (escuchando / señal detectada / decodificado), clave opcional.
- Canvas de espectro en vivo (AnalyserNode) en el panel Recibir.
- Panel "Prueba local" sin micrófono: emite, añade ruido gaussiano con deslizador de SNR (-12..+12 dB) sobre el audio generado y decodifica en la misma página, mostrando éxito/fallo. Debe funcionar sin permisos de audio.
- Cargar un WAV para decodificar.
- Texto breve al pie: nombre SpaceWases, autor Andrés Felipe Verbel Pacheco (CUC), aviso de que no cifra el mensaje y que los resultados sin probar por aire son de simulación.
- Accesibilidad: labels visibles, foco visible, botones <button>, `lang="es"`, `prefers-reduced-motion`, tema claro/oscuro por prefers-color-scheme.
- Mensaje claro si no hay permiso de micrófono o HTTPS/localhost.

## 3. Pruebas Node: `test/roundtrip.mjs` (node test/roundtrip.mjs)
- send->receive en memoria para los 3 perfiles, con y sin clave, mensajes de 0, 16, 100, 500 bytes.
- Decodifica los WAV de `test/fixtures/py_*.wav` (generados por la versión Python, claves: robust/normal/fast con clave "clave", py_nokey sin clave) y comprueba que el texto es "hola spacewases <perfil>" y "mensaje sin clave".
- Con AWGN a 0 dB y perfil robust: >= 90 % de éxito en 20 intentos.
Imprime PASS/FAIL por caso y sale con código distinto de cero si algo falla.

## Reglas
No toques nada fuera de web/. Corre las pruebas y corrige hasta que pasen. Al final imprime un resumen de 10 líneas con el resultado real de las pruebas.
