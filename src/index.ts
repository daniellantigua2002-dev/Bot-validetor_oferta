/**
 * Punto de entrada: arranca el bot de Telegram (npm run bot / npm start).
 * En un servidor (Render, con PORT) también abre la página de salud y revisa si Banxico le responde.
 */
import { revisarBanxico } from "./banxico/reintentos.js";
import { iniciarBot, log } from "./bot/index.js";
import { entorno } from "./entorno.js";
import { iniciarServidor } from "./servidor.js";

if (entorno.puerto !== null) {
  iniciarServidor(entorno.puerto, log);
  // Los sitios de bancos y de gobierno bloquean a veces las IP de centros de datos: se sabe al arrancar.
  void revisarBanxico().then((salud) =>
    log(
      salud.ok
        ? "Banxico responde desde este servidor"
        : `Banxico NO responde desde este servidor (${salud.motivo}). Si sigue así, puede que bloquee la IP del servidor.`,
    ),
  );
}

iniciarBot().catch((e) => {
  const mensaje = (e as Error).message;
  log(
    mensaje.includes("409")
      ? "El bot se detuvo: ya hay otra copia funcionando (otra ventana, iniciar-bot.bat, npm run dev o el servidor). " +
          "Telegram solo permite una a la vez: deja abierta solo una."
      : `No se pudo iniciar el bot: ${mensaje}`,
  );
  process.exit(1);
});
