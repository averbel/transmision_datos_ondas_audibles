# Diagnóstico de la prueba por aire (2026-10-31)

Scripts que se usaron para investigar por qué `prueba_aire.py` falla (9 de 180 ensayos). Todos reproducen sonido por el altavoz y graban con el micrófono sin tocar el volumen del sistema.

**Están escritos para el PC de esa sesión**: las rutas (`C:\t\repo\mi_version`) y los índices de dispositivo (salida 4, entrada 1; rutas MME, DirectSound y WASAPI en `air_diag.py`) hay que adaptarlos. Lista los tuyos con `python -c "import sounddevice as sd; print(sd.query_devices())"`.

| Script | Qué mide |
|---|---|
| `air_diag.py` | Errores de byte antes de RS y respuesta en frecuencia (barrido 0,5–8 kHz) con tres rutas de audio de Windows |
| `air_drift.py` | Deriva de reloj entre el chirp inicial y el final, y dónde caen los bytes erróneos |
| `air_tones.py` | Precisión por índice de tono (0–15) en cada grupo y qué índice se recibe cuando falla |
| `air_equalize.py` | Prueba fuera de línea: normalizar cada tono con su respuesta medida |
| `air_offset.py` | Barrido del desplazamiento de la ventana de análisis y si los errores copian al símbolo vecino |
| `air_dfe.py` | Prueba fuera de línea: restar una fracción de la potencia del símbolo anterior (DFE) |
| `air_cp_sweep.py` | Precisión de nibble y de byte según el largo del prefijo cíclico (0 a 4096) |
| `air_diversity.py` | Diversidad en frecuencia: el mismo nibble en los dos grupos, con y sin DFE |
| `air_single_tone.py` | Separa diversidad de interferencia entre tonos: diseño actual, mismo nibble en ambos grupos y un solo tono |
| `air_integrate.py` | Símbolos de 1, 2, 3 y 6 tramas con suma de tramas descartando la primera, como hace ggwave |
| `air_div_frames.py` | Diversidad combinada con símbolos de 1, 2 y 3 tramas, sin DFE |
| `grabar_secuencia.py` | Graba tres mensajes seguidos por aire para pasarlos por el receptor en flujo con `web/test/stream_grabacion.mjs` |

Resultados y conclusiones: ver el punto 0 de `CONTINUAR.md` en la raíz del repositorio.
