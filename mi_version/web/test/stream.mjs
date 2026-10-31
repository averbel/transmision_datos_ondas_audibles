// Pruebas del receptor en flujo: se le pasa el audio en trozos, como llega del microfono.
import { send, StreamReceiver, ReplayGuard, Resampler, FS } from "../spacewases.js";

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
    if (ev.message !== null || ev.rejected !== null || ev.failed) events.push(ev);
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
  const texts = events.map((e) => (e.message ? dec.decode(e.message) : null));
  return JSON.stringify(texts) === JSON.stringify(["primero", "segundo"]) || JSON.stringify(texts);
});

await check("mensaje de más de 32 s (antes no cabía en la ventana)", async () => {
  const rng = makeRng(3);
  const text = "x".repeat(150);
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
