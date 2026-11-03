export const FS = 48000;
export const SYMBOL = 1024;
export const CYCLIC_PREFIX = 256;
export const BASE_BIN = 40;
export const N_TONES = 16;
// Cada simbolo lleva 3 bytes: 6 tonos a la vez, uno por nibble, en 6 grupos contiguos de
// 16 bins. Por aire acierta casi lo mismo que 1 byte por simbolo (air_tonos.py), con el
// triple de datos. La amplitud es tal que los 6 tonos juntos nunca saturan.
export const BYTES_PER_SYMBOL = 3;
const N_GROUPS = 2 * BYTES_PER_SYMBOL;
export const CHIRP_MS = 150;
export const CHIRP_LEN = Math.trunc((FS * CHIRP_MS) / 1000);
export const CHIRP_F0 = 1500;
export const CHIRP_F1 = 6000;
export const GUARD = 384;
export const SYMBOL_RAMP = 64;
export const TONE_AMP = 0.16;
// Umbrales del chirp (igual que en modem.py). El de inicio es bajo porque por aire hay
// mensajes decodificables con el chirp en 0,07-0,12, y una falsa deteccion casi no cuesta:
// el bloque de longitud, con su Reed-Solomon, la descarta. El de fin es alto porque los
// tonos de los datos llegan a 0,16: un fin falso cortaria el mensaje, y perder el fin no
// impide decodificar porque la longitud ya se conoce.
export const SYNC_THRESHOLD = 0.07;
export const END_THRESHOLD = 0.25;
export const MAGIC = 0xa5;
export const VERSION = 1;
export const HEADER_LEN = 6;
export const HMAC_LEN = 4;
export const VERSION_KEYED = 2;
export const SESSION_LEN = 10;
export const HEADER_LEN_V2 = HEADER_LEN + SESSION_LEN;
export const HMAC_LEN_V2 = 8;

// Bloque de longitud al inicio de cada transmision (igual que en frame.py): perfil y
// longitud total protegidos por su propio Reed-Solomon; el ultimo fragmento no se rellena.
export const LEN_MAGIC = 0xb0;
export const LEN_DATA = 3;
export const LEN_PARITY = 6;
export const LEN_BLOCK = LEN_DATA + LEN_PARITY;
const MAX_MESSAGE = 0xffff;

// [bytes en claro, paridad] de cada fragmento de un mensaje de length bytes. La paridad
// es la del perfil aunque el bloque sea corto (ver block_sizes en frame.py).
export function blockSizes(length, keyed, chunk, parity) {
  const head = keyed ? HEADER_LEN_V2 : HEADER_LEN;
  const tag = keyed ? HMAC_LEN_V2 : HMAC_LEN;
  const count = Math.max(1, Math.ceil(length / chunk));
  const sizes = [];
  for (let idx = 0; idx < count; idx++) {
    sizes.push([head + Math.min(chunk, length - idx * chunk) + tag, parity]);
  }
  return sizes;
}

// Bytes de una copia del mensaje, redondeados a simbolos enteros.
function sequenceLength(length, keyed, chunk, parity) {
  const bytes = blockSizes(length, keyed, chunk, parity).reduce((n, [p, r]) => n + p + r, LEN_BLOCK);
  return Math.ceil(bytes / BYTES_PER_SYMBOL) * BYTES_PER_SYMBOL;
}

// [id, chunk, paridad RS] de la capa de trama (igual que api.PROFILES en Python).
export const PROFILES = {
  robust: [0, 48, 20],
  normal: [1, 48, 32],
  fast: [2, 48, 20],
};

// Tramas de 1024 muestras por simbolo (igual que api.FRAMES en Python).
export const FRAMES = {
  robust: 6,
  normal: 3,
  fast: 3,
};

const RECEIVE_ORDER = ["robust", "normal", "fast"];

// Desplazamientos (muestras) de la ventana de analisis que se prueban si la posicion
// estimada por el chirp no decodifica (igual que api.ALIGN_OFFSETS en Python).
export const ALIGN_OFFSETS = [0, -256, -512, 256];

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

// Forma de un simbolo (igual que modem._layout en Python). Con frames == 1: prefijo
// ciclico de CYCLIC_PREFIX muestras + una trama. Con frames > 1: frames tramas del
// mismo tono; la primera hace de guarda frente a la cola del simbolo anterior y el
// receptor suma las demas antes de la FFT, como ggwave.
function symbolLayout(frames) {
  if (!Number.isInteger(frames) || frames < 1) throw new Error("frames debe ser >= 1");
  const lead = frames === 1 ? CYCLIC_PREFIX : SYMBOL;
  const analyzed = Math.max(1, frames - 1);
  return { lead, analyzed, period: lead + analyzed * SYMBOL };
}

function makeSymbolEnvelope(period) {
  const env = new Float64Array(period);
  env.fill(1);
  const ramp = Math.min(SYMBOL_RAMP, Math.trunc(period / 2));
  const edge = new Float64Array(ramp);
  for (let i = 0; i < ramp; i++) {
    const r = i / Math.max(ramp - 1, 1);
    edge[i] = 0.5 * (1 - Math.cos(Math.PI * r));
  }
  for (let i = 0; i < ramp; i++) env[i] *= edge[i];
  for (let i = 0; i < ramp; i++) env[period - ramp + i] *= edge[ramp - 1 - i];
  return env;
}

function makeToneTable(group, lead, period) {
  const table = new Array(N_TONES);
  for (let k = 0; k < N_TONES; k++) {
    const freq = BASE_BIN + N_TONES * group + k;
    const tone = new Float64Array(period);
    for (let n = 0; n < period; n++) {
      tone[n] = TONE_AMP * Math.sin((2 * Math.PI * (n - lead) * freq) / SYMBOL);
    }
    table[k] = tone;
  }
  return table;
}

const shapeCache = new Map();

function symbolShape(frames) {
  let shape = shapeCache.get(frames);
  if (!shape) {
    const layout = symbolLayout(frames);
    shape = {
      ...layout,
      envelope: makeSymbolEnvelope(layout.period),
      tones: Array.from({ length: N_GROUPS }, (_, group) => makeToneTable(group, layout.lead, layout.period)),
    };
    shapeCache.set(frames, shape);
  }
  return shape;
}

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
  return signal instanceof Float64Array ? signal : Float64Array.from(signal);
}

// FFT mas larga que se usa para correlar. Senales mas largas se procesan por bloques
// (solapar y guardar): una FFT de millones de puntos es varias veces mas lenta por
// muestra que muchas de este tamano, y en un movil congelaba la pagina segundos.
const MAX_CORRELATION_FFT = 1 << 16;

function findChirpInternal(s, reverse) {
  const n = s.length;
  const length = CHIRP.length;
  if (n < length) return null;
  const count = n - length + 1;
  const nfft = Math.min(MAX_CORRELATION_FFT, 1 << bitLength(n + length - 2));
  const step = nfft - length + 1;
  const tf = templateFft(reverse, nfft);
  const tre = tf.re;
  const tim = tf.im;
  const re = new Float64Array(nfft);
  const im = new Float64Array(nfft);

  let energy = 0;
  for (let i = 0; i < length; i++) energy += s[i] * s[i];
  let bestIndex = 0;
  let bestScore = -Infinity;
  for (let k0 = 0; k0 < count; k0 += step) {
    // Bloque s[k0, k0 + nfft): sus salidas validas son las correlaciones k0..k0+step-1.
    re.fill(0);
    im.fill(0);
    re.set(s.subarray(k0, Math.min(n, k0 + nfft)), 0);
    fft(re, im, false);
    for (let i = 0; i < nfft; i++) {
      const ar = re[i];
      const ai = im[i];
      const br = tre[i];
      const bi = tim[i];
      re[i] = ar * br - ai * bi;
      im[i] = ar * bi + ai * br;
    }
    fft(re, im, true);

    const end = Math.min(count, k0 + step);
    for (let k = k0; k < end; k++) {
      if (k > 0) {
        const add = s[k + length - 1];
        const sub = s[k - 1];
        energy += add * add - sub * sub;
      }
      const denom = Math.sqrt(Math.max(energy, 0) * CHIRP_ENERGY) + 1e-12;
      const score = Math.abs(re[length - 1 + k - k0]) / denom;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = k;
      }
    }
  }
  return { index: bestIndex, score: bestScore };
}

export function findChirp(signal, reverse = false) {
  return findChirpInternal(toFloat64Array(signal), Boolean(reverse));
}

// Nibble de un grupo: el tono con mas potencia. Los tonos son contiguos y ortogonales en la
// trama, asi que se mira solo su bin.
function strongestTone(power, group) {
  const first = BASE_BIN + N_TONES * group;
  let best = 0;
  for (let k = 1; k < N_TONES; k++) if (power[first + k] > power[first + best]) best = k;
  return best;
}

// Busca el chirp inicial y el final una sola vez; los perfiles comparten la sincronia.
function synchronize(signal) {
  const s = toFloat64Array(signal);
  const found = findChirpInternal(s, false);
  if (!found || found.score < SYNC_THRESHOLD) return null;

  const dataStart = found.index + CHIRP_LEN + GUARD;
  let dataEnd = s.length;
  if (dataStart < s.length) {
    const endFound = findChirpInternal(s.subarray(dataStart), true);
    if (endFound && endFound.score >= END_THRESHOLD) dataEnd = dataStart + endFound.index - GUARD;
  }
  return { s, dataStart, dataEnd, endKnown: dataEnd !== s.length };
}

// offset desplaza las ventanas de analisis respecto a la posicion estimada por el chirp.
function demodulateSynced(sync, frames, offset = 0) {
  const { s, dataStart, dataEnd } = sync;
  if (dataStart >= s.length) return new Uint8Array(0);
  const { lead, analyzed, period } = symbolLayout(frames);
  const count = Math.max(0, Math.trunc((dataEnd - dataStart - offset) / period));
  if (count === 0) return new Uint8Array(0);

  const out = new Uint8Array(count * BYTES_PER_SYMBOL);
  const re = new Float64Array(SYMBOL);
  const im = new Float64Array(SYMBOL);
  const power = new Float64Array(SYMBOL / 2 + 1);
  let written = 0;

  for (let b = 0; b < count; b++) {
    const start = dataStart + b * period + lead + offset;
    if (start < 0 || start + analyzed * SYMBOL > s.length) break;
    re.fill(0);
    for (let f = 0; f < analyzed; f++) {
      const base = start + f * SYMBOL;
      for (let i = 0; i < SYMBOL; i++) re[i] += s[base + i];
    }
    let mean = 0;
    for (let i = 0; i < SYMBOL; i++) mean += re[i];
    mean /= SYMBOL;
    for (let i = 0; i < SYMBOL; i++) {
      re[i] -= mean;
      im[i] = 0;
    }
    fft(re, im, false);
    for (let i = 0; i < power.length; i++) power[i] = re[i] * re[i] + im[i] * im[i];
    for (let g = 0; g < N_GROUPS; g += 2) {
      out[written++] = (strongestTone(power, g) << 4) | strongestTone(power, g + 1);
    }
  }

  return out.slice(0, written);
}

export function demodulate(signal, frames = 1) {
  const sync = synchronize(signal);
  return sync === null ? null : demodulateSynced(sync, frames);
}

export function modulate(data, frames = 1) {
  const bytes = data instanceof Uint8Array ? data : Uint8Array.from(data);
  const { period, envelope, tones } = symbolShape(frames);
  const symbols = Math.ceil(bytes.length / BYTES_PER_SYMBOL);
  const total = 2 * CHIRP_LEN + 2 * GUARD + symbols * period;
  const out = new Float32Array(total);
  out.set(CHIRP, 0);
  let offset = CHIRP_LEN + GUARD;
  for (let s = 0; s < symbols; s++) {
    for (let g = 0; g < N_GROUPS; g++) {
      const value = bytes[s * BYTES_PER_SYMBOL + (g >> 1)] ?? 0;
      const tone = tones[g][g % 2 === 0 ? value >> 4 : value & 0x0f];
      for (let i = 0; i < period; i++) out[offset + i] += tone[i] * envelope[i];
    }
    offset += period;
  }
  offset += GUARD;
  for (let i = 0; i < CHIRP_LEN; i++) out[offset + i] = CHIRP_REVERSED[i];
  return out;
}

// Sin Web Crypto no se puede cifrar ni generar nonces seguros: mejor fallar que degradar.
async function getSubtle() {
  if (!globalThis.crypto || !globalThis.crypto.subtle) throw new Error("crypto.subtle no disponible");
  return globalThis.crypto.subtle;
}

const hmacKeyCache = new Map();

function bytesToHex(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}

// Cache de derivaciones de clave, limitada para no retener en memoria todas las claves
// probadas en la pagina. Un fallo no se guarda: el siguiente intento vuelve a derivar.
const KEY_CACHE_SIZE = 8;

function cachedKey(cache, id, derive) {
  let promise = cache.get(id);
  if (!promise) {
    promise = derive();
    cache.set(id, promise);
    promise.catch(() => cache.delete(id));
    if (cache.size > KEY_CACHE_SIZE) cache.delete(cache.keys().next().value);
  }
  return promise;
}

function importHmacKey(key) {
  const normalized = key.length === 0 ? new Uint8Array(64) : key;
  return cachedKey(hmacKeyCache, bytesToHex(normalized), () =>
    getSubtle().then((subtle) =>
      subtle.importKey("raw", normalized, { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
    )
  );
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
// Clave maestra de 32 bytes: PBKDF2-HMAC-SHA256 de la clave del usuario (igual que
// frame.master_key en Python). La sal es fija para no derivar en cada intento de
// decodificacion; ver la explicacion en frame.py. La sal y la etiqueta de las subclaves
// conservan el nombre anterior del proyecto: cambiarlas haria incompatibles los mensajes con clave.
export const PBKDF2_SALT = textEncoder.encode("spacewases-pbkdf2-v1");
export const PBKDF2_ITERATIONS = 600000;

export async function masterKey(key) {
  const subtle = await getSubtle();
  const base = await subtle.importKey("raw", key, "PBKDF2", false, ["deriveBits"]);
  const bits = await subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: PBKDF2_SALT, iterations: PBKDF2_ITERATIONS },
    base,
    256
  );
  return new Uint8Array(bits);
}

function subkeys(key) {
  return cachedKey(subkeyCache, bytesToHex(key), async () => {
    const subtle = await getSubtle();
    const root = await importHmacKey(await masterKey(key));
    const derive = async (label) => {
      const digest = await subtle.sign("HMAC", root, textEncoder.encode(`spacewases-v2-${label}`));
      return subtle.importKey("raw", digest, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    };
    return { enc: await derive("enc"), mac: await derive("mac") };
  });
}

function randomBytes(n) {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
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
  return plain;
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
    this.lastReason = null;
  }

  // Tras un rechazo, lastReason es "antiguo" (fuera de la ventana de tiempo) o "repetido".
  accept(session) {
    this.lastReason = null;
    if (session === null) return true;
    const now = this.clock();
    const stamp = new DataView(session.buffer, session.byteOffset, 4).getUint32(0, false);
    if (Math.abs(now - stamp) > this.maxAge) {
      this.lastReason = "antiguo";
      return false;
    }
    for (const [id, t] of this.seen) if (Math.abs(now - t) > this.maxAge) this.seen.delete(id);
    const id = bytesToHex(session);
    if (this.seen.has(id)) {
      this.lastReason = "repetido";
      return false;
    }
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
    lastMessageId = randomBytes(1)[0] || 1;
  }
  return lastMessageId;
}

async function packMessage(msg, key, profileId, chunk, parity, msgId = null, repeat = 1) {
  if (!Number.isInteger(repeat) || repeat < 1) throw new Error("repeat debe ser >= 1");
  if (chunk <= 0 || chunk > 230) throw new Error("chunk invalido");
  if (msg.length > MAX_MESSAGE || Math.ceil(msg.length / chunk) > 255) {
    throw new Error("mensaje demasiado largo");
  }
  const ident = msgId === null ? nextMessageId() : msgId & 0xff;
  const session = key === null ? null : newSession();
  const header = Uint8Array.from([LEN_MAGIC | (profileId & 0x0f), msg.length >> 8, msg.length & 0xff]);
  const blocks = [rsEncode(header, LEN_PARITY)];
  const sizes = blockSizes(msg.length, key !== null, chunk, parity);
  for (let idx = 0; idx < sizes.length; idx++) {
    const payload = msg.slice(idx * chunk, (idx + 1) * chunk);
    const plain = await encodeFragment(ident, idx, sizes.length, payload, key, profileId, chunk, session);
    blocks.push(rsEncode(plain, sizes[idx][1]));
  }
  const used = blocks.reduce((n, block) => n + block.length, 0);
  blocks.push(new Uint8Array(sequenceLength(msg.length, key !== null, chunk, parity) - used));
  const once = concatBytes(blocks);
  return concatBytes(Array.from({ length: repeat }, () => once));
}

// Longitud del mensaje si el bloque de longitud en offset es valido para el perfil.
function readLength(raw, offset, profileId) {
  if (offset + LEN_BLOCK > raw.length) return null;
  let header;
  try {
    header = rsDecode(raw.slice(offset, offset + LEN_BLOCK), LEN_PARITY);
  } catch {
    return null;
  }
  if (header[0] !== (LEN_MAGIC | (profileId & 0x0f))) return null;
  return (header[1] << 8) | header[2];
}

async function decodeStream(raw, key, profiles, guard = null) {
  const keyed = key !== null;
  for (const [profileId, chunk, parity] of profiles) {
    // Si el bloque de longitud de la primera copia esta danado, prueba el de las
    // demas suponiendo que raw son k copias exactas.
    let length = null;
    for (const k of [1, 2, 3]) {
      const part = Math.trunc(raw.length / k);
      if (k > 1 && raw.length % k) continue;
      for (let copy = 0; copy < k && length === null; copy++) {
        const found = readLength(raw, copy * part, profileId);
        if (found !== null && (k === 1 || sequenceLength(found, keyed, chunk, parity) === part)) length = found;
      }
      if (length !== null) break;
    }
    if (length === null) continue;
    const seq = sequenceLength(length, keyed, chunk, parity);
    const sizes = blockSizes(length, keyed, chunk, parity);

    // Cada bloque se valida por separado: uno danado no descarta al resto, y si el
    // mensaje se envio repetido los fragmentos buenos de cualquier copia completan
    // los que faltan.
    const reassembler = new Reassembler();
    const copies = Math.max(1, Math.trunc(raw.length / seq));
    for (let copy = 0; copy < copies; copy++) {
      let offset = copy * seq + LEN_BLOCK;
      for (const [plainLen, blockParity] of sizes) {
        const end = offset + plainLen + blockParity;
        if (end > raw.length) break;
        const block = raw.slice(offset, end);
        offset = end;
        let fragment = null;
        try {
          fragment = await parseFragment(rsDecode(block, blockParity), key, profileId, chunk);
        } catch {
          fragment = null;
        }
        if (fragment === null) continue;
        const result = reassembler.push(fragment);
        if (result !== null) {
          if (guard !== null && !guard.accept(fragment.session)) return null;
          return result;
        }
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
  return modulate(raw, FRAMES[profile]);
}

// Duracion en segundos de la senal que send() generaria (para la interfaz).
export function signalSeconds(byteLength, profile, keyed = false, repeat = 1) {
  const [, chunk, parity] = PROFILES[profile];
  const symbols = (repeat * sequenceLength(byteLength, keyed, chunk, parity)) / BYTES_PER_SYMBOL;
  return (2 * CHIRP_LEN + 2 * GUARD + symbols * symbolLayout(FRAMES[profile]).period) / FS;
}

// Cada perfil usa un largo de simbolo distinto: se sincroniza una vez y se prueba cada
// perfil con cada desplazamiento de ALIGN_OFFSETS hasta que Reed-Solomon y la etiqueta acepten.
export async function receive(signal, key = null, onStatus = null, guard = null) {
  if (guard !== null) guard.lastReason = null;
  const sync = synchronize(signal, onStatus);
  return sync === null ? null : decodeWithRetry(sync, key, onStatus, guard, RECEIVE_ORDER);
}

async function decodeSynced(sync, key, onStatus, guard, names) {
  for (const name of names) {
    for (const offset of ALIGN_OFFSETS) {
      const raw = demodulateSynced(sync, FRAMES[name], offset);
      const result = await decodeStream(raw, key, [PROFILES[name]], guard);
      if (result !== null) {
        if (onStatus) onStatus({ decoded: true, profile: name });
        return result;
      }
      if (guard !== null && guard.lastReason !== null) return null;
    }
  }
  return null;
}

// Si un fin de datos falso corto el mensaje, se repite sin el: la longitud ya delimita
// los bloques, y el fin solo hace falta para repartir copias repetidas.
async function decodeWithRetry(sync, key, onStatus, guard, names) {
  const message = await decodeSynced(sync, key, onStatus, guard, names);
  if (message !== null || !sync.endKnown || (guard !== null && guard.lastReason !== null)) return message;
  return decodeSynced({ ...sync, dataEnd: sync.s.length, endKnown: false }, key, onStatus, guard, names);
}

// Primer chirp (directo o invertido) de signal a partir de from, buscado en ventanas
// de window muestras que se solapan un chirp, como si el audio llegara en trozos
// pequenos. Asi, en un tramo largo con varios mensajes, se encuentra el primero y no
// el que mas correlaciona. Devuelve el indice absoluto o null.
function firstChirp(signal, from, reverse, window, threshold) {
  for (let start = from; start + CHIRP_LEN <= signal.length; start += window - CHIRP_LEN) {
    const segment = signal.subarray(start, Math.min(signal.length, start + window));
    const found = findChirpInternal(toFloat64Array(segment), reverse);
    if (found && found.score >= threshold) return start + found.index;
    if (start + window >= signal.length) break;
  }
  return null;
}

// Copias del mensaje que se esperan como maximo sin ver el chirp final (como en la web).
const MAX_COPIES = 3;
// Sin bloque de longitud valido, lo detectado se abandona en silencio tras este tiempo:
// casi siempre fue una falsa deteccion. Se espera algo por si una copia repetida se salva.
const NO_HEADER_SECONDS = 30;
// Muestras de mas antes de decodificar, para las ventanas desplazadas de ALIGN_OFFSETS.
const DECODE_MARGIN = 512;

// Receptor en flujo. En reposo busca el chirp de inicio; al encontrarlo lee el bloque de
// longitud, que dice donde acaba el mensaje, y decodifica al llegar ahi sin depender del
// chirp final. Si el bloque no se lee, espera el chirp final o abandona. Estados: "idle"
// (en reposo), "candidate" (chirp detectado, aun sin longitud) y "recording" (mensaje
// confirmado). Los trozos pueden ser de cualquier tamano y caben varios mensajes en uno.
export class StreamReceiver {
  constructor({ maxSeconds = 90, hop = 4096, endCheckEvery = 16384 } = {}) {
    this.maxSamples = Math.round(maxSeconds * FS);
    this.window = 2 * CHIRP_LEN + hop;
    this.endCheckEvery = endCheckEvery;
    this.data = new Float32Array(1 << 16);
    this.reset();
  }

  reset() {
    this.state = "idle";
    this.size = 0;
    this.startPending = false;
    this.skip = 0;
    this.start = 0;
    this.header = null;
    this.triedHeader = new Set();
    this.copiesTried = 0;
    this.checkedUpTo = 0;
  }

  // Lo recibido hasta ahora, sin copiar. Se invalida al llamar a append o drop.
  get audio() {
    return this.data.subarray(0, this.size);
  }

  get dataStart() {
    return this.start + CHIRP_LEN + GUARD;
  }

  // Avance de la recepcion confirmada de 0 a 1, o null si no hay ninguna.
  get progress() {
    if (this.state !== "recording") return null;
    return Math.min(1, (this.size - this.dataStart) / this.header.samples);
  }

  // Hay alguien emitiendo: un chirp a medio confirmar o un mensaje en curso. Un candidato
  // que ya no puede tener longitud valida no cuenta, para no bloquear los envios.
  get busy() {
    return (
      this.startPending ||
      this.skip > 0 ||
      this.state === "recording" ||
      (this.state === "candidate" && this.triedHeader.size < RECEIVE_ORDER.length)
    );
  }

  // Duplica la capacidad al crecer: copiar toda la grabacion en cada trozo cuesta mucho
  // en una grabacion larga y el recolector de basura detiene la pagina.
  append(samples) {
    const needed = this.size + samples.length;
    if (needed > this.data.length) {
      const grown = new Float32Array(Math.max(needed, 2 * this.data.length));
      grown.set(this.audio, 0);
      this.data = grown;
    }
    this.data.set(samples, this.size);
    this.size = needed;
  }

  drop(count) {
    this.data.copyWithin(0, count, this.size);
    this.size -= count;
  }

  beginCandidate(start) {
    const dropped = Math.max(0, start - SYMBOL);
    this.drop(dropped);
    this.start = start - dropped;
    this.state = "candidate";
    this.header = null;
    this.triedHeader = new Set();
    this.copiesTried = 0;
    this.checkedUpTo = this.dataStart;
    this.restartFrom = this.dataStart;
  }

  // Intenta leer el bloque de longitud con cada perfil, una sola vez cuando ya llego.
  readHeader(keyed) {
    for (const name of RECEIVE_ORDER) {
      if (this.triedHeader.has(name)) continue;
      const { period } = symbolLayout(FRAMES[name]);
      const blockSamples = (LEN_BLOCK / BYTES_PER_SYMBOL) * period;
      const blockEnd = this.dataStart + blockSamples + DECODE_MARGIN;
      if (this.size < blockEnd) continue;
      this.triedHeader.add(name);
      const s = toFloat64Array(this.audio.subarray(0, blockEnd));
      const [profileId, chunk, parity] = PROFILES[name];
      for (const offset of ALIGN_OFFSETS) {
        const dataEnd = this.dataStart + offset + blockSamples;
        const raw = demodulateSynced({ s, dataStart: this.dataStart, dataEnd }, FRAMES[name], offset);
        const length = readLength(raw, 0, profileId);
        if (length !== null) {
          return { name, samples: (sequenceLength(length, keyed, chunk, parity) / BYTES_PER_SYMBOL) * period };
        }
      }
    }
    return null;
  }

  async decode(end, key, guard) {
    const limit = end === null ? this.size : Math.min(this.size, end + CHIRP_LEN);
    const s = toFloat64Array(this.audio.subarray(0, limit));
    const sync = { s, dataStart: this.dataStart, dataEnd: end === null ? limit : end - GUARD, endKnown: end !== null };
    const result = { message: null, profile: null, rejected: null, failed: false };
    const onStatus = (status) => {
      if (status.decoded) result.profile = status.profile;
    };
    const names = this.header ? [this.header.name] : RECEIVE_ORDER;
    if (guard !== null) guard.lastReason = null;
    result.message = await decodeWithRetry(sync, key, onStatus, guard, names);
    if (result.message === null) {
      if (guard !== null && guard.lastReason !== null) result.rejected = guard.lastReason;
      else result.failed = true;
    }
    return result;
  }

  finish(cut, results, result) {
    if (result) results.push(result);
    const dropped = Math.min(this.size, cut);
    this.drop(dropped);
    this.skip = cut - dropped;
    this.state = "idle";
    this.header = null;
  }

  // Avanza la recepcion en curso. Devuelve true si termino y hay que volver a buscar.
  async advance(key, guard, results) {
    if (this.header === null) {
      this.header = this.readHeader(key !== null);
      if (this.header !== null) this.state = "recording";
    }

    // Longitud conocida: se decodifica al llegar al final de cada copia posible.
    if (this.header !== null) {
      while (this.copiesTried < MAX_COPIES) {
        const copyEnd = this.dataStart + (this.copiesTried + 1) * this.header.samples;
        if (this.size < copyEnd + DECODE_MARGIN) break;
        this.copiesTried++;
        const result = await this.decode(null, key, guard);
        if (result.message !== null || result.rejected !== null || this.copiesTried === MAX_COPIES) {
          // Se salta tambien el chirp final, aunque aun no haya llegado: a este umbral
          // pareceria un inicio y crearia una deteccion falsa.
          this.finish(copyEnd + GUARD + CHIRP_LEN + SYMBOL, results, result);
          return true;
        }
      }
    }

    // Busca en el audio nuevo el chirp final y, sin longitud, otro chirp de inicio.
    const tooLong = this.size >= this.maxSamples;
    if (this.size - this.checkedUpTo >= this.endCheckEvery || tooLong) {
      const from = Math.max(this.dataStart, this.checkedUpTo - CHIRP_LEN);
      const audio = this.audio.subarray(0, Math.min(this.size, this.maxSamples));
      const end = firstChirp(audio, from, true, this.window, END_THRESHOLD);
      this.checkedUpTo = this.size;
      // Los tonos de un mensaje real tambien superan el umbral de inicio: solo se busca
      // otro inicio cuando ya se probo a leer la longitud con todos los perfiles.
      let restart = null;
      if (this.header === null && this.triedHeader.size === RECEIVE_ORDER.length) {
        restart = firstChirp(audio, this.restartFrom, false, this.window, SYNC_THRESHOLD);
        this.restartFrom = Math.max(this.dataStart, this.size - CHIRP_LEN);
      }
      if (restart !== null && (end === null || restart < end)) {
        this.finish(Math.max(0, restart - SYMBOL), results, null);
        return true;
      }
      if (end !== null) {
        this.finish(end + CHIRP_LEN + SYMBOL, results, await this.decode(end, key, guard));
        return true;
      }
    }

    if (this.header === null && this.size - this.start >= NO_HEADER_SECONDS * FS) {
      this.finish(this.size - 2 * CHIRP_LEN, results, null);
      return true;
    }
    if (tooLong) {
      this.finish(this.maxSamples, results, await this.decode(null, key, guard));
      return true;
    }
    return false;
  }

  // Recibe muestras a FS y devuelve { state, results, message, profile, rejected, failed }.
  // results tiene un resultado { message, profile, rejected, failed } por cada grabacion
  // terminada en este trozo; los demas campos repiten el primero (o valen null/false):
  // message es el mensaje decodificado y profile, el perfil con que se decodifico;
  // rejected, el motivo de ReplayGuard si lo descarto; failed, true si una grabacion
  // completa no se pudo decodificar.
  async push(samples, key = null, guard = null) {
    this.append(samples instanceof Float32Array ? samples : Float32Array.from(samples));
    const results = [];

    for (;;) {
      if (this.state === "idle") {
        const skipped = Math.min(this.skip, this.size);
        this.drop(skipped);
        this.skip -= skipped;
        const start = this.size >= CHIRP_LEN ? firstChirp(this.audio, 0, false, this.window, SYNC_THRESHOLD) : null;
        if (start === null) {
          // Se guarda lo justo para no partir un chirp que siga en el proximo trozo.
          if (this.size > 2 * CHIRP_LEN) this.drop(this.size - 2 * CHIRP_LEN);
          this.startPending = false;
          break;
        }
        // Un chirp a medio llegar ya supera el umbral en una posicion adelantada: se
        // espera a tenerlo entero y se toma el maximo, que es la posicion verdadera.
        const settled = start + 2 * CHIRP_LEN;
        this.startPending = this.size < settled;
        if (this.startPending) {
          if (start > SYMBOL) this.drop(start - SYMBOL);
          break;
        }
        const peak = findChirpInternal(toFloat64Array(this.audio.subarray(start, settled)), false);
        this.beginCandidate(start + peak.index);
      }
      if (!(await this.advance(key, guard, results))) break;
    }

    const first = results[0] || { message: null, profile: null, rejected: null, failed: false };
    return { state: this.state, results, ...first };
  }
}

// Una sesion de escucha: remuestrea, decodifica en orden y avisa con onEvent. Es lo que
// corre en el hilo aparte (receptor.js). El audio que llega mientras decodifica espera
// en cola y se procesa junto, asi que nunca hay dos decodificaciones a la vez.
export class LiveSession {
  constructor(captureRate, onEvent, { maxSeconds = 90 } = {}) {
    this.resampler = new Resampler(captureRate, FS);
    this.receiver = new StreamReceiver({ maxSeconds });
    this.guard = new ReplayGuard();
    this.onEvent = onEvent;
    this.pending = [];
    this.running = false;
    this.resetRequested = false;
  }

  // Descarta lo recibido. Si hay una decodificacion en curso, su resultado se ignora.
  reset() {
    this.pending = [];
    this.resetRequested = true;
    if (!this.running) this.applyReset();
  }

  applyReset() {
    this.resetRequested = false;
    this.receiver.reset();
    this.onEvent({ results: [], state: "idle", progress: null, busy: false, encrypted: false });
  }

  feed(samples, key, replayCheck) {
    this.pending.push(samples);
    this.key = key;
    this.replayCheck = replayCheck;
    if (!this.running) this.run();
  }

  async run() {
    this.running = true;
    while (this.pending.length > 0 || this.resetRequested) {
      if (this.resetRequested) {
        this.applyReset();
        continue;
      }
      const batch = concatSamples(this.pending);
      this.pending = [];
      const key = this.key;
      const guard = key !== null && this.replayCheck ? this.guard : null;
      try {
        const { results, state } = await this.receiver.push(this.resampler.push(batch), key, guard);
        if (!this.resetRequested) {
          const { progress, busy } = this.receiver;
          this.onEvent({ results, state, progress, busy, encrypted: key !== null });
        }
      } catch (error) {
        this.receiver.reset();
        this.onEvent({ results: [], state: "idle", progress: null, busy: false, encrypted: false, error: error.message });
      }
    }
    this.running = false;
  }
}

// Turnos al emitir: un dispositivo no puede recibir mientras emite, porque su altavoz tapa
// al otro (air_duplex.py). Por eso cada mensaje espera en cola a que el canal este libre y a
// un retardo aleatorio, y vuelve a comprobarlo antes de sonar. Asi, dos que esperan no
// arrancan a la vez. Solo funciona con el microfono activado; sin el, isBusy siempre es falso.
export class SendQueue {
  constructor({
    isBusy,
    transmit,
    onChange = () => {},
    backoffMs = 3000,
    pollMs = 100,
    maxWaitMs = 100000,
    random = Math.random,
    now = () => Date.now(),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }) {
    Object.assign(this, { isBusy, transmit, onChange, backoffMs, pollMs, maxWaitMs, random, now, sleep });
    this.items = [];
    this.running = false;
    this.mustBackOff = false;
  }

  get length() {
    return this.items.length;
  }

  push(item) {
    this.items.push(item);
    this.onChange();
    if (!this.running) this.finished = this.run();
    return this.finished;
  }

  // Espera su turno. Si el canal estaba libre y nadie acaba de hablar, no espera nada.
  async waitForTurn() {
    const deadline = this.now() + this.maxWaitMs;
    while (this.now() < deadline) {
      if (this.isBusy()) {
        this.mustBackOff = true;
        await this.sleep(this.pollMs);
        continue;
      }
      if (!this.mustBackOff) return;
      this.mustBackOff = false;
      await this.sleep(this.random() * this.backoffMs);
      if (!this.isBusy()) return;
    }
  }

  async run() {
    this.running = true;
    while (this.items.length > 0) {
      await this.waitForTurn();
      const item = this.items.shift();
      this.onChange();
      await this.transmit(item);
      // Tras emitir se da paso a quien estuviera esperando.
      this.mustBackOff = true;
    }
    this.running = false;
    this.mustBackOff = false;
  }
}

function concatSamples(parts) {
  const out = new Float32Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

// Remuestreo lineal en flujo: conserva la posicion fraccionaria y la ultima muestra
// entre llamadas, asi que pasar el audio en trozos da lo mismo que de una vez.
export class Resampler {
  constructor(fromRate, toRate = FS) {
    this.step = fromRate / toRate;
    this.position = 0;
    this.last = null;
  }

  push(input) {
    if (this.step === 1) return input;
    if (input.length === 0) return new Float32Array(0);
    // Con la muestra anterior delante, el indice 0 es la ultima del trozo previo.
    const prefix = this.last === null ? 0 : 1;
    const at = (i) => (i < prefix ? this.last : input[i - prefix]);
    const available = input.length + prefix;
    const out = [];
    let position = this.position;
    while (Math.floor(position) + 1 < available) {
      const index = Math.floor(position);
      const fraction = position - index;
      const a = at(index);
      out.push(a + (at(index + 1) - a) * fraction);
      position += this.step;
    }
    this.position = position - (available - 1);
    this.last = input[input.length - 1];
    return Float32Array.from(out);
  }
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
  if (fmt.audioFormat !== 1 && fmt.audioFormat !== 0xfffe) throw new Error("solo se admiten WAV PCM");
  if (fmt.bits !== 16) throw new Error("solo se admiten WAV de 16 bits");
  if (fmt.channels < 1 || (fmt.blockAlign && fmt.blockAlign !== fmt.channels * 2)) {
    throw new Error("cabecera WAV incoherente");
  }
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
