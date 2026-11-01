// Hilo aparte para la recepción en vivo: buscar el chirp y decodificar cuesta segundos
// en un móvil, y aquí no congelan la página. La lógica está en LiveSession.
import { LiveSession } from "./spacewases.js?v=20261101a";

let session = null;

self.onmessage = ({ data }) => {
  if (data.type === "start") {
    session = new LiveSession(data.captureRate, (event) => self.postMessage(event), { maxSeconds: data.maxSeconds });
  } else if (data.type === "audio" && session) {
    session.feed(data.samples, data.key, data.replayCheck);
  } else if (data.type === "reset" && session) {
    session.reset();
  }
};
