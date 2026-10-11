/**
 * Carga y valida las variables de entorno (.env).
 */
import "dotenv/config";
import { z } from "zod";

const EntornoSchema = z.object({
  NVIDIA_API_KEY: z.string().default(""),
  NVIDIA_MODEL: z.string().min(1).default("moonshotai/kimi-k3"),
  // Se usa si el modelo principal falla. Vacío = sin respaldo.
  NVIDIA_MODEL_RESPALDO: z.string().default("meta/llama-3.2-90b-vision-instruct"),
  // Segunda IA de respaldo (Google AI Studio, gratuita). Vacía = sin Gemini.
  GEMINI_API_KEY: z.string().default(""),
  // Uno o varios modelos separados por coma: si uno está saturado (503), entra el siguiente.
  GEMINI_MODEL: z.string().min(1).default("gemini-3.5-flash,gemini-3.8-flash"),
  TELEGRAM_BOT_TOKEN: z.string().default(""),
  ALLOWED_USER_IDS: z.string().default(""),
  ALLOWED_CHAT_IDS: z.string().default(""),
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
  nvidiaModeloRespaldo: crudo.NVIDIA_MODEL_RESPALDO.trim(),
  geminiApiKey: crudo.GEMINI_API_KEY.trim(),
  geminiModelos: crudo.GEMINI_MODEL.split(",").map((m) => m.trim()).filter(Boolean),
  telegramToken: crudo.TELEGRAM_BOT_TOKEN,
  /** Pueden usar el bot en privado. */
  usuariosPermitidos: listaDeIds(crudo.ALLOWED_USER_IDS),
  /** Grupos donde cualquier miembro puede usar el bot (sus IDs empiezan con -100). */
  gruposPermitidos: listaDeIds(crudo.ALLOWED_CHAT_IDS),
};
