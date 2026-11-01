import { readFileSync } from "node:fs";
import {
  send,
  receive,
  wavDecode,
  wavEncode,
  PROFILES,
  FRAMES,
  ReplayGuard,
  CHIRP_LEN,
  GUARD,
  SYMBOL,
  FS,
  modulate,
  demodulate,
  signalSeconds,
  masterKey,
  findChirp,
} from "../spacewases.js";

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

function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function makeMessage(length) {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = (i * 37 + 11) & 0xff;
  return out;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const keyCases = [
  ["sin clave", null],
  ["con clave", encoder.encode("clave")],
];

for (const profile of Object.keys(PROFILES)) {
  for (const [keyName, key] of keyCases) {
    for (const length of [0, 16, 100, 500]) {
      const name = `send/receive ${profile} ${keyName} ${length} B`;
      try {
        const message = makeMessage(length);
        const signal = await send(message, key, profile);
        const result = await receive(signal, key);
        if (result === null) {
          fail(name, "receive devolvió null");
        } else if (!equalBytes(result, message)) {
          fail(name, `esperado ${length} B, obtenido ${result.length} B`);
        } else {
          pass(name);
        }
      } catch (error) {
        fail(name, error.message);
      }
    }
  }
}

const fixtures = [
  ["py_robust.wav", "clave", "hola spacewases robust"],
  ["py_normal.wav", "clave", "hola spacewases normal"],
  ["py_fast.wav", "clave", "hola spacewases fast"],
  ["py_nokey.wav", null, "mensaje sin clave"],
];

for (const [file, keyText, expected] of fixtures) {
  const name = `fixture ${file}`;
  try {
    const bytes = new Uint8Array(readFileSync(new URL(`./fixtures/${file}`, import.meta.url)));
    const signal = wavDecode(bytes);
    const result = await receive(signal, keyText === null ? null : encoder.encode(keyText));
    const text = result === null ? null : decoder.decode(result);
    if (text === expected) pass(name);
    else fail(name, `obtenido ${JSON.stringify(text)}`);
  } catch (error) {
    fail(name, error.message);
  }
}

{
  const key = encoder.encode("clave");
  const message = encoder.encode("abrir puerta");
  const check = async (name, fn) => {
    try {
      const ok = await fn();
      if (ok) pass(name);
      else fail(name);
    } catch (error) {
      fail(name, error.message);
    }
  };
  await check("v2: clave errónea devuelve null", async () => {
    const signal = await send(message, key, "normal");
    return (await receive(signal, encoder.encode("otra"))) === null;
  });
  await check("v2: v1 sin clave no se acepta con clave", async () => {
    const signal = await send(message, null, "normal");
    return (await receive(signal, key)) === null;
  });
  await check("v2: señal con clave no se acepta sin clave", async () => {
    const signal = await send(message, key, "normal");
    return (await receive(signal, null)) === null;
  });
  await check("v2: ReplayGuard rechaza la repetición", async () => {
    const guard = new ReplayGuard();
    const signal = await send(message, key, "normal");
    const first = await receive(signal, key, null, guard);
    const second = await receive(signal, key, null, guard);
    const fresh = await receive(await send(message, key, "normal"), key, null, guard);
    return first !== null && equalBytes(first, message) && second === null && fresh !== null;
  });
  await check("v2: ventana de tiempo", async () => {
    const guard = new ReplayGuard(60, () => Date.now() / 1000 + 3600);
    const signal = await send(message, key, "normal");
    return (await receive(signal, key, null, guard)) === null && guard.lastReason === "antiguo";
  });
  await check("v2: ReplayGuard informa el motivo del rechazo", async () => {
    const guard = new ReplayGuard();
    const signal = await send(message, key, "normal");
    await receive(signal, key, null, guard);
    const reasonAfterOk = guard.lastReason;
    await receive(signal, key, null, guard);
    return reasonAfterOk === null && guard.lastReason === "repetido";
  });
  await check("v2: repeat=3 con clave", async () => {
    const result = await receive(await send(message, key, "normal", 3), key);
    return result !== null && equalBytes(result, message);
  });
}

{
  const message = makeMessage(100);
  const wipeBlock = (signal) => {
    // Anula 20 simbolos dentro del bloque 1 de la primera copia (normal: bloques de 90 simbolos).
    const period = FRAMES.normal * SYMBOL;
    const start = CHIRP_LEN + GUARD + 110 * period;
    const out = Float32Array.from(signal);
    out.fill(0, start, start + 20 * period);
    return out;
  };
  try {
    const once = await receive(wipeBlock(await send(message, null, "normal")), null);
    const twice = await receive(wipeBlock(await send(message, null, "normal", 2)), null);
    if (once === null) pass("sin repetición un bloque anulado pierde el mensaje");
    else fail("sin repetición un bloque anulado pierde el mensaje");
    if (twice !== null && equalBytes(twice, message)) pass("repeat=2 recupera con un bloque anulado");
    else fail("repeat=2 recupera con un bloque anulado");
  } catch (error) {
    fail("recuperación por fragmento", error.message);
  }
}

{
  // El mismo vector esta en tests/test_spacewases.py: Python y JS deben derivar igual.
  const name = "PBKDF2: misma clave maestra que Python";
  try {
    const hex = Array.from(await masterKey(encoder.encode("clave")), (b) => b.toString(16).padStart(2, "0")).join("");
    if (hex === "5291958f4436a8226a06d5c96faa7d72e5d1ca4221d7e80cf1e8242d5fda62e3") pass(name);
    else fail(name, hex);
  } catch (error) {
    fail(name, error.message);
  }
}

{
  // Datos 500 muestras antes de lo que indica el chirp: la busqueda de alineacion los recupera.
  const name = "búsqueda de alineación recupera datos adelantados";
  try {
    const message = makeMessage(40);
    const signal = await send(message, null, "normal");
    const early = new Float32Array(signal.length - 500);
    early.set(signal.subarray(0, CHIRP_LEN), 0);
    early.set(signal.subarray(CHIRP_LEN + 500), CHIRP_LEN);
    const result = await receive(early, null);
    if (result !== null && equalBytes(result, message)) pass(name);
    else fail(name);
  } catch (error) {
    fail(name, error.message);
  }
}

for (const frames of [1, 2, 3, 6]) {
  const name = `módem con símbolos de ${frames} trama(s)`;
  try {
    const data = makeMessage(64);
    const got = demodulate(modulate(data, frames), frames);
    if (got !== null && equalBytes(got, data)) pass(name);
    else fail(name);
  } catch (error) {
    fail(name, error.message);
  }
}

for (const profile of Object.keys(PROFILES)) {
  const name = `signalSeconds coincide con send (${profile})`;
  try {
    const message = makeMessage(100);
    const key = encoder.encode("clave");
    const signal = await send(message, key, profile, 2);
    const expected = signalSeconds(message.length, profile, true, 2);
    if (Math.abs(signal.length / FS - expected) < 1e-9) pass(name);
    else fail(name, `${signal.length / FS} s frente a ${expected} s`);
  } catch (error) {
    fail(name, error.message);
  }
}

{
  const name = "ReplayGuard: un fallo posterior no hereda el motivo anterior";
  try {
    const key = encoder.encode("clave");
    const guard = new ReplayGuard();
    const signal = await send(encoder.encode("hola"), key, "fast");
    await receive(signal, key, null, guard);
    await receive(signal, key, null, guard);
    const silence = new Float32Array(FS);
    const result = await receive(silence, key, null, guard);
    if (result === null && guard.lastReason === null) pass(name);
    else fail(name, `lastReason=${guard.lastReason}`);
  } catch (error) {
    fail(name, error.message);
  }
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

{
  const attempts = 20;
  const rng = makeRng(0x5eed1234);
  let successes = 0;
  try {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const message = new Uint8Array(100);
      for (let i = 0; i < message.length; i++) message[i] = Math.floor(rng() * 256);
      const signal = await send(message, null, "robust");
      let power = 0;
      for (let i = 0; i < signal.length; i++) power += signal[i] * signal[i];
      power /= signal.length;
      const sigma = Math.sqrt(power);
      const noisy = new Float32Array(signal.length);
      for (let i = 0; i < signal.length; i++) noisy[i] = signal[i] + sigma * gaussian(rng);
      const result = await receive(noisy, null);
      if (result !== null && equalBytes(result, message)) successes++;
    }
    const name = `AWGN 0 dB robust (${successes}/${attempts})`;
    if (successes >= Math.ceil(attempts * 0.9)) pass(name);
    else fail(name, `se esperaban al menos ${Math.ceil(attempts * 0.9)}`);
  } catch (error) {
    fail("AWGN 0 dB robust", error.message);
  }
}

{
  // La correlación por bloques encuentra el chirp exacto también cuando cae en la
  // frontera entre bloques, y sobre 90 s tarda poco.
  const chirp = modulate(new Uint8Array(0)).subarray(0, CHIRP_LEN);
  const rng = makeRng(0xc41f);
  const step = (1 << 16) - CHIRP_LEN + 1;
  let ok = true;
  let detail = "";
  for (const pos of [0, step - 1, step, step + 1, 2 * step - CHIRP_LEN, 300000 - CHIRP_LEN]) {
    const s = new Float32Array(300000);
    for (let i = 0; i < s.length; i++) s[i] = 0.05 * gaussian(rng);
    for (let i = 0; i < CHIRP_LEN; i++) s[pos + i] += 0.5 * chirp[i];
    const found = findChirp(s);
    if (found.index !== pos || found.score < 0.9) {
      ok = false;
      detail = `pos ${pos}: ${found.index} (${found.score.toFixed(3)})`;
    }
  }
  if (ok) pass("findChirp por bloques: posición exacta en las fronteras");
  else fail("findChirp por bloques: posición exacta en las fronteras", detail);

  const long = new Float32Array(90 * FS);
  long.set(chirp, 60 * FS);
  const started = performance.now();
  const found = findChirp(long);
  const elapsed = performance.now() - started;
  if (found.index === 60 * FS && elapsed < 2500) pass(`findChirp sobre 90 s en ${elapsed.toFixed(0)} ms`);
  else fail("findChirp sobre 90 s", `índice ${found.index}, ${elapsed.toFixed(0)} ms`);
}

{
  // Cabeceras WAV que no son PCM de 16 bits o son incoherentes se rechazan con un error claro.
  const good = wavEncode(new Float32Array(100));
  const cases = [
    ["formato no PCM", (v) => v.setUint16(20, 3, true)],
    ["cero canales", (v) => v.setUint16(22, 0, true)],
    ["blockAlign incoherente", (v) => v.setUint16(32, 1, true)],
  ];
  for (const [label, mutate] of cases) {
    const bytes = good.slice();
    mutate(new DataView(bytes.buffer));
    try {
      wavDecode(bytes);
      fail(`WAV inválido rechazado: ${label}`, "no lanzó error");
    } catch {
      pass(`WAV inválido rechazado: ${label}`);
    }
  }
}

{
  // Entradas inválidas: error claro, nunca una señal o un mensaje a medias.
  const noises = async (label, action) => {
    try {
      await action();
      fail(`entrada inválida rechazada: ${label}`, "no lanzó error");
    } catch {
      pass(`entrada inválida rechazada: ${label}`);
    }
  };
  await noises("perfil desconocido", () => send(new Uint8Array(1), null, "ultra"));
  await noises("repeat 0", () => send(new Uint8Array(1), null, "fast", 0));
  await noises("mensaje demasiado largo", () => send(new Uint8Array(13000), null, "fast"));
  await noises("frames 0", () => modulate(new Uint8Array(1), 0));
  await noises("WAV corto", () => wavDecode(new Uint8Array(4)));
  await noises("no es WAV", () => wavDecode(new Uint8Array(44)));
  const wav = wavEncode(new Float32Array(100));
  const mutated = (mutate) => {
    const bytes = wav.slice();
    mutate(new DataView(bytes.buffer));
    return bytes;
  };
  await noises("WAV de 8 bits", () => wavDecode(mutated((v) => v.setUint16(34, 8, true))));
  await noises("WAV a otra frecuencia", () => wavDecode(mutated((v) => v.setUint32(24, 44100, true))));
  await noises("WAV sin bloque fmt", () => wavDecode(mutated((v) => v.setUint32(12, 0x61746164, false))));

  // La caché de claves está limitada y seguir usando una clave que salió de ella funciona.
  const message = encoder.encode("clave vuelta a derivar");
  const firstKey = encoder.encode("frase 0");
  const signal = await send(message, firstKey, "fast");
  for (let i = 1; i <= 9; i++) await send(message, encoder.encode(`frase ${i}`), "fast");
  const back = await receive(signal, firstKey);
  if (back !== null && equalBytes(back, message)) pass("caché de claves limitada: la clave expulsada se vuelve a derivar");
  else fail("caché de claves limitada: la clave expulsada se vuelve a derivar");
}

console.log("");
console.log(`Resumen: ${passed} PASS, ${failed} FAIL`);
process.exit(failed === 0 ? 0 : 1);
