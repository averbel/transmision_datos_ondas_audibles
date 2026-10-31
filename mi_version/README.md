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
node test/stream.mjs      # 6 pruebas del receptor en flujo
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

**Por aire** (`aire_2026-10-31_tramas.csv`): altavoz y micrófono integrados de un portátil, una sala, volumen del sistema fijo, mensaje de 16 B, 10 ensayos por punto; la ganancia digital baja la señal emitida.

| Ganancia | robust | normal | fast |
|---|---|---|---|
| 1,0 | 8/10 | 6/10 | 9/10 |
| 0,5 | 9/10 | 10/10 | 9/10 |
| 0,25 | 8/10 | 9/10 | 9/10 |
| 0,12 | 10/10 | 10/10 | 10/10 |
| 0,06 | 10/10 | 9/10 | 9/10 |
| 0,03 | 2/10 | 3/10 | 2/10 |
| **Total** | **47/60** | **47/60** | **48/60** |

Con el diseño anterior (símbolos de una trama) la misma prueba dio 7/60, 1/60 y 1/60 (`aire_2026-10-31.csv`); el diagnóstico está en `diagnostico_aire/`. Es un solo equipo y una sala: falta repetirlo en otros.

**Simulación con ruido blanco** (16 B, 100 intentos por punto, semilla fija; `bench_resultados.csv` y `bench_bps.csv`): los tres perfiles decodifican el 100 % desde −12 dB, el piso del banco. Tasa neta con 16 B: robust 12,4 bps, normal 21,1 y fast 24,1; cada bloque se rellena a 48 B, así que los mensajes cortos pagan el bloque entero. No se comparó con ggwave en las mismas condiciones.

## Límites conocidos

- Con `key=None` (trama v1) el mensaje viaja en claro y se firma con clave vacía: cualquiera puede fabricar tramas. Con clave (trama v2) el mensaje va cifrado y autenticado con una etiqueta de 8 bytes.
- La protección contra repetición es opcional y del receptor: hay que pasar un `ReplayGuard` a `receive`. Exige relojes razonablemente sincronizados (ventana de 120 s por defecto).
- Cada bloque Reed-Solomon se valida por separado, pero un mensaje de varios fragmentos solo se recupera si llegan todos. `send(..., repeat=N)` lo envía N veces para rellenar huecos, a costa de N veces el tiempo de aire.
- Los símbolos largos cuestan tasa: un bloque de `robust` dura unos 10 s. No hay seguimiento de reloj ni búsqueda fina de alineación (ggwave prueba 16 desplazamientos por trama). Los valores de tramas y paridad se eligieron con mediciones de un solo equipo y sala (`diagnostico_aire/`).

`docs/SPEC.md` es la especificación que se dio al agente que escribió el código inicial.
