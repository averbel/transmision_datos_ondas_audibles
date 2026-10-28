#include "ggwave/ggwave.h"
#include <cstdio>
#include <cstdlib>
#include <vector>
// uso: dec <in.raw>  -> imprime payload o FAIL
int main(int argc, char** argv) {
    if (argc < 2) return 2;
    ggwave_setLogFile(nullptr);
    ggwave_Parameters p = ggwave_getDefaultParameters();
    p.sampleFormatInp = GGWAVE_SAMPLE_FORMAT_F32; p.sampleFormatOut = GGWAVE_SAMPLE_FORMAT_F32;
    ggwave_Instance g = ggwave_init(p);
    FILE* f = fopen(argv[1], "rb"); if (!f) return 3;
    fseek(f, 0, SEEK_END); long n = ftell(f); fseek(f, 0, SEEK_SET);
    std::vector<char> b(n); fread(b.data(), 1, n, f); fclose(f);
    char out[256] = {0};
    int r = ggwave_ndecode(g, b.data(), n, out, 255);
    if (r > 0) printf("OK %s\n", out); else printf("FAIL %d\n", r);
    return 0;
}
