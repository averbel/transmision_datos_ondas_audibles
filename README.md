<picture>
  <source media="(prefers-color-scheme: dark)" srcset="SpacesWases/web/logo-blanco.svg">
  <img src="SpacesWases/web/logo-negro.svg" alt="SpaceWases" width="420">
</picture>

# Transmisión de datos mediante ondas audibles

Investigación (Universidad de la Costa, CUC) sobre comunicación de datos por sonido con altavoz y micrófono:
fundamentos del canal acústico, estado del arte con cifras publicadas y un estudio de caso del sistema
abierto [ggwave](https://github.com/ggerganov/ggwave).

**Web en uso:** https://spacewases.vercel.app — envía y recibe texto por sonido entre dos dispositivos cercanos, con una interfaz al estilo de Waver (la app de ggwave). Ábrela en los dos, activa el micrófono en el que recibe y escribe en el otro.

## Contenido

| Carpeta | Qué hay |
|---|---|
| `paper/` | Artículo en formato IEEE de dos columnas: `Articulo_IEEE_Transmision_ondas_audibles.pdf`, su fuente `articulo.html`, las figuras y `make_figures.py`. `Informe_hallazgos_y_mejoras.pdf` reúne aparte los errores encontrados y cómo se mejoraron, y `Funcionamiento_interno_SpaceWases.pdf` explica cómo funciona la aplicación por dentro. |
| `SpacesWases/` | **SpaceWases**, módem acústico propio en Python con pruebas, benchmark y diagnóstico por aire. Ver `SpacesWases/README.md`. |
| `SpacesWases/web/` | La web publicada: port exacto del módem a JavaScript, sin dependencias, con sus pruebas en `web/test/`. |
| `experimentos/ggwave_bench/` | Banco de pruebas en C++ (canal con ruido blanco gaussiano simulado) y resultados en CSV. |
| `experimentos/prueba_acustica/` | Herramientas para la prueba real altavoz→micrófono (`enc.cpp`, `dec.cpp`, `air.py`). **Pendiente**: las series completas se descartaron por condiciones no controladas. |

## Reproducir

El código de ggwave no forma parte de este repositorio: se tomó como referencia para el análisis y las mediciones (licencia MIT, © 2020 Georgi Gerganov). Para reproducir las mediciones, descárgalo aparte en la misma versión:

```bash
git clone https://github.com/ggerganov/ggwave.git
git -C ggwave checkout 060aec7
```

Compilar el banco de pruebas (cualquier compilador C++17; se usó `zig c++`):

```bash
zig c++ -O2 -std=c++17 -I ggwave/include -I ggwave/src \
  experimentos/ggwave_bench/bench2.cpp ggwave/src/ggwave.cpp -o bench2
./bench2 > resultados.csv
```

Regenerar el PDF desde el HTML (Edge o Chrome):

```bash
msedge --headless=new --no-pdf-header-footer \
  --print-to-pdf=paper/Articulo_IEEE_Transmision_ondas_audibles.pdf paper/articulo.html
```

## Estado

- Revisión de literatura y análisis de ggwave: hecho.
- Mediciones con ruido simulado: hechas (`results2.csv`).
- Prueba acústica de ggwave con volumen y distancia controlados: pendiente.
- Versión propia (`SpacesWases/`): hecha. Transmite 3 bytes por símbolo, de 47 a 84 bps con 16 bytes. Con ruido simulado, Robusto decodifica el 100 % desde −14 dB, y Normal y Rápido desde −10 dB. Por aire, en un portátil y una sala, 85 de 90 mensajes; a volumen bajo, turnando mensajes con el formato anterior, 20 frente a 12 de 45. Los dispositivos se turnan solos para emitir. Tiene cifrado opcional con clave, protección contra repetición y recuperación por fragmento.
- Web: publicada en Vercel con la interfaz al estilo Waver. Probada por el autor entre dos dispositivos: a veces no recibía mensajes; se corrigió una causa (ver `CONTINUAR.md`, punto 9) y falta repetir esa prueba.

## Atribución y licencia

El análisis se basa en ggwave de Georgi Gerganov (MIT). Las referencias completas están en el artículo.
Autor: Andrés Felipe Verbel Pacheco (CUC).
El material propio se publica con licencia MIT (ver `LICENSE`). La licencia de ggwave es la suya y no cambia.
