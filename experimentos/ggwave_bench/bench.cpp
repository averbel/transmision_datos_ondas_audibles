// Banco de pruebas sobre ggwave: canal AWGN simulado + medicion de duracion.
#include "ggwave/ggwave.h"
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cmath>
#include <random>
#include <vector>

int main() {
    ggwave_setLogFile(nullptr);
    ggwave_Parameters p = ggwave_getDefaultParameters();
    p.sampleFormatInp = GGWAVE_SAMPLE_FORMAT_F32;
    p.sampleFormatOut = GGWAVE_SAMPLE_FORMAT_F32;
    ggwave_Instance inst = ggwave_init(p);

    std::mt19937 rng(12345);
    std::normal_distribution<float> gauss(0.f, 1.f);

    struct P { int id; const char* name; };
    P protos[] = {
        {GGWAVE_PROTOCOL_AUDIBLE_NORMAL, "Audible Normal"},
        {GGWAVE_PROTOCOL_AUDIBLE_FAST, "Audible Fast"},
        {GGWAVE_PROTOCOL_AUDIBLE_FASTEST, "Audible Fastest"},
        {GGWAVE_PROTOCOL_ULTRASOUND_FAST, "Ultrasound Fast"},
        {GGWAVE_PROTOCOL_DT_FAST, "DT Fast"},
    };

    // Experimento 1: duracion y tasa efectiva vs longitud de payload (sin ruido)
    printf("#EXP1 protocol,len,samples,seconds,effective_Bps,ok\n");
    int lens[] = {4, 8, 16, 32, 64, 100, 140};
    for (auto& pr : protos) for (int L : lens) {
        std::vector<char> pay(L);
        for (auto& c : pay) c = 'a' + rng() % 26;
        int n = ggwave_encode(inst, pay.data(), L, (ggwave_ProtocolId)pr.id, 25, nullptr, 1);
        std::vector<char> w(n);
        ggwave_encode(inst, pay.data(), L, (ggwave_ProtocolId)pr.id, 25, w.data(), 0);
        int ns = n / sizeof(float);
        // relleno de silencio
        std::vector<float> buf(ns + 2 * 8192, 0.f);
        memcpy(buf.data() + 8192, w.data(), n);
        char out[256] = {0};
        int r = ggwave_ndecode(inst, buf.data(), buf.size() * sizeof(float), out, 255);
        bool ok = (r == L) && memcmp(out, pay.data(), L) == 0;
        double sec = ns / 48000.0;
        printf("EXP1,%s,%d,%d,%.3f,%.2f,%d\n", pr.name, L, ns, sec, L / sec, ok);
    }

    // Experimento 2: tasa de exito vs SNR (AWGN), payload 16 bytes
    printf("#EXP2 protocol,snr_db,trials,success\n");
    const int L = 16, T = 60;
    for (auto& pr : protos) {
        for (int snr = -6; snr <= 24; snr += 2) {
            int succ = 0;
            for (int t = 0; t < T; ++t) {
                char pay[L];
                for (int i = 0; i < L; ++i) pay[i] = 'a' + rng() % 26;
                int n = ggwave_encode(inst, pay, L, (ggwave_ProtocolId)pr.id, 25, nullptr, 1);
                std::vector<char> w(n);
                ggwave_encode(inst, pay, L, (ggwave_ProtocolId)pr.id, 25, w.data(), 0);
                int ns = n / sizeof(float);
                std::vector<float> buf(ns + 2 * 8192, 0.f);
                memcpy(buf.data() + 8192, w.data(), n);
                // potencia de la senal (solo tramo activo)
                double pw = 0;
                for (int i = 0; i < ns; ++i) { float s = buf[8192 + i]; pw += s * s; }
                pw /= ns;
                double sigma = sqrt(pw / pow(10.0, snr / 10.0));
                for (auto& s : buf) s += (float)(sigma * gauss(rng));
                char out[256] = {0};
                int r = ggwave_ndecode(inst, buf.data(), buf.size() * sizeof(float), out, 255);
                if (r == L && memcmp(out, pay, L) == 0) ++succ;
            }
            printf("EXP2,%s,%d,%d,%d\n", pr.name, snr, T, succ);
        }
    }
    ggwave_free(inst);
    return 0;
}
