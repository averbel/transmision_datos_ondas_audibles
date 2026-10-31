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

1. **Prueba real por aire** con `mi_version/prueba_aire.py SALIDA ENTRADA ENSAYOS`: volumen del sistema fijo y puesto por la persona, sin audífonos, cuarto en silencio. La serie en `aire_resultados.csv` está incompleta (168 de 180) y no es un resultado. Hay que repetirla entera.
2. Hallazgos de revisión: **hecho en Python (2026-10-31)** trama v2 con clave (cifrado HMAC-SHA256 en modo contador, sesión de marca de tiempo + nonce, etiqueta de 8 bytes, rechazo de v1 con clave) y `ReplayGuard` opcional en `receive(signal, key, guard)`; 28 pruebas pasan. Sin guardia no hay protección contra repetición. **Pendiente:** portar la v2 a `web/spacewases.js` y regenerar los fixtures con clave (hoy las pruebas JS con clave fallarían), recuperación por fragmento y prefijo cíclico contra eco de sala.
3. Añadir SpaceWases y sus resultados reales al paper, marcando qué es simulación y qué es aire.
4. Elegir licencia para el material propio y decidir si el repositorio sigue privado. Publicar la web con https (por ejemplo GitHub Pages) hace pública la página.
5. Borrar a mano el repositorio equivocado `Andres0122/transmision-datos-ondas-audibles`.

## Acuerdos de trabajo

- Autoría: Andrés Felipe Verbel Pacheco (CUC), averbel1@cuc.edu.co. En commits usar su nombre; no deben aparecer `Claude` ni `Andres0122` en el repositorio.
- ggwave (MIT, Georgi Gerganov) se dice que se **tomó como referencia**, no que se clonó ni copió. Mantener su aviso de licencia.
- Las pruebas con volumen alto las hace la persona subiendo el volumen; Claude no cambia la configuración del sistema.
- Para ahorrar tokens se delegó código a agentes gratuitos de OpenCode (`opencode run -m opencode/big-pickle`; `nemotron-3-ultra-free` falló). Siempre se verifican las pruebas aparte.
- Regenerar el PDF desde el HTML con Edge headless (ver `README.md`).
