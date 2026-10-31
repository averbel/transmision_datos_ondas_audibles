export const FS = 48000;
export const SYMBOL = 1024;
export const CYCLIC_PREFIX = 256;
export const BASE_BIN = 40;
export const N_TONES = 16;
export const TONE_STEP = 6;
export const CHIRP_MS = 150;
export const CHIRP_LEN = Math.trunc((FS * CHIRP_MS) / 1000);
export const CHIRP_F0 = 1500;
export const CHIRP_F1 = 6000;
export const GUARD = 384;
export const SYMBOL_RAMP = 64;
export const TONE_AMP = 0.36;
export const SYNC_THRESHOLD = 0.25;
export const MAGIC = 0xa5;
export const VERSION = 1;
export const HEADER_LEN = 6;
export const HMAC_LEN = 4;
export const VERSION_KEYED = 2;
export const SESSION_LEN = 10;
export const HEADER_LEN_V2 = HEADER_LEN + SESSION_LEN;
export const HMAC_LEN_V2 = 8;

export function dataLen(chunk, keyed) {
  return keyed ? HEADER_LEN_V2 + chunk + HMAC_LEN_V2 : HEADER_LEN + chunk + HMAC_LEN;
}

export const PROFILES = {
  robust: [0, 48, 20],
  normal: [1, 48, 10],
  fast: [2, 48, 6],
};

const PROFILE_ORDER = [PROFILES.robust, PROFILES.normal, PROFILES.fast];

const GF_POLY = 0x11d;
const GF_SIZE = 256;
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(GF_SIZE);

{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= GF_POLY;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
}

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function gfInv(a) {
  if (a === 0) throw new Error("inverso de cero en GF(256)");
  return GF_EXP[255 - GF_LOG[a]];
}

function gfPow(x, e) {
  if (e === 0) return 1;
  if (x === 0) return 0;
  return GF_EXP[(GF_LOG[x] * e) % 255];
}

function generator(nparity) {
  let gen = [1];
  for (let i = 0; i < nparity; i++) {
    const root = GF_EXP[i];
    const nxt = new Array(gen.length + 1).fill(0);
    for (let j = 0; j < gen.length; j++) {
      const coef = gen[j];
      nxt[j] ^= coef;
      nxt[j + 1] ^= gfMul(coef, root);
    }
    gen = nxt;
  }
  return gen;
}

function rsEncode(data, nparity) {
  if (nparity < 0) throw new Error("nparity negativo");
  if (nparity === 0) return Uint8Array.from(data);
  if (data.length + nparity > 255) throw new Error("bloque RS demasiado largo");
  const gen = generator(nparity);
  const work = new Array(data.length + nparity).fill(0);
  for (let i = 0; i < data.length; i++) work[i] = data[i];
  for (let i = 0; i < data.length; i++) {
    const coef = work[i];
    if (coef) {
      for (let j = 0; j < gen.length; j++) {
        work[i + j] ^= gfMul(gen[j], coef);
      }
    }
  }
  const out = new Uint8Array(data.length + nparity);
  out.set(data, 0);
  for (let i = 0; i < nparity; i++) out[data.length + i] = work[data.length + i];
  return out;
}

function evalDesc(coeffs, x) {
  let y = 0;
  for (let i = 0; i < coeffs.length; i++) y = gfMul(y, x) ^ coeffs[i];
  return y;
}

function evalAsc(coeffs, x) {
  let y = 0;
  for (let i = coeffs.length - 1; i >= 0; i--) y = gfMul(y, x) ^ coeffs[i];
  return y;
}

function solveGf(a, b) {
  const n = a.length;
  const m = new Array(n);
  for (let i = 0; i < n; i++) m[i] = a[i].slice().concat([b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = -1;
    for (let r = col; r < n; r++) {
      if (m[r][col]) {
        pivot = r;
        break;
      }
    }
    if (pivot === -1) throw new Error("sistema singular");
    if (pivot !== col) {
      const tmp = m[col];
      m[col] = m[pivot];
      m[pivot] = tmp;
    }
    const inv = gfInv(m[col][col]);
    for (let c = 0; c <= n; c++) m[col][c] = gfMul(m[col][c], inv);
    for (let r = 0; r < n; r++) {
      if (r !== col && m[r][col]) {
        const f = m[r][col];
        for (let c = 0; c <= n; c++) {
          m[r][c] ^= gfMul(f, m[col][c]);
        }
      }
    }
  }
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = m[i][n];
  return out;
}

function rsDecode(block, nparity) {
  if (nparity < 0) throw new Error("nparity negativo");
  if (nparity === 0) return Uint8Array.from(block);
  if (block.length > 255) throw new Error("bloque RS demasiado largo");
  if (block.length <= nparity) throw new Error("bloque sin datos");

  const syndromes = new Array(nparity);
  let anySyndrome = false;
  for (let j = 0; j < nparity; j++) {
    syndromes[j] = evalDesc(block, GF_EXP[j]);
    if (syndromes[j]) anySyndrome = true;
  }
  if (!anySyndrome) return block.slice(0, block.length - nparity);

  let locator = new Uint8Array(nparity + 1);
  let prev = new Uint8Array(nparity + 1);
  locator[0] = 1;
  prev[0] = 1;
  let degree = 0;
  let shift = 1;
  let last = 1;

  for (let n = 0; n < nparity; n++) {
    let disc = syndromes[n];
    for (let i = 1; i <= degree; i++) {
      disc ^= gfMul(locator[i], syndromes[n - i]);
    }
    if (disc === 0) {
      shift++;
      continue;
    }
    const coef = gfMul(disc, gfInv(last));
    const old = locator.slice();
    const limit = nparity + 1 - shift;
    for (let i = 0; i < limit; i++) {
      locator[i + shift] ^= gfMul(coef, prev[i]);
    }
    if (2 * degree <= n) {
      degree = n + 1 - degree;
      prev = old;
      last = disc;
      shift = 1;
    } else {
      shift++;
    }
  }

  if (degree > (nparity >> 1)) throw new Error("demasiados errores");

  const positions = [];
  for (let idx = 0; idx < block.length; idx++) {
    const power = block.length - 1 - idx;
    const root = GF_EXP[((-power % 255) + 255) % 255];
    if (evalAsc(locator, root) === 0) positions.push([idx, power]);
  }
  if (positions.length !== degree) throw new Error("locator inconsistente");

  const xs = positions.map(([, power]) => GF_EXP[((power % 255) + 255) % 255]);
  const rows = [];
  for (let j = 0; j < degree; j++) {
    const row = new Array(degree);
    for (let i = 0; i < degree; i++) row[i] = gfPow(xs[i], j);
    rows.push(row);
  }
  const magnitudes = solveGf(rows, syndromes.slice(0, degree));

  const fixed = block.slice();
  for (let i = 0; i < positions.length; i++) fixed[positions[i][0]] ^= magnitudes[i];

  for (let j = 0; j < nparity; j++) {
    if (evalDesc(fixed, GF_EXP[j])) throw new Error("correccion fallida");
  }
  return fixed.slice(0, fixed.length - nparity);
}

function makeChirp() {
  const n = CHIRP_LEN;
  const duration = n / FS;
  const chirp = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / FS;
    const phase = 2 * Math.PI * (CHIRP_F0 * t + ((CHIRP_F1 - CHIRP_F0) * t * t) / (2 * duration));
    chirp[i] = Math.sin(phase);
  }
  const ramp = Math.trunc(0.01 * FS);
  const edge = new Float64Array(ramp);
  for (let i = 0; i < ramp; i++) {
    const r = i / Math.max(ramp - 1, 1);
    edge[i] = 0.5 * (1 - Math.cos(Math.PI * r));
  }
  for (let i = 0; i < ramp; i++) chirp[i] *= edge[i];
  for (let i = 0; i < ramp; i++) chirp[n - ramp + i] *= edge[ramp - 1 - i];
  return chirp;
}

const CHIRP = makeChirp();
const CHIRP_REVERSED = CHIRP.slice().reverse();
let CHIRP_ENERGY = 0;
for (let i = 0; i < CHIRP.length; i++) CHIRP_ENERGY += CHIRP[i] * CHIRP[i];

// Cada simbolo ocupa CYCLIC_PREFIX + SYMBOL muestras: el prefijo es la continuacion
// periodica del tono y el receptor analiza solo las SYMBOL muestras posteriores.
const SYMBOL_PERIOD = CYCLIC_PREFIX + SYMBOL;

function makeSymbolEnvelope() {
  const env = new Float64Array(SYMBOL_PERIOD);
  env.fill(1);
  const ramp = Math.min(SYMBOL_RAMP, Math.trunc(SYMBOL_PERIOD / 2));
  const edge = new Float64Array(ramp);
  for (let i = 0; i < ramp; i++) {
    const r = i / Math.max(ramp - 1, 1);
    edge[i] = 0.5 * (1 - Math.cos(Math.PI * r));
  }
  for (let i = 0; i < ramp; i++) env[i] *= edge[i];
  for (let i = 0; i < ramp; i++) env[SYMBOL_PERIOD - ramp + i] *= edge[ramp - 1 - i];
  return env;
}

const SYMBOL_ENVELOPE = makeSymbolEnvelope();

function makeToneTable(offset) {
  const table = new Array(N_TONES);
  for (let k = 0; k < N_TONES; k++) {
    const freq = BASE_BIN + offset + TONE_STEP * k;
    const tone = new Float64Array(SYMBOL_PERIOD);
    for (let n = 0; n < SYMBOL_PERIOD; n++) {
      tone[n] = TONE_AMP * Math.sin((2 * Math.PI * (n - CYCLIC_PREFIX) * freq) / SYMBOL);
    }
    table[k] = tone;
  }
  return table;
}

const TONES_A = makeToneTable(0);
const TONES_B = makeToneTable(3);

const planCache = new Map();

function getPlan(n) {
  let plan = planCache.get(n);
  if (plan) {
    planCache.delete(n);
    planCache.set(n, plan);
    return plan;
  }
  const half = n >> 1;
  const cos = new Float64Array(half);
  const sin = new Float64Array(half);
  for (let i = 0; i < half; i++) {
    const a = (2 * Math.PI * i) / n;
    cos[i] = Math.cos(a);
    sin[i] = Math.sin(a);
  }
  const rev = new Uint32Array(n);
  let j = 0;
  for (let i = 0; i < n; i++) {
    rev[i] = j;
    let bit = n >> 1;
    while (j & bit) {
      j ^= bit;
      bit >>= 1;
    }
    j ^= bit;
  }
  plan = { cos, sin, rev };
  planCache.set(n, plan);
  if (planCache.size > 4) {
    const oldest = planCache.keys().next().value;
    planCache.delete(oldest);
  }
  return plan;
}

function fft(re, im, inverse) {
  const n = re.length;
  const plan = getPlan(n);
  const rev = plan.rev;
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
  const cos = plan.cos;
  const sin = plan.sin;
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const step = n / len;
    for (let base = 0; base < n; base += len) {
      for (let j = 0; j < half; j++) {
        const k = j * step;
        const wr = cos[k];
        const wi = inverse ? sin[k] : -sin[k];
        const a = base + j;
        const b = a + half;
        const xr = re[b];
        const xi = im[b];
        const vr = xr * wr - xi * wi;
        const vi = xr * wi + xi * wr;
        const ur = re[a];
        const ui = im[a];
        re[a] = ur + vr;
        im[a] = ui + vi;
        re[b] = ur - vr;
        im[b] = ui - vi;
      }
    }
  }
  if (inverse) {
    const scale = 1 / n;
    for (let i = 0; i < n; i++) {
      re[i] *= scale;
      im[i] *= scale;
    }
  }
}

const templateCache = new Map();

function templateFft(reverse, nfft) {
  const key = `${reverse ? 1 : 0}:${nfft}`;
  let entry = templateCache.get(key);
  if (entry) {
    templateCache.delete(key);
    templateCache.set(key, entry);
    return entry;
  }
  const re = new Float64Array(nfft);
  const im = new Float64Array(nfft);
  const src = reverse ? CHIRP : CHIRP_REVERSED;
  re.set(src, 0);
  fft(re, im, false);
  entry = { re, im };
  templateCache.set(key, entry);
  if (templateCache.size > 4) {
    const oldest = templateCache.keys().next().value;
    templateCache.delete(oldest);
  }
  return entry;
}

function bitLength(value) {
  if (value <= 0) return 0;
  return 32 - Math.clz32(value);
}

function toFloat64Array(signal) {
  if (signal instanceof Float64Array) return signal;
  if (signal instanceof Float32Array) return Float64Array.from(signal);
  if (ArrayBuffer.isView(signal)) return Float64Array.from(signal);
  return Float64Array.from(signal);
}

function findChirpInternal(s, reverse) {
  const n = s.length;
  const length = CHIRP.length;
  if (n < length) return null;
  const nfft = 1 << bitLength(n + length - 2);
  const re = new Float64Array(nfft);
  const im = new Float64Array(nfft);
  re.set(s, 0);
  fft(re, im, false);
  const tf = templateFft(reverse, nfft);
  const tre = tf.re;
  const tim = tf.im;
  for (let i = 0; i < nfft; i++) {
    const ar = re[i];
    const ai = im[i];
    const br = tre[i];
    const bi = tim[i];
    re[i] = ar * br - ai * bi;
    im[i] = ar * bi + ai * br;
  }
  fft(re, im, true);

  let energy = 0;
  for (let i = 0; i < length; i++) energy += s[i] * s[i];
  let bestIndex = 0;
  let bestScore = -Infinity;
  const count = n - length + 1;
  for (let k = 0; k < count; k++) {
    if (k > 0) {
      const add = s[k + length - 1];
      const sub = s[k - 1];
      energy += add * add - sub * sub;
    }
    const denom = Math.sqrt(Math.max(energy, 0) * CHIRP_ENERGY) + 1e-12;
    const score = Math.abs(re[length - 1 + k]) / denom;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = k;
    }
  }
  return { index: bestIndex, score: bestScore };
}

export function findChirp(signal, reverse = false) {
  return findChirpInternal(toFloat64Array(signal), Boolean(reverse));
}

function toneScores(power, offset) {
  let best = 0;
  let bestValue = -1;
  for (let k = 0; k < N_TONES; k++) {
    const bin = BASE_BIN + offset + TONE_STEP * k;
    const lo = Math.max(bin - 1, 0);
    const hi = bin + 2;
    let sum = 0;
    for (let j = lo; j < hi; j++) sum += power[j];
    if (sum > bestValue) {
      bestValue = sum;
      best = k;
    }
  }
  return best;
}

function demodulate(signal, onStatus) {
  const s = toFloat64Array(signal);
  if (s.length === 0) {
    if (onStatus) onStatus({ detected: false, score: 0 });
    return null;
  }
  const found = findChirpInternal(s, false);
  if (!found || found.score < SYNC_THRESHOLD) {
    if (onStatus) onStatus({ detected: false, score: found ? found.score : 0 });
    return null;
  }
  if (onStatus) onStatus({ detected: true, score: found.score });

  const dataStart = found.index + CHIRP_LEN + GUARD;
  if (dataStart >= s.length) return new Uint8Array(0);

  const endFound = findChirpInternal(s.subarray(dataStart), true);
  let count;
  if (endFound && endFound.score >= SYNC_THRESHOLD) {
    const endStart = dataStart + endFound.index;
    count = Math.max(0, Math.trunc((endStart - GUARD - dataStart) / SYMBOL_PERIOD));
  } else {
    count = Math.max(0, Math.trunc((s.length - dataStart) / SYMBOL_PERIOD));
  }
  if (count === 0) return new Uint8Array(0);

  const out = new Uint8Array(count);
  const re = new Float64Array(SYMBOL);
  const im = new Float64Array(SYMBOL);
  const power = new Float64Array(SYMBOL / 2 + 1);
  let written = 0;

  for (let b = 0; b < count; b++) {
    const offset = dataStart + b * SYMBOL_PERIOD + CYCLIC_PREFIX;
    if (offset + SYMBOL > s.length) break;
    let mean = 0;
    for (let i = 0; i < SYMBOL; i++) mean += s[offset + i];
    mean /= SYMBOL;
    for (let i = 0; i < SYMBOL; i++) {
      re[i] = s[offset + i] - mean;
      im[i] = 0;
    }
    fft(re, im, false);
    for (let i = 0; i < power.length; i++) power[i] = re[i] * re[i] + im[i] * im[i];
    const high = toneScores(power, 0);
    const low = toneScores(power, 3);
    out[written++] = (high << 4) | low;
  }

  return out.slice(0, written);
}

export function modulate(data) {
  const bytes = data instanceof Uint8Array ? data : Uint8Array.from(data);
  const symbols = bytes.length;
  const total = 2 * CHIRP_LEN + 2 * GUARD + symbols * SYMBOL_PERIOD;
  const out = new Float32Array(total);
  out.set(CHIRP, 0);
  let offset = CHIRP_LEN + GUARD;
  for (let s = 0; s < symbols; s++) {
    const value = bytes[s];
    const high = value >> 4;
    const low = value & 0x0f;
    const ta = TONES_A[high];
    const tb = TONES_B[low];
    for (let i = 0; i < SYMBOL_PERIOD; i++) {
      out[offset + i] = (ta[i] + tb[i]) * SYMBOL_ENVELOPE[i];
    }
    offset += SYMBOL_PERIOD;
  }
  offset += GUARD;
  for (let i = 0; i < CHIRP_LEN; i++) out[offset + i] = CHIRP_REVERSED[i];
  return out;
}

let subtlePromise = null;

function getSubtle() {
  if (globalThis.crypto && globalThis.crypto.subtle) {
    return Promise.resolve(globalThis.crypto.subtle);
  }
  if (!subtlePromise) {
    subtlePromise = import("node:crypto").then((mod) => {
      const wc = mod.webcrypto;
      if (!wc || !wc.subtle) throw new Error("crypto.subtle no disponible");
      return wc.subtle;
    });
  }
  return subtlePromise;
}

const hmacKeyCache = new Map();

function bytesToHex(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}

function importHmacKey(key) {
  const normalized = key.length === 0 ? new Uint8Array(64) : key;
  const id = bytesToHex(normalized);
  let promise = hmacKeyCache.get(id);
  if (!promise) {
    promise = getSubtle().then((subtle) =>
      subtle.importKey("raw", normalized, { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
    );
    hmacKeyCache.set(id, promise);
  }
  return promise;
}

async function hmacTag(body, key) {
  const subtle = await getSubtle();
  const cryptoKey = await importHmacKey(key || new Uint8Array(0));
  const signature = await subtle.sign("HMAC", cryptoKey, body);
  return new Uint8Array(signature).slice(0, HMAC_LEN);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function concatBytes(parts) {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const subkeyCache = new Map();
const textEncoder = new TextEncoder();

// Claves de cifrado y de etiqueta derivadas de la clave del usuario (igual que frame._subkey).
function subkeys(key) {
  const id = bytesToHex(key);
  let promise = subkeyCache.get(id);
  if (!promise) {
    promise = (async () => {
      const subtle = await getSubtle();
      const root = await importHmacKey(key);
      const derive = async (label) => {
        const digest = await subtle.sign("HMAC", root, textEncoder.encode(`spacewases-v2-${label}`));
        return subtle.importKey("raw", digest, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      };
      return { enc: await derive("enc"), mac: await derive("mac") };
    })();
    subkeyCache.set(id, promise);
  }
  return promise;
}

function randomBytes(n) {
  const out = new Uint8Array(n);
  if (globalThis.crypto && globalThis.crypto.getRandomValues) {
    globalThis.crypto.getRandomValues(out);
  } else {
    for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
  }
  return out;
}

// Sesion nueva: marca de tiempo (s, 4 bytes big-endian) + nonce aleatorio de 6 bytes.
export function newSession(nowSeconds = Date.now() / 1000) {
  const out = new Uint8Array(SESSION_LEN);
  new DataView(out.buffer).setUint32(0, Math.floor(nowSeconds) >>> 0, false);
  out.set(randomBytes(SESSION_LEN - 4), 4);
  return out;
}

async function keystream(encKey, session, msgId, fragIdx, length) {
  const subtle = await getSubtle();
  const out = new Uint8Array(Math.ceil(length / 32) * 32);
  for (let counter = 0; counter * 32 < length; counter++) {
    const block = new Uint8Array(SESSION_LEN + 2 + 4);
    block.set(session, 0);
    block[SESSION_LEN] = msgId;
    block[SESSION_LEN + 1] = fragIdx;
    new DataView(block.buffer).setUint32(SESSION_LEN + 2, counter, false);
    out.set(new Uint8Array(await subtle.sign("HMAC", encKey, block)), counter * 32);
  }
  return out.slice(0, length);
}

function xorBytes(data, stream) {
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i] ^ stream[i];
  return out;
}

async function encodeFragment(msgId, fragIdx, fragTotal, payload, key, profileId, chunk, session = null) {
  if (payload.length > chunk) throw new Error("fragmento demasiado grande");
  if (msgId < 0 || msgId > 255 || fragTotal < 1 || fragTotal > 255) {
    throw new Error("identificadores fuera de rango");
  }
  if (fragIdx < 0 || fragIdx >= fragTotal) throw new Error("indice de fragmento fuera de rango");
  const keyed = key !== null;
  const version = keyed ? VERSION_KEYED : VERSION;
  const flags = (version << 4) | (profileId & 0x0f);
  const header = Uint8Array.from([MAGIC, flags, msgId, fragIdx, fragTotal, payload.length]);
  let plain;
  if (keyed) {
    const sess = session === null ? newSession() : session;
    if (sess.length !== SESSION_LEN) throw new Error("sesion invalida");
    const keys = await subkeys(key);
    const stream = await keystream(keys.enc, sess, msgId, fragIdx, payload.length);
    const body = concatBytes([header, sess, xorBytes(payload, stream)]);
    const subtle = await getSubtle();
    const tag = new Uint8Array(await subtle.sign("HMAC", keys.mac, body)).slice(0, HMAC_LEN_V2);
    plain = concatBytes([body, tag]);
  } else {
    const body = concatBytes([header, payload]);
    plain = concatBytes([body, await hmacTag(body, null)]);
  }
  const out = new Uint8Array(dataLen(chunk, keyed));
  out.set(plain, 0);
  return out;
}

async function parseFrame(plain, key) {
  if (plain.length < HEADER_LEN + HMAC_LEN || plain[0] !== MAGIC) return null;
  const keyed = key !== null;
  if (plain[1] >> 4 !== (keyed ? VERSION_KEYED : VERSION)) return null;
  const length = plain[5];
  const head = keyed ? HEADER_LEN_V2 : HEADER_LEN;
  const tagLen = keyed ? HMAC_LEN_V2 : HMAC_LEN;
  if (head + length + tagLen > plain.length) return null;
  const body = plain.slice(0, head + length);
  const tag = plain.slice(head + length, head + length + tagLen);
  let payload;
  let session = null;
  if (keyed) {
    const keys = await subkeys(key);
    const subtle = await getSubtle();
    const expected = new Uint8Array(await subtle.sign("HMAC", keys.mac, body)).slice(0, HMAC_LEN_V2);
    if (!timingSafeEqual(tag, expected)) return null;
    session = plain.slice(HEADER_LEN, HEADER_LEN_V2);
    const stream = await keystream(keys.enc, session, plain[2], plain[3], length);
    payload = xorBytes(plain.slice(head, head + length), stream);
  } else {
    if (!timingSafeEqual(tag, await hmacTag(body, null))) return null;
    payload = plain.slice(head, head + length);
  }
  return {
    msgId: plain[2],
    fragIdx: plain[3],
    fragTotal: plain[4],
    length,
    payload,
    profileId: plain[1] & 0x0f,
    session,
  };
}

// Rechaza mensajes con clave ya vistos o fuera de la ventana de maxAge segundos.
export class ReplayGuard {
  constructor(maxAge = 120, clock = () => Date.now() / 1000) {
    this.maxAge = maxAge;
    this.clock = clock;
    this.seen = new Map();
  }

  accept(session) {
    if (session === null) return true;
    const now = this.clock();
    const stamp = new DataView(session.buffer, session.byteOffset, 4).getUint32(0, false);
    if (Math.abs(now - stamp) > this.maxAge) return false;
    for (const [id, t] of this.seen) if (Math.abs(now - t) > this.maxAge) this.seen.delete(id);
    const id = bytesToHex(session);
    if (this.seen.has(id)) return false;
    this.seen.set(id, stamp);
    return true;
  }
}

async function parseFragment(plain, key, profileId, chunk) {
  const frame = await parseFrame(plain, key);
  if (frame === null || frame.profileId !== profileId || frame.length > chunk) return null;
  return frame;
}

class Reassembler {
  constructor() {
    this.pending = new Map();
  }

  reset() {
    this.pending.clear();
  }

  push(frame) {
    const msgId = frame.session === null ? `${frame.msgId}` : `${frame.msgId}:${bytesToHex(frame.session)}`;
    const total = frame.fragTotal;
    let state = this.pending.get(msgId);
    if (!state || state.total !== total) {
      state = { total, parts: new Map() };
      this.pending.set(msgId, state);
    }
    const idx = frame.fragIdx;
    if (idx >= 0 && idx < total && !state.parts.has(idx)) state.parts.set(idx, frame.payload);
    if (state.parts.size !== total) return null;
    for (let i = 0; i < total; i++) if (!state.parts.has(i)) return null;
    const parts = [];
    for (let i = 0; i < total; i++) parts.push(state.parts.get(i));
    this.pending.delete(msgId);
    return concatBytes(parts);
  }
}

let lastMessageId = -1;

function nextMessageId() {
  lastMessageId = (lastMessageId + 1) & 0xff;
  if (lastMessageId === 0) {
    const random = new Uint8Array(1);
    if (globalThis.crypto && globalThis.crypto.getRandomValues) {
      globalThis.crypto.getRandomValues(random);
    } else {
      random[0] = 1 + Math.floor(Math.random() * 255);
    }
    lastMessageId = random[0] || 1;
  }
  return lastMessageId;
}

async function packMessage(msg, key, profileId, chunk, parity, msgId = null, repeat = 1) {
  if (!Number.isInteger(repeat) || repeat < 1) throw new Error("repeat debe ser >= 1");
  if (chunk <= 0 || chunk > 249) throw new Error("chunk invalido");
  const total = Math.max(1, Math.ceil(msg.length / chunk));
  if (total > 255) throw new Error("mensaje demasiado largo");
  const ident = msgId === null ? nextMessageId() : msgId & 0xff;
  const session = key === null ? null : newSession();
  const blocks = [];
  for (let idx = 0; idx < total; idx++) {
    const payload = msg.slice(idx * chunk, (idx + 1) * chunk);
    const plain = await encodeFragment(ident, idx, total, payload, key, profileId, chunk, session);
    blocks.push(rsEncode(plain, parity));
  }
  const once = concatBytes(blocks);
  return concatBytes(Array.from({ length: repeat }, () => once));
}

async function decodeStream(raw, key, profiles, guard = null) {
  for (const [profileId, chunk, parity] of profiles) {
    const blockLen = dataLen(chunk, key !== null) + parity;
    const maxBlocks = Math.trunc(raw.length / blockLen);
    if (maxBlocks === 0) continue;
    const decoded = new Map();

    const blockFrame = async (i) => {
      if (decoded.has(i)) return decoded.get(i);
      let frame = null;
      try {
        const plain = rsDecode(raw.slice(i * blockLen, (i + 1) * blockLen), parity);
        frame = await parseFragment(plain, key, profileId, chunk);
      } catch {
        frame = null;
      }
      decoded.set(i, frame);
      return frame;
    };

    // Cada bloque se valida por separado: uno danado no descarta al resto, y si el
    // mensaje se envio repetido los fragmentos buenos de cualquier copia completan
    // los que faltan.
    const reassembler = new Reassembler();
    for (let i = 0; i < maxBlocks; i++) {
      const fragment = await blockFrame(i);
      if (fragment === null) continue;
      const result = reassembler.push(fragment);
      if (result !== null) {
        if (guard !== null && !guard.accept(fragment.session)) return null;
        return result;
      }
    }
  }
  return null;
}

export async function send(msg, key = null, profile = "normal", repeat = 1) {
  if (!Object.prototype.hasOwnProperty.call(PROFILES, profile)) {
    throw new Error(`perfil desconocido: ${profile}`);
  }
  const [profileId, chunk, parity] = PROFILES[profile];
  const bytes = msg instanceof Uint8Array ? msg : Uint8Array.from(msg);
  const raw = await packMessage(bytes, key, profileId, chunk, parity, null, repeat);
  return modulate(raw);
}

export async function receive(signal, key = null, onStatus = null, guard = null) {
  const raw = demodulate(signal, onStatus);
  if (raw === null) return null;
  return decodeStream(raw, key, PROFILE_ORDER, guard);
}

export function wavEncode(signal) {
  const samples = signal.length;
  const dataSize = samples * 2;
  const out = new Uint8Array(44 + dataSize);
  const view = new DataView(out.buffer);
  const writeTag = (offset, tag) => {
    for (let i = 0; i < 4; i++) out[offset + i] = tag.charCodeAt(i);
  };
  writeTag(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeTag(8, "WAVE");
  writeTag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, FS, true);
  view.setUint32(28, FS * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeTag(36, "data");
  view.setUint32(40, dataSize, true);
  for (let i = 0; i < samples; i++) {
    const value = Math.max(-1, Math.min(1, signal[i]));
    view.setInt16(44 + i * 2, Math.trunc(value * 32767), true);
  }
  return out;
}

export function wavDecode(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (data.length < 12) throw new Error("WAV demasiado corto");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const tag = (offset) => String.fromCharCode(data[offset], data[offset + 1], data[offset + 2], data[offset + 3]);
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("no es un archivo WAV");
  let offset = 12;
  let fmt = null;
  let dataOffset = 0;
  let dataLength = 0;
  while (offset + 8 <= data.length) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt ") {
      fmt = {
        audioFormat: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        blockAlign: view.getUint16(body + 12, true),
        bits: view.getUint16(body + 14, true),
      };
    } else if (id === "data") {
      dataOffset = body;
      dataLength = Math.min(size, data.length - body);
    }
    offset = body + size + (size & 1);
  }
  if (!fmt) throw new Error("WAV sin bloque fmt");
  if (fmt.bits !== 16) throw new Error("solo se admiten WAV de 16 bits");
  if (fmt.sampleRate !== FS) throw new Error(`se esperaban ${FS} Hz`);
  const channels = fmt.channels;
  const blockAlign = fmt.blockAlign || channels * 2;
  const frames = Math.floor(dataLength / blockAlign);
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      sum += view.getInt16(dataOffset + (i * channels + c) * 2, true);
    }
    out[i] = sum / channels / 32768;
  }
  return out;
}
