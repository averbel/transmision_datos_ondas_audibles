#include "ggwave/ggwave.h"
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>
// uso: enc <protocolId> <payload> <out.raw>   (float32 mono 48 kHz)
int main(int argc, char** argv) {
    if (argc < 4) return 2;
    ggwave_setLogFile(nullptr);
    ggwave_Parameters p = ggwave_getDefaultParameters();
    p.sampleFormatInp = GGWAVE_SAMPLE_FORMAT_F32; p.sampleFormatOut = GGWAVE_SAMPLE_FORMAT_F32;
    ggwave_Instance g = ggwave_init(p);
    int L = strlen(argv[2]);
    int n = ggwave_encode(g, argv[2], L, (ggwave_ProtocolId)atoi(argv[1]), 50, nullptr, 1);
    std::vector<char> w(n);
    ggwave_encode(g, argv[2], L, (ggwave_ProtocolId)atoi(argv[1]), 50, w.data(), 0);
    FILE* f = fopen(argv[3], "wb"); fwrite(w.data(), 1, n, f); fclose(f);
    printf("%d\n", n / 4);
    return 0;
}
