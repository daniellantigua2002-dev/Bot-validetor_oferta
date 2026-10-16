/**
 * Carga y valida las variables de entorno (.env).
 */
import "dotenv/config";
import { z } from "zod";

const EntornoSchema = z.object({
  NVIDIA_API_KEY: z.string().default(""),
  // Respaldo final: entra cuando se agota la cuota de todas las claves de Gemini. Visión en NVIDIA Build.
  NVIDIA_MODEL: z.string().min(1).default("google/gemma-4-31b-it"),
  // IA principal (Google AI Studio, gratuita). Una o varias claves separadas por coma, una por cuenta de
  // Google: el bot las rota en orden y salta a la siguiente cuando una se queda sin cuota del día (429).
  // Vacío = sin Gemini (solo NVIDIA y OCR).
  GEMINI_API_KEY: z.string().default(""),
  // Uno o varios modelos separados por coma: si uno está saturado (503) o sin cuota, entra el siguiente.
  GEMINI_MODEL: z.string().min(1).default("gemini-3.5-flash"),
  TELEGRAM_BOT_TOKEN: z.string().default(""),
  ALLOWED_USER_IDS: z.string().default(""),
  ALLOWED_CHAT_IDS: z.string().default(""),
  // Lo pone el servidor (Render): con él, el bot abre una página de salud en ese puerto. En la PC, vacío.
  PORT: z.string().default(""),
});

const crudo = EntornoSchema.parse(process.env);

/** "123, 456" → [123, 456] */
const listaDeIds = (s: string) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map(Number);

export const entorno = {
  nvidiaApiKey: crudo.NVIDIA_API_KEY,
  nvidiaModel: crudo.NVIDIA_MODEL,
  /** Claves de Gemini (una por cuenta de Google), en el orden en que se rotan. */
  geminiApiKeys: crudo.GEMINI_API_KEY.split(",").map((k) => k.trim()).filter(Boolean),
  geminiModelos: crudo.GEMINI_MODEL.split(",").map((m) => m.trim()).filter(Boolean),
  telegramToken: crudo.TELEGRAM_BOT_TOKEN,
  /** Pueden usar el bot en privado. */
  usuariosPermitidos: listaDeIds(crudo.ALLOWED_USER_IDS),
  /** Grupos donde cualquier miembro puede usar el bot (sus IDs empiezan con -100). */
  gruposPermitidos: listaDeIds(crudo.ALLOWED_CHAT_IDS),
  /** Puerto de la página de salud; null en la PC (sin servidor). */
  puerto: crudo.PORT.trim() ? Number(crudo.PORT) : null,
};

/** ¿Corre en un servidor (Render)? Allí hay poca memoria: el navegador de la foto se cierra al terminar. */
export const enServidor = entorno.puerto !== null;
