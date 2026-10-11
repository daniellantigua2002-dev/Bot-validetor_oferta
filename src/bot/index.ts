/**
 * Bot de Telegram (grammY, long polling): recibe la foto del comprobante y responde, siempre como
 * respuesta a ese mensaje, con la captura de Banxico o con el motivo del rechazo.
 *
 * - En privado solo atiende a ALLOWED_USER_IDS; en los grupos de ALLOWED_CHAT_IDS, a cualquier miembro.
 * - Solo acepta imágenes (JPG, PNG o WEBP de hasta 10 MB): cualquier otro mensaje se borra y se
 *   muestra un aviso que desaparece solo. En un grupo además se borran los mensajes editados y
 *   cada persona envía una foto a la vez (la segunda se borra, aunque vaya en el mismo envío).
 *   En un grupo necesita ser administrador con permiso de borrar mensajes.
 * - Los botones de una pregunta solo los puede pulsar quien envió el comprobante.
 * - Cola: un comprobante a la vez, con tiempo máximo, guardada en data/cola.json para retomarla si
 *   el bot se reinicia. Mientras espera, cada comprobante ve su lugar en la fila.
 * - Si Banxico deja de responder lo avisa en el grupo, y también cuando vuelve.
 * - Se revisan solos más tarde (ver espera.ts): los pagos de hace pocos minutos que Banxico todavía no
 *   publica, y los comprobantes que no se pudieron consultar porque Banxico no respondía. A estos últimos
 *   los revisa juntos el vigía (vigia.ts): una sola petición a Banxico cada 3 min, no una por comprobante.
 * - Al arrancar deja fijada en cada grupo la guía de cómo enviar el comprobante y su nota.
 */
import { Bot, GrammyError, HttpError, InlineKeyboard, InputFile, type Api } from "grammy";
import { randomBytes } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { formatInTimeZone } from "date-fns-tz";
import { revisarBanxico, type SaludBanxico } from "../banxico/reintentos.js";
import { RITMO } from "../banxico/ritmo.js";
import { cerrarNavegador } from "../capture/screenshot.js";
import { BANCOS, CUENTAS_DESTINO, ZONA_HORARIA, type ClaveBanco } from "../config.js";
import { entorno } from "../entorno.js";
import type { ResultadoExtraccion } from "../extraction/index.js";
import { leerNota, type NotaLeida } from "../extraction/nota.js";
import { terminarOcr } from "../extraction/ocr-fallback.js";
import { validarComprobante, type Progreso, type ResultadoValidacion } from "../pipeline.js";
import type { Confirmaciones } from "../rules/index.js";
import { Cola, TiempoAgotado } from "./cola.js";
import { decidirEspera, FECHAS_AL_REINTENTAR_RECIENTE, MAX_ESPERA_BANXICO_MS, MAX_REINTENTOS_RECIENTE, type Espera } from "./espera.js";
import { ColaGuardada } from "./cola-guardada.js";
import { banxicoRespondio, EstadoBanxico } from "./estado-banxico.js";
import {
  clasificarMensaje,
  esGrupo,
  formatoImagen,
  puedeUsar,
} from "./filtro.js";
import {
  AVISO_BANXICO_CAIDO,
  AVISO_BANXICO_VOLVIO,
  AVISO_EDITADO,
  AVISO_SOLO_IMAGENES,
  avisoPreguntaPendiente,
  avisoUnaFotoALaVez,
  AYUDA,
  GUIA_GRUPO,
  MENSAJE_BANXICO_SIN_RESPUESTA,
  MENSAJE_IMAGEN_NO_VALIDA,
  reaccionPara,
  renderizarProgreso,
  respuestaFinal,
  resumenIntentos,
  TEXTO_BANXICO_LENTO,
  TEXTO_REANUDANDO,
  TEXTO_TIEMPO_AGOTADO,
  textoEnCola,
  textoEsperaBanxico,
  textoEsperaPagoReciente,
  textoPlano,
  type Boton,
} from "./mensajes.js";
import { INTERVALO_GRUPO_MS, IndicadorProgreso } from "./progreso.js";
import { VigiaBanxico } from "./vigia.js";

export function log(mensaje: string): void {
  console.log(`[${formatInTimeZone(new Date(), ZONA_HORARIA, "yyyy-MM-dd HH:mm:ss")}] ${mensaje}`);
}

/** Un comprobante en la cola. Se guarda en data/cola.json para retomarlo si el bot se reinicia. */
interface Trabajo {
  id: string;
  chatId: number;
  /** Mensaje de progreso ("en cola", animación) que termina mostrando el resultado. */
  avisoId: number;
  usuario: string;
  /** Nombre de Telegram de quien envió el comprobante ("Daniel"). */
  nombre?: string;
  /** Mensaje con la foto del comprobante: la respuesta va como respuesta a él. */
  mensajeOriginal: number;
  /** Comprobante nuevo: archivo de Telegram con la imagen. */
  fileId?: string;
  /** Respuesta a una pregunta: la lectura ya hecha (no se vuelve a leer la imagen). */
  extraccion?: ResultadoExtraccion;
  confirmaciones: Confirmaciones;
  /** Clave con la que este trabajo ya registró el pago (por si el bot se reinicia antes de responder). */
  claveRegistrada?: string;
  /** Lo que la persona escribió en la nota de la foto. */
  nota?: NotaLeida;
  /** Si espera para volver a revisarse solo (pago reciente o Banxico caído). */
  espera?: Espera;
}

/** Pregunta pendiente (banco o cuenta) esperando que la persona pulse un botón. */
interface Pendiente {
  usuario: string;
  nombre?: string;
  mensajeOriginal: number;
  extraccion: ResultadoExtraccion;
  confirmaciones: Confirmaciones;
  nota?: NotaLeida;
  creado: number;
}

const VIGENCIA_PREGUNTA_MS = 60 * 60 * 1000;
/**
 * Tiempo máximo por comprobante, desde que empieza hasta que el pago queda registrado. 5 min a pedido del
 * usuario (11-oct, antes 3): más tiempo para buscar en Banxico, a costa de que la fila espere más.
 */
const LIMITE_POR_COMPROBANTE_MS = 5 * 60_000;
/** Tiempo máximo para descargar la imagen de Telegram. */
const LIMITE_DESCARGA_MS = 30_000;
/** El aviso "solo imágenes" se borra solo después de este tiempo. */
const DURACION_AVISO_MS = 5000;
/** En un grupo, la ayuda (/start, /ayuda) se borra sola después de este tiempo. */
const DURACION_AYUDA_GRUPO_MS = 30_000;
/** El aviso "Banxico ya está respondiendo" se borra solo después de este tiempo. */
const DURACION_AVISO_VOLVIO_MS = 10 * 60_000;
/** Como mucho un aviso temporal cada este tiempo por chat (si mandan varios mensajes seguidos). */
const ESPERA_ENTRE_AVISOS_MS = 8000;

const teclado = (botones?: Boton[][]) => {
  if (!botones) return undefined;
  const t = new InlineKeyboard();
  botones.forEach((fila, i) => {
    for (const b of fila) t.text(b.texto, b.datos);
    if (i < botones.length - 1) t.row();
  });
  return t;
};

/** Pone 👍 o 👎 sobre el mensaje del comprobante. Si Telegram no lo permite, solo se registra. */
async function reaccionar(api: Api, chatId: number, mensajeId: number, emoji: "👍" | "👎"): Promise<void> {
  await api
    .setMessageReaction(chatId, mensajeId, [{ type: "emoji", emoji }])
    .catch((e) => log(`No se pudo poner la reacción ${emoji}: ${(e as Error).message}`));
}

/** Grupos que ve el bot, con su ID, para llenar ALLOWED_CHAT_IDS sin copiarlo a mano. */
const RUTA_GRUPOS_DETECTADOS = resolve("data/grupos-detectados.txt");

async function anotarGrupo(id: number, titulo: string): Promise<void> {
  const fecha = formatInTimeZone(new Date(), ZONA_HORARIA, "yyyy-MM-dd HH:mm:ss");
  await appendFile(RUTA_GRUPOS_DETECTADOS, `${fecha}\t${id}\t${titulo}\n`).catch(() => undefined);
}

/** Repite la llamada si Telegram pide bajar el ritmo (429), esperando lo que indique (hasta 3 intentos). */
async function conReintento<T>(llamada: () => Promise<T>): Promise<T> {
  for (let intento = 1; ; intento++) {
    try {
      return await llamada();
    } catch (e) {
      if (!(e instanceof GrammyError) || e.error_code !== 429 || intento >= 3) throw e;
      const segundos = e.parameters.retry_after ?? 5;
      log(`Telegram pidió esperar ${segundos} s (límite de mensajes); se reintenta`);
      await new Promise((r) => setTimeout(r, segundos * 1000));
    }
  }
}

/** El mensaje ya no existe o ya no se puede editar (lo borraron o tiene más de 48 h). */
const noSePuedeEditar = (e: unknown) =>
  e instanceof GrammyError && /message to edit not found|message can't be edited/i.test(e.description);

async function descargarArchivo(api: Api, token: string, fileId: string, signal: AbortSignal): Promise<Buffer> {
  // grammY declara su propio tipo de AbortSignal (abort-controller), equivalente al de Node.
  const archivo = await api.getFile(fileId, signal as unknown as Parameters<Api["getFile"]>[1]);
  if (!archivo.file_path) throw new Error("Telegram no devolvió la ruta del archivo");
  const r = await fetch(`https://api.telegram.org/file/bot${token}/${archivo.file_path}`, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(LIMITE_DESCARGA_MS)]),
  });
  if (!r.ok) throw new Error(`No se pudo descargar la imagen (HTTP ${r.status})`);
  return Buffer.from(await r.arrayBuffer());
}

export interface BotValidador {
  bot: Bot;
  /** Retoma los comprobantes que quedaron en data/cola.json. Llamarlo antes de recibir mensajes. */
  reanudarPendientes: () => Promise<number>;
  /** Deja fijada en cada grupo autorizado la guía de cómo enviar el comprobante (si no lo está ya). */
  fijarGuia: (idBot: number) => Promise<void>;
}

export function crearBot(
  token = entorno.telegramToken,
  permitidos = entorno.usuariosPermitidos,
  gruposPermitidos = entorno.gruposPermitidos,
  guardada = new ColaGuardada<Trabajo>(),
): BotValidador {
  if (!token) throw new Error("Falta TELEGRAM_BOT_TOKEN en el archivo .env");
  if (!permitidos.length && !gruposPermitidos.length) {
    throw new Error("ALLOWED_USER_IDS y ALLOWED_CHAT_IDS están vacíos en el .env: el bot no respondería a nadie");
  }

  const bot = new Bot(token);
  const cola = new Cola();
  const estadoBanxico = new EstadoBanxico();
  const pendientes = new Map<string, Pendiente>();
  const ultimoAviso = new Map<number, number>();
  /** Crece si un grupo autorizado se convierte en supergrupo (Telegram le cambia el ID). */
  const grupos = new Set(gruposPermitidos);
  /** Grupos no autorizados ya avisados en la consola (para no repetir el aviso con cada mensaje). */
  const gruposAvisados = new Set<number>();
  /** Avisos de "Banxico no está respondiendo" publicados: se borran cuando vuelve. */
  const avisosBanxicoCaido: { chatId: number; mensajeId: number }[] = [];
  /**
   * Comprobantes que esperan para revisarse solos: los de un pago reciente con su reloj; los que esperan a
   * Banxico, sin reloj (los revisa el vigía, todos juntos).
   */
  const esperando = new Map<string, { trabajo: Trabajo; reloj?: ReturnType<typeof setTimeout> }>();
  const vigia = new VigiaBanxico(
    () => revisarBanxico(),
    (salud) => alRevisarBanxico(bot.api, salud),
  );
  let avisoSinPermisoDeBorrar = false;

  const nuevoId = () => randomBytes(6).toString("hex");

  /** ¿La persona tiene una pregunta (banco o cuenta) sin responder de un comprobante anterior? */
  const tienePreguntaPendiente = (usuario: string) =>
    [...pendientes.values()].some((p) => p.usuario === usuario && Date.now() - p.creado <= VIGENCIA_PREGUNTA_MS);

  /** Avisa en los grupos cuando Banxico deja de responder y cuando vuelve. */
  async function registrarEstadoBanxico(api: Api, respondio: boolean | null): Promise<void> {
    const cambio = estadoBanxico.registrar(respondio);
    if (!cambio) return;
    log(cambio === "CAYO" ? "Banxico dejó de responder: se avisa en el grupo" : "Banxico volvió a responder: se avisa en el grupo");
    if (cambio === "VOLVIO") {
      for (const a of avisosBanxicoCaido.splice(0)) await borrar(api, a.chatId, a.mensajeId);
      // Banxico volvió: los comprobantes que esperaban por él se revisan ya.
      for (const [id, e] of esperando) if (e.trabajo.espera?.motivo === "BANXICO") despertar(api, id);
    }
    for (const chatId of grupos) {
      const texto = cambio === "CAYO" ? AVISO_BANXICO_CAIDO : AVISO_BANXICO_VOLVIO;
      const aviso = await conReintento(() => api.sendMessage(chatId, texto, { parse_mode: "HTML" })).catch(() => null);
      if (!aviso) continue;
      if (cambio === "CAYO") avisosBanxicoCaido.push({ chatId, mensajeId: aviso.message_id });
      else setTimeout(() => void borrar(api, chatId, aviso.message_id), DURACION_AVISO_VOLVIO_MS);
    }
  }

  /** Envía el resultado como respuesta al comprobante: la foto de Banxico o el texto (con botones si hay pregunta). */
  async function responder(api: Api, trabajo: Trabajo, r: ResultadoValidacion): Promise<void> {
    const { chatId, avisoId, mensajeOriginal } = trabajo;
    let id = "";
    if (r.codigo === "REQUIERE_CONFIRMACION_BANCO" || r.codigo === "REQUIERE_CONFIRMACION_CUENTA") {
      for (const [clave, p] of pendientes) if (Date.now() - p.creado > VIGENCIA_PREGUNTA_MS) pendientes.delete(clave);
      id = nuevoId();
      const { usuario, nombre, confirmaciones, nota } = trabajo;
      pendientes.set(id, { usuario, nombre, mensajeOriginal, confirmaciones, nota, extraccion: r.extraccion!, creado: Date.now() });
    }
    const respuesta = respuestaFinal(r, id, trabajo.nombre, trabajo.nota);
    const enRespuesta = { message_id: mensajeOriginal, allow_sending_without_reply: true };
    if (respuesta.foto) {
      await conReintento(() =>
        api.sendPhoto(chatId, new InputFile(respuesta.foto!), {
          caption: respuesta.texto,
          parse_mode: "HTML",
          reply_parameters: enRespuesta,
        }),
      );
      await api.deleteMessage(chatId, avisoId).catch(() => undefined);
    } else {
      const opciones = { parse_mode: "HTML" as const, reply_markup: teclado(respuesta.botones) };
      await conReintento(() => api.editMessageText(chatId, avisoId, respuesta.texto, opciones)).catch(async (e) => {
        // Si el mensaje de progreso ya no existe, el resultado va en un mensaje nuevo.
        if (!noSePuedeEditar(e)) throw e;
        await conReintento(() => api.sendMessage(chatId, respuesta.texto, { ...opciones, reply_parameters: enRespuesta }));
      });
    }
    const reaccion = reaccionPara(r.codigo);
    if (reaccion) await reaccionar(api, chatId, mensajeOriginal, reaccion);
    const t = r.tiempos;
    const e = r.extraccion;
    log(
      `Usuario ${trabajo.usuario}: ${r.codigo}` +
        `${r.pago?.claveRastreo ? ` clave=${r.pago.claveRastreo}` : ""}` +
        `${r.normalizados?.cuentaDestino ? ` cuenta=${r.normalizados.cuentaDestino}` : ""}` +
        ` (lectura ${t.lectura ?? 0} ms, Banxico ${t.banxico ?? 0} ms, captura ${t.captura ?? 0} ms, total ${t.total ?? 0} ms` +
        `${e ? `, origen ${e.origen}${e.modelo ? ` (${e.modelo})` : ""}` : ""}` +
        `${e?.errorNvidia ? `, la IA falló: ${e.errorNvidia}` : ""}` +
        `${e?.cuentaCorregida ? `, cuenta corregida con el OCR (la IA leyó ${e.cuentaCorregida.ia ?? "nada"})` : ""}` +
        `${e?.completadoConOcr ? `, completado con el OCR: ${e.completadoConOcr.join(", ")}` : ""}` +
        `${r.montoCorregido ? `, monto corregido: se leyó ${r.montoCorregido.leido} y en Banxico es ${r.montoCorregido.banxico}` : ""}` +
        `${r.ruta ? `, ruta ${r.ruta}` : ""})`,
    );
    // El detalle de cada consulta no va al grupo (allí solo el resumen): queda aquí.
    if (r.codigo !== "VALIDADO" && r.intentos.length) log(`Consultas a Banxico:\n${resumenIntentos(r)}`);
    await registrarEstadoBanxico(api, banxicoRespondio(r));
  }

  /**
   * Programa el siguiente intento de un comprobante que espera. Los que esperan a Banxico no tienen reloj
   * propio: los revisa el vigía, con una sola petición para todos.
   */
  function programar(api: Api, trabajo: Trabajo): void {
    if (trabajo.espera?.motivo === "BANXICO") {
      esperando.set(trabajo.id, { trabajo });
      vigia.programar(trabajo.espera.proxima);
      return;
    }
    const ms = Math.max(0, (trabajo.espera?.proxima ?? Date.now()) - Date.now());
    esperando.set(trabajo.id, { trabajo, reloj: setTimeout(() => despertar(api, trabajo.id), ms) });
  }

  const esperanABanxico = () => [...esperando.values()].filter((e) => e.trabajo.espera?.motivo === "BANXICO");

  /**
   * Resultado de la revisión del vigía. Si Banxico responde, los comprobantes que lo esperaban salen a la
   * cola (que los atiende de uno en uno). Si no, a los que llevan 1 h esperando se les responde. Devuelve
   * si quedan comprobantes esperando a Banxico.
   */
  async function alRevisarBanxico(api: Api, salud: SaludBanxico): Promise<boolean> {
    const enEspera = esperanABanxico();
    if (!enEspera.length) return false;
    if (salud.ok) {
      // El aviso "Banxico ya responde" lo da la primera validación que lo consulte con éxito.
      log(`Banxico responde: se revisan los ${enEspera.length} comprobantes que lo esperaban`);
      for (const e of enEspera) despertar(api, e.trabajo.id);
      return false;
    }
    log(`Banxico sigue sin responder (${salud.motivo ?? "sin detalle"}); se vuelve a revisar en 3 min`);
    for (const e of enEspera) {
      if (Date.now() - e.trabajo.espera!.desde >= MAX_ESPERA_BANXICO_MS) await rendirse(api, e.trabajo);
    }
    await registrarEstadoBanxico(api, false);
    return esperanABanxico().length > 0;
  }

  /** Banxico no respondió en 1 hora: se le responde a la persona y el comprobante deja de esperar. */
  async function rendirse(api: Api, trabajo: Trabajo): Promise<void> {
    esperando.delete(trabajo.id);
    log(`Usuario ${trabajo.usuario}: Banxico no respondió en 1 hora; se deja de esperar`);
    const r: ResultadoValidacion = {
      codigo: "BANXICO_NO_DISPONIBLE",
      mensaje: MENSAJE_BANXICO_SIN_RESPUESTA,
      extraccion: trabajo.extraccion,
      reglas: [],
      intentos: [],
      tiempos: {},
    };
    await responder(api, trabajo, r).catch((e) => log(`No se pudo responder al usuario ${trabajo.usuario}: ${(e as Error).message}`));
    await guardada.quitar(trabajo.id).catch(() => undefined);
  }

  /** Vuelve a poner en la cola un comprobante que esperaba. */
  function despertar(api: Api, id: string): void {
    const e = esperando.get(id);
    if (!e) return;
    clearTimeout(e.reloj);
    esperando.delete(id);
    const antes = cola.enEspera;
    if (antes) void api.editMessageText(e.trabajo.chatId, e.trabajo.avisoId, textoEnCola(antes), { parse_mode: "HTML" }).catch(() => undefined);
    encolar(api, e.trabajo);
  }

  /**
   * Guarda el comprobante para revisarlo solo más tarde y se lo avisa a la persona. La lectura ya
   * hecha se conserva: al reintentar no se vuelve a leer la imagen.
   */
  async function esperarYReintentar(api: Api, trabajo: Trabajo, r: ResultadoValidacion | null, espera: Espera): Promise<void> {
    // Los que esperan a Banxico se revisan juntos, cuando le toca al vigía.
    if (espera.motivo === "BANXICO") espera = { ...espera, proxima: vigia.programar(espera.proxima) };
    const siguiente: Trabajo = { ...trabajo, id: nuevoId(), extraccion: r?.extraccion ?? trabajo.extraccion, espera };
    await guardada.guardar(siguiente).catch((e) => log(`No se pudo guardar la cola en el disco: ${(e as Error).message}`));
    const hora = formatInTimeZone(new Date(espera.proxima), ZONA_HORARIA, "HH:mm");
    const reciente = espera.motivo === "RECIENTE";
    const texto = reciente ? textoEsperaPagoReciente(hora, espera.reintentos, MAX_REINTENTOS_RECIENTE) : textoEsperaBanxico(hora);
    await conReintento(() => api.editMessageText(trabajo.chatId, trabajo.avisoId, texto, { parse_mode: "HTML" })).catch(() => undefined);
    log(
      `Usuario ${trabajo.usuario}: ${reciente ? "pago reciente que Banxico todavía no publica" : "Banxico no responde"}; ` +
        `se revisa solo a las ${hora} (intento ${espera.reintentos})`,
    );
    programar(api, siguiente);
    if (r) await registrarEstadoBanxico(api, banxicoRespondio(r));
  }

  /** Descarga la imagen (o usa la lectura ya hecha) y valida el comprobante. */
  async function validar(
    api: Api,
    trabajo: Trabajo,
    signal: AbortSignal,
    alProgreso: (p: Progreso) => void,
    limite: number,
  ): Promise<ResultadoValidacion> {
    // Pago de hace minutos: la revisión de los 5 min busca solo hoy; la última (10 min), en todas las fechas.
    const reciente = trabajo.espera?.motivo === "RECIENTE" ? trabajo.espera : undefined;
    const ultimaRevision = !!reciente && reciente.reintentos >= MAX_REINTENTOS_RECIENTE;
    const opciones = {
      usuario: trabajo.usuario,
      confirmaciones: trabajo.confirmaciones,
      claveYaRegistrada: trabajo.claveRegistrada,
      nota: trabajo.nota?.datos,
      maxFechas: reciente && !ultimaRevision ? FECHAS_AL_REINTENTAR_RECIENTE : undefined,
      busquedaCompleta: ultimaRevision || undefined,
      limite,
      signal,
      alProgreso,
    };
    if (trabajo.extraccion) return validarComprobante(null, { ...opciones, extraccion: trabajo.extraccion });
    if (!trabajo.fileId) throw new Error("El trabajo no tiene imagen ni lectura");
    const imagen = await descargarArchivo(api, token, trabajo.fileId, signal);
    if (!formatoImagen(imagen)) return { codigo: "NO_ES_COMPROBANTE", mensaje: MENSAJE_IMAGEN_NO_VALIDA, reglas: [], intentos: [], tiempos: {} };
    return validarComprobante(imagen, opciones);
  }

  /** Encola un comprobante con su mensaje de progreso animado y maneja sus errores sin tumbar el bot. */
  function encolar(api: Api, trabajo: Trabajo): void {
    const { chatId, avisoId } = trabajo;
    // Los IDs de los grupos son negativos.
    const indicador = new IndicadorProgreso(api, chatId, avisoId, chatId < 0 ? INTERVALO_GRUPO_MS : undefined);
    let etapa: Progreso["etapa"] = trabajo.extraccion ? "REGLAS" : "LEYENDO";

    void cola
      .agregar(
        async ({ signal, quitarLimite }) => {
          indicador.iniciar(etapa);
          // La búsqueda en Banxico termina antes del tiempo máximo con lo que alcanzó a revisar.
          const limite = Date.now() + LIMITE_POR_COMPROBANTE_MS;
          try {
            const r = await validar(api, trabajo, signal, (p) => {
              etapa = p.etapa;
              if (p.etapa === "CAPTURA") {
                // Ya hay resultado (validado y registrado, o devuelto): desde aquí no se corta, hay que entregar la foto.
                quitarLimite();
                if (p.clave) void guardada.guardar({ ...trabajo, claveRegistrada: p.clave }).catch(() => undefined);
              }
              indicador.actualizar(p);
            }, limite);
            if (signal.aborted) return; // ya se le avisó que tardó demasiado
            quitarLimite(); // ya hay resultado: la respuesta se entrega aunque Telegram pida esperar
            await indicador.detener();
            const espera = decidirEspera(r, trabajo.espera, new Date());
            if (espera) await esperarYReintentar(api, trabajo, r, espera);
            else await responder(api, trabajo, r);
          } finally {
            await indicador.detener();
          }
        },
        {
          usuario: trabajo.usuario,
          limiteMs: LIMITE_POR_COMPROBANTE_MS,
          alCambiarPosicion: (antes) =>
            void api.editMessageText(chatId, avisoId, textoEnCola(antes), { parse_mode: "HTML" }).catch(() => undefined),
        },
      )
      .catch(async (e) => {
        await indicador.detener();
        if (e instanceof TiempoAgotado) {
          const enBanxico = etapa === "BANXICO";
          log(`Usuario ${trabajo.usuario}: el comprobante superó el tiempo máximo (etapa ${etapa})`);
          // Banxico tan lento que se agotó el tiempo: cuenta como caído y el comprobante se revisa solo más tarde.
          const espera = enBanxico ? decidirEspera({ codigo: "BANXICO_NO_DISPONIBLE" }, trabajo.espera, new Date()) : null;
          if (espera) {
            await registrarEstadoBanxico(api, false);
            await esperarYReintentar(api, trabajo, null, espera);
            return;
          }
          await api.editMessageText(chatId, avisoId, enBanxico ? TEXTO_BANXICO_LENTO : TEXTO_TIEMPO_AGOTADO).catch(() => undefined);
          await reaccionar(api, chatId, trabajo.mensajeOriginal, "👎");
          if (enBanxico) await registrarEstadoBanxico(api, false);
          return;
        }
        log(`Error con el comprobante del usuario ${trabajo.usuario}: ${(e as Error).stack ?? e}`);
        await api
          .editMessageText(chatId, avisoId, "❌ Ocurrió un error al validar el comprobante. Intenta de nuevo en unos minutos.")
          .catch(() => undefined);
      })
      .finally(() => guardada.quitar(trabajo.id))
      .catch((e) => log(`Error al cerrar el comprobante del usuario ${trabajo.usuario}: ${(e as Error).message}`));
  }

  /** Guarda el comprobante en data/cola.json y lo pone en la cola. */
  async function agregarTrabajo(api: Api, trabajo: Trabajo): Promise<void> {
    await guardada.guardar(trabajo).catch((e) => log(`No se pudo guardar la cola en el disco: ${(e as Error).message}`));
    encolar(api, trabajo);
  }

  /** Borra un mensaje. En un grupo, si el bot no es administrador, lo avisa una vez en la consola. */
  async function borrar(api: Api, chatId: number, mensajeId: number): Promise<void> {
    await api.deleteMessage(chatId, mensajeId).catch((e) => {
      if (chatId < 0 && !avisoSinPermisoDeBorrar) {
        avisoSinPermisoDeBorrar = true;
        log(`No pude borrar un mensaje en el grupo ${chatId} (${(e as Error).message}). Haz al bot administrador con permiso de "Eliminar mensajes".`);
      }
    });
  }

  /** Borra el mensaje y muestra un aviso que se borra solo. */
  async function rechazarMensaje(api: Api, chatId: number, mensajeId: number, texto = AVISO_SOLO_IMAGENES): Promise<void> {
    await borrar(api, chatId, mensajeId);
    const ahora = Date.now();
    if (ahora - (ultimoAviso.get(chatId) ?? 0) < ESPERA_ENTRE_AVISOS_MS) return;
    ultimoAviso.set(chatId, ahora);
    const aviso = await api.sendMessage(chatId, texto, { parse_mode: "HTML" }).catch(() => null);
    if (aviso) setTimeout(() => void api.deleteMessage(chatId, aviso.message_id).catch(() => undefined), DURACION_AVISO_MS);
  }

  // /id: responde el ID del chat, también en grupos no autorizados (para llenar ALLOWED_CHAT_IDS).
  // En un grupo ya autorizado, /id se borra como cualquier otro texto.
  bot.command("id", async (ctx, next) => {
    if (grupos.has(ctx.chat.id)) return next();
    const tipo = esGrupo(ctx.chat) ? "este grupo" : "este chat";
    log(`ID de ${tipo}: ${ctx.chat.id}${"title" in ctx.chat ? ` ("${ctx.chat.title}")` : ""}`);
    if (esGrupo(ctx.chat)) await anotarGrupo(ctx.chat.id, ("title" in ctx.chat && ctx.chat.title) || "");
    await ctx.reply(`🆔 El ID de ${tipo} es: <code>${ctx.chat.id}</code>`, { parse_mode: "HTML" }).catch(() => undefined);
  });

  // En privado, solo usuarios autorizados; en grupos, solo los grupos autorizados.
  bot.use(async (ctx, next) => {
    const chat = ctx.chat;
    if (puedeUsar(chat, ctx.from?.id, permitidos, grupos)) {
      await next();
      return;
    }
    if (chat && esGrupo(chat)) {
      if (gruposAvisados.has(chat.id)) return;
      gruposAvisados.add(chat.id);
      const titulo = ("title" in chat && chat.title) || "";
      log(`Grupo no autorizado: "${titulo}" con ID ${chat.id}. Para activarlo, pon ALLOWED_CHAT_IDS=${chat.id} en el .env y reinicia el bot.`);
      await anotarGrupo(chat.id, titulo);
      return;
    }
    log(`Ignorado: usuario no autorizado ${ctx.from?.id ?? "?"} (@${ctx.from?.username ?? "-"})`);
  });

  // Mensajes: solo imágenes; todo lo demás se borra.
  bot.on("message", async (ctx) => {
    const clasificacion = clasificarMensaje(ctx.message);
    const chatId = ctx.chat.id;

    if (clasificacion.tipo === "ayuda") {
      await ctx.deleteMessage().catch(() => undefined);
      const ayuda = await ctx.reply(AYUDA, { parse_mode: "HTML" });
      // En el grupo solo quedan los comprobantes y sus respuestas: la ayuda se borra sola.
      if (esGrupo(ctx.chat)) setTimeout(() => void borrar(ctx.api, chatId, ayuda.message_id), DURACION_AYUDA_GRUPO_MS);
      return;
    }
    if (clasificacion.tipo === "servicio") {
      const idNuevo = ctx.message.migrate_to_chat_id;
      if (idNuevo) {
        grupos.add(idNuevo);
        log(`El grupo ${chatId} se convirtió en supergrupo y su ID ahora es ${idNuevo}. Cambia ALLOWED_CHAT_IDS=${idNuevo} en el .env.`);
        return;
      }
      if (esGrupo(ctx.chat)) await borrar(ctx.api, chatId, ctx.message.message_id);
      return;
    }
    if (clasificacion.tipo === "rechazar") {
      log(`Usuario ${ctx.from.id}: mensaje que no es imagen (o no es JPG, PNG o WEBP de hasta 10 MB), borrado`);
      await rechazarMensaje(ctx.api, chatId, ctx.message.message_id);
      return;
    }

    const usuario = String(ctx.from.id);
    const nombre = ctx.from.first_name || (ctx.from.username ? `@${ctx.from.username}` : undefined);
    // En el grupo, una foto a la vez por persona. Los mensajes se atienden de uno en uno, así que
    // si mandan varias fotos juntas, cuando llega la segunda la primera ya está en la cola.
    if (esGrupo(ctx.chat)) {
      const yaEspera = [...esperando.values()].some((e) => e.trabajo.usuario === usuario);
      if (cola.deUsuario(usuario) > 0 || yaEspera) {
        log(`Usuario ${usuario}: ya tiene un comprobante en proceso, foto borrada`);
        await rechazarMensaje(ctx.api, chatId, ctx.message.message_id, avisoUnaFotoALaVez(nombre));
        return;
      }
      if (tienePreguntaPendiente(usuario)) {
        log(`Usuario ${usuario}: tiene una pregunta sin responder, foto borrada`);
        await rechazarMensaje(ctx.api, chatId, ctx.message.message_id, avisoPreguntaPendiente(nombre));
        return;
      }
    }

    const antes = cola.enEspera;
    const inicial = antes ? textoEnCola(antes) : renderizarProgreso({ etapa: "LEYENDO", cuadro: 0, porcentaje: 5, segundos: 0 });
    const aviso = await conReintento(() =>
      ctx.reply(inicial, {
        parse_mode: "HTML",
        reply_parameters: { message_id: ctx.message.message_id, allow_sending_without_reply: true },
      }),
    );
    const enGrupo = "title" in ctx.chat ? ` en el grupo "${ctx.chat.title}"` : "";
    const nota = leerNota(ctx.message.caption) ?? undefined;
    const textoNota = nota
      ? `, nota: ${[...nota.entendidos, ...nota.noEntendidos.map((p) => `no entendido «${p}»`)].join(", ")}`
      : "";
    log(`Usuario ${usuario}: comprobante recibido${enGrupo}${antes ? ` (en cola, ${antes} antes)` : ""}${textoNota}`);
    await agregarTrabajo(ctx.api, {
      id: nuevoId(),
      chatId,
      avisoId: aviso.message_id,
      usuario,
      nombre,
      mensajeOriginal: ctx.message.message_id,
      fileId: clasificacion.fileId,
      nota,
      confirmaciones: {},
    });
  });

  // Cambiaron los permisos del bot en un grupo (por ejemplo, le dieron "Fijar mensajes"): fija la guía ya.
  bot.on("my_chat_member", async (ctx) => {
    const nuevo = ctx.myChatMember.new_chat_member;
    const puedeFijar = nuevo.status === "creator" || (nuevo.status === "administrator" && nuevo.can_pin_messages === true);
    if (grupos.has(ctx.chat.id) && puedeFijar) await fijarGuia(ctx.me.id);
  });

  // En el grupo no se permite editar: así nadie cambia la foto después de recibir la respuesta.
  bot.on("edited_message", async (ctx) => {
    if (!esGrupo(ctx.chat)) return;
    log(`Usuario ${ctx.from?.id ?? "?"}: editó un mensaje en el grupo, borrado`);
    await rechazarMensaje(ctx.api, ctx.chat.id, ctx.editedMessage.message_id, AVISO_EDITADO);
  });

  // Respuesta a una pregunta (banco o cuenta).
  bot.on("callback_query:data", async (ctx) => {
    const [tipo, id, valor] = ctx.callbackQuery.data.split(":");
    const pendiente = id ? pendientes.get(id) : undefined;
    // En un grupo, nadie más puede responder por quien envió el comprobante.
    if (pendiente && String(ctx.from.id) !== pendiente.usuario) {
      await ctx
        .answerCallbackQuery({ text: "Solo quien envió el comprobante puede elegir.", show_alert: true })
        .catch(() => undefined);
      return;
    }
    await ctx.answerCallbackQuery().catch(() => undefined);
    const avisoId = ctx.callbackQuery.message?.message_id;
    if (!pendiente || !avisoId || !ctx.chat) {
      await ctx.editMessageText("⌛ Esta pregunta ya expiró. Envía el comprobante de nuevo.").catch(() => undefined);
      return;
    }
    pendientes.delete(id!);
    if (tipo === "x") {
      await ctx.editMessageText("✖️ Validación cancelada.").catch(() => undefined);
      await reaccionar(ctx.api, ctx.chat.id, pendiente.mensajeOriginal, "👎");
      return;
    }

    const confirmaciones: Confirmaciones = { ...pendiente.confirmaciones };
    let elegido = "";
    if (tipo === "b" && valor && valor in BANCOS) {
      confirmaciones.banco = { clave: valor as ClaveBanco, nombreLibre: null };
      elegido = BANCOS[valor as ClaveBanco].nombre;
    } else if (tipo === "k" && CUENTAS_DESTINO[Number(valor)]) {
      const cuenta = CUENTAS_DESTINO[Number(valor)]!;
      confirmaciones.cuentaClabe = cuenta.clabe;
      elegido = `${BANCOS[cuenta.banco].nombre} …${cuenta.clabe.slice(-4)}`;
    } else {
      return;
    }
    log(`Usuario ${pendiente.usuario}: eligió ${elegido}`);
    // Quita los botones; si hay otros antes, muestra su lugar en la fila.
    const antes = cola.enEspera;
    if (antes) await ctx.editMessageText(textoEnCola(antes), { parse_mode: "HTML" }).catch(() => undefined);
    await agregarTrabajo(ctx.api, {
      id: nuevoId(),
      chatId: ctx.chat.id,
      avisoId,
      usuario: pendiente.usuario,
      nombre: pendiente.nombre,
      mensajeOriginal: pendiente.mensajeOriginal,
      extraccion: pendiente.extraccion,
      nota: pendiente.nota,
      confirmaciones,
    });
  });

  bot.catch((err) => {
    const e = err.error;
    const detalle = e instanceof GrammyError ? `Telegram: ${e.description}` : e instanceof HttpError ? `red: ${e.message}` : String(e);
    log(`Error al procesar una actualización: ${detalle}`);
  });

  async function reanudarPendientes(): Promise<number> {
    const trabajos = await guardada.cargar();
    for (const trabajo of trabajos) {
      // Los que esperaban para revisarse solos siguen esperando (su aviso ya dice a qué hora). Los que
      // esperaban a Banxico van al vigía aunque ya les tocara: una sola revisión para todos.
      if (trabajo.espera && (trabajo.espera.motivo === "BANXICO" || trabajo.espera.proxima > Date.now())) {
        programar(bot.api, trabajo);
        continue;
      }
      const antes = cola.enEspera;
      await bot.api
        .editMessageText(trabajo.chatId, trabajo.avisoId, antes ? textoEnCola(antes) : TEXTO_REANUDANDO, { parse_mode: "HTML" })
        .catch(() => undefined);
      encolar(bot.api, trabajo);
    }
    return trabajos.length;
  }

  async function fijarGuia(idBot: number): Promise<void> {
    for (const chatId of grupos) {
      try {
        const chat = await bot.api.getChat(chatId);
        const fijado = chat.pinned_message;
        const delBot = fijado?.from?.id === idBot;
        if (delBot && fijado?.text === textoPlano(GUIA_GRUPO)) continue; // ya está fijada y al día
        const miembro = await bot.api.getChatMember(chatId, idBot);
        const puedeFijar = miembro.status === "creator" || (miembro.status === "administrator" && miembro.can_pin_messages === true);
        if (!puedeFijar) {
          log(`No puedo fijar la guía en el grupo ${chatId}: dale al bot el permiso de administrador "Fijar mensajes".`);
          continue;
        }
        // Una guía anterior del bot se reemplaza (al borrarla se desfija).
        if (delBot && fijado) await bot.api.deleteMessage(chatId, fijado.message_id).catch(() => undefined);
        const guia = await bot.api.sendMessage(chatId, GUIA_GRUPO, { parse_mode: "HTML" });
        await bot.api.pinChatMessage(chatId, guia.message_id, { disable_notification: true });
        log(`Guía de la nota fijada en el grupo ${chatId}`);
      } catch (e) {
        log(`No se pudo fijar la guía en el grupo ${chatId}: ${(e as Error).message}`);
      }
    }
  }

  return { bot, reanudarPendientes, fijarGuia };
}

/** Arranca el bot en modo long polling (no necesita servidor público). */
export async function iniciarBot(): Promise<void> {
  const { bot, reanudarPendientes, fijarGuia } = crearBot();
  // Los avisos de captcha (con cuántas peticiones hubo antes) van a la consola del bot, con la hora.
  RITMO.alAvisar(log);
  let deteniendo = false;
  const detener = async (senal: string) => {
    if (deteniendo) return;
    deteniendo = true;
    log(`Deteniendo el bot (${senal})…`);
    await bot.stop().catch(() => undefined);
    await terminarOcr().catch(() => undefined);
    await cerrarNavegador().catch(() => undefined);
    process.exit(0);
  };
  process.once("SIGINT", () => void detener("SIGINT"));
  process.once("SIGTERM", () => void detener("SIGTERM"));

  await bot.api.setMyCommands([
    { command: "start", description: "Cómo usar el validador" },
    { command: "ayuda", description: "Ayuda" },
  ]);
  await bot.start({
    // grammY espera a que termine onStart antes de recibir mensajes: la cola guardada se retoma primero.
    onStart: async (yo) => {
      log(
        `Bot @${yo.username} en línea (long polling). Usuarios autorizados: ${entorno.usuariosPermitidos.join(", ") || "ninguno"}.` +
          ` Grupos autorizados: ${entorno.gruposPermitidos.join(", ") || "ninguno"}`,
      );
      const retomados = await reanudarPendientes().catch((e) => {
        log(`No se pudo leer la cola guardada: ${(e as Error).message}`);
        return 0;
      });
      if (retomados) log(`Se retomaron ${retomados} comprobantes que quedaron pendientes antes del reinicio`);
      await fijarGuia(yo.id);
    },
  });
}
