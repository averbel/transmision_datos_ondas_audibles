import sys, subprocess, random, string, json, numpy as np, sounddevice as sd
OUT, INP = int(sys.argv[1]), int(sys.argv[2])
PROTOS = [(0,"Audible Normal"),(1,"Audible Fast"),(2,"Audible Fastest"),(4,"Ultrasound Fast")]
T = int(sys.argv[3]); GAIN = float(sys.argv[4]); only = sys.argv[5] if len(sys.argv)>5 else None
FS = 48000
sd.default.samplerate = FS
def rec_play(sig):
    pad = np.zeros(FS, dtype=np.float32)
    x = np.concatenate([pad, sig*GAIN, pad]).astype(np.float32)
    y = sd.playrec(x.reshape(-1,1), samplerate=FS, channels=1, device=(INP, OUT), dtype='float32')
    sd.wait()
    return x, y[:,0]
# ruido de fondo
noise = sd.rec(int(2*FS), samplerate=FS, channels=1, device=INP, dtype='float32'); sd.wait()
Pn = float(np.mean(noise**2)); print("ruido RMS", Pn**.5, flush=True)
res = []
for pid, name in PROTOS:
    if only and only != name: continue
    ok = 0; snrs = []; t_ = []
    for t in range(T):
        pay = ''.join(random.choice(string.ascii_lowercase) for _ in range(16))
        subprocess.run(['./enc.exe', str(pid), pay, 'tx.raw'], capture_output=True)
        sig = np.fromfile('tx.raw', dtype=np.float32)
        x, y = rec_play(sig)
        y.astype(np.float32).tofile('rx.raw')
        r = subprocess.run(['./dec.exe', 'rx.raw'], capture_output=True, text=True).stdout.strip()
        good = (r == 'OK ' + pay)
        ok += good
        e = np.cumsum(np.concatenate([[0], y.astype(np.float64)**2]))
        w = len(sig); win = e[w:] - e[:-w]
        Ps = float(win.max()/w); snr = 10*np.log10(max(Ps-Pn,1e-12)/Pn)
        snrs.append(snr); t_.append(len(sig)/FS)
        print(f"{name} #{t+1} {'OK' if good else 'FAIL'} snr={snr:.1f}dB peak={float(np.max(np.abs(y))):.3f}", flush=True)
    res.append(dict(protocol=name, trials=T, success=int(ok), snr_mean=float(np.mean(snrs)), snr_min=float(np.min(snrs)), seconds=float(np.mean(t_))))
print(json.dumps(res))
