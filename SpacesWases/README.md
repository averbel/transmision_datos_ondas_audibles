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

`web/` es una página estática (sin dependencias ni compilación) con la disposición de Waver, la app de ggwave: pestañas Ajustes, Mensajes y Espectro; un historial con líneas `hora | Recv/Send | protocolo | texto`; una línea de estado (escuchando, recibiendo, enviando con barra de progreso), y la caja de envío abajo. Ajustes reúne el volumen, el protocolo, las repeticiones, la clave, los WAV y una prueba sin micrófono. El espectro muestra la cascada del micrófono. El audio del micrófono se captura con un `AudioWorklet` (`web/captura.js`), que no pierde muestras aunque la página esté ocupada, y se decodifica en un hilo aparte (`web/receptor.js`), que no congela la página; donde no hay Workers de módulo se decodifica en la propia página. `web/spacewases.js` es un port del Python, con el mismo formato de señal; se comprobó que cada lado decodifica lo que emite el otro.

El receptor en vivo (`StreamReceiver`) detecta el chirp de inicio con un umbral bajo y lee el bloque de longitud, que descarta las falsas detecciones y dice dónde acaba el mensaje. Así decodifica aunque el chirp final llegue débil o no llegue, muestra el avance real y no se queda grabando en una falsa detección.

```bash
cd web
python -m http.server 8790
node test/roundtrip.mjs   # 63 pruebas, incluye WAV generados por Python
node test/stream.mjs      # 21 pruebas del receptor en flujo y del remuestreo
```

Abre `http://localhost:8790`. El micrófono solo funciona en `localhost` o `https`.

### Publicar en GitHub Pages

El flujo `.github/workflows/pages.yml` corre las pruebas JS y publica solo `index.html`, `app.js`, `spacewases.js`, `captura.js`, `receptor.js` y `style.css`. Pages sirve con https, que el micrófono necesita. No se ejecuta solo: hay que lanzarlo a mano.

1. Decidir antes la visibilidad (la licencia es MIT, `LICENSE` en la raíz): la página publicada es pública aunque el repositorio sea privado, y Pages en un repositorio privado requiere un plan de pago de GitHub.
2. En GitHub: *Settings → Pages → Build and deployment → Source: GitHub Actions*.
3. En cada publicación, cambiar la versión `?v=AAAAMMDD` en `web/index.html` (dos veces), `web/app.js` (tres veces) y `web/receptor.js`, para que nadie se quede con un JS viejo en caché; correr las pruebas de Python y JS; hacer push.
4. *Actions → Publicar web → Run workflow*. La dirección queda en el resumen del trabajo (`https://<usuario>.github.io/<repositorio>/`).

La página declara una política de seguridad de contenido que solo permite cargar recursos del mismo sitio.

### Publicar en Vercel

Publicada en https://spacewases.vercel.app (proyecto `averbels-projects/spacewases`, sin conexión a GitHub: cada push no publica nada). Para publicar de nuevo, desde `web/`: `npx vercel deploy --prod`. `.vercelignore` deja fuera `SPEC.md` y `test/`, y `vercel.json` añade cabeceras de seguridad (la misma política de contenido más `frame-ancestors 'none'`, `nosniff`, sin referer y micrófono solo para el propio sitio). La regla de cambiar `?v=` en cada publicación es la misma.

## Uso

```bash
pip install numpy pytest sounddevice
python -m pytest -q
python -m spacewases.cli encode "hola" salida.wav --profile robust
python -m spacewases.cli decode salida.wav
```

La clave opcional se pasa con `--key` o, mejor, con la variable de entorno `SPACEWASES_KEY`, para que no quede en el historial ni en la lista de procesos.

## Resultados

**Por aire** (`aire_2026-10-31_longitud_b.csv`): altavoz y micrófono integrados de un portátil, una sala, volumen del sistema fijo, mensaje de 16 B, 10 ensayos por punto; la ganancia digital baja la señal emitida.

| Ganancia | robust | normal | fast |
|---|---|---|---|
| 1,0 | 10/10 | 6/10 | 8/10 |
| 0,5 | 10/10 | 7/10 | 8/10 |
| 0,25 | 10/10 | 8/10 | 9/10 |
| 0,12 | 10/10 | 10/10 | 10/10 |
| 0,06 | 9/10 | 10/10 | 10/10 |
| 0,03 | 5/10 | 9/10 | 8/10 |
| **Total** | **54/60** | **50/60** | **53/60** |

Evolución en la misma prueba: símbolos de una trama 9/180 (`aire_2026-10-31.csv`), símbolos de varias tramas con bloques rellenos 142/180 (`aire_2026-10-31_tramas.csv`) y sin relleno 157/180. Una variante sin relleno con paridad proporcional al bloque dio 106/180 (`aire_2026-10-31_longitud.csv`) y se descartó. El diagnóstico está en `diagnostico_aire/`. Es un solo equipo y una sala: falta repetirlo en otros.

**Receptor en vivo, sobre el mismo audio por aire** (2026-11-01, `aire_2026-11-01_receptores*.csv`): 90 capturas por serie (3 perfiles, 6 ganancias, 5 ensayos, 16 B), pasadas en trozos de 4096 muestras por el receptor anterior y por el actual. El volumen del sistema estaba más bajo que en la tabla de arriba, así que estas cifras no se comparan con aquellas.

| Ganancia | Serie con la que se eligió el umbral | Serie nueva de validación |
|---|---|---|
| 1,0 | 14 → 14 de 15 | 14 → 14 de 15 |
| 0,5 | 14 → 14 de 15 | 14 → 14 de 15 |
| 0,25 | 7 → 14 de 15 | 8 → 14 de 15 |
| 0,12 | 0 → 12 de 15 | 0 → 9 de 15 |
| 0,06 | 0 → 2 de 15 | 0 → 3 de 15 |
| 0,03 | 0 → 0 de 15 | 0 → 0 de 15 |
| **Total** | **35 → 56 de 90** | **36 → 54 de 90** |

En las dos series ningún mensaje empeora y ninguno sale erróneo. La mejora está en los volúmenes bajos; con volumen alto el resultado es el mismo. Es recepción con altavoz y micrófono del mismo portátil: falta repetirlo entre dos dispositivos.

**Simulación con ruido blanco** (16 B, 100 intentos por punto, semilla fija; `bench_resultados.csv` y `bench_bps.csv`): robust decodifica el 100 % desde −20 dB y cae a 4 % en −22 dB; normal y fast, el 100 % desde −16 dB y 3 % y 1 % en −18 dB. Esta SNR es de toda la señal e incluye los chirps. Tasa neta con 16 B: robust 17,4 bps, normal 27,8 y fast 33,4 (antes, con bloques rellenos a 48 B: 12,4 / 21,1 / 24,1). No se comparó con ggwave en las mismas condiciones.

## Límites conocidos

- Con `key=None` (trama v1) el mensaje viaja en claro y se firma con clave vacía: cualquiera puede fabricar tramas. Con clave (trama v2) el mensaje va cifrado y autenticado con una etiqueta de 8 bytes. La clave pasa por PBKDF2-HMAC-SHA256 (600 000 iteraciones, sal fija `spacewases-pbkdf2-v1`), que encarece los ataques de diccionario pero no salva una frase débil.
- La protección contra repetición es opcional y del receptor: hay que pasar un `ReplayGuard` a `receive`. Exige relojes razonablemente sincronizados (ventana de 120 s por defecto).
- Cada bloque Reed-Solomon se valida por separado, pero un mensaje de varios fragmentos solo se recupera si llegan todos. `send(..., repeat=N)` lo envía N veces para rellenar huecos, a costa de N veces el tiempo de aire.
- Los símbolos largos cuestan tasa: un bloque de `robust` dura unos 10 s. No hay seguimiento de reloj. Si la posición que da el chirp no decodifica, el receptor prueba la ventana desplazada 0, −256, −512 y +256 muestras (ggwave prueba 16 desplazamientos por trama); sobre las mismas 45 grabaciones por aire pasó de 44 a 45 decodificadas (`aire_2026-10-31_alineacion.csv`). Los valores de tramas, paridad y umbral de inicio se eligieron con mediciones de un solo equipo y sala (`diagnostico_aire/`).
- Un mensaje cuyo bloque de longitud se dañe y que no tenga repeticiones no se puede decodificar. Una falsa detección se abandona en silencio, sin molestar en el historial; si un sonido imita también el chirp final, puede aparecer un aviso de señal no decodificada.

`docs/SPEC.md` es la especificación que se dio al agente que escribió el código inicial.
