import {
  send,
  receive,
  wavEncode,
  wavDecode,
  ReplayGuard,
  PROFILES,
  FRAMES,
  FS,
  signalSeconds,
  StreamReceiver,
  Resampler,
} from "./spacewases.js?v=20261031b";

const PROFILE_LABELS = {
  robust: "Robusto",
  normal: "Normal",
  fast: "Rápido",
};

const encoder = new TextEncoder();
const $ = (id) => document.getElementById(id);

const tabs = {
  settings: [$("tab-settings"), $("view-settings")],
  messages: [$("tab-messages"), $("view-messages")],
  spectrum: [$("tab-spectrum"), $("view-spectrum")],
};
const dotMessages = $("dot-messages");
const dotSpectrum = $("dot-spectrum");

const messagesList = $("messages");
const rxStatus = $("rx-status");
const txProgress = $("tx-progress");
const cancelRxButton = $("cancel-rx");
const listenButton = $("listen");
const sendForm = $("send-form");
const sendText = $("send-text");
const emitButton = $("emit");
const durationLabel = $("duration");

const spectrumCanvas = $("spectrum");

const volumeInput = $("volume");
const volumeValue = $("volume-value");
const protocolsBox = $("protocols");
const sendRepeat = $("send-repeat");
const keyInput = $("key");
const replayCheck = $("replay-guard");
const downloadButton = $("download");
const wavFile = $("wav-file");
const fileStatus = $("file-status");
const localSnr = $("local-snr");
const snrValue = $("snr-value");
const localRun = $("local-run");
const localResult = $("local-result");

// --- Pestañas ---------------------------------------------------------------

let currentTab = "messages";

function showTab(name) {
  currentTab = name;
  for (const [key, [tab, view]] of Object.entries(tabs)) {
    const selected = key === name;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
    view.hidden = !selected;
  }
  if (name === "messages") dotMessages.hidden = true;
  if (name === "spectrum") startSpectrum();
}

const tabOrder = Object.keys(tabs);
for (const [name, [tab]] of Object.entries(tabs)) {
  tab.addEventListener("click", () => showTab(name));
  tab.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    const step = event.key === "ArrowRight" ? 1 : -1;
    const next = tabOrder[(tabOrder.indexOf(name) + step + tabOrder.length) % tabOrder.length];
    showTab(next);
    tabs[next][0].focus();
  });
}

// --- Ajustes ----------------------------------------------------------------

let profile = "normal";

for (const name of Object.keys(PROFILES)) {
  const [, chunk, parity] = PROFILES[name];
  const symbolMs = Math.round((FRAMES[name] * 1024 * 1000) / FS);
  const label = document.createElement("label");
  const radio = document.createElement("input");
  radio.type = "radio";
  radio.name = "protocol";
  radio.value = name;
  radio.checked = name === profile;
  radio.addEventListener("change", () => {
    profile = name;
    updateComposer();
  });
  const text = document.createElement("span");
  text.textContent = PROFILE_LABELS[name];
  const detail = document.createElement("span");
  detail.className = "proto-detail";
  detail.textContent = `${symbolMs} ms por símbolo · ${parity} B de paridad`;
  detail.title = `${chunk} B por bloque`;
  label.append(radio, text, detail);
  protocolsBox.append(label);
}

function volume() {
  return Number(volumeInput.value) / 100;
}

volumeInput.addEventListener("input", () => {
  volumeValue.textContent = `${volumeInput.value} %`;
});

function keyBytes() {
  return keyInput.value.length ? encoder.encode(keyInput.value) : null;
}

function repeatCount() {
  const value = Number.parseInt(sendRepeat.value, 10);
  return value >= 1 && value <= 3 ? value : 1;
}

function formatSeconds(seconds) {
  return seconds.toLocaleString("es", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

const MAX_LIVE_SECONDS = 90;

function updateComposer() {
  sendText.placeholder = `Enviar mensaje con «${PROFILE_LABELS[profile]}»`;
  const bytes = encoder.encode(sendText.value).length;
  if (bytes === 0) {
    durationLabel.textContent = "";
    return;
  }
  const [, chunk] = PROFILES[profile];
  if (bytes > 255 * chunk) {
    durationLabel.textContent = `Mensaje demasiado largo para ${PROFILE_LABELS[profile]}.`;
    return;
  }
  const seconds = signalSeconds(bytes, profile, keyBytes() !== null, repeatCount());
  let text = `≈ ${formatSeconds(seconds)} s · ${bytes} B`;
  if (seconds > MAX_LIVE_SECONDS) text += ` · más de ${MAX_LIVE_SECONDS} s: no se recibirá en vivo; usa un WAV`;
  durationLabel.textContent = text;
}

sendText.addEventListener("input", updateComposer);
keyInput.addEventListener("input", updateComposer);
sendRepeat.addEventListener("change", updateComposer);

// --- Historial --------------------------------------------------------------

function timeString(date) {
  return date.toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function decodeText(bytes) {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text.length ? text : "(mensaje vacío)";
  } catch {
    return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join(" ");
  }
}

// Una línea al estilo de Waver: hora | Recv/Send | protocolo | texto.
function addLogEntry({ direction, profileName = null, encrypted = false, text, error = false }) {
  const hint = messagesList.querySelector(".log-hint");
  if (hint) hint.remove();
  const item = document.createElement("li");
  const now = new Date();
  const time = document.createElement("time");
  time.className = "meta-line";
  time.dateTime = now.toISOString();
  time.textContent = `${timeString(now)} | `;
  item.append(time);

  const dir = document.createElement("span");
  dir.className = direction === "Recv" ? "recv" : direction === "Send" ? "send" : "error-text";
  dir.textContent = direction;
  item.append(dir, separator());

  if (profileName) {
    const proto = document.createElement("span");
    proto.className = "proto";
    proto.textContent = PROFILE_LABELS[profileName] + (encrypted ? " · cifrado" : "");
    item.append(proto, separator());
  }

  const body = document.createElement("span");
  if (error) body.className = "error-text";
  body.textContent = text;
  item.append(body);

  messagesList.append(item);
  while (messagesList.children.length > 200) messagesList.firstElementChild.remove();
  messagesList.scrollTop = messagesList.scrollHeight;
  if (currentTab !== "messages" && direction !== "Send") dotMessages.hidden = false;
}

function separator() {
  const span = document.createElement("span");
  span.className = "meta-line";
  span.textContent = " | ";
  return span;
}

function setRxStatus(text, kind = "") {
  rxStatus.textContent = text;
  if (kind) rxStatus.dataset.kind = kind;
  else delete rxStatus.dataset.kind;
}

function idleStatus() {
  if (listening) setRxStatus("Escuchando ondas (longitud variable)…");
  else setRxStatus("Micrófono apagado");
}

// --- Envío ------------------------------------------------------------------

let playbackContext = null;
let transmitting = false;

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

async function buildSignal() {
  const signal = await send(encoder.encode(sendText.value), keyBytes(), profile, repeatCount());
  const gain = volume();
  if (gain !== 1) for (let i = 0; i < signal.length; i++) signal[i] *= gain;
  return signal;
}

function showTxProgress(context, startTime, seconds) {
  txProgress.hidden = false;
  const tick = () => {
    if (!transmitting) return;
    txProgress.value = Math.min(1, (context.currentTime - startTime) / seconds);
    window.requestAnimationFrame(tick);
  };
  tick();
}

function finishTransmission() {
  transmitting = false;
  emitButton.disabled = false;
  txProgress.hidden = true;
  txProgress.value = 0;
  // Lo que el micrófono captó durante la emisión es nuestra propia señal: se descarta.
  clearLiveAudio();
  idleStatus();
}

sendForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (transmitting || sendText.value.length === 0) return;
  transmitting = true;
  emitButton.disabled = true;
  setRxStatus("Generando señal…", "send");
  try {
    const signal = await buildSignal();
    const context = await ensurePlaybackContext();
    const buffer = context.createBuffer(1, signal.length, FS);
    buffer.getChannelData(0).set(signal);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    const seconds = signal.length / FS;
    addLogEntry({ direction: "Send", profileName: profile, encrypted: keyBytes() !== null, text: sendText.value });
    sendText.value = "";
    updateComposer();
    setRxStatus(`Enviando ${formatSeconds(seconds)} s`, "send");
    source.onended = finishTransmission;
    const startTime = context.currentTime;
    source.start();
    showTxProgress(context, startTime, seconds);
  } catch (error) {
    finishTransmission();
    addLogEntry({ direction: "Error", text: `No se pudo enviar: ${error.message}`, error: true });
  }
});

let downloadBusy = false;

downloadButton.addEventListener("click", async () => {
  if (downloadBusy) return;
  if (sendText.value.length === 0) {
    fileStatus.textContent = "Escribe primero el mensaje en la pestaña Mensajes.";
    return;
  }
  downloadBusy = true;
  downloadButton.disabled = true;
  fileStatus.textContent = "Preparando WAV…";
  try {
    const wav = wavEncode(await buildSignal());
    const url = URL.createObjectURL(new Blob([wav], { type: "audio/wav" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "spacewases.wav";
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 2000);
    fileStatus.textContent = "WAV guardado.";
  } catch (error) {
    fileStatus.textContent = `No se pudo generar el WAV: ${error.message}`;
  } finally {
    downloadBusy = false;
    downloadButton.disabled = false;
  }
});

// --- Recepción en vivo ------------------------------------------------------
// El micrófono alimenta un receptor en flujo: detecta el chirp de inicio, graba
// hasta el de fin y decodifica en ese momento.

const liveReceiver = new StreamReceiver({ maxSeconds: MAX_LIVE_SECONDS });
let liveGuard = new ReplayGuard();
let pendingAudio = [];

let captureRate = FS;
let resampler = null;
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

function clearLiveAudio() {
  pendingAudio = [];
  liveReceiver.reset();
  cancelRxButton.hidden = true;
}

function takePendingAudio() {
  const total = pendingAudio.reduce((n, part) => n + part.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const part of pendingAudio) {
    out.set(part, offset);
    offset += part.length;
  }
  pendingAudio = [];
  return out;
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
  for (const node of [sourceNode, silentGain, analyserNode]) if (node) node.disconnect();
  sourceNode = null;
  silentGain = null;
  analyserNode = null;
  if (micStream) {
    for (const track of micStream.getTracks()) track.stop();
    micStream = null;
  }
  if (micContext) {
    micContext.close().catch(() => {});
    micContext = null;
  }
  captureRate = FS;
  resampler = null;
  clearLiveAudio();
  listenButton.textContent = "Activar micrófono";
  listenButton.classList.remove("active");
  dotSpectrum.className = "dot dot-off";
  idleStatus();
}

async function startListening() {
  if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setRxStatus("El micrófono necesita HTTPS o localhost.", "error");
    return;
  }
  setRxStatus("Solicitando permiso de micrófono…");
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      video: false,
    });
  } catch (error) {
    const denied = error && error.name === "NotAllowedError";
    setRxStatus(denied ? "Permiso de micrófono denegado." : "No se pudo abrir el micrófono.", "error");
    return;
  }

  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) throw new Error("este navegador no admite Web Audio");
    // Se pide 48 kHz; algunos navegadores (Firefox) no conectan un micrófono de otra
    // frecuencia a ese contexto, y entonces se usa la del sistema y se remuestrea.
    try {
      micContext = new AudioContextClass({ sampleRate: FS });
      sourceNode = micContext.createMediaStreamSource(micStream);
    } catch {
      if (micContext) micContext.close().catch(() => {});
      micContext = new AudioContextClass();
      sourceNode = micContext.createMediaStreamSource(micStream);
    }
    captureRate = micContext.sampleRate;
    resampler = new Resampler(captureRate, FS);
    if (micContext.state === "suspended") await micContext.resume();

    analyserNode = micContext.createAnalyser();
    analyserNode.fftSize = 2048;
    analyserNode.smoothingTimeConstant = 0.6;
    sourceNode.connect(analyserNode);

    processorNode = micContext.createScriptProcessor(4096, 1, 1);
    processorNode.onaudioprocess = (event) => {
      if (!listening || transmitting) return;
      pendingAudio.push(Float32Array.from(event.inputBuffer.getChannelData(0)));
    };
    silentGain = micContext.createGain();
    silentGain.gain.value = 0;
    sourceNode.connect(processorNode);
    processorNode.connect(silentGain);
    silentGain.connect(micContext.destination);

    clearLiveAudio();
    liveGuard = new ReplayGuard();
    listening = true;
    listenButton.textContent = "Apagar micrófono";
    listenButton.classList.add("active");
    dotSpectrum.className = "dot dot-on";
    idleStatus();
    if (currentTab === "spectrum") startSpectrum();
    scanTimer = window.setTimeout(scanLoop, 200);
  } catch (error) {
    stopListening();
    setRxStatus(`No se pudo iniciar la escucha: ${error.message}`, "error");
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

cancelRxButton.addEventListener("click", () => {
  clearLiveAudio();
  idleStatus();
});

async function scanOnce() {
  if (pendingAudio.length === 0 || transmitting) return;
  const samples = resampler.push(takePendingAudio());
  const key = keyBytes();
  const guard = key !== null && replayCheck.checked ? liveGuard : null;
  const event = await liveReceiver.push(samples, key, guard);
  if (event.message !== null) {
    addLogEntry({
      direction: "Recv",
      profileName: event.profile,
      encrypted: key !== null,
      text: decodeText(event.message),
    });
  } else if (event.rejected !== null) {
    const why =
      event.rejected === "repetido"
        ? "mensaje repetido (posible reenvío de una grabación)"
        : "mensaje antiguo o con la hora de un dispositivo mal puesta";
    addLogEntry({ direction: "Error", text: `Descartado: ${why}`, error: true });
  } else if (event.failed) {
    addLogEntry({
      direction: "Error",
      text: key !== null ? "Señal recibida pero no decodificada (¿misma clave?)" : "Señal recibida pero no decodificada",
      error: true,
    });
  }
  if (liveReceiver.state === "recording") {
    const seconds = liveReceiver.buffer.length / FS;
    setRxStatus(`Recibiendo… ${formatSeconds(seconds)} s`, "busy");
    cancelRxButton.hidden = false;
  } else {
    cancelRxButton.hidden = true;
    if (!transmitting) idleStatus();
  }
}

async function scanLoop() {
  if (!listening) return;
  if (!scanning) {
    scanning = true;
    try {
      await scanOnce();
    } catch (error) {
      if (listening) addLogEntry({ direction: "Error", text: `Error al decodificar: ${error.message}`, error: true });
    } finally {
      scanning = false;
    }
  }
  if (listening) scanTimer = window.setTimeout(scanLoop, 200);
}

// --- Espectro y cascada -----------------------------------------------------

let spectrumFrame = 0;
let waterfall = null;

function startSpectrum() {
  if (!spectrumFrame) spectrumFrame = window.requestAnimationFrame(drawSpectrum);
}

function waterfallColor(value) {
  // De negro a verde y a amarillo, como el espectro de Waver.
  const v = Math.min(1, value);
  return [Math.round(255 * Math.max(0, v * 2 - 1)), Math.round(255 * Math.min(1, v * 1.6)), Math.round(40 * v)];
}

function drawSpectrum() {
  spectrumFrame = 0;
  if (currentTab !== "spectrum") return;
  spectrumFrame = window.requestAnimationFrame(drawSpectrum);

  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.floor(spectrumCanvas.clientWidth * ratio));
  const height = Math.max(1, Math.floor(spectrumCanvas.clientHeight * ratio));
  if (spectrumCanvas.width !== width || spectrumCanvas.height !== height) {
    spectrumCanvas.width = width;
    spectrumCanvas.height = height;
    waterfall = null;
  }
  const context = spectrumCanvas.getContext("2d");
  const barsHeight = Math.floor(height * 0.35);
  const fallTop = barsHeight + Math.round(6 * ratio);
  const fallHeight = height - fallTop;

  context.fillStyle = "#0b0b0b";
  context.fillRect(0, 0, width, barsHeight);
  if (!analyserNode) {
    context.fillStyle = "#8f8f8f";
    context.font = `${Math.round(14 * ratio)}px sans-serif`;
    context.fillText("Activa el micrófono en la pestaña Mensajes", Math.round(12 * ratio), Math.round(28 * ratio));
    return;
  }

  const bins = new Uint8Array(analyserNode.frequencyBinCount);
  analyserNode.getByteFrequencyData(bins);
  const maxBin = Math.min(bins.length - 1, Math.floor((8000 / (captureRate / 2)) * bins.length));
  const columns = Math.min(width, 256);
  const column = width / columns;

  context.fillStyle = "#4fe07a";
  const values = new Float32Array(columns);
  for (let i = 0; i < columns; i++) {
    const value = bins[Math.round((i / (columns - 1)) * maxBin)] / 255;
    values[i] = value;
    const h = Math.max(1, value * (barsHeight - 4));
    context.fillRect(i * column, barsHeight - h, Math.max(1, column - 1), h);
  }

  // Cascada: desplaza una fila hacia abajo y pinta la nueva arriba.
  if (fallHeight > 2) {
    if (!waterfall || waterfall.width !== width) {
      waterfall = context.createImageData(width, fallHeight);
    }
    const data = waterfall.data;
    data.copyWithin(width * 4, 0, data.length - width * 4);
    for (let x = 0; x < width; x++) {
      const [r, g, b] = waterfallColor(values[Math.min(columns - 1, Math.floor(x / column))]);
      data[x * 4] = r;
      data[x * 4 + 1] = g;
      data[x * 4 + 2] = b;
      data[x * 4 + 3] = 255;
    }
    context.putImageData(waterfall, 0, fallTop);
  }
}

// --- WAV y prueba sin micrófono ---------------------------------------------

// Unos 17 min de audio mono a 48 kHz; evita que un archivo enorme cuelgue la pestaña.
const MAX_WAV_BYTES = 100 * 1024 * 1024;

wavFile.addEventListener("change", async () => {
  const file = wavFile.files && wavFile.files[0];
  if (!file) return;
  if (file.size > MAX_WAV_BYTES) {
    fileStatus.textContent = "WAV demasiado grande (máximo 100 MB).";
    wavFile.value = "";
    return;
  }
  fileStatus.textContent = `Leyendo ${file.name}…`;
  try {
    const signal = wavDecode(new Uint8Array(await file.arrayBuffer()));
    const key = keyBytes();
    let decodedProfile = null;
    const message = await receive(signal, key, (status) => {
      if (status.decoded) decodedProfile = status.profile;
    });
    if (message !== null) {
      addLogEntry({ direction: "Recv", profileName: decodedProfile, encrypted: key !== null, text: `${decodeText(message)} (WAV)` });
      fileStatus.textContent = "WAV decodificado: el mensaje está en la pestaña Mensajes.";
    } else {
      fileStatus.textContent = "No se pudo decodificar el WAV. Revisa la clave.";
    }
  } catch (error) {
    fileStatus.textContent = `WAV no válido: ${error.message}`;
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
  localResult.textContent = "Generando y decodificando…";
  try {
    const snr = Number(localSnr.value);
    const text = sendText.value.length ? sendText.value : "prueba local de spacewases";
    const signal = await send(encoder.encode(text), null, profile);
    let power = 0;
    for (let i = 0; i < signal.length; i++) power += signal[i] * signal[i];
    power /= signal.length;
    const sigma = Math.sqrt(power / Math.pow(10, snr / 10));
    const noisy = new Float32Array(signal.length);
    for (let i = 0; i < signal.length; i++) noisy[i] = signal[i] + sigma * gaussianRandom();
    const started = performance.now();
    const result = await receive(noisy, null);
    const elapsed = Math.round(performance.now() - started);
    localResult.textContent =
      result !== null
        ? `Éxito con ${PROFILE_LABELS[profile]} a ${snr} dB en ${elapsed} ms: «${decodeText(result)}»`
        : `Fallo con ${PROFILE_LABELS[profile]} a ${snr} dB. Prueba otro protocolo o menos ruido.`;
  } catch (error) {
    localResult.textContent = `Error: ${error.message}`;
  } finally {
    localBusy = false;
    localRun.disabled = false;
  }
});

// --- Inicio -----------------------------------------------------------------

showTab("messages");
updateComposer();
idleStatus();

if (!globalThis.crypto || !globalThis.crypto.subtle) {
  setRxStatus("Este navegador no expone crypto.subtle: abre la página por HTTPS.", "error");
  emitButton.disabled = true;
}
