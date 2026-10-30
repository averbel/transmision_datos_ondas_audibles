# SpaceWases

Módem acústico propio en Python (solo `numpy` y la biblioteca estándar) para enviar datos por sonido con altavoz y micrófono. Código escrito desde cero; ggwave (MIT, Georgi Gerganov) se tomó como referencia para el diseño; no se copió código de él.

## Qué incluye

- `spacewases/rs.py`: Reed-Solomon sobre GF(256).
- `spacewases/modem.py`: modulación MFSK a 48 kHz con sincronía por chirp (bins de 46,875 Hz desde 1875 Hz).
- `spacewases/frame.py`: tramas con cabecera, HMAC-SHA256 truncado a 4 bytes, fragmentación y protección Reed-Solomon.
- `spacewases/api.py`: `send` y `receive`, con perfiles `robust`, `normal` y `fast`.
- `spacewases/cli.py`: codificar y decodificar archivos WAV.
- `bench.py`: éxito frente a SNR con ruido gaussiano simulado; `prueba_aire.py`: prueba real altavoz → micrófono.

## Web

`web/` es una página estática (sin dependencias ni compilación): envía y recibe con altavoz y micrófono, muestra el espectro y trae una prueba local con ruido ajustable. `web/spacewases.js` es un port exacto del Python; se comprobó que cada lado decodifica lo que emite el otro.

```bash
cd web
python -m http.server 8790
node test/roundtrip.mjs   # 29 pruebas, incluye WAV generados por Python
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
| robust | −10 dB | 64,6 bps |
| normal | −10 dB | 72,5 bps |
| fast | −8 dB | 76,1 bps |

Estas cifras son de simulación, no de aire. Tampoco se compararon con ggwave bajo las mismas condiciones, así que no deben leerse como una ventaja sobre él. La prueba real con altavoz y micrófono está **pendiente**: hay una serie parcial (168 de 180 ensayos, `aire_resultados.csv`) sin analizar y cuyas condiciones no se controlaron hasta el final, así que no es un resultado.

## Límites conocidos

- El HMAC de 4 bytes autentica pero no cifra: el mensaje viaja en claro.
- No hay protección contra repetición: una trama grabada se puede reproducir. Con `key=None` la trama se firma con clave vacía y cualquiera puede fabricarla.
- Un mensaje es un solo flujo: si un bloque Reed-Solomon falla, se pierde completo.
- Sin prefijo cíclico ni seguimiento de reloj: el eco de una sala real puede causar interferencia entre símbolos. No está medido.

`docs/SPEC.md` es la especificación que se dio al agente que escribió el código inicial.
