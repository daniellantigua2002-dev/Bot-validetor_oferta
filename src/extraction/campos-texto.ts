/**
 * Extracción de campos con expresiones regulares a partir del texto del OCR (respaldo local).
 *
 * El texto se recorre línea por línea llevando la "sección" actual: origen (cuenta del que paga),
 * destino (cuenta del beneficiario), columnas (Banorte pone "Desde | Para" lado a lado) o neutra.
 * Así no se confunde la cuenta de origen con la de destino, ni el banco destino con el emisor.
 */
import { BANCOS, type ClaveBanco, type DefinicionBanco } from "../config.js";
import { bancoPorFirma, bancosEnLinea, detectarBancoPorClave, normalizarTexto, resolverBanco } from "../normalize/banco.js";
import { claveDesdeOperacionMercadoPago } from "../normalize/index.js";
import { clabeValida } from "../normalize/validadores.js";
import type { DatosExtraidos } from "./schema.js";

type Seccion = "origen" | "destino" | "columnas" | null;

interface Linea {
  texto: string;
  /** Texto normalizado (minúsculas, sin acentos). */
  norm: string;
  seccion: Seccion;
}

// "Desde" u "Origen" al inicio de la línea: Banorte pone "Desde | Para" en dos columnas y BBVA
// "Origen  Cuenta de Ahorro •2929".
const ETIQUETA_ORIGEN =
  /(^desde\b|^origen\b|\b(cuenta (de )?origen|banco origen|cliente origen|ordenante|cuenta de cargo|desde (tu|la) cuenta|numero de cuenta spin|cuenta spin|tu cuenta|remitente)\b)/;
// "para" solo al inicio ("Para: Juan Pérez"); en medio de una frase es demasiado común.
const ETIQUETA_DESTINO =
  /(^para\b|\b(cuenta destino|destino|clabe|beneficiari[oa]|destinatario|tarjeta destino|cuenta receptora|a la cuenta)\b)/;
// "banco" no reinicia la sección: en Klar la línea "Banco BANAMEX" pertenece al destino.
const ETIQUETA_NEUTRA =
  /\b(referencia|concepto|monto|importe|total|fecha|hora|clave de rastreo|folio|estado|estatus|mensaje|motivo|id de movimiento|operacion)\b/;

// Mercado Pago pone las dos cuentas bajo un solo título: primero la de origen y después la de destino.
const ORIGEN_Y_DESTINO = /\borigen y destino\b/;
// Banorte: "Desde  Para" en un renglón y debajo las dos columnas juntas ("Cuenta ****4406 Tarjeta ****8852").
const DESDE_PARA = /^desde para$/;

/** Divide el texto en líneas y asigna a cada una su sección. */
function analizarLineas(texto: string): Linea[] {
  const lineas: Linea[] = [];
  let seccion: Seccion = null;
  // Bajo "Origen y destino", todo es origen hasta pasar la primera cuenta ("CLABE: ****3529").
  let origenHastaLaPrimeraCuenta = false;
  for (const cruda of texto.split(/\r?\n/)) {
    const t = cruda.trim();
    if (!t) continue;
    const norm = normalizarTexto(t);
    if (ORIGEN_Y_DESTINO.test(norm)) {
      seccion = "origen";
      origenHastaLaPrimeraCuenta = true;
    } else if (origenHastaLaPrimeraCuenta) {
      // Las etiquetas no cambian la sección hasta pasar la cuenta de origen.
    } else if (DESDE_PARA.test(norm)) seccion = "columnas";
    else if (seccion === "columnas" && !ETIQUETA_NEUTRA.test(norm)) {
      // En las columnas, "Cuenta ****4008  CLABE ****1946" trae etiquetas de los dos lados: no cambian la sección.
    } else if (ETIQUETA_ORIGEN.test(norm)) seccion = "origen";
    else if (ETIQUETA_DESTINO.test(norm)) seccion = "destino";
    // "Comprobante" solo (Mercado Pago: el número de comprobante) cierra la sección de destino.
    else if (ETIQUETA_NEUTRA.test(norm) || norm === "comprobante") seccion = null;
    lineas.push({ texto: t, norm, seccion });
    if (origenHastaLaPrimeraCuenta && cuentasEnLinea(t).length) {
      seccion = "destino";
      origenHastaLaPrimeraCuenta = false;
    }
  }
  return lineas;
}

/** Valor de una etiqueta: el resto de la misma línea o, si está vacío, la línea siguiente. */
function valorDeEtiqueta(lineas: Linea[], etiqueta: RegExp): { valor: string; indice: number } | null {
  for (let i = 0; i < lineas.length; i++) {
    const m = lineas[i]!.texto.match(etiqueta);
    if (!m) continue;
    const resto = lineas[i]!.texto.slice((m.index ?? 0) + m[0].length).replace(/^[\s:#.-]+/, "").trim();
    if (resto) return { valor: resto, indice: i };
    if (i + 1 < lineas.length) return { valor: lineas[i + 1]!.texto, indice: i + 1 };
  }
  return null;
}

// --- Clave de rastreo -------------------------------------------------------

const TOKEN_CLAVE = /^[A-Za-z0-9-]{6,30}$/;
const CONTINUACION_CLAVE = /^[A-Za-z0-9-]{1,15}$/;
/** BBVA: "MBAN01" + 18 dígitos. */
const LARGO_CLAVE_BBVA = 24;

/** Bancos cuya clave tiene una forma reconocible sin prefijo fijo (Santander, Azteca, BanCoppel…). */
const PATRONES_CLAVE = (Object.values(BANCOS) as DefinicionBanco[]).flatMap((b) => (b.patronClave ? [b.patronClave] : []));

function extraerClaveRastreo(lineas: Linea[]): string | null {
  // "Clave de rastreo", "Clave de rastreo SPEI" o "Tu clave de rastreo es:".
  const etiqueta = valorDeEtiqueta(lineas, /clave\s+de\s+rastreo(\s+spei)?(\s+es\b)?/i);
  if (etiqueta) {
    // Lo que sigue a la clave en el mismo renglón (o un carácter mal leído al final, "…417€") no es parte de ella.
    let clave = etiqueta.valor.match(/^[A-Za-z0-9-]+/)?.[0] ?? "";
    // La clave puede venir partida en dos líneas (Spin: "SPIN-20261008200443959" + "PNEB9").
    const siguiente = lineas[etiqueta.indice + 1]?.texto;
    if (siguiente && CONTINUACION_CLAVE.test(siguiente) && !ETIQUETA_NEUTRA.test(normalizarTexto(siguiente))) {
      if ((clave + siguiente).length <= 30) clave += siguiente;
    }
    if (TOKEN_CLAVE.test(clave)) return clave;
  }

  // Sin etiqueta: tokens con un prefijo conocido (MBAN…, SPIN-…).
  const prefijos = (Object.values(BANCOS) as DefinicionBanco[]).flatMap((b) => b.prefijosClave);
  for (const [i, l] of lineas.entries()) {
    for (const token of l.texto.split(/\s+/)) {
      if (!prefijos.some((p) => token.startsWith(p)) || !TOKEN_CLAVE.test(token)) continue;
      // BBVA en dos columnas: "Clave de  MBAN010026100800" y abajo "rastreo  83280746".
      const resto = lineas[i + 1]?.texto.match(/(\d+)$/)?.[1];
      if (/^mban/i.test(token) && resto && token.length + resto.length === LARGO_CLAVE_BBVA) return token + resto;
      return token;
    }
  }

  // Sin etiqueta ni prefijo: un renglón con la forma de clave de algún banco ("2026100340014BMOVP…").
  for (const l of lineas) {
    const token = l.texto.replace(/\s+/g, "");
    if (PATRONES_CLAVE.some((p) => p.test(token)) && !clabeValida(token)) return token;
  }

  // Klar: la clave es la parte del "Folio" antes de ":".
  const folio = valorDeEtiqueta(lineas, /\bfolio\b/i);
  if (folio?.valor.includes(":")) {
    const antes = folio.valor.split(":")[0]!.trim();
    if (/^[A-Za-z0-9]{15,30}$/.test(antes)) return antes;
  }
  return null;
}

// --- Referencia y número de operación ----------------------------------------

/** Dígitos de la referencia al inicio del valor (puede venir el nombre de la app antes: "SuperMóvil 1234567"). */
const VALOR_REFERENCIA = /^(?:\p{L}+\.?\s+|\D{0,3})(\d{1,7})\b/u;

/**
 * Referencia numérica: "Número de referencia", "Referencia numérica", "Referencia", "Ref." o
 * "Ref. SuperMóvil" (Santander). Si Santander trae "Ref. SuperMóvil" y además "Número de referencia",
 * Banxico usa el número de referencia: por eso se busca primero.
 */
function extraerReferencia(lineas: Linea[]): string | null {
  for (const etiqueta of [
    /(n[uú]mero|no\.?)\s+de\s+referencia|referencia\s+num[eé]rica/i,
    /(n[uú]mero\s+de\s+)?(referencia|\bref\b\.?)(\s+num[eé]rica)?/i,
  ]) {
    const r = valorDeEtiqueta(lineas, etiqueta)?.valor.match(VALOR_REFERENCIA)?.[1];
    if (r) return r;
  }
  // Etiqueta partida en dos columnas (Spin): "Número de   7358003" y abajo "referencia".
  for (let i = 1; i < lineas.length; i++) {
    if (lineas[i]!.norm !== "referencia") continue;
    const digitos = lineas[i - 1]!.texto.match(/\b(\d{4,7})$/)?.[1];
    if (digitos) return digitos;
  }
  return null;
}

function extraerNumeroOperacion(lineas: Linea[]): string | null {
  for (const l of lineas) {
    const m = l.texto.match(/#\s?(\d{6,})\b/);
    if (m) return `#${m[1]}`;
  }
  // Mercado Pago: "Comprobante" y debajo "#182949974794". El OCR suele leer el "#" como un "4"
  // ("4182949974794"); si se equivoca, la referencia (últimos 7 dígitos) no cambia.
  const i = lineas.findIndex((l) => l.norm === "comprobante");
  const numero = i >= 0 ? lineas[i + 1]?.texto.replace(/\s/g, "").match(/^(?:#|4(?=\d{12}$))?(\d{10,13})$/)?.[1] : undefined;
  if (numero) return `#${numero}`;
  const r = valorDeEtiqueta(lineas, /(n[uú]mero\s+de\s+)?operaci[oó]n/i);
  const digitos = r?.valor.match(/\b(\d{6,})\b/)?.[1];
  return digitos ? `#${digitos}` : null;
}

// --- Monto ------------------------------------------------------------------

const MONTO = /-?\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:[.\s](\d{2}))?/;
const MONTO_SIN_SIGNO = /^-?\s?(\d{1,3}(?:,\d{3})+|\d+)\.(\d{2})(?:\s|$)/;
/** Renglones con importes que no son el de la transferencia ("Comisión $0.00"). */
const NO_ES_MONTO = /\b(comision|iva)\b/;

function aNumero(m: RegExpMatchArray): number {
  const enteros = m[1]!.replace(/,/g, "");
  return Number(`${enteros}.${m[2] ?? "00"}`);
}

/** Importe mayor que cero de un renglón (o null). */
function montoEnLinea(l: Linea | undefined): number | null {
  if (!l || NO_ES_MONTO.test(l.norm)) return null;
  const m = l.texto.match(MONTO);
  const monto = m ? aNumero(m) : 0;
  return monto > 0 ? monto : null;
}

function extraerMonto(lineas: Linea[]): number | null {
  // 1) Línea con etiqueta de monto (o la siguiente).
  for (let i = 0; i < lineas.length; i++) {
    if (!/\b(monto( total| transferido)?|importe|cantidad|total)\b/.test(lineas[i]!.norm)) continue;
    const monto = montoEnLinea(lineas[i]) ?? montoEnLinea(lineas[i + 1]);
    if (monto) return monto;
  }
  // 2) El primer importe con signo de pesos (suele ser el principal, en letra grande).
  for (const l of lineas) {
    const monto = montoEnLinea(l);
    if (monto) return monto;
  }
  // 3) Sin signo de pesos (Santander: "-1,300.00 MXN"): un renglón que empieza con un importe con centavos.
  for (const l of lineas) {
    const m = l.texto.match(MONTO_SIN_SIGNO);
    if (m && !NO_ES_MONTO.test(l.norm) && aNumero(m) > 0) return aNumero(m);
  }
  return null;
}

// --- Fecha y hora -------------------------------------------------------------

const MESES: Record<string, number> = {
  ene: 1, enero: 1, feb: 2, febrero: 2, mar: 3, marzo: 3, abr: 4, abril: 4, may: 5, mayo: 5,
  jun: 6, junio: 6, jul: 7, julio: 7, ago: 8, agosto: 8, sep: 9, sept: 9, set: 9, septiembre: 9,
  oct: 10, octubre: 10, nov: 11, noviembre: 11, dic: 12, diciembre: 12,
};

function iso(anio: number, mes: number, dia: number): string | null {
  const f = new Date(Date.UTC(anio, mes - 1, dia));
  if (f.getUTCFullYear() !== anio || f.getUTCMonth() !== mes - 1 || f.getUTCDate() !== dia) return null;
  return `${anio}-${String(mes).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;
}

/** Mes escrito con letras; el OCR a veces lee la "O" como cero ("0ct") o la "l" como uno. */
const mesEscrito = (texto: string | undefined) => (texto ? MESES[texto.replace(/0/g, "o").replace(/1/g, "l")] : undefined);

export function fechaEnLinea(texto: string): string | null {
  const norm = normalizarTexto(texto);
  let m = texto.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (m) return iso(+m[1]!, +m[2]!, +m[3]!);
  m = texto.match(/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})\b/);
  if (m) return iso(+m[3]!, +m[2]!, +m[1]!);
  // "08/Oct/2026", "22 sep 2026", "8 de octubre de 2026"
  m = norm.match(/\b(\d{1,2}) (?:de )?([a-z0-9]{3,10}) (?:de |del )?(\d{4})\b/);
  let mes = mesEscrito(m?.[2]);
  if (m && mes) return iso(+m[3]!, mes, +m[1]!);
  // Año con dos dígitos (Santander): "02/oct/26".
  m = norm.match(/\b(\d{1,2}) ([a-z0-9]{3,10}) (\d{2})\b/);
  mes = mesEscrito(m?.[2]);
  if (m && mes) return iso(2000 + +m[3]!, mes, +m[1]!);
  return null;
}

/**
 * Fecha partida en dos renglones por las columnas (BBVA, "Detalle de movimiento"):
 * "Fecha de  08 octubre" y abajo "operación  2026". Entre el mes y el año puede quedar una palabra.
 */
function fechaEnDosLineas(arriba: string, abajo: string): string | null {
  const m = normalizarTexto(`${arriba} ${abajo}`).match(/\b(\d{1,2}) (?:de )?([a-z0-9]{3,10}) (?:[a-z]+ )?(?:de |del )?(\d{4})\b/);
  const mes = mesEscrito(m?.[2]);
  return m && mes ? iso(+m[3]!, mes, +m[1]!) : null;
}

function horaEnLinea(texto: string): string | null {
  const m = texto.match(/\b(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap])?\.?\s?(m\.?)?/i);
  if (!m) return null;
  let h = Number(m[1]);
  const sufijo = m[4] && m[5] ? m[4].toLowerCase() : null;
  if (sufijo === "p" && h < 12) h += 12;
  if (sufijo === "a" && h === 12) h = 0;
  if (h > 23 || Number(m[2]) > 59) return null;
  return `${String(h).padStart(2, "0")}:${m[2]}${m[3] ? `:${m[3]}` : ""}`;
}

/** La primera fecha del texto y la hora de esa misma línea (o de las dos siguientes). */
function extraerFechaHora(lineas: Linea[]): { fecha: string | null; hora: string | null } {
  const conHora = (i: number, fecha: string) => {
    // Se quita la fecha para que "08/10/2026" no se lea como hora.
    for (const j of [i, i + 1, i + 2]) {
      const texto = lineas[j]?.texto.replace(/\d{1,4}[/.-]\d{1,2}[/.-]\d{2,4}/g, " ");
      const hora = texto ? horaEnLinea(texto) : null;
      if (hora) return { fecha, hora };
    }
    return { fecha, hora: null };
  };
  for (let i = 0; i < lineas.length; i++) {
    const fecha = fechaEnLinea(lineas[i]!.texto);
    if (fecha) return conHora(i, fecha);
  }
  for (let i = 0; i + 1 < lineas.length; i++) {
    const fecha = fechaEnDosLineas(lineas[i]!.texto, lineas[i + 1]!.texto);
    if (fecha) return conHora(i, fecha);
  }
  return { fecha: null, hora: null };
}

// --- Cuenta destino ------------------------------------------------------------

/**
 * Cuenta enmascarada: "****5884", "xx5884", "•1871" (BBVA pone un solo punto) y lo que el OCR hace con
 * las máscaras: "*+**41871", "*=\"1946", ":4191" o "-:1871". Si quedan más de 4 dígitos, la máscara
 * se leyó como dígito y la terminación son los últimos 4.
 */
const ENMASCARADA = /(?:[*•·+"=]+|[xX]{2,}|(?<=\s|^)-?[:.;](?=\d{4}\b))\s?(\d{3,6})\b/g;
const GRUPO_DIGITOS = /\b\d[\d ]{8,24}\d\b/g;
const LONGITUDES_CUENTA = new Set([10, 16, 18]); // celular, tarjeta, CLABE
/** Renglón que es solo una terminación ("1871", "•1871"): el OCR a veces se come el punto. */
const SOLO_TERMINACION = /^[*•·.\s]*(\d{3,4})$/;
/** Etiquetas cuyo valor nunca es la cuenta destino, aunque tenga 10 dígitos como un celular. */
const ETIQUETA_NO_CUENTA = /\b(referencia|folio|operacion|autorizacion|rastreo|movimiento)\b/;
const TIENE_LETRAS = /\p{L}/u;

/** Cuentas de un renglón, en orden de aparición. */
function cuentasEnLinea(texto: string): string[] {
  const encontradas: { indice: number; cuenta: string }[] = [];
  for (const m of texto.matchAll(ENMASCARADA)) {
    const digitos = m[1]!;
    encontradas.push({ indice: m.index ?? 0, cuenta: digitos.length > 4 ? digitos.slice(-4) : digitos });
  }
  for (const g of texto.matchAll(GRUPO_DIGITOS)) {
    const d = g[0].replace(/ /g, "");
    if (LONGITUDES_CUENTA.has(d.length)) encontradas.push({ indice: g.index ?? 0, cuenta: d });
  }
  return encontradas.sort((a, b) => a.indice - b.indice).map((e) => e.cuenta);
}

function extraerCuentaDestino(lineas: Linea[]): string | null {
  // Primero en la sección destino, luego en las columnas "Desde | Para" (la de la derecha) y al final
  // fuera de secciones. Nunca en la sección origen.
  for (const seccion of ["destino", "columnas", null] as const) {
    for (const [i, l] of lineas.entries()) {
      if (l.seccion !== seccion) continue;
      if (ETIQUETA_NO_CUENTA.test(l.norm)) continue;
      // El valor de "Folio de la operación" va en el renglón siguiente (BBVA: "0555577886").
      const anterior = lineas[i - 1];
      if (anterior && ETIQUETA_NO_CUENTA.test(anterior.norm) && !TIENE_LETRAS.test(l.texto)) continue;
      const cuentas = cuentasEnLinea(l.texto);
      // En dos columnas, la de la derecha ("Para") es el destino.
      if (cuentas.length) return seccion === "columnas" ? cuentas.at(-1)! : cuentas[0]!;
      if (seccion === "destino") {
        const terminacion = l.texto.match(SOLO_TERMINACION)?.[1];
        if (terminacion) return terminacion;
      }
    }
  }
  return null;
}

// --- Beneficiario ---------------------------------------------------------------

function extraerBeneficiario(lineas: Linea[]): string | null {
  const r = valorDeEtiqueta(lineas, /\b(beneficiario|destinatario|nombre del beneficiario|titular)\b/i);
  const nombre = r?.valor.match(/^[\p{L} .]{3,}$/u)?.[0];
  if (nombre) return nombre.trim();
  // Spin: "a Nicolas Alejandro Josid" debajo del monto.
  for (const l of lineas) {
    const m = l.texto.match(/^a\s+(\p{Lu}[\p{L}]+(?:\s+\p{Lu}[\p{L}]+){1,5})$/u);
    if (m) return m[1]!;
  }
  return null;
}

// --- Bancos emisor y destino por texto ----------------------------------------------

/**
 * En las columnas "Desde | Para" el OCR junta los dos lados en un renglón; si un nombre se cortó con
 * "...", lo de la izquierda es el origen y lo de la derecha el destino. Un renglón que es solo el
 * nombre de un banco ("INBURSA") es la columna de la derecha.
 */
function ladosDeColumnas(texto: string): { origen: string; destino: string } {
  const partes = texto.split(/\.{2,}|…/);
  if (partes.length > 1) return { origen: partes.slice(0, -1).join(" "), destino: partes.at(-1)!.trim() };
  return resolverBanco(texto) ? { origen: "", destino: texto } : { origen: texto, destino: "" };
}

/**
 * Bancos del lado destino, en orden: los de la sección destino, los de la columna "Para" y los de
 * los renglones con un número de cuenta fuera del origen ("BANORTE - TDD **1871").
 */
function bancosDestino(lineas: Linea[]): ClaveBanco[] {
  const destino: ClaveBanco[] = [];
  const agregar = (texto: string) => {
    for (const banco of bancosEnLinea(texto)) if (!destino.includes(banco)) destino.push(banco);
  };
  for (const l of lineas) {
    if (l.seccion === "columnas") {
      const derecha = ladosDeColumnas(l.texto).destino;
      if (resolverBanco(derecha)) agregar(derecha);
    } else if (l.seccion === "destino" || (l.seccion !== "origen" && cuentasEnLinea(l.texto).length)) {
      agregar(l.texto);
    }
  }
  return destino;
}

/**
 * Banco emisor según las palabras del texto. Se ignoran las menciones del lado destino. Se prefieren
 * las menciones de la sección origen (la cuenta de origen es del banco emisor).
 */
export function bancoEmisorPorTexto(texto: string): ClaveBanco | null {
  const lineas = analizarLineas(texto);

  // El banco que aparece junto a la cuenta destino ("BANORTE - TDD **1871") es el destino, y se
  // descarta en todo el comprobante: Santander, por ejemplo, repite "Banco: BANORTE" bajo la
  // cuenta de origen. Si emisor y destino fueran el mismo banco, el logo (modelo) lo indicará.
  const destino = new Set(bancosDestino(lineas));

  const candidatos: { banco: ClaveBanco; prioridad: number }[] = [];
  lineas.forEach((l, i) => {
    let texto = l.texto;
    if (l.seccion === "columnas") texto = ladosDeColumnas(l.texto).origen;
    else if (l.seccion === "destino" || (l.seccion !== "origen" && cuentasEnLinea(l.texto).length)) return;
    for (const banco of bancosEnLinea(texto)) {
      // La columna "Desde" es el origen aunque el mismo banco también sea el destino (Banorte → Banorte).
      if (!destino.has(banco) || l.seccion === "columnas") candidatos.push({ banco, prioridad: (l.seccion === "origen" || l.seccion === "columnas" ? 0 : 1000) + i });
    }
  });
  candidatos.sort((a, b) => a.prioridad - b.prioridad);
  return candidatos[0]?.banco ?? null;
}

// --- Extracción completa -----------------------------------------------------------

const PALABRAS_COMPROBANTE =
  /\b(transferencia|spei|enviaste|comprobante|operacion exitosa|clave de rastreo|referencia|pago|envio|traspaso)\b/;

/** Convierte el texto del OCR en el mismo JSON que devuelve el modelo de visión. */
export function extraerDeTexto(texto: string): DatosExtraidos {
  const lineas = analizarLineas(texto);
  const referencia = extraerReferencia(lineas);
  const numeroOperacion = extraerNumeroOperacion(lineas);
  const monto = extraerMonto(lineas);
  const { fecha, hora } = extraerFechaHora(lineas);

  const porTexto = bancoEmisorPorTexto(texto);
  const esMercadoPago =
    porTexto === "MERCADO_PAGO" || lineas.some((l) => bancosEnLinea(l.texto).includes("MERCADO_PAGO"));
  // Mercado Pago no imprime la clave: es "CPO" + el número de comprobante.
  const claveRastreo = extraerClaveRastreo(lineas) ?? (esMercadoPago ? claveDesdeOperacionMercadoPago(numeroOperacion) : null);
  const porClave = detectarBancoPorClave(claveRastreo);
  const porFirma = bancoPorFirma(texto);
  const banco = porTexto ?? porClave ?? porFirma;
  const destino = bancosDestino(lineas)[0] ?? null;

  const pareceComprobante = PALABRAS_COMPROBANTE.test(normalizarTexto(texto));
  // Sin monto (el OCR no siempre lo ve) sigue siendo comprobante si trae con qué buscarlo en Banxico:
  // así la respuesta es "falta el monto" (y se puede escribir en la nota) y no "no es un comprobante".
  const identificador = claveRastreo !== null || referencia !== null || numeroOperacion !== null;
  return {
    esComprobante:
      (monto !== null && (claveRastreo !== null || referencia !== null || pareceComprobante)) || (identificador && pareceComprobante),
    descripcionVisual: "Extracción por OCR local, sin análisis visual.",
    bancoEmisor: {
      nombre: banco ? BANCOS[banco].nombre : null,
      fuente: porTexto ? "texto" : porClave ? "clave_rastreo" : porFirma ? "logo" : "desconocido",
      confianza: banco ? 0.5 : 0,
    },
    esMercadoPago,
    cuentaDestino: extraerCuentaDestino(lineas),
    bancoDestino: destino ? BANCOS[destino].nombre : null,
    claveRastreo,
    referencia,
    numeroOperacion,
    fecha,
    hora,
    monto,
    beneficiario: extraerBeneficiario(lineas),
  };
}
