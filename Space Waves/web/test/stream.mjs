// Pruebas del receptor en flujo: se le pasa el audio en trozos, como llega del microfono.
import { send, StreamReceiver, LiveSession, SendQueue, ReplayGuard, Resampler, FS, CHIRP_LEN } from "../spacewaves.js";

let passed = 0;
let failed = 0;

function pass(name) {
  passed++;
  console.log(`PASS ${name}`);
}

function fail(name, detail) {
  failed++;
  console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}

function makeRng(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 4294967296;
  };
}

function gaussian(rng) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function concat(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function noise(seconds, sigma, rng) {
  const out = new Float32Array(Math.round(seconds * FS));
  for (let i = 0; i < out.length; i++) out[i] = sigma * gaussian(rng);
  return out;
}

// Pasa la senal en trozos de tamano variable (1024-8192) y junta los eventos.
async function stream(receiver, signal, rng, key = null, guard = null) {
  const events = [];
  let offset = 0;
  while (offset < signal.length) {
    const size = 1024 + Math.floor(rng() * 7168);
    const ev = await receiver.push(signal.subarray(offset, offset + size), key, guard);
    events.push(...ev.results);
    offset += size;
  }
  return events;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

async function check(name, fn) {
  try {
    const result = await fn();
    if (result === true) pass(name);
    else fail(name, typeof result === "string" ? result : "");
  } catch (error) {
    fail(name, error.message);
  }
}

await check("un mensaje entre silencio y ruido, en trozos", async () => {
  const rng = makeRng(1);
  const sig = await send(enc.encode("hola flujo"), null, "normal");
  const audio = concat([noise(2, 0.01, rng), sig, noise(2, 0.01, rng)]);
  const events = await stream(new StreamReceiver(), audio, rng);
  if (events.length !== 1) return `eventos: ${events.length}`;
  return dec.decode(events[0].message) === "hola flujo" || "mensaje distinto";
});

await check("dos mensajes seguidos con perfiles distintos", async () => {
  const rng = makeRng(2);
  const a = await send(enc.encode("primero"), null, "fast");
  const b = await send(enc.encode("segundo"), null, "robust");
  const audio = concat([noise(1, 0.01, rng), a, noise(1.5, 0.01, rng), b, noise(1, 0.01, rng)]);
  const events = await stream(new StreamReceiver(), audio, rng);
  const texts = events.map((e) => (e.message ? `${dec.decode(e.message)}/${e.profile}` : null));
  return JSON.stringify(texts) === JSON.stringify(["primero/fast", "segundo/robust"]) || JSON.stringify(texts);
});

await check("mensaje de más de 32 s (antes no cabía en la ventana)", async () => {
  const rng = makeRng(3);
  const text = "x".repeat(500);
  const sig = await send(enc.encode(text), null, "robust");
  if (sig.length / FS <= 32) return `la señal dura solo ${(sig.length / FS).toFixed(1)} s`;
  const audio = concat([noise(1, 0.01, rng), sig, noise(1, 0.01, rng)]);
  const events = await stream(new StreamReceiver(), audio, rng);
  return (events.length === 1 && dec.decode(events[0].message) === text) || `eventos: ${events.length}`;
});

await check("solo ruido: ningún evento", async () => {
  const rng = makeRng(4);
  const receiver = new StreamReceiver();
  const events = await stream(receiver, noise(20, 0.05, rng), rng);
  return (events.length === 0 && receiver.state === "idle") || `eventos: ${events.length}, estado ${receiver.state}`;
});

await check("con clave y guardia: la repetición se informa como rechazada", async () => {
  const rng = makeRng(5);
  const key = enc.encode("frase larga de prueba");
  const sig = await send(enc.encode("abrir"), key, "fast");
  const audio = concat([noise(1, 0.01, rng), sig, noise(1, 0.01, rng), sig, noise(1, 0.01, rng)]);
  const guard = new ReplayGuard();
  const events = await stream(new StreamReceiver(), audio, rng, key, guard);
  if (events.length !== 2) return `eventos: ${events.length}`;
  return (dec.decode(events[0].message) === "abrir" && events[1].rejected === "repetido") || JSON.stringify(events[1]);
});

await check("señal cortada sin chirp final: falla al llegar al tope y vuelve a reposo", async () => {
  const rng = makeRng(6);
  const sig = await send(enc.encode("se corta"), null, "fast");
  const truncated = sig.subarray(0, Math.floor(sig.length / 2));
  const receiver = new StreamReceiver({ maxSeconds: 6 });
  const audio = concat([noise(1, 0.01, rng), truncated, noise(6, 0.01, rng)]);
  const events = await stream(receiver, audio, rng);
  return (events.length === 1 && events[0].failed && receiver.state === "idle") || `eventos: ${events.length}`;
});

await check("trozos grandes (0,5 a 4 s, hilo ocupado): no se pierde ningún mensaje", async () => {
  const rng = makeRng(9);
  const a = await send(enc.encode("primero"), null, "fast");
  const b = await send(enc.encode("segundo"), null, "fast");
  const audio = concat([noise(1.3, 0.01, rng), a, noise(1, 0.01, rng), b, noise(3, 0.01, rng)]);
  for (const seconds of [0.5, 1, 2, 4]) {
    const receiver = new StreamReceiver();
    const step = Math.round(seconds * FS);
    const texts = [];
    for (let off = 0; off < audio.length; off += step) {
      const ev = await receiver.push(audio.subarray(off, off + step));
      for (const r of ev.results) texts.push(r.message ? dec.decode(r.message) : "fallo");
    }
    if (JSON.stringify(texts) !== JSON.stringify(["primero", "segundo"])) return `${seconds} s: ${JSON.stringify(texts)}`;
  }
  return true;
});

await check("dos mensajes en un mismo trozo: salen los dos, en orden", async () => {
  const rng = makeRng(10);
  const a = await send(enc.encode("uno"), null, "fast");
  const b = await send(enc.encode("dos"), null, "normal");
  const audio = concat([noise(0.5, 0.01, rng), a, noise(0.5, 0.01, rng), b, noise(0.5, 0.01, rng)]);
  const ev = await new StreamReceiver().push(audio);
  const texts = ev.results.map((r) => (r.message ? `${dec.decode(r.message)}/${r.profile}` : "fallo"));
  return JSON.stringify(texts) === JSON.stringify(["uno/fast", "dos/normal"]) || JSON.stringify(texts);
});

// Reloj simulado para los turnos: sleep avanza el tiempo sin esperar de verdad.
class VirtualTime {
  constructor() {
    this.t = 0;
    this.waiting = [];
    this.now = () => this.t;
    this.sleep = (ms) => new Promise((resolve) => this.waiting.push({ at: this.t + ms, resolve }));
  }

  async run() {
    for (let idle = 0; idle < 5; idle++) {
      await new Promise((resolve) => setImmediate(resolve));
      if (this.waiting.length === 0) continue;
      idle = -1;
      this.waiting.sort((a, b) => a.at - b.at);
      const next = this.waiting.shift();
      this.t = next.at;
      next.resolve();
    }
  }
}

await check("cola: con el canal libre emite enseguida y en orden", async () => {
  const time = new VirtualTime();
  const sent = [];
  const queue = new SendQueue({
    isBusy: () => false,
    transmit: async (item) => {
      sent.push(`${item}@${time.t}`);
      await time.sleep(1000);
    },
    random: () => 0.5,
    backoffMs: 1000,
    now: time.now,
    sleep: time.sleep,
  });
  queue.push("uno");
  queue.push("dos");
  await time.run();
  // El segundo deja antes el retardo aleatorio, para dar paso a quien esperara.
  return JSON.stringify(sent) === JSON.stringify(["uno@0", "dos@1500"]) || JSON.stringify(sent);
});

await check("cola: espera mientras alguien emite y sigue esperando si vuelve a estar ocupado", async () => {
  const time = new VirtualTime();
  const sent = [];
  // Ocupado hasta 2 s, libre durante el retardo y otra vez ocupado de 2,2 a 4 s.
  const isBusy = () => time.t < 2000 || (time.t >= 2200 && time.t < 4000);
  const queue = new SendQueue({
    isBusy,
    transmit: async (item) => sent.push(`${item}@${time.t}`),
    random: () => 0.5,
    backoffMs: 1000,
    now: time.now,
    sleep: time.sleep,
  });
  queue.push("hola");
  await time.run();
  const at = Number(sent[0].split("@")[1]);
  return (sent.length === 1 && at >= 4000 && !isBusy()) || JSON.stringify(sent);
});

await check("cola: no espera para siempre si el canal no se libera", async () => {
  const time = new VirtualTime();
  const sent = [];
  const queue = new SendQueue({
    isBusy: () => true,
    transmit: async (item) => sent.push(`${item}@${time.t}`),
    maxWaitMs: 5000,
    now: time.now,
    sleep: time.sleep,
  });
  queue.push("hola");
  await time.run();
  return (sent.length === 1 && Number(sent[0].split("@")[1]) >= 5000) || JSON.stringify(sent);
});

await check("cola: el mensaje escrito mientras se emite sale después, sin perderse", async () => {
  const time = new VirtualTime();
  const sent = [];
  const queue = new SendQueue({
    isBusy: () => false,
    transmit: async (item) => {
      sent.push(item);
      if (item === "uno") queue.push("dos");
      await time.sleep(1000);
    },
    random: () => 0,
    now: time.now,
    sleep: time.sleep,
  });
  queue.push("uno");
  await time.run();
  return JSON.stringify(sent) === JSON.stringify(["uno", "dos"]) || JSON.stringify(sent);
});

// Dos dispositivos que esperan a que termine un tercero. Cada uno tarda LAG en oír al otro.
const COLLISION_LAG = 250;
const EMISSION = 2750;
let collisionRate = 0;

await check("turnos: dos dispositivos que esperan suelen no chocar y ninguno pierde el turno", async () => {
  const rng = makeRng(21);
  const trials = 400;
  let collisions = 0;
  for (let trial = 0; trial < trials; trial++) {
    const time = new VirtualTime();
    const starts = [null, null];
    const hears = (other) => {
      if (time.t < 1000) return true; // El tercero emite durante el primer segundo.
      const s = starts[other];
      return s !== null && time.t >= s + COLLISION_LAG && time.t < s + EMISSION + COLLISION_LAG;
    };
    const device = (me) =>
      new SendQueue({
        isBusy: () => hears(1 - me),
        transmit: async () => {
          starts[me] = time.t;
          await time.sleep(EMISSION);
        },
        random: rng,
        now: time.now,
        sleep: time.sleep,
      });
    device(0).push("a");
    device(1).push("b");
    await time.run();
    if (starts[0] === null || starts[1] === null) return `turno ${trial}: alguien no emitió`;
    if (Math.abs(starts[0] - starts[1]) < EMISSION) collisions++;
  }
  collisionRate = collisions / trials;
  console.log(`     colisiones con dos esperando: ${(100 * collisionRate).toFixed(1)} %`);
  return collisionRate < 0.25 || `${(100 * collisionRate).toFixed(1)} %`;
});

await check("ocupado: se avisa desde que llega el chirp y se libera al terminar", async () => {
  const rng = makeRng(22);
  const sig = await send(enc.encode("turno"), null, "normal");
  const audio = concat([noise(0.5, 0.01, rng), sig, noise(0.5, 0.01, rng)]);
  const receiver = new StreamReceiver();
  const chirpEnd = Math.round(0.5 * FS) + CHIRP_LEN;
  const signalEnd = Math.round(0.5 * FS) + sig.length;
  let firstBusy = null;
  let lastBusy = null;
  for (let off = 0; off < audio.length; off += 2048) {
    await receiver.push(audio.subarray(off, off + 2048));
    if (receiver.busy) {
      firstBusy ??= off + 2048;
      lastBusy = off + 2048;
    }
  }
  const lag = (firstBusy - chirpEnd) / FS;
  if (firstBusy === null) return "nunca estuvo ocupado";
  if (lag > 0.1) return `tarda ${lag.toFixed(2)} s desde el final del chirp`;
  return (lastBusy >= signalEnd - 5000 && !receiver.busy) || `último ocupado ${lastBusy}, fin ${signalEnd}`;
});

await check("ocupado: una falsa detección solo bloquea hasta probar la longitud", async () => {
  const rng = makeRng(23);
  const sig = await send(enc.encode("x"), null, "fast");
  const receiver = new StreamReceiver();
  await stream(receiver, concat([noise(0.5, 0.01, rng), sig.subarray(0, CHIRP_LEN), noise(3, 0.01, rng)]), rng);
  return (receiver.state === "candidate" && !receiver.busy) || `estado ${receiver.state}, ocupado ${receiver.busy}`;
});

await check("sonidos que no son mensajes: ningún mensaje ni error, y vuelve a reposo", async () => {
  const seconds = 12;
  const tone = (fn) => Float32Array.from({ length: seconds * FS }, (_, i) => fn(i / FS));
  const sounds = {
    tono: tone((t) => 0.3 * Math.sin(2 * Math.PI * 3000 * t)),
    barrido: tone((t) => {
      const u = t % 0.15;
      return 0.3 * Math.sin(2 * Math.PI * (1000 * u + (3000 * u * u) / 0.15));
    }),
    acordes: tone((t) => {
      let s = 0;
      for (const f of [523, 1047, 1568, 2093, 3136, 4186]) s += Math.sin(2 * Math.PI * f * (1 + (Math.floor(t * 2) % 5) / 12) * t);
      return 0.05 * s;
    }),
    voz: (() => {
      // La fase se integra: el tono de una voz sube y baja despacio, no barre como un chirp.
      let phase = 0;
      return tone((t) => {
        phase += (2 * Math.PI * (130 + 60 * Math.sin(2 * Math.PI * 1.3 * t))) / FS;
        let s = 0;
        for (let h = 1; h <= 20; h++) s += Math.sin(h * phase) / h;
        return 0.2 * s * (0.5 + 0.5 * Math.sin(2 * Math.PI * 2.7 * t));
      });
    })(),
  };
  for (const [name, audio] of Object.entries(sounds)) {
    const receiver = new StreamReceiver();
    const rng = makeRng(20);
    const events = await stream(receiver, concat([audio, noise(32, 0.001, rng)]), rng);
    if (events.length !== 0 || receiver.state !== "idle") return `${name}: ${events.length} eventos, estado ${receiver.state}`;
  }
  return true;
});

await check("sin chirp final: decodifica por la longitud, sin esperar al tope", async () => {
  const rng = makeRng(11);
  const sig = await send(enc.encode("sin final"), null, "fast");
  const audio = concat([noise(1, 0.01, rng), sig.subarray(0, sig.length - CHIRP_LEN), noise(1, 0.01, rng)]);
  const receiver = new StreamReceiver();
  const events = await stream(receiver, audio, rng);
  if (events.length !== 1 || !events[0].message) return `eventos: ${events.length}`;
  return (dec.decode(events[0].message) === "sin final" && receiver.state === "idle") || "mensaje distinto";
});

await check("chirp final débil y otro mensaje detrás: salen los dos", async () => {
  const rng = makeRng(12);
  const a = await send(enc.encode("primero"), null, "fast");
  const b = await send(enc.encode("segundo"), null, "fast");
  const debil = Float32Array.from(a);
  for (let i = debil.length - CHIRP_LEN; i < debil.length; i++) debil[i] *= 0.02;
  const audio = concat([noise(1, 0.01, rng), debil, noise(1, 0.01, rng), b, noise(1, 0.01, rng)]);
  const events = await stream(new StreamReceiver(), audio, rng);
  const texts = events.map((e) => (e.message ? dec.decode(e.message) : "fallo"));
  return JSON.stringify(texts) === JSON.stringify(["primero", "segundo"]) || JSON.stringify(texts);
});

await check("falsa detección seguida de un mensaje: se recibe el mensaje y no hay error", async () => {
  const rng = makeRng(13);
  const sig = await send(enc.encode("real"), null, "fast");
  const audio = concat([noise(1, 0.01, rng), sig.subarray(0, CHIRP_LEN), noise(2, 0.01, rng), sig, noise(1, 0.01, rng)]);
  const events = await stream(new StreamReceiver(), audio, rng);
  const texts = events.map((e) => (e.message ? dec.decode(e.message) : "fallo"));
  return JSON.stringify(texts) === JSON.stringify(["real"]) || JSON.stringify(texts);
});

await check("falsa detección sola: pasa a candidato, se abandona sin error y vuelve a reposo", async () => {
  const rng = makeRng(14);
  const sig = await send(enc.encode("x"), null, "fast");
  const receiver = new StreamReceiver();
  let events = await stream(receiver, concat([noise(1, 0.01, rng), sig.subarray(0, CHIRP_LEN), noise(3, 0.01, rng)]), rng);
  if (receiver.state !== "candidate" || events.length !== 0) return `estado ${receiver.state}`;
  events = await stream(receiver, noise(31, 0.01, rng), rng);
  return (events.length === 0 && receiver.state === "idle") || `eventos ${events.length}, estado ${receiver.state}`;
});

await check("progreso: solo con mensaje confirmado, creciente y hasta 1", async () => {
  const rng = makeRng(15);
  const sig = await send(enc.encode("avance"), null, "normal");
  const audio = concat([noise(0.5, 0.01, rng), sig, noise(0.5, 0.01, rng)]);
  const receiver = new StreamReceiver();
  const seen = [];
  for (let off = 0; off < audio.length; off += 4096) {
    await receiver.push(audio.subarray(off, off + 4096));
    if (receiver.progress !== null) seen.push(receiver.progress);
  }
  const increasing = seen.every((v, i) => i === 0 || v >= seen[i - 1]);
  return (seen.length > 5 && increasing && seen[0] > 0 && seen[seen.length - 1] <= 1) || JSON.stringify(seen.slice(0, 5));
});

await check("mensaje repetido con la primera copia dañada, sin chirp final: lo salva la segunda", async () => {
  const rng = makeRng(16);
  const sig = await send(enc.encode("dos copias"), null, "fast", 2);
  const damaged = Float32Array.from(sig.subarray(0, sig.length - CHIRP_LEN));
  const copy = (damaged.length - CHIRP_LEN) / 2;
  for (let i = Math.floor(copy * 0.55); i < Math.floor(copy * 0.75); i++) damaged[i] = 0.5 * gaussian(rng);
  const audio = concat([noise(0.5, 0.01, rng), damaged, noise(4, 0.01, rng)]);
  const events = await stream(new StreamReceiver(), audio, rng);
  const texts = events.map((e) => (e.message ? dec.decode(e.message) : "fallo"));
  return texts[0] === "dos copias" || JSON.stringify(texts);
});

await check("clave equivocada: falla una vez y sigue recibiendo", async () => {
  const rng = makeRng(17);
  const a = await send(enc.encode("secreto"), enc.encode("otra frase larga"), "fast");
  const b = await send(enc.encode("abierto"), null, "fast");
  const audio = concat([noise(0.5, 0.01, rng), a, noise(1, 0.01, rng), b, noise(1, 0.01, rng)]);
  const events = await stream(new StreamReceiver(), audio, rng);
  const texts = events.map((e) => (e.message ? dec.decode(e.message) : "fallo"));
  return JSON.stringify(texts) === JSON.stringify(["fallo", "abierto"]) || JSON.stringify(texts);
});

await check("grabación larga: el búfer no se copia en cada trozo", async () => {
  const receiver = new StreamReceiver();
  const sig = await send(enc.encode("x".repeat(500)), null, "robust");
  const started = performance.now();
  let worst = 0;
  for (let off = 0; off < sig.length; off += 4096) {
    const t0 = performance.now();
    await receiver.push(sig.subarray(off, off + 4096));
    worst = Math.max(worst, performance.now() - t0);
  }
  const elapsed = performance.now() - started;
  return (receiver.state === "idle" && elapsed < 3000) || `${elapsed.toFixed(0)} ms, peor ${worst.toFixed(0)} ms`;
});

await check("LiveSession: en cola, en orden y sin decodificar dos veces a la vez", async () => {
  const rng = makeRng(18);
  const a = await send(enc.encode("uno"), null, "fast");
  const b = await send(enc.encode("dos"), null, "fast");
  const audio = concat([noise(0.5, 0.01, rng), a, noise(1, 0.01, rng), b, noise(1, 0.01, rng)]);
  const texts = [];
  const session = new LiveSession(FS, (event) => {
    for (const r of event.results) texts.push(r.message ? dec.decode(r.message) : "fallo");
  });
  for (let off = 0; off < audio.length; off += 4096) session.feed(audio.slice(off, off + 4096), null, false);
  while (session.running) await new Promise((resolve) => setTimeout(resolve, 5));
  return JSON.stringify(texts) === JSON.stringify(["uno", "dos"]) || JSON.stringify(texts);
});

await check("LiveSession: reset descarta lo recibido y sigue funcionando", async () => {
  const rng = makeRng(19);
  const a = await send(enc.encode("cortado"), null, "fast");
  const b = await send(enc.encode("entero"), null, "fast");
  const texts = [];
  const session = new LiveSession(FS, (event) => {
    for (const r of event.results) texts.push(r.message ? dec.decode(r.message) : "fallo");
  });
  session.feed(concat([noise(0.5, 0.01, rng), a.subarray(0, a.length >> 1)]), null, false);
  session.reset();
  session.feed(concat([noise(0.5, 0.01, rng), b, noise(1, 0.01, rng)]), null, false);
  while (session.running) await new Promise((resolve) => setTimeout(resolve, 5));
  return JSON.stringify(texts) === JSON.stringify(["entero"]) || JSON.stringify(texts);
});

// Remuestreo lineal de una sola vez, como "microfono" a otra frecuencia en las pruebas.
function resampleOnce(input, fromRate, toRate) {
  const step = fromRate / toRate;
  const out = new Float32Array(Math.floor((input.length - 1) / step) + 1);
  for (let i = 0; i < out.length; i++) {
    const index = Math.floor(i * step);
    const fraction = i * step - index;
    const b = input[Math.min(index + 1, input.length - 1)];
    out[i] = input[index] + (b - input[index]) * fraction;
  }
  return out;
}

await check("Resampler: en trozos da lo mismo que de una vez", async () => {
  const rng = makeRng(7);
  const input = noise(1, 0.3, rng);
  for (const rate of [16000, 44100, 96000]) {
    const whole = resampleOnce(input, rate, FS);
    const resampler = new Resampler(rate, FS);
    const parts = [];
    for (let off = 0; off < input.length; ) {
      const size = 1 + Math.floor(rng() * 5000);
      parts.push(resampler.push(input.subarray(off, off + size)));
      off += size;
    }
    const chunked = concat(parts);
    if (Math.abs(chunked.length - whole.length) > 1) return `${rate}: ${chunked.length} vs ${whole.length}`;
    const n = Math.min(chunked.length, whole.length);
    for (let i = 0; i < n; i++) {
      if (Math.abs(chunked[i] - whole[i]) > 1e-5) return `${rate}: difiere en ${i}`;
    }
  }
  return true;
});

await check("micrófono a 16 y 44,1 kHz remuestreado en lotes de 200 ms", async () => {
  const rng = makeRng(8);
  const sig = await send(enc.encode("otra frecuencia"), null, "normal");
  const audio = concat([noise(1, 0.01, rng), sig, noise(1, 0.01, rng)]);
  for (const rate of [16000, 44100]) {
    const mic = resampleOnce(audio, FS, rate);
    const resampler = new Resampler(rate, FS);
    const receiver = new StreamReceiver();
    const batch = Math.round(rate * 0.2);
    const texts = [];
    for (let off = 0; off < mic.length; off += batch) {
      const ev = await receiver.push(resampler.push(mic.subarray(off, off + batch)));
      if (ev.message !== null) texts.push(dec.decode(ev.message));
      else if (ev.failed) texts.push("fallo");
    }
    if (JSON.stringify(texts) !== JSON.stringify(["otra frecuencia"])) return `${rate}: ${JSON.stringify(texts)}`;
  }
  return true;
});

console.log("");
console.log(`Resumen: ${passed} PASS, ${failed} FAIL`);
process.exit(failed === 0 ? 0 : 1);
