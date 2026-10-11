/**
 * Punto de entrada: arranca el bot de Telegram (npm run bot / npm start).
 */
import { iniciarBot, log } from "./bot/index.js";

iniciarBot().catch((e) => {
  const mensaje = (e as Error).message;
  log(
    mensaje.includes("409")
      ? "El bot se detuvo: ya hay otra copia funcionando (otra ventana, iniciar-bot.bat o npm run dev). " +
          "Telegram solo permite una a la vez: deja abierta solo una."
      : `No se pudo iniciar el bot: ${mensaje}`,
  );
  process.exit(1);
});
