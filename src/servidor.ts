/**
 * Página de salud para el servidor (Render). Render exige que el servicio escuche en un puerto, y el plan
 * gratuito apaga el servicio tras 15 min sin visitas: un monitor externo (cron-job.org, UptimeRobot…) que
 * visite esta página cada 5–10 min lo mantiene despierto. Telegram no cuenta como visita (el bot le pregunta
 * a Telegram, no al revés).
 */
import { createServer, type Server } from "node:http";

const inicio = Date.now();

export function iniciarServidor(puerto: number, log: (mensaje: string) => void): Server {
  const servidor = createServer((peticion, respuesta) => {
    const minutos = Math.floor((Date.now() - inicio) / 60_000);
    respuesta.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    // HEAD (lo usan algunos monitores) va sin cuerpo.
    respuesta.end(peticion.method === "HEAD" ? undefined : `ok: el bot está funcionando (hace ${minutos} min)\n`);
  });
  servidor.listen(puerto, () => log(`Página de salud en el puerto ${puerto}`));
  return servidor;
}
