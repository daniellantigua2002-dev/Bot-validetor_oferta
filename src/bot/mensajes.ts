/**
 * Textos y botones que el bot envía a Telegram (HTML de Telegram).
 */
import { BANCOS, CUENTAS_DESTINO, type ClaveBanco, type DefinicionBanco } from "../config.js";
import type { Diferencia, NotaLeida } from "../extraction/nota.js";
import type { Progreso, ResultadoValidacion } from "../pipeline.js";
import { TAMANO_MAXIMO_MB } from "./filtro.js";

export const escapar = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const PESOS = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" });
const pesos = (monto: string | number | null | undefined) =>
  monto === null || monto === undefined || monto === "" ? "?" : PESOS.format(Number(monto));

export const AYUDA = `👋 <b>Validador de comprobantes SPEI</b>

Envía la <b>foto</b> o captura del comprobante de transferencia y lo verifico en Banxico (CEP). Si es válido, respondo con la captura de Banxico.

• Solo se aceptan depósitos a nuestras cuentas: ${[...new Set(CUENTAS_DESTINO.map((c) => BANCOS[c.banco].nombre))].join(", ")}.
• Para una mejor lectura envíalo como <b>archivo</b> (📎 → Archivo): Telegram comprime las fotos.
• Envía <b>una foto a la vez</b> (JPG, PNG o WEBP de hasta ${TAMANO_MAXIMO_MB} MB) y espera su respuesta antes de enviar otra.
• Si el pago es muy reciente, espera unos minutos: Banxico lo registra hasta 5 minutos después.

📝 <b>Si a tu comprobante le falta un dato</b>, escríbelo en la nota de la foto (el texto que va con ella), separado por comas:
<code>fecha 09/10/2026, ref 2309260, banco BBVA</code>
Palabras: <b>fecha, monto, clave, ref, banco, cuenta</b>. Si te equivocas, borra la foto y envíala de nuevo: en el grupo los mensajes editados se borran.`;

/** Mensaje fijado en el grupo: cómo enviar el comprobante y cómo darle datos en la nota de la foto. */
export const GUIA_GRUPO = `📌 <b>Cómo validar tu comprobante</b>

Envía la <b>captura del comprobante</b>, una a la vez, y espera la respuesta.

📝 Si a tu comprobante le falta un dato, escríbelo en la <b>nota de la foto</b> (el texto que va con la imagen), separado por comas y en cualquier orden:

• <code>fecha 09/10/2026</code>: día del pago
• <code>monto 400</code>: cantidad enviada
• <code>clave MBAN01002610090090453121</code>: clave de rastreo
• <code>ref 1234567</code>: número de referencia
• <code>banco BBVA</code>: banco desde el que pagaste
• <code>cuenta 1871</code>: últimos dígitos de la cuenta a la que pagaste

Ejemplo: <code>fecha 09/10/2026, ref 1234567, banco BBVA</code>

⚠️ Solo se aceptan imágenes: los mensajes de texto se borran.`;

/** El texto de un mensaje HTML tal como lo devuelve Telegram (sin etiquetas). */
export const textoPlano = (html: string) =>
  html.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

// --- Comprobantes que se revisan solos más tarde ------------------------------------------------

/** El pago es muy reciente y Banxico todavía no lo publica. `hora`: "17:45" (CDMX). */
export const textoEsperaPagoReciente = (hora: string, intento: number, de: number) =>
  `⏳ <b>Banxico todavía no publica este pago.</b>\n` +
  `Algunos bancos tardan hasta 15 minutos en enviarlo. Lo vuelvo a revisar solo a las <b>${hora}</b> ` +
  `(revisión ${intento} de ${de}). No hace falta volver a enviarlo.`;

/** Banxico no responde: el comprobante queda guardado y se revisa solo. */
export const textoEsperaBanxico = (hora: string) =>
  `⏳ <b>Banxico no está respondiendo.</b>\n` +
  `Tu comprobante quedó guardado: lo vuelvo a revisar solo a las <b>${hora}</b>, o antes si Banxico vuelve. ` +
  "No hace falta volver a enviarlo.";

// --- Avisos temporales (se borran solos) -----------------------------------------------------

/** Cuando se envía algo que no es una imagen (o una imagen que no es JPG, PNG o WEBP de hasta 10 MB). */
export const AVISO_SOLO_IMAGENES = `⚠️ Solo se aceptan <b>imágenes</b> del comprobante: foto o archivo JPG, PNG o WEBP de hasta ${TAMANO_MAXIMO_MB} MB.`;

/** En el grupo cada persona envía una foto a la vez: la segunda (aunque vaya en el mismo envío) se borra. */
export const avisoUnaFotoALaVez = (nombre?: string) =>
  `⏳ ${nombre?.trim() ? `${escapar(nombre.trim())}, se` : "Se"} acepta <b>una foto a la vez</b>. ` +
  "Espera la respuesta de tu comprobante y después envía el siguiente.";

/** Tiene una pregunta (banco o cuenta) sin responder de su comprobante anterior. */
export const avisoPreguntaPendiente = (nombre?: string) =>
  `❓ ${nombre?.trim() ? `${escapar(nombre.trim())}, primero` : "Primero"} responde la pregunta de tu comprobante anterior ` +
  "(o pulsa <b>Cancelar</b>) y después envía el siguiente.";

export const AVISO_EDITADO = "✏️ No se permite editar mensajes en el grupo: el mensaje editado se borró.";

// --- Banxico y resultados especiales ----------------------------------------------------------

/** Aviso en el grupo cuando Banxico deja de responder (se borra cuando vuelve). */
export const AVISO_BANXICO_CAIDO =
  "⚠️ <b>Banxico no está respondiendo</b> en este momento.\n\nPor ahora no se pueden validar comprobantes. Avisaré aquí cuando vuelva.";

/** Aviso en el grupo cuando Banxico vuelve a responder. */
export const AVISO_BANXICO_VOLVIO = "✅ <b>Banxico ya está respondiendo.</b> Ya pueden enviar sus comprobantes.";

/** La validación superó el tiempo máximo mientras consultaba Banxico. */
/** Respuesta final a un comprobante que esperó 1 hora a que Banxico volviera. */
export const MENSAJE_BANXICO_SIN_RESPUESTA = "Banxico no respondió durante 1 hora. Envía el comprobante de nuevo más tarde.";

export const TEXTO_BANXICO_LENTO ="⚠️ Banxico no está respondiendo. Envía el comprobante de nuevo en unos minutos.";

/** La validación superó el tiempo máximo en otra etapa. */
export const TEXTO_TIEMPO_AGOTADO = "⌛ La validación tardó demasiado. Envía el comprobante de nuevo en unos minutos.";

/** Al arrancar, en los comprobantes que quedaron pendientes por un reinicio del bot. */
export const TEXTO_REANUDANDO = "🔄 <b>El bot se reinició.</b> Retomando este comprobante…";

export const MENSAJE_IMAGEN_NO_VALIDA = "El archivo no es una imagen válida. Envía una foto o un archivo JPG, PNG o WEBP.";

// --- Mensaje de progreso animado -----------------------------------------------------------

/** Pasos que se muestran en el mensaje de progreso, en orden. */
const PASOS: { etapa: Progreso["etapa"]; texto: string }[] = [
  { etapa: "LEYENDO", texto: "Leyendo los datos de la imagen" },
  { etapa: "REGLAS", texto: "Revisando cuenta, banco y fecha" },
  { etapa: "BANXICO", texto: "Consultando Banxico" },
  { etapa: "CAPTURA", texto: "Generando la captura" },
];

/** Reloj que "gira" en el paso actual (un cuadro por actualización). */
const RELOJ = ["🕐", "🕑", "🕒", "🕓", "🕔", "🕕", "🕖", "🕗", "🕘", "🕙", "🕚", "🕛"];

export interface EstadoProgreso {
  etapa: Progreso["etapa"];
  /** Número de consulta a Banxico. */
  consulta?: number;
  /** Cuadro de la animación. */
  cuadro: number;
  /** 0–100 */
  porcentaje: number;
  segundos: number;
}

function barra(porcentaje: number): string {
  const llenos = Math.max(0, Math.min(10, Math.round(porcentaje / 10)));
  return "▰".repeat(llenos) + "▱".repeat(10 - llenos);
}

/** Mensaje de progreso: pasos hechos ✅, paso actual con el reloj girando, barra y tiempo. */
export function renderizarProgreso(e: EstadoProgreso): string {
  const actual = PASOS.findIndex((p) => p.etapa === e.etapa);
  const lineas = PASOS.map((paso, i) => {
    if (i < actual) return `✅ ${paso.texto}`;
    if (i > actual) return `▫️ ${paso.texto}`;
    const detalle = paso.etapa === "BANXICO" && e.consulta && e.consulta > 1 ? ` (consulta ${e.consulta})` : "";
    return `${RELOJ[e.cuadro % RELOJ.length]} <b>${paso.texto}${detalle}…</b>`;
  });
  return [
    "🔎 <b>Validando tu comprobante</b>",
    "",
    "✅ Imagen recibida",
    ...lineas,
    "",
    `${barra(e.porcentaje)} ${Math.round(e.porcentaje)}%  ·  ⏱ ${e.segundos} s`,
  ].join("\n");
}

export const textoEnCola = (antes: number) =>
  `🕐 <b>En cola</b>\n\n${antes === 1 ? "Hay 1 comprobante" : `Hay ${antes} comprobantes`} antes que este. Empieza en cuanto termine el anterior.`;

export interface Boton {
  texto: string;
  datos: string;
}

export interface Respuesta {
  /** Texto (o pie de foto) en HTML. */
  texto: string;
  /** Ruta de la imagen a enviar. */
  foto?: string;
  botones?: Boton[][];
}

/** Datos clave del comprobante, para ayudar a responder una pregunta. */
function datosDelComprobante(r: ResultadoValidacion): string {
  const n = r.normalizados;
  if (!n) return "";
  const partes = [
    n.monto ? `💰 ${pesos(n.monto)}` : null,
    n.fecha ? `📅 ${n.fecha.split("-").reverse().join("/")}` : null,
    n.claveRastreo ? `🔑 <code>${escapar(n.claveRastreo)}</code>` : n.referencia ? `🔢 Ref. ${escapar(n.referencia)}` : null,
  ].filter(Boolean);
  return partes.length ? `\n\n${partes.join("\n")}` : "";
}

/** Bancos con nombre en el catálogo de Banxico (los pendientes, como Stori, no sirven para consultar). */
const BANCOS_CONSULTABLES = (Object.entries(BANCOS) as [ClaveBanco, DefinicionBanco][]).filter(([, b]) => b.catalogo.length);

function filas<T>(elementos: T[], porFila: number): T[][] {
  const resultado: T[][] = [];
  for (let i = 0; i < elementos.length; i += porFila) resultado.push(elementos.slice(i, i + porFila));
  return resultado;
}

/** Botones de bancos: primero los candidatos detectados, luego los demás. */
export function botonesBanco(id: string, candidatos: ClaveBanco[] = []): Boton[][] {
  const orden = [...new Set([...candidatos, ...BANCOS_CONSULTABLES.map(([clave]) => clave)])].filter(
    (c) => BANCOS[c].catalogo.length,
  );
  const botones = orden.map((clave) => ({
    texto: candidatos.includes(clave) ? `⭐ ${BANCOS[clave].nombre}` : BANCOS[clave].nombre,
    datos: `b:${id}:${clave}`,
  }));
  return [...filas(botones, 3), [{ texto: "✖️ Cancelar", datos: `x:${id}` }]];
}

/** Botones de nuestras cuentas destino. */
export function botonesCuenta(id: string, candidatas: readonly { clabe: string }[]): Boton[][] {
  const botones = CUENTAS_DESTINO.map((c, i) => ({ c, i }))
    .filter(({ c }) => candidatas.some((x) => x.clabe === c.clabe))
    .map(({ c, i }) => ({ texto: `${BANCOS[c.banco].nombre} …${c.clabe.slice(-4)}`, datos: `k:${id}:${i}` }));
  return [...filas(botones, 1), [{ texto: "✖️ Cancelar", datos: `x:${id}` }]];
}

/**
 * Las consultas hechas a Banxico, una por línea, para la consola del bot. En el grupo solo va el
 * resumen (qué fechas se revisaron y cuántas consultas), que ya trae el mensaje. Con `detalle`, también
 * el número de referencia usado y el porqué de cada resultado (por ejemplo, un pago descartado por la clave).
 */
export function resumenIntentos(r: Pick<ResultadoValidacion, "intentos">, { detalle = false }: { detalle?: boolean } = {}): string {
  return r.intentos
    .map((i) => {
      const criterio = i.criterio === "CLAVE_RASTREO" ? "clave" : detalle ? `referencia ${i.valorCriterio}` : "referencia";
      const cuenta = i.cuenta ? ` · …${i.cuenta.slice(-4)}` : "";
      const sondeo = i.sondeo === "SIN_CUENTA" ? " (clave y monto)" : i.sondeo ? " (solo clave)" : "";
      const porque = detalle && i.detalle ? ` (${i.detalle})` : "";
      return `• ${i.fecha} · ${criterio}${cuenta}${sondeo} → ${i.resultado.replace(/_/g, " ").toLowerCase()}${porque}`;
    })
    .join("\n");
}

/**
 * Datos leídos del comprobante, en una línea, para la consola del bot (no van al grupo). Con esto se sabe
 * después qué clave, referencia y banco se usaron (el 12-oct no quedó en el log qué clave leyó la IA).
 */
export function resumenLectura(r: Pick<ResultadoValidacion, "normalizados" | "bancoEmisor" | "extraccion">): string {
  const n = r.normalizados;
  const banco = r.bancoEmisor ?? (r.extraccion ? { clave: r.extraccion.banco.banco, nombreLibre: r.extraccion.banco.nombreLibre } : null);
  const emisor = banco?.clave ?? banco?.nombreLibre ?? "?";
  if (!n) return `emisor=${emisor}`;
  const campos = { clave: n.claveRastreo, ref: n.referencia, monto: n.monto, fecha: n.fecha, hora: n.hora, cuenta: n.cuentaDestino };
  return `${Object.entries(campos)
    .map(([nombre, valor]) => `${nombre}=${valor ?? "-"}`)
    .join(" ")} emisor=${emisor}`;
}

/**
 * Reacción sobre el mensaje del comprobante: 👍 si se validó, 👎 si no.
 * "Mismo banco" también lleva 👍: es un comprobante legítimo que no se valida por SPEI.
 * Mientras hay una pregunta pendiente (banco o cuenta) todavía no hay resultado: sin reacción.
 */
export function reaccionPara(codigo: ResultadoValidacion["codigo"]): "👍" | "👎" | null {
  if (codigo === "VALIDADO" || codigo === "MISMO_BANCO") return "👍";
  if (codigo === "REQUIERE_CONFIRMACION_BANCO" || codigo === "REQUIERE_CONFIRMACION_CUENTA") return null;
  return "👎";
}

/** "Daniel, su comprobante fue validado." (sin nombre: "Su comprobante fue validado."). */
export function textoValidado(nombre?: string): string {
  const limpio = nombre?.trim();
  return `✅ ${limpio ? `${escapar(limpio)}, su` : "Su"} comprobante fue validado.`;
}

const NOMBRE_CAMPO: Record<Diferencia["campo"], string> = {
  fecha: "La fecha",
  monto: "El monto",
  clave: "La clave de rastreo",
  ref: "La referencia",
  banco: "El banco",
  cuenta: "La cuenta",
};

/** Ejemplo de nota para cada dato que falta (los textos de `faltantes` de las reglas). */
const EJEMPLO_FALTANTE: Record<string, string> = {
  "el monto": "monto 400",
  "la fecha": "fecha 09/10/2026",
  "la clave de rastreo o el número de referencia": "ref 1234567",
};

/**
 * Si no se encontró el pago, cómo dar en la nota el dato que pudo fallar: la fecha o la clave/referencia
 * si el comprobante no las muestra (se buscó de hoy hacia atrás, o con la referencia habitual del
 * banco); si las muestra, la fecha (si la nota ya trae una, no se sugiere otra vez).
 */
function sugerenciaSinDatos(r: ResultadoValidacion, nota: NotaLeida | undefined): string | null {
  const n = r.normalizados;
  // Con la clave cortada el mensaje ya dice qué hacer (la captura completa o la clave en la nota): no se sugiere la fecha.
  if (!n || r.claveCortada) return null;
  const falta: string[] = [];
  const ejemplo: string[] = [];
  if (!n.fecha) {
    falta.push("la fecha");
    ejemplo.push(EJEMPLO_FALTANTE["la fecha"]!);
  }
  if (!n.claveRastreo && !n.referencia) {
    falta.push("la clave de rastreo ni la referencia");
    ejemplo.push(EJEMPLO_FALTANTE["la clave de rastreo o el número de referencia"]!);
  }
  if (falta.length) {
    return `💡 El comprobante no muestra ${falta.join(" ni ")}. Si lo sabes, reenvía la foto con la nota, por ejemplo: <code>${ejemplo.join(", ")}</code>`;
  }
  if (nota?.datos.fecha) return null;
  const revisa = r.claveInexistente ? "Revisa la fecha y la clave de rastreo del comprobante. Si" : "Si";
  return `💡 ${revisa} la fecha del pago es otra, reenvía la foto escribiéndola en la nota, por ejemplo: <code>${EJEMPLO_FALTANTE["la fecha"]}</code>`;
}

/**
 * Avisos sobre la nota de la foto: los datos que contradicen a la imagen (siempre) y, si no se
 * validó, lo que se usó de la nota, lo que no se entendió y cómo escribir lo que falta.
 */
function textoNota(r: ResultadoValidacion, nota: NotaLeida | undefined): string {
  const lineas: string[] = [];
  for (const d of r.extraccion?.notaAplicada?.diferencias ?? []) {
    lineas.push(`⚠️ ${NOMBRE_CAMPO[d.campo]} de tu nota (${escapar(d.nota)}) no coincide con la imagen (${escapar(d.imagen)}).`);
  }
  if (r.codigo !== "VALIDADO") {
    if (nota?.entendidos.length) lineas.push(`📝 De tu nota usé: ${escapar(nota.entendidos.join(", "))}.`);
    if (nota?.noEntendidos.length) {
      lineas.push(
        `❔ No entendí de tu nota: ${nota.noEntendidos.map((p) => `«${escapar(p)}»`).join(", ")}. ` +
          "Usa fecha, monto, clave, ref, banco o cuenta, separados por coma.",
      );
    }
    const ejemplo = r.codigo === "DATOS_INSUFICIENTES" ? (r.faltantes ?? []).map((f) => EJEMPLO_FALTANTE[f]).filter(Boolean) : [];
    if (ejemplo.length) lineas.push(`💡 Reenvía la foto escribiendo en la nota lo que falta, por ejemplo: <code>${ejemplo.join(", ")}</code>`);
    const sugerencia = r.codigo === "NO_ENCONTRADO" ? sugerenciaSinDatos(r, nota) : null;
    if (sugerencia) lineas.push(sugerencia);
    // La IA no respondió y se leyó solo con el OCR: el rechazo puede ser por una mala lectura, no por el comprobante.
    if (r.extraccion?.errorNvidia && RECHAZOS_POR_LECTURA.has(r.codigo)) {
      lineas.push("⚠️ El servicio que lee los comprobantes no respondió y se leyó con un método más simple: si los datos de tu comprobante son correctos, envíalo de nuevo en unos minutos.");
    }
  }
  return lineas.length ? `\n\n${lineas.join("\n")}` : "";
}

/** Rechazos que pueden venir de una mala lectura (cuando la IA no respondió y se leyó solo con el OCR). */
const RECHAZOS_POR_LECTURA: ReadonlySet<ResultadoValidacion["codigo"]> = new Set([
  "NO_ES_COMPROBANTE",
  "DATOS_INSUFICIENTES",
  "CUENTA_INCORRECTA",
  "NO_ENCONTRADO",
  "MONTO_NO_COINCIDE",
]);

/**
 * Respuesta final según el resultado. `id` identifica la pregunta pendiente (confirmaciones),
 * `nombre` es el nombre de Telegram de quien envió el comprobante y `nota`, lo que escribió en la foto.
 */
export function respuestaFinal(r: ResultadoValidacion, id = "", nombre?: string, nota?: NotaLeida): Respuesta {
  const respuesta = respuestaSegunCodigo(r, id, nombre);
  return { ...respuesta, texto: respuesta.texto + textoNota(r, nota) };
}

function respuestaSegunCodigo(r: ResultadoValidacion, id: string, nombre?: string): Respuesta {
  const mensaje = escapar(r.mensaje);
  switch (r.codigo) {
    case "VALIDADO": {
      // La foto de Banxico ya muestra todos los datos: basta con avisarle a la persona.
      const texto = textoValidado(nombre);
      if (r.captura) return { texto, foto: r.captura.ruta };
      return { texto: `${texto}\n\n<i>No se pudo generar la captura: ${escapar(r.errorCaptura ?? "error desconocido")}</i>` };
    }
    case "MISMO_BANCO":
      // No se valida por SPEI, pero es buena señal (transferencia legítima entre cuentas del mismo banco).
      return { texto: `✅ ${mensaje}` };
    case "FECHA_FUTURA":
    case "COMPROBANTE_NOCTURNO":
      return { texto: `⏳ ${mensaje}` };
    case "DUPLICADO":
      return { texto: `⚠️ ${mensaje}${datosDelComprobante(r)}` };
    case "BANXICO_NO_DISPONIBLE":
      return { texto: `⚠️ ${mensaje}` };
    case "NO_ENCONTRADO":
      // El mensaje ya dice qué fechas se revisaron; el detalle de cada consulta queda en la consola.
      return { texto: `🔍 ${mensaje}${datosDelComprobante(r)}` };
    case "NO_LIQUIDADO": {
      const texto = `${r.pago?.estado === "EN_PROCESO" ? "⏳" : "❌"} ${mensaje}`;
      // Pago devuelto: va con la foto de la tabla de Banxico, para ver la devolución.
      return r.captura ? { texto, foto: r.captura.ruta } : { texto };
    }
    case "REQUIERE_CONFIRMACION_BANCO":
      return { texto: `❓ ${mensaje}${datosDelComprobante(r)}`, botones: botonesBanco(id, r.candidatosBanco) };
    case "REQUIERE_CONFIRMACION_CUENTA":
      return {
        texto: `❓ ${mensaje}${datosDelComprobante(r)}`,
        botones: botonesCuenta(id, r.candidatosCuenta?.length ? r.candidatosCuenta : CUENTAS_DESTINO),
      };
    default:
      // CUENTA_INCORRECTA, NO_ES_COMPROBANTE, DATOS_INSUFICIENTES, MONTO_NO_COINCIDE
      return { texto: `❌ ${mensaje}` };
  }
}
