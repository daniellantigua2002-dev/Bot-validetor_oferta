/**
 * Clientes de visión (APIs compatibles con OpenAI): NVIDIA Build y, de respaldo, Gemini de Google.
 * Preprocesa la imagen con sharp, pide el JSON al modelo y lo valida con Zod.
 */
import OpenAI from "openai";
import type { ChatCompletion, ChatCompletionCreateParamsNonStreaming, ChatCompletionMessageParam } from "openai/resources/chat/completions";
import sharp from "sharp";
import { entorno } from "../entorno.js";
import { PROMPT_SISTEMA, PROMPT_USUARIO, promptCorreccion } from "./prompt.js";
import { DatosExtraidosSchema, type DatosExtraidos } from "./schema.js";

export const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";
export const LADO_MAXIMO_PX = 1600;
/** Tiempo máximo por llamada. Sin reintento automático: si falla se pasa al modelo de respaldo. */
const TIMEOUT_MS = 75_000;
/** API de Gemini compatible con OpenAI (Google AI Studio). */
export const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/";
/**
 * Si un modelo no respondió en este tiempo, arranca también el siguiente. Gemini suele contestar en ~12 s
 * (por debajo de esto), así que normalmente solo se gasta una clave por comprobante; si una clave se queda
 * sin cuota falla al instante y la siguiente arranca de inmediato, sin esperar este tiempo.
 */
export const ESPERA_ANTES_DEL_RESPALDO_MS = 30_000;
/** Gemini "piensa" antes de responder y esos tokens cuentan: con 1024 la respuesta puede quedar cortada. */
const TOKENS_GEMINI = 8192;

/** Error de extracción: el llamador debe pasar al respaldo local (OCR). */
export class ErrorExtraccion extends Error {
  constructor(
    mensaje: string,
    readonly causa?: unknown,
  ) {
    super(mensaje);
    this.name = "ErrorExtraccion";
  }

  /** Código HTTP de la API cuando la llamada falló (429 sin cuota, 503 saturado…). */
  get estado(): number | undefined {
    return (this.causa as { status?: number } | undefined)?.status;
  }
}

/** Lo mínimo del cliente de OpenAI que se usa (permite simularlo en los tests). */
export interface ClienteChat {
  chat: { completions: { create(params: ChatCompletionCreateParamsNonStreaming): Promise<ChatCompletion> } };
}

export function crearClienteNvidia(apiKey: string = entorno.nvidiaApiKey): ClienteChat {
  if (!apiKey) throw new ErrorExtraccion("Falta NVIDIA_API_KEY en el archivo .env");
  return new OpenAI({ baseURL: NVIDIA_BASE_URL, apiKey, maxRetries: 0, timeout: TIMEOUT_MS });
}

export function crearClienteGemini(apiKey: string = entorno.geminiApiKeys[0] ?? ""): ClienteChat {
  if (!apiKey) throw new ErrorExtraccion("Falta GEMINI_API_KEY en el archivo .env");
  return new OpenAI({ baseURL: GEMINI_BASE_URL, apiKey, maxRetries: 0, timeout: TIMEOUT_MS });
}

/** Rotación automática según EXIF, máximo 1600 px por lado y JPEG. */
export async function preprocesarImagen(imagen: Buffer): Promise<Buffer> {
  return sharp(imagen)
    .rotate()
    .resize({ width: LADO_MAXIMO_PX, height: LADO_MAXIMO_PX, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 90 })
    .toBuffer();
}

/** Saca el objeto JSON de la respuesta del modelo (tolera bloques ``` y texto alrededor). */
export function extraerJson(texto: string): unknown {
  const sinBloques = texto.replace(/```(?:json)?/gi, "");
  const inicio = sinBloques.indexOf("{");
  const fin = sinBloques.lastIndexOf("}");
  if (inicio === -1 || fin <= inicio) throw new SyntaxError("la respuesta no contiene un objeto JSON");
  return JSON.parse(sinBloques.slice(inicio, fin + 1));
}

/** Arreglos menores antes de validar: números que llegan como texto ("1,352.00", "0.9"). */
function limpiarRespuesta(valor: unknown): unknown {
  if (typeof valor !== "object" || valor === null) return valor;
  const obj = { ...(valor as Record<string, unknown>) };
  if (typeof obj.monto === "string") {
    const n = Number(obj.monto.replace(/[$,\s-]/g, ""));
    obj.monto = obj.monto.trim() === "" || Number.isNaN(n) ? null : n;
  }
  if (typeof obj.monto === "number") obj.monto = Math.abs(obj.monto);
  const banco = obj.bancoEmisor as Record<string, unknown> | undefined;
  if (banco && typeof banco.confianza === "string") obj.bancoEmisor = { ...banco, confianza: Number(banco.confianza) };
  return obj;
}

/** Valida el texto del modelo. Devuelve los datos o el motivo del fallo. */
export function validarRespuesta(texto: string): { ok: true; datos: DatosExtraidos } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = limpiarRespuesta(extraerJson(texto));
  } catch (e) {
    return { ok: false, error: `JSON inválido: ${(e as Error).message}` };
  }
  const r = DatosExtraidosSchema.safeParse(json);
  if (r.success) return { ok: true, datos: r.data };
  const detalle = r.error.issues
    .slice(0, 5)
    .map((i) => `${i.path.join(".") || "(raíz)"}: ${i.message}`)
    .join("; ");
  return { ok: false, error: `no cumple el schema: ${detalle}` };
}

export interface OpcionesNvidia {
  cliente?: ClienteChat;
  modelo?: string;
  /** Nombre del servicio para los mensajes de error ("NVIDIA", "Gemini"). */
  proveedor?: string;
  /** Gemini piensa antes de responder y gasta más tokens. */
  maxTokens?: number;
}

/**
 * Extrae los datos del comprobante con el modelo de visión (cualquier API compatible con OpenAI).
 * Si el JSON es inválido, reintenta una vez pidiendo la corrección.
 * Lanza ErrorExtraccion si falla la red, la API (429, 5xx…) o el segundo intento.
 */
export async function extraerConNvidia(imagen: Buffer, opciones: OpcionesNvidia = {}): Promise<DatosExtraidos> {
  const cliente = opciones.cliente ?? crearClienteNvidia();
  const modelo = opciones.modelo ?? entorno.nvidiaModel;
  const proveedor = opciones.proveedor ?? "NVIDIA";
  const jpeg = await preprocesarImagen(imagen);

  const mensajes: ChatCompletionMessageParam[] = [
    { role: "system", content: PROMPT_SISTEMA },
    {
      role: "user",
      content: [
        { type: "text", text: PROMPT_USUARIO },
        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${jpeg.toString("base64")}` } },
      ],
    },
  ];

  let ultimoError = "";
  for (let intento = 1; intento <= 2; intento++) {
    let respuesta: ChatCompletion;
    try {
      respuesta = await cliente.chat.completions.create({
        model: modelo,
        messages: mensajes,
        temperature: 0,
        max_tokens: opciones.maxTokens ?? 1024,
      });
    } catch (e) {
      const estado = (e as { status?: number }).status;
      throw new ErrorExtraccion(`Falló la llamada a ${proveedor}${estado ? ` (HTTP ${estado})` : ""}: ${(e as Error).message}`, e);
    }

    const texto = respuesta.choices[0]?.message?.content ?? "";
    const resultado = validarRespuesta(texto);
    if (resultado.ok) return resultado.datos;

    ultimoError = resultado.error;
    mensajes.push({ role: "assistant", content: texto }, { role: "user", content: promptCorreccion(resultado.error) });
  }
  throw new ErrorExtraccion(`${proveedor} devolvió una respuesta inválida dos veces: ${ultimoError}`);
}

/** Un modelo de visión a probar: su nombre (para los registros) y cómo extrae. */
export interface ModeloVision {
  nombre: string;
  extraer: (imagen: Buffer) => Promise<DatosExtraidos>;
  /**
   * Familia a la que pertenece (el modelo de Gemini, o NVIDIA). Si uno responde saturado (503), los de su
   * familia que aún no arrancaron se omiten: reintentar con otra clave del mismo modelo no ayuda.
   */
  grupo?: string;
}

/** Lo que `modelosConfigurados` necesita del entorno (parametrizable para los tests). */
export interface ConfigModelos {
  geminiApiKeys: string[];
  geminiModelos: string[];
  geminiModeloRespaldo: string;
  nvidiaApiKey: string;
  nvidiaModel: string;
}

export interface FabricaClientes {
  gemini(apiKey: string): ClienteChat;
  nvidia(apiKey: string): ClienteChat;
}

/**
 * Modelos configurados, en el orden en que entran a la carrera:
 * 1. Gemini (Google AI Studio), modelo principal (GEMINI_MODEL): cada clave de cada cuenta, en orden. Es la
 *    IA principal porque es rápida y precisa. Cuando una clave se queda sin cuota del día (429) falla al
 *    instante y la carrera salta sola a la siguiente clave; así se aprovechan los 20/día de cada cuenta.
 *    Si responde saturado (503) se omiten las demás claves de ese modelo (no ayudaría) y se pasa al respaldo.
 * 2. Gemini de respaldo (GEMINI_MODEL_RESPALDO, flash-lite), con las mismas claves y las mismas reglas:
 *    429 → siguiente clave; 503 → directo a NVIDIA. Vacío = sin este paso.
 * 3. NVIDIA (gemma) como respaldo final: solo entra cuando se agotaron (o están saturados) los de Gemini.
 *    Tiene límites mucho más generosos, así que el servicio nunca se queda sin IA.
 * El nombre de cada uno lleva el modelo y la clave ("gemini-3.5-flash#2") para distinguirlos en los registros.
 * Si ninguno responde, el pipeline usa el OCR local (ver extraction/index.ts).
 */
export function modelosConfigurados(
  config: ConfigModelos = entorno,
  clientes: FabricaClientes = { gemini: crearClienteGemini, nvidia: crearClienteNvidia },
): ModeloVision[] {
  const modelos: ModeloVision[] = [];
  const geminis = [...new Set([...config.geminiModelos, config.geminiModeloRespaldo].filter(Boolean))];
  for (const modelo of geminis) {
    config.geminiApiKeys.forEach((apiKey, i) => {
      const cliente = clientes.gemini(apiKey);
      modelos.push({
        nombre: `${modelo}#${i + 1}`,
        grupo: modelo,
        extraer: (img) => extraerConNvidia(img, { cliente, modelo, proveedor: "Gemini", maxTokens: TOKENS_GEMINI }),
      });
    });
  }
  if (config.nvidiaApiKey && config.nvidiaModel) {
    const modelo = config.nvidiaModel;
    const apiKey = config.nvidiaApiKey;
    modelos.push({
      nombre: modelo,
      grupo: "nvidia",
      extraer: (img) => extraerConNvidia(img, { cliente: clientes.nvidia(apiKey), modelo }),
    });
  }
  return modelos;
}

/**
 * Carrera escalonada entre los modelos: arranca el primero; si falla, o si en `esperaMs` no ha
 * respondido, arranca también el siguiente (y así con el resto). Gana la primera respuesta válida;
 * las demás se ignoran. Si uno responde saturado (HTTP 503), los pendientes de su mismo `grupo` se omiten.
 * Lanza ErrorExtraccion con los motivos de todos si ninguno responde bien.
 */
export function extraerConModelos(
  imagen: Buffer,
  modelos: ModeloVision[] = modelosConfigurados(),
  esperaMs = ESPERA_ANTES_DEL_RESPALDO_MS,
): Promise<{ datos: DatosExtraidos; modelo: string }> {
  if (modelos.length === 0) return Promise.reject(new ErrorExtraccion("no hay modelos configurados (falta NVIDIA_API_KEY o GEMINI_API_KEY)"));
  return new Promise((resolver, rechazar) => {
    const errores: string[] = [];
    const saturados = new Set<string>();
    let indice = 0;
    let iniciados = 0;
    let terminados = 0;
    let listo = false;
    let reloj: ReturnType<typeof setTimeout> | undefined;

    /** Arranca el siguiente modelo que no esté omitido. Devuelve false si ya no queda ninguno. */
    const arrancar = (): boolean => {
      if (listo) return false;
      while (indice < modelos.length && modelos[indice]!.grupo !== undefined && saturados.has(modelos[indice]!.grupo!)) indice++;
      if (indice >= modelos.length) return false;
      const { nombre, extraer, grupo } = modelos[indice++]!;
      iniciados++;
      clearTimeout(reloj);
      if (indice < modelos.length) reloj = setTimeout(arrancar, esperaMs);
      extraer(imagen).then(
        (datos) => {
          if (listo) return;
          listo = true;
          clearTimeout(reloj);
          resolver({ datos, modelo: nombre });
        },
        (e: unknown) => {
          errores.push(`${nombre}: ${(e as Error).message}`);
          terminados++;
          if (listo) return;
          if (grupo !== undefined && (e as ErrorExtraccion).estado === 503) saturados.add(grupo);
          // Todos los que corrían fallaron: el siguiente arranca ya, sin esperar. Si no queda ninguno, se rinde.
          if (terminados === iniciados && !arrancar()) {
            listo = true;
            clearTimeout(reloj);
            rechazar(new ErrorExtraccion(errores.join(" | ")));
          }
        },
      );
      return true;
    };
    arrancar();
  });
}
