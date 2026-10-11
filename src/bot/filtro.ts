/**
 * Quién puede usar el bot y qué mensajes acepta: solo imágenes (foto o archivo JPG, PNG o WEBP de
 * hasta 10 MB). Todo lo demás se borra.
 */
import type { Chat, Message } from "grammy/types";

export const TAMANO_MAXIMO_MB = 10;
const TAMANO_MAXIMO_BYTES = TAMANO_MAXIMO_MB * 1024 * 1024;

/** Formatos que se aceptan cuando la imagen llega como archivo. */
const TIPOS_IMAGEN = new Set(["image/jpeg", "image/png", "image/webp"]);

export type Clasificacion =
  | { tipo: "imagen"; fileId: string }
  /** /start o /ayuda: se responde con la ayuda. */
  | { tipo: "ayuda" }
  /** Aviso de Telegram (alguien entró o salió del grupo, cambió el nombre…): se borra sin avisar. */
  | { tipo: "servicio" }
  | { tipo: "rechazar" };

const COMANDOS_AYUDA = /^\/(start|ayuda|help)(@\w+)?(\s|$)/i;

/** Campos que solo traen los mensajes de servicio de Telegram. */
const CAMPOS_SERVICIO = [
  "new_chat_members",
  "left_chat_member",
  "new_chat_title",
  "new_chat_photo",
  "delete_chat_photo",
  "group_chat_created",
  "supergroup_chat_created",
  "migrate_to_chat_id",
  "migrate_from_chat_id",
  "pinned_message",
  "message_auto_delete_timer_changed",
] as const;

type MensajeEntrante = Pick<Message, "photo" | "document" | "text"> &
  Partial<Record<(typeof CAMPOS_SERVICIO)[number], unknown>>;

const pesaDeMas = (bytes?: number) => (bytes ?? 0) > TAMANO_MAXIMO_BYTES;

export function clasificarMensaje(m: MensajeEntrante): Clasificacion {
  const foto = m.photo?.at(-1); // la de mayor resolución
  if (foto) return pesaDeMas(foto.file_size) ? { tipo: "rechazar" } : { tipo: "imagen", fileId: foto.file_id };
  const doc = m.document;
  if (doc && TIPOS_IMAGEN.has(doc.mime_type ?? "") && !pesaDeMas(doc.file_size)) return { tipo: "imagen", fileId: doc.file_id };
  if (m.text && COMANDOS_AYUDA.test(m.text.trim())) return { tipo: "ayuda" };
  if (CAMPOS_SERVICIO.some((campo) => m[campo] !== undefined)) return { tipo: "servicio" };
  return { tipo: "rechazar" };
}

/**
 * Formato real de la imagen según sus primeros bytes (el tipo que manda Telegram lo declara el
 * teléfono y puede no coincidir). null si no es JPG, PNG ni WEBP.
 */
export function formatoImagen(datos: Uint8Array): "jpeg" | "png" | "webp" | null {
  const empieza = (bytes: number[], desde = 0) => bytes.every((b, i) => datos[desde + i] === b);
  if (empieza([0xff, 0xd8, 0xff])) return "jpeg";
  if (empieza([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (empieza([0x52, 0x49, 0x46, 0x46]) && empieza([0x57, 0x45, 0x42, 0x50], 8)) return "webp"; // "RIFF"…"WEBP"
  return null;
}

export const esGrupo = (chat: Pick<Chat, "type"> | undefined) => chat?.type === "group" || chat?.type === "supergroup";

/**
 * En un grupo autorizado (ALLOWED_CHAT_IDS) puede usarlo cualquier miembro; en privado, solo
 * ALLOWED_USER_IDS. En grupos no autorizados y canales no responde a nadie.
 */
export function puedeUsar(
  chat: Pick<Chat, "id" | "type"> | undefined,
  usuarioId: number | undefined,
  permitidos: readonly number[],
  grupos: ReadonlySet<number>,
): boolean {
  if (esGrupo(chat)) return grupos.has(chat!.id);
  if (chat?.type === "channel") return false;
  return usuarioId !== undefined && permitidos.includes(usuarioId);
}
