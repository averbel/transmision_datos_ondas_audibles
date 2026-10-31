# Para continuar en otro PC

Resumen del estado al 2026-10-30. Pégalo o pide a Claude que lo lea al empezar una sesión nueva en este repositorio.

## Qué hay

- `paper/`: artículo IEEE de dos columnas (PDF + fuente `articulo.html`). Es una investigación general sobre transmisión de datos por ondas audibles; ggwave aparece como caso de estudio y referencia, no como tema único. Datos reales: literatura verificada y mediciones con ruido simulado.
- `mi_version/`: **SpaceWases**, módem acústico propio en Python (`spacewases/`), con pruebas (`pytest`, 23), benchmark (`bench.py`) y web estática (`web/`, port a JavaScript con 29 pruebas en `node web/test/roundtrip.mjs`).
- `experimentos/`: banco de pruebas de ggwave (C++) y herramientas antiguas de prueba por aire.

## Puesta en marcha

```bash
git clone https://github.com/averbel/transmision-datos-ondas-audibles.git
cd transmision-datos-ondas-audibles/mi_version
pip install numpy pytest sounddevice
python -m pytest -q
```

El repositorio es privado: inicia sesión con la cuenta GitHub `averbel` (no `Andres0122`). Los índices de dispositivos de audio cambian entre PC; lista los tuyos con `python -c "import sounddevice as sd; print(sd.query_devices())"`.

## Pendiente

0. **Resultado de la prueba por aire del 2026-10-31** (`mi_version/aire_2026-10-31.csv`, 180 ensayos completos, salida 4 Altavoces Realtek, entrada 1 Varios micrófonos Realtek, volumen que tenía el sistema): solo 9/180 decodificaron (robust 7/60, normal 1/60, fast 1/60) y el éxito **no** sube con la ganancia ni con la SNR medida (en robust, 0,03 dio 3/10 y 1,0 dio 1/10; la SNR acústica medida es errática), así que el ruido no explica el fallo. La serie anterior (parcial, módem sin prefijo) tuvo robust 10/10 a ganancia 0,5, pero en otras condiciones no controladas. Un A/B corto el mismo día (robust, ganancia 0,5, 5 ensayos por caso) dio 0/10: sin prefijo 20–31 de 78 bytes erróneos antes de RS, con prefijo 15–24; robust corrige solo 10. Conclusión: no es una regresión del prefijo, que ayuda un poco, pero **en este equipo y sala el canal aire falla** por una causa no identificada (candidatas: mejoras de audio/AGC del micrófono, volumen o nivel de captura bajos —el pico captado fue 0,04–0,1—, distorsión del altavoz, eco). No se añadió al paper. Antes de publicar la web hay que diagnosticarlo (otro equipo, volumen alto fijo, mejoras de audio desactivadas) y repetir la serie entera.
1. **Prueba real por aire** con `mi_version/prueba_aire.py SALIDA ENTRADA ENSAYOS`: volumen del sistema fijo y puesto por la persona, sin audífonos, cuarto en silencio. La serie en `aire_resultados.csv` está incompleta (168 de 180) y no es un resultado. Hay que repetirla entera.
2. Hallazgos de revisión: **hecho en Python (2026-10-31)** trama v2 con clave (cifrado HMAC-SHA256 en modo contador, sesión de marca de tiempo + nonce, etiqueta de 8 bytes, rechazo de v1 con clave) y `ReplayGuard` opcional en `receive(signal, key, guard)`; 28 pruebas pasan. Sin guardia no hay protección contra repetición. **Port JS hecho:** `web/spacewases.js` (v2, `ReplayGuard`, `receive(signal, key, onStatus, guard)`), fixtures con clave regenerados y 34 pruebas JS pasan; verificado también JS→Python por CLI. La web en vivo todavía no usa `ReplayGuard`. **Hecho también:** recuperación por fragmento (cada bloque RS se valida solo; `send(..., repeat=N)` repite el mensaje para rellenar huecos) y prefijo cíclico de 256 muestras en el módem (Py y JS, cambia la señal en el aire: los WAV viejos ya no decodifican). Costó 25 % de tasa neta (ahora 53,4 / 60,1 / 63,3 bps). En simulación ayuda con ecos dentro del prefijo; no está medido en una sala real. 32 pruebas Python y 36 JS pasan. **Interfaz web (2026-10-31, pensada para despliegue público):** selector de repeticiones (1–3) con duración estimada, casilla de rechazo de repetidos/antiguos al escuchar (activa por defecto, con el motivo; no aplica a WAV), etiquetas "cifrado / sin cifrar" en los mensajes, aviso de que la clave no sale del navegador y pie de página corregido (decía que no se cifraba). 38 pruebas JS pasan; verificada a mano en un navegador local sin errores de consola. **Pendiente antes de publicar:** (a) la clave se usa tal cual como clave HMAC, sin función de derivación (PBKDF2/scrypt): una frase corta se puede adivinar por fuerza bruta offline; cambiarlo toca Python, JS y los fixtures; (b) servir con https; (c) el resultado negativo de la prueba por aire (punto 0); (d) licencia.
3. SpaceWases en el paper: **hecho (2026-10-31)** sección VIII, Tabla V y notas en resumen, validez y conclusiones; todo marcado como simulación, sin datos de aire. PDF regenerado (6 páginas; solo verifiqué el texto extraído, no el aspecto visual: conviene abrirlo y revisar el maquetado). Cuando exista la serie real por aire (punto 1), añadirla a la sección VIII y a la X.
4. Elegir licencia para el material propio y decidir si el repositorio sigue privado. Publicar la web con https (por ejemplo GitHub Pages) hace pública la página.
5. Borrar a mano el repositorio equivocado `Andres0122/transmision-datos-ondas-audibles`.

## Acuerdos de trabajo

- Autoría: Andrés Felipe Verbel Pacheco (CUC), averbel1@cuc.edu.co. En commits usar su nombre; no deben aparecer `Claude` ni `Andres0122` en el repositorio.
- ggwave (MIT, Georgi Gerganov) se dice que se **tomó como referencia**, no que se clonó ni copió. Mantener su aviso de licencia.
- Las pruebas con volumen alto las hace la persona subiendo el volumen; Claude no cambia la configuración del sistema.
- Para ahorrar tokens se delegó código a agentes gratuitos de OpenCode (`opencode run -m opencode/big-pickle`; `nemotron-3-ultra-free` falló). Siempre se verifican las pruebas aparte.
- Regenerar el PDF desde el HTML con Edge headless (ver `README.md`).
