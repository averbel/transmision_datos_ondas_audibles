import {
  send,
  receive,
  wavEncode,
  wavDecode,
  ReplayGuard,
  PROFILES,
  FS,
  SYMBOL,
  CYCLIC_PREFIX,
  CHIRP_LEN,
  GUARD,
  dataLen,
} from "./spacewases.js";

const PROFILE_LABELS = {
  robust: "Robusto",
  normal: "Normal",
  fast: "Rápido",
};

const encoder = new TextEncoder();

const sendText = document.getElementById("send-text");
const sendProfile = document.getElementById("send-profile");
const sendKey = document.getElementById("send-key");
const sendRepeat = document.getElementById("send-repeat");
const replayCheck = document.getElementById("replay-guard");
const emitButton = document.getElementById("emit");
const downloadButton = document.getElementById("download");
const sendStatus = document.getElementById("send-status");
const durationLabel = document.getElementById("duration");

const receiveKey = document.getElementById("receive-key");
const listenButton = document.getElementById("listen");
const receiveStatus = document.getElementById("receive-status");
const spectrumCanvas = document.getElementById("spectrum");
const wavFile = document.getElementById("wav-file");
const messagesList = document.getElementById("messages");

const localText = document.getElementById("local-text");
const localProfile = document.getElementById("local-profile");
const localSnr = document.getElementById("local-snr");
const snrValue = document.getElementById("snr-value");
const localRun = document.getElementById("local-run");
const localResult = document.getElementById("local-result");

for (const select of [sendProfile, localProfile]) {
  for (const name of Object.keys(PROFILES)) {
    const [, chunk, parity] = PROFILES[name];
    const option = document.createElement("option");
    option.value = name;
    option.textContent = `${PROFILE_LABELS[name]} · ${chunk} B por bloque · RS ${parity}`;
    select.append(option);
  }
  select.value = "normal";
}

function setStatus(element, text, kind = "") {
  element.textContent = text;
  if (kind) element.dataset.kind = kind;
  else delete element.dataset.kind;
}

function keyFrom(input) {
  return input.value.length ? encoder.encode(input.value) : null;
}

function repeatCount() {
  const value = Number.parseInt(sendRepeat.value, 10);
  return value >= 1 && value <= 3 ? value : 1;
}

function estimateSeconds(byteLength, profileName, keyed = false, repeat = 1) {
  const [, chunk, parity] = PROFILES[profileName];
  const total = Math.max(1, Math.ceil(byteLength / chunk));
  const raw = repeat * total * (dataLen(chunk, keyed) + parity);
  const samples = 2 * CHIRP_LEN + 2 * GUARD + raw * (SYMBOL + CYCLIC_PREFIX);
  return samples / FS;
}

function updateDuration() {
  const bytes = encoder.encode(sendText.value).length;
  const profile = sendProfile.value;
  const [, chunk] = PROFILES[profile];
  const maxBytes = 255 * chunk;
  if (bytes > maxBytes) {
    durationLabel.textContent = `Mensaje demasiado largo para el perfil ${PROFILE_LABELS[profile]}.`;
    return;
  }
  const seconds = estimateSeconds(bytes, profile, keyFrom(sendKey) !== null, repeatCount());
  const formatted = seconds.toLocaleString("es", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  let text = `Duración estimada: ${formatted} s · ${bytes} B`;
  if (seconds > SCAN_SECONDS) {
    text += ` · más de ${SCAN_SECONDS} s: la escucha en vivo no la decodificará; usa un WAV o menos repeticiones`;
  }
  durationLabel.textContent = text;
}

sendText.addEventListener("input", updateDuration);
sendProfile.addEventListener("change", updateDuration);
sendKey.addEventListener("input", updateDuration);
sendRepeat.addEventListener("change", updateDuration);

let playbackContext = null;

async function ensurePlaybackContext() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) throw new Error("este navegador no admite Web Audio");
  if (!playbackContext) {
    try {
      playbackContext = new AudioContextClass({ sampleRate: FS });
    } catch {
      playbackContext = new AudioContextClass();
    }
  }
  if (playbackContext.state === "suspended") await playbackContext.resume();
  return playbackContext;
}

let emitBusy = false;

emitButton.addEventListener("click", async () => {
  if (emitBusy) return;
  emitBusy = true;
  emitButton.disabled = true;
  setStatus(sendStatus, "Generando señal…", "busy");
  try {
    const signal = await send(
      encoder.encode(sendText.value),
      keyFrom(sendKey),
      sendProfile.value,
      repeatCount()
    );
    const context = await ensurePlaybackContext();
    const buffer = context.createBuffer(1, signal.length, FS);
    buffer.getChannelData(0).set(signal);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    const seconds = signal.length / FS;
    setStatus(
      sendStatus,
      `Emitiendo ${seconds.toLocaleString("es", {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      })} s…`,
      "busy"
    );
    source.onended = () => {
      emitBusy = false;
      emitButton.disabled = false;
      setStatus(sendStatus, "Emisión terminada.", "ok");
    };
    source.start();
  } catch (error) {
    emitBusy = false;
    emitButton.disabled = false;
    setStatus(sendStatus, `No se pudo emitir: ${error.message}`, "error");
  }
});

let downloadBusy = false;

downloadButton.addEventListener("click", async () => {
  if (downloadBusy) return;
  downloadBusy = true;
  downloadButton.disabled = true;
  setStatus(sendStatus, "Preparando WAV…", "busy");
  try {
    const signal = await send(
      encoder.encode(sendText.value),
      keyFrom(sendKey),
      sendProfile.value,
      repeatCount()
    );
    const wav = wavEncode(signal);
    const blob = new Blob([wav], { type: "audio/wav" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "spacewases.wav";
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 2000);
    setStatus(sendStatus, "WAV descargado.", "ok");
  } catch (error) {
    setStatus(sendStatus, `No se pudo generar el WAV: ${error.message}`, "error");
  } finally {
    downloadBusy = false;
    downloadButton.disabled = false;
  }
});

const RING_SECONDS = 25;
const SCAN_SECONDS = 20;
const ring = new Float32Array(FS * RING_SECONDS);

let ringPosition = 0;
let ringFilled = 0;
let captureRate = FS;
let listening = false;
let starting = false;
let scanning = false;
let scanTimer = 0;
let micContext = null;
let micStream = null;
let sourceNode = null;
let processorNode = null;
let silentGain = null;
let analyserNode = null;
let spectrumFrame = 0;

function clearRing() {
  ringPosition = 0;
  ringFilled = 0;
}

function pushRing(input) {
  const capacity = ring.length;
  for (let i = 0; i < input.length; i++) {
    ring[ringPosition] = input[i];
    ringPosition = (ringPosition + 1) % capacity;
    if (ringFilled < capacity) ringFilled++;
  }
}

function getWindow(limit) {
  const length = Math.min(ringFilled, limit);
  if (length <= 0) return new Float32Array(0);
  const output = new Float32Array(length);
  const start = (ringPosition - length + ring.length) % ring.length;
  if (start + length <= ring.length) {
    output.set(ring.subarray(start, start + length));
  } else {
    const first = ring.length - start;
    output.set(ring.subarray(start));
    output.set(ring.subarray(0, length - first), first);
  }
  return output;
}

function resampleLinear(input, fromRate, toRate) {
  if (fromRate === toRate || input.length === 0) return input;
  const outputLength = Math.max(1, Math.floor((input.length * toRate) / fromRate));
  const output = new Float32Array(outputLength);
  const step = fromRate / toRate;
  for (let i = 0; i < outputLength; i++) {
    const position = i * step;
    const index = Math.floor(position);
    const fraction = position - index;
    const a = input[Math.min(index, input.length - 1)];
    const b = input[Math.min(index + 1, input.length - 1)];
    output[i] = a + (b - a) * fraction;
  }
  return output;
}

function clearSpectrum() {
  const context = spectrumCanvas.getContext("2d");
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, spectrumCanvas.width, spectrumCanvas.height);
}

function drawSpectrum() {
  if (!analyserNode || !micContext) {
    spectrumFrame = 0;
    return;
  }
  spectrumFrame = window.requestAnimationFrame(drawSpectrum);
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.floor(spectrumCanvas.clientWidth));
  const height = Math.max(1, Math.floor(spectrumCanvas.clientHeight));
  const targetWidth = Math.round(width * ratio);
  const targetHeight = Math.round(height * ratio);
  if (spectrumCanvas.width !== targetWidth || spectrumCanvas.height !== targetHeight) {
    spectrumCanvas.width = targetWidth;
    spectrumCanvas.height = targetHeight;
  }
  const context = spectrumCanvas.getContext("2d");
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  const styles = window.getComputedStyle(document.documentElement);
  const background = styles.getPropertyValue("--canvas").trim() || "#e8e2d6";
  const accent = styles.getPropertyValue("--accent").trim() || "#0e6b5b";
  const line = styles.getPropertyValue("--line").trim() || "#d5cdbd";
  context.fillStyle = background;
  context.fillRect(0, 0, width, height);

  const bins = new Uint8Array(analyserNode.frequencyBinCount);
  analyserNode.getByteFrequencyData(bins);
  const nyquist = captureRate / 2;
  const maxFrequency = 8000;
  const maxBin = Math.min(
    bins.length - 1,
    Math.max(1, Math.floor((maxFrequency / nyquist) * bins.length))
  );
  const bars = Math.min(110, maxBin + 1);
  const gap = bars > 70 ? 1 : 2;
  const barWidth = Math.max(1, (width - gap * (bars - 1)) / bars);

  context.fillStyle = accent;
  for (let i = 0; i < bars; i++) {
    const index = Math.round((i / Math.max(1, bars - 1)) * maxBin);
    const value = bins[index] / 255;
    const barHeight = Math.max(1, value * (height - 10));
    const x = i * (barWidth + gap);
    context.fillRect(x, height - barHeight, barWidth, barHeight);
  }
  context.fillStyle = line;
  context.fillRect(0, height - 1, width, 1);
  context.globalAlpha = 0.5;
  context.fillStyle = accent;
  context.fillRect(0, height - 1, 1, height);
  context.globalAlpha = 1;
}

function addMessage(bytes, kind) {
  const item = document.createElement("li");
  const time = document.createElement("time");
  const now = new Date();
  time.dateTime = now.toISOString();
  time.textContent = now.toLocaleTimeString("es", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const text = document.createElement("span");
  text.className = "message-text";
  let decoded;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    decoded = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join(" ");
  }
  text.textContent = decoded.length ? decoded : "(mensaje vacío)";
  const label = document.createElement("span");
  label.className = "message-kind";
  label.textContent = kind;
  item.append(time, text, label);
  messagesList.prepend(item);
  while (messagesList.children.length > 25) messagesList.lastElementChild.remove();
}

function stopListening() {
  listening = false;
  if (scanTimer) {
    window.clearTimeout(scanTimer);
    scanTimer = 0;
  }
  if (processorNode) {
    processorNode.onaudioprocess = null;
    processorNode.disconnect();
    processorNode = null;
  }
  if (sourceNode) {
    sourceNode.disconnect();
    sourceNode = null;
  }
  if (silentGain) {
    silentGain.disconnect();
    silentGain = null;
  }
  if (analyserNode) {
    analyserNode.disconnect();
    analyserNode = null;
  }
  if (micStream) {
    for (const track of micStream.getTracks()) track.stop();
    micStream = null;
  }
  if (micContext) {
    micContext.close().catch(() => {});
    micContext = null;
  }
  if (spectrumFrame) {
    window.cancelAnimationFrame(spectrumFrame);
    spectrumFrame = 0;
  }
  captureRate = FS;
  listenButton.textContent = "Escuchar";
  listenButton.classList.remove("active");
  clearSpectrum();
  setStatus(receiveStatus, "Detenido.", "");
}

async function startListening() {
  if (!window.isSecureContext) {
    setStatus(
      receiveStatus,
      "El micrófono necesita HTTPS o localhost. Abre esta página desde un servidor local.",
      "error"
    );
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setStatus(
      receiveStatus,
      "Este navegador no ofrece captura de micrófono. Usa HTTPS o localhost.",
      "error"
    );
    return;
  }
  setStatus(receiveStatus, "Solicitando permiso de micrófono…", "busy");
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      video: false,
    });
  } catch (error) {
    const reason =
      error && error.name === "NotAllowedError"
        ? "Permiso de micrófono denegado."
        : "No se pudo abrir el micrófono.";
    setStatus(receiveStatus, `${reason} Usa HTTPS o localhost y concede el permiso.`, "error");
    return;
  }

  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) throw new Error("este navegador no admite Web Audio");
    try {
      micContext = new AudioContextClass({ sampleRate: FS });
    } catch {
      micContext = new AudioContextClass();
    }
    captureRate = micContext.sampleRate;
    if (micContext.state === "suspended") await micContext.resume();

    sourceNode = micContext.createMediaStreamSource(micStream);
    analyserNode = micContext.createAnalyser();
    analyserNode.fftSize = 2048;
    analyserNode.smoothingTimeConstant = 0.75;
    sourceNode.connect(analyserNode);

    processorNode = micContext.createScriptProcessor(4096, 1, 1);
    processorNode.onaudioprocess = (event) => {
      if (!listening) return;
      pushRing(event.inputBuffer.getChannelData(0));
    };
    silentGain = micContext.createGain();
    silentGain.gain.value = 0;
    sourceNode.connect(processorNode);
    processorNode.connect(silentGain);
    silentGain.connect(micContext.destination);

    clearRing();
    liveGuard = new ReplayGuard();
    listening = true;
    listenButton.textContent = "Detener";
    listenButton.classList.add("active");
    setStatus(receiveStatus, "Escuchando…", "busy");
    drawSpectrum();
    scanTimer = window.setTimeout(scanLoop, 700);
  } catch (error) {
    stopListening();
    setStatus(receiveStatus, `No se pudo iniciar la escucha: ${error.message}`, "error");
  }
}

listenButton.addEventListener("click", async () => {
  if (starting) return;
  if (listening) {
    stopListening();
    return;
  }
  starting = true;
  listenButton.disabled = true;
  try {
    await startListening();
  } finally {
    starting = false;
    listenButton.disabled = false;
  }
});

// Una guardia por sesion de escucha: recuerda las sesiones vistas mientras la pagina siga abierta.
let liveGuard = new ReplayGuard();

async function scanOnce() {
  const limit = Math.min(ringFilled, FS * SCAN_SECONDS);
  if (limit < CHIRP_LEN * 2) return;
  let windowSamples = getWindow(limit);
  if (captureRate !== FS) windowSamples = resampleLinear(windowSamples, captureRate, FS);
  let detected = false;
  const key = keyFrom(receiveKey);
  const guard = key !== null && replayCheck.checked ? liveGuard : null;
  const message = await receive(
    windowSamples,
    key,
    (info) => {
      if (info.detected) detected = true;
    },
    guard
  );
  if (message !== null) {
    addMessage(message, key !== null ? "decodificado · cifrado" : "decodificado · sin cifrar");
    setStatus(receiveStatus, "Decodificado.", "ok");
    clearRing();
    return;
  }
  if (guard !== null && guard.lastReason !== null) {
    const why =
      guard.lastReason === "repetido"
        ? "ya se había recibido (posible repetición)"
        : "es antiguo o la hora de uno de los dispositivos no es correcta";
    setStatus(receiveStatus, `Mensaje descartado: ${why}.`, "error");
    clearRing();
    return;
  }
  if (detected) setStatus(receiveStatus, "Señal detectada; intentando decodificar…", "busy");
  else setStatus(receiveStatus, "Escuchando…", "busy");
}

async function scanLoop() {
  if (!listening) return;
  if (!scanning) {
    scanning = true;
    try {
      await scanOnce();
    } catch (error) {
      if (listening) setStatus(receiveStatus, `Error al decodificar: ${error.message}`, "error");
    } finally {
      scanning = false;
    }
  }
  if (listening) scanTimer = window.setTimeout(scanLoop, 700);
}

wavFile.addEventListener("change", async () => {
  const file = wavFile.files && wavFile.files[0];
  if (!file) return;
  setStatus(receiveStatus, `Leyendo ${file.name}…`, "busy");
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const signal = wavDecode(bytes);
    const key = keyFrom(receiveKey);
    const message = await receive(signal, key);
    if (message !== null) {
      addMessage(message, key !== null ? "WAV · cifrado" : "WAV · sin cifrar");
      setStatus(receiveStatus, "WAV decodificado.", "ok");
    } else {
      setStatus(receiveStatus, "No se pudo decodificar el WAV. Revisa la clave.", "error");
    }
  } catch (error) {
    setStatus(receiveStatus, `WAV no válido: ${error.message}`, "error");
  } finally {
    wavFile.value = "";
  }
});

let spareGaussian = null;

function gaussianRandom() {
  if (spareGaussian !== null) {
    const value = spareGaussian;
    spareGaussian = null;
    return value;
  }
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  const radius = Math.sqrt(-2 * Math.log(u));
  const angle = 2 * Math.PI * v;
  spareGaussian = radius * Math.sin(angle);
  return radius * Math.cos(angle);
}

localSnr.addEventListener("input", () => {
  snrValue.textContent = `${localSnr.value} dB`;
});

let localBusy = false;

localRun.addEventListener("click", async () => {
  if (localBusy) return;
  localBusy = true;
  localRun.disabled = true;
  setStatus(localResult, "Generando y decodificando…", "busy");
  try {
    const profile = localProfile.value;
    const snr = Number(localSnr.value);
    const message = encoder.encode(localText.value);
    const signal = await send(message, null, profile);
    let power = 0;
    for (let i = 0; i < signal.length; i++) power += signal[i] * signal[i];
    power /= signal.length;
    const sigma = Math.sqrt(power / Math.pow(10, snr / 10));
    const noisy = new Float32Array(signal.length);
    for (let i = 0; i < signal.length; i++) {
      noisy[i] = signal[i] + sigma * gaussianRandom();
    }
    const started = performance.now();
    const result = await receive(noisy, null);
    const elapsed = Math.round(performance.now() - started);
    if (result !== null) {
      const text = new TextDecoder().decode(result);
      setStatus(localResult, `Éxito a ${snr} dB en ${elapsed} ms: “${text}”`, "ok");
    } else {
      setStatus(
        localResult,
        `Fallo a ${snr} dB en ${elapsed} ms. Prueba otro perfil o menos ruido.`,
        "error"
      );
    }
  } catch (error) {
    setStatus(localResult, `Error: ${error.message}`, "error");
  } finally {
    localBusy = false;
    localRun.disabled = false;
  }
});

updateDuration();
snrValue.textContent = `${localSnr.value} dB`;

if (!globalThis.crypto || !globalThis.crypto.subtle) {
  setStatus(
    sendStatus,
    "Este navegador no expone crypto.subtle. Abre la página por HTTPS o localhost.",
    "error"
  );
  setStatus(
    localResult,
    "La prueba local necesita crypto.subtle: usa HTTPS o localhost.",
    "error"
  );
}
