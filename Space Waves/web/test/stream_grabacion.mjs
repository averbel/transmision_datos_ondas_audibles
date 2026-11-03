// Pasa una grabacion real (float32 crudo a 48 kHz) por StreamReceiver en trozos de 4096
// muestras, como los entrega el navegador, e imprime cada evento.
// Uso: node stream_grabacion.mjs archivo.f32
import { readFileSync } from "node:fs";
import { StreamReceiver, FS } from "../spacewaves.js";

const bytes = readFileSync(process.argv[2]);
const audio = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
const receiver = new StreamReceiver();
const decoder = new TextDecoder();
const CHUNK = 4096;

for (let offset = 0; offset < audio.length; offset += CHUNK) {
  const before = receiver.state;
  const event = await receiver.push(audio.slice(offset, offset + CHUNK));
  const t = ((offset + CHUNK) / FS).toFixed(2);
  if (before === "idle" && event.state === "recording") console.log(`${t} s  inicio detectado`);
  if (event.message !== null) console.log(`${t} s  MENSAJE: "${decoder.decode(event.message)}"`);
  if (event.failed) console.log(`${t} s  señal detectada pero no decodificada`);
}
console.log(`fin de la grabación (${(audio.length / FS).toFixed(1)} s), estado ${receiver.state}`);
