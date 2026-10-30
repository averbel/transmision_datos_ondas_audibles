# Transmisión de datos mediante ondas audibles

Investigación (Universidad de la Costa, CUC) sobre comunicación de datos por sonido con altavoz y micrófono:
fundamentos del canal acústico, estado del arte con cifras publicadas y un estudio de caso del sistema
abierto [ggwave](https://github.com/ggerganov/ggwave).

## Contenido

| Carpeta | Qué hay |
|---|---|
| `paper/` | Artículo en formato IEEE de dos columnas: `Articulo_IEEE_Transmision_ondas_audibles.pdf`, su fuente `articulo.html`, las figuras y `make_figures.py`. |
| `mi_version/` | **spacewases**, módem acústico propio en Python con pruebas y benchmark. Ver `mi_version/README.md`. |
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
- Prueba acústica real con volumen y distancia controlados: pendiente.
- Versión propia del sistema (`mi_version/`): hecha y probada con ruido simulado; faltan la prueba real por aire, la protección contra repetición y la recuperación por fragmento.

## Atribución y licencia

El análisis se basa en ggwave de Georgi Gerganov (MIT). Las referencias completas están en el artículo.
Autor: Andrés Felipe Verbel Pacheco (CUC).
No se ha elegido aún una licencia para este material propio.
