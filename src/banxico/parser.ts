/**
 * Interpreta la respuesta HTML de valida.do (ver docs/banxico-cep.md §2.1).
 */
import { normalizarTexto } from "../normalize/banco.js";
import type { EstadoPago, PagoBanxico } from "../types.js";

export type RespuestaBanxico =
  | { tipo: "PAGOS"; pagos: PagoBanxico[] }
  | { tipo: "NO_ENCONTRADO"; mensaje: string }
  | { tipo: "CEP_DISPONIBLE" }
  | { tipo: "CAPTCHA"; mensaje: string }
  | { tipo: "ERROR"; mensaje: string };

const ENTIDADES: Record<string, string> = {
  aacute: "á", eacute: "é", iacute: "í", oacute: "ó", uacute: "ú",
  Aacute: "Á", Eacute: "É", Iacute: "Í", Oacute: "Ó", Uacute: "Ú",
  ntilde: "ñ", Ntilde: "Ñ", uuml: "ü", nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', reg: "®",
};

export function decodificarEntidades(texto: string): string {
  return texto.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") return String.fromCodePoint(e[1]?.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    return ENTIDADES[e] ?? m;
  });
}

/** Texto plano de un fragmento HTML (sin etiquetas, entidades decodificadas, espacios simples). */
function texto(html: string): string {
  return decodificarEntidades(html.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

const ESTADOS: [string, EstadoPago][] = [
  ["en proceso de devolucion", "EN_PROCESO_DEVOLUCION"],
  ["en proceso", "EN_PROCESO"],
  ["no liquidado", "NO_LIQUIDADO"],
  ["liquidado", "LIQUIDADO"],
  ["devuelto", "DEVUELTO"],
  ["cancelado", "CANCELADO"],
  ["rechazado", "RECHAZADO"],
  ["retornado", "RETORNADO"],
  ["no encontrado", "NO_ENCONTRADO"],
];

export function estadoDesdeTexto(valor: string): EstadoPago {
  const norm = normalizarTexto(valor);
  return (ESTADOS.find(([t]) => norm === t) ?? ESTADOS.find(([t]) => norm.includes(t)))?.[1] ?? "ERROR";
}

type Campo = keyof Omit<PagoBanxico, "estado"> | "estado";

/** Etiqueta normalizada de la tabla → campo del pago. */
function campoDeEtiqueta(etiqueta: string): Campo | null {
  const e = normalizarTexto(etiqueta);
  if (e.includes("referencia")) return "referencia";
  if (e.includes("rastreo")) return "claveRastreo";
  if (e.includes("emisora")) return "emisor";
  if (e.includes("receptora")) return "receptor";
  if (e.includes("estado")) return "estado";
  if (e.includes("recepcion")) return "fechaRecepcion";
  if (e.includes("procesamiento")) return "fechaProcesamiento";
  if (e.includes("cuenta")) return "cuentaBeneficiaria";
  if (e.includes("monto")) return "monto";
  return null;
}

function construirPago(valores: Partial<Record<Campo, string>>): PagoBanxico {
  const v = (c: Campo) => valores[c]?.trim() || null;
  const monto = v("monto");
  return {
    estado: estadoDesdeTexto(v("estado") ?? ""),
    referencia: v("referencia"),
    claveRastreo: v("claveRastreo"),
    emisor: v("emisor"),
    receptor: v("receptor"),
    cuentaBeneficiaria: v("cuentaBeneficiaria"),
    monto: monto && !Number.isNaN(Number(monto.replace(/,/g, ""))) ? Number(monto.replace(/,/g, "")).toFixed(2) : monto,
    fechaRecepcion: v("fechaRecepcion"),
    fechaProcesamiento: v("fechaProcesamiento"),
  };
}

const filas = (html: string) => [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) => m[1]!);
const celdas = (fila: string, etiqueta: "td" | "th") =>
  [...fila.matchAll(new RegExp(`<${etiqueta}\\b([^>]*)>([\\s\\S]*?)</${etiqueta}>`, "gi"))].map((m) => ({
    atributos: m[1]!,
    texto: texto(m[2]!),
  }));

/** Tabla vertical (un pago): <tr><td>Etiqueta</td><td>Valor</td></tr>. */
function parsearVertical(tabla: string): PagoBanxico {
  const valores: Partial<Record<Campo, string>> = {};
  for (const fila of filas(tabla)) {
    const [etiqueta, valor] = celdas(fila, "td");
    const campo = etiqueta ? campoDeEtiqueta(etiqueta.texto) : null;
    if (campo && valor) valores[campo] = valor.texto;
  }
  return construirPago(valores);
}

/** Tabla horizontal (varios pagos): encabezado en <thead> y una fila por pago. */
function parsearHorizontal(tabla: string): PagoBanxico[] {
  const [encabezado, ...resto] = filas(tabla.match(/<thead\b[\s\S]*?<\/thead>/i)?.[0] ?? "");
  if (!encabezado) return [];
  // "Fecha y hora" ocupa 2 columnas (colspan): Recepción y Procesamiento, que vienen en la 2ª fila.
  const subtitulos = resto.flatMap((f) => celdas(f, "th").map((c) => c.texto));
  const columnas: (Campo | null)[] = [];
  for (const th of celdas(encabezado, "th")) {
    const span = Number(th.atributos.match(/colspan="?(\d+)/i)?.[1] ?? 1);
    if (span > 1) for (let i = 0; i < span; i++) columnas.push(campoDeEtiqueta(subtitulos.shift() ?? ""));
    else columnas.push(campoDeEtiqueta(th.texto));
  }
  const cuerpo = tabla.match(/<tbody\b[\s\S]*?<\/tbody>/i)?.[0] ?? "";
  return filas(cuerpo)
    .map((f) => celdas(f, "td"))
    .filter((tds) => tds.length > 0)
    .map((tds) => {
      const valores: Partial<Record<Campo, string>> = {};
      tds.forEach((td, i) => {
        const campo = columnas[i];
        if (campo) valores[campo] = td.texto;
      });
      return construirPago(valores);
    });
}

export function parsearRespuesta(html: string): RespuestaBanxico {
  // El sitio repite mensajes dentro de comentarios HTML: se quitan antes de analizar.
  const limpio = html.replace(/<!--[\s\S]*?-->/g, "");

  if (limpio.includes('id="#error_div"') || limpio.includes("meta:stats=ERR")) {
    const mensaje = texto(limpio.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? "Error de Banxico");
    const captcha = /imagen de seguridad|c[oó]digo de seguridad/i.test(mensaje) || /name="varHideCaptcha" value="false"/.test(limpio);
    return captcha ? { tipo: "CAPTCHA", mensaje } : { tipo: "ERROR", mensaje };
  }

  if (/descarga\.do\?formato=/i.test(limpio)) return { tipo: "CEP_DISPONIBLE" };

  const tablas = [...limpio.matchAll(/<table\b([^>]*)>([\s\S]*?)<\/table>/gi)].filter((m) => /styled-table/.test(m[1]!));
  if (tablas.length) {
    const pagos = tablas.flatMap(([, atributos, contenido]) =>
      /\bvertical\b/.test(atributos!) ? [parsearVertical(contenido!)] : parsearHorizontal(contenido!),
    );
    if (pagos.length) return { tipo: "PAGOS", pagos };
  }

  if (/Operaci[oó]n no encontrada/i.test(limpio)) {
    const strong = limpio.match(/<strong>([\s\S]*?)<\/strong>/i)?.[1];
    return { tipo: "NO_ENCONTRADO", mensaje: texto(strong ?? "Operación no encontrada") };
  }

  return { tipo: "ERROR", mensaje: "Respuesta de Banxico no reconocida" };
}
