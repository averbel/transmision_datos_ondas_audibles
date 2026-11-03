// Pasa las capturas de grabar_serie.py por dos versiones del receptor en flujo, en trozos
// de 4096 muestras como la web, e imprime un CSV. Uso:
// node comparar_receptores.mjs CARPETA receptor_a.js receptor_b.js > resultados.csv
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const [folder, pathA, pathB] = process.argv.slice(2);
const load = (path) => import(pathToFileURL(resolve(path)).href);
const [a, b] = [await load(pathA), await load(pathB)];

async function decode(module, audio, expected) {
  const receiver = new module.StreamReceiver();
  const padded = new Float32Array(audio.length + 2 * module.FS);
  padded.set(audio, 0);
  let result = "nada";
  let at = -1;
  for (let off = 0; off < padded.length; off += 4096) {
    const event = await receiver.push(padded.slice(off, off + 4096));
    for (const r of event.results) {
      if (result === "ok") continue;
      const hex = r.message ? Buffer.from(r.message).toString("hex") : null;
      result = hex === expected ? "ok" : hex ? "erroneo" : "fallo";
      if (result === "ok") at = (off + 4096) / module.FS;
    }
  }
  return { result, at };
}

console.log("archivo,perfil,ganancia,ensayo,pico,a,a_segundos,b,b_segundos");
const rows = readFileSync(`${folder}/manifiesto.csv`, "utf8").trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [file, profile, gain, trial, hex, peak] = row.split(",");
  const bytes = readFileSync(`${folder}/${file}`);
  const audio = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
  const ra = await decode(a, audio, hex);
  const rb = await decode(b, audio, hex);
  console.log([file, profile, gain, trial, peak, ra.result, ra.at, rb.result, rb.at].join(","));
}
