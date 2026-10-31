import { readFileSync } from "node:fs";
import {
  send,
  receive,
  wavDecode,
  PROFILES,
  ReplayGuard,
  CHIRP_LEN,
  GUARD,
  SYMBOL,
  CYCLIC_PREFIX,
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
    // Anula 20 simbolos dentro del bloque 1 de la primera copia (normal: bloques de 68 simbolos).
    const start = CHIRP_LEN + GUARD + 80 * (SYMBOL + CYCLIC_PREFIX);
    const out = Float32Array.from(signal);
    out.fill(0, start, start + 20 * (SYMBOL + CYCLIC_PREFIX));
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

console.log("");
console.log(`Resumen: ${passed} PASS, ${failed} FAIL`);
process.exit(failed === 0 ? 0 : 1);
