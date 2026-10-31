# SpaceWases

Módem acústico propio en Python (solo `numpy` y la biblioteca estándar) para enviar datos por sonido con altavoz y micrófono. Código escrito desde cero; ggwave (MIT, Georgi Gerganov) se tomó como referencia para el diseño; no se copió código de él.

## Qué incluye

- `spacewases/rs.py`: Reed-Solomon sobre GF(256).
- `spacewases/modem.py`: modulación MFSK a 48 kHz con sincronía por chirp (bins de 46,875 Hz desde 1875 Hz). Cada símbolo dura varias tramas de 1024 muestras (6 en `robust`, 3 en `normal` y `fast`): la primera hace de guarda frente a la reverberación y el receptor suma las demás, como ggwave.
- `spacewases/frame.py`: tramas con cabecera, HMAC-SHA256 truncado a 4 bytes, fragmentación y protección Reed-Solomon.
- `spacewases/api.py`: `send` y `receive`, con perfiles `robust`, `normal` y `fast`.
- `spacewases/cli.py`: codificar y decodificar archivos WAV.
- `bench.py`: éxito frente a SNR con ruido gaussiano simulado; `prueba_aire.py`: prueba real altavoz → micrófono.

## Web

`web/` es una página estática (sin dependencias ni compilación): envía y recibe con altavoz y micrófono, muestra el espectro y trae una prueba local con ruido ajustable. `web/spacewases.js` es un port exacto del Python; se comprobó que cada lado decodifica lo que emite el otro.

```bash
cd web
python -m http.server 8790
node test/roundtrip.mjs   # 46 pruebas, incluye WAV generados por Python
```

Abre `http://localhost:8790`. El micrófono solo funciona en `localhost` o `https`.

## Uso

```bash
pip install numpy pytest sounddevice
python -m pytest -q
python -m spacewases.cli encode "hola" salida.wav --profile robust
python -m spacewases.cli decode salida.wav
```

La clave opcional se pasa con `--key` o, mejor, con la variable de entorno `SPACEWASES_KEY`, para que no quede en el historial ni en la lista de procesos.

## Resultados

Con ruido blanco gaussiano **simulado** (mensaje de 16 B, 100 intentos por punto, semilla fija; `bench_resultados.csv` y `bench_bps.csv`):

| Perfil | 100 % de éxito desde | Tasa neta |
|---|---|---|
| robust | −10 dB | 53,4 bps |
| normal | −10 dB | 60,1 bps |
| fast | −10 dB | 63,3 bps |

El prefijo cíclico (256 muestras por símbolo de 1024) costó un 25 % de tasa neta; antes eran 64,6 / 72,5 / 76,1 bps. La tasa de éxito con ruido blanco mejoró (p. ej. robust a −12 dB pasó de 33 a 89 de 100), probablemente porque la ventana de análisis ya no incluye las rampas de la envolvente; no se ha aislado la causa.

Con eco simulado (una réplica retardada 100 muestras, ≈2 ms, con la misma amplitud) el módem sin prefijo falla decenas de bytes de 200 y con prefijo casi ninguno; con retardos mayores que el prefijo (≥ 300 muestras) no hay mejora. Estas cifras son de simulación, no de aire. Tampoco se compararon con ggwave bajo las mismas condiciones, así que no deben leerse como una ventaja sobre él. La prueba real con altavoz y micrófono está **pendiente**: hay una serie parcial (168 de 180 ensayos, `aire_resultados.csv`) sin analizar y cuyas condiciones no se controlaron hasta el final, así que no es un resultado.

## Límites conocidos

- Con `key=None` (trama v1) el mensaje viaja en claro y se firma con clave vacía: cualquiera puede fabricar tramas. Con clave (trama v2) el mensaje va cifrado y autenticado con una etiqueta de 8 bytes.
- La protección contra repetición es opcional y del receptor: hay que pasar un `ReplayGuard` a `receive`. Exige relojes razonablemente sincronizados (ventana de 120 s por defecto).
- Cada bloque Reed-Solomon se valida por separado, pero un mensaje de varios fragmentos solo se recupera si llegan todos. `send(..., repeat=N)` lo envía N veces para rellenar huecos, a costa de N veces el tiempo de aire.
- Los símbolos largos cuestan tasa: un bloque de `robust` dura unos 10 s. No hay seguimiento de reloj ni búsqueda fina de alineación (ggwave prueba 16 desplazamientos por trama). Los valores de tramas y paridad se eligieron con mediciones de un solo equipo y sala (`diagnostico_aire/`).

`docs/SPEC.md` es la especificación que se dio al agente que escribió el código inicial.
