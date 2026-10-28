import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
plt.rcParams.update({'font.family':'serif','font.serif':['Times New Roman','DejaVu Serif'],'font.size':8})

# Fig A: tasas publicadas (bps), escala log
data=[
 ("Lee et al. (2015)",15,'#7f7f7f'),
 ("Madhavapeddy: OOK 21,2 kHz",8,'#1f77b4'),
 ("Madhavapeddy: DTMF",20,'#1f77b4'),
 ("Madhavapeddy: tonos de llamada",83,'#1f77b4'),
 ("Madhavapeddy: OOK 10 kHz",251,'#1f77b4'),
 ("Digital Voices",80,'#7f7f7f'),
 ("Nearby (Getreuer)",84,'#7f7f7f'),
 ("ggwave (audible/inaudible)",268,'#d62728'),
 ("HRCSS",500,'#7f7f7f'),
 ("Gonçalves et al. (2017)",600,'#7f7f7f'),
 ("PriWhisper",729,'#7f7f7f'),
 ("Dhwani",2400,'#2ca02c'),
 ("Tabak et al. (2021)",4000,'#2ca02c'),
]
data.sort(key=lambda x:x[1])
fig,ax=plt.subplots(figsize=(3.4,3.0),dpi=300)
ax.barh([d[0] for d in data],[d[1] for d in data],color=[d[2] for d in data])
ax.set_xscale('log'); ax.set_xlabel('Tasa neta (bps, escala log)')
for i,d in enumerate(data): ax.text(d[1]*1.1,i,f"{d[1]:,}".replace(',','.'),va='center',fontsize=6)
ax.set_xlim(5,2e4); ax.grid(axis='x',alpha=.3,which='both',linewidth=.3)
ax.tick_params(axis='y',labelsize=6.5)
plt.tight_layout(); plt.savefig('fig_rates.png'); plt.close()

# Fig B: exito vs SNR (mis mediciones)
import csv,collections
d=collections.defaultdict(dict)
for r in csv.reader(open('results2.csv')):
    d[r[1]][int(r[2])]=100*int(r[4])/int(r[3])
fig,ax=plt.subplots(figsize=(3.4,2.4),dpi=300)
for k,m in [("Audible Normal",'o'),("Audible Fast",'s'),("Audible Fastest",'^'),("DT Fast",'x')]:
    xs=sorted(d[k]); ax.plot(xs,[d[k][x] for x in xs],marker=m,ms=3,lw=1,label=k)
ax.set_xlabel('SNR de banda ancha (dB)'); ax.set_ylabel('Éxito (%)'); ax.set_ylim(-3,103)
ax.grid(alpha=.3,linewidth=.3); ax.legend(fontsize=6,frameon=False)
plt.tight_layout(); plt.savefig('fig_snr.png'); plt.close()
print('ok')
