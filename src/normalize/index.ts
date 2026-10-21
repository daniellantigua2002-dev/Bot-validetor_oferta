/**
 * Normalización de los datos extraídos: clave de rastreo, monto, fecha, cuenta, referencia y banco.
 */
import { formatInTimeZone } from "date-fns-tz";
import { BANCOS, ZONA_HORARIA, type ClaveBanco, type DefinicionBanco } from "../config.js";
import type { DatosExtraidos } from "../extraction/schema.js";
import type { DatosNormalizados } from "../types.js";
import { normalizarTexto } from "./banco.js";

export { bancosEnLinea, detectarBancoPorClave, normalizarTexto, resolverBanco } from "./banco.js";
export { clabeValida, tarjetaValida } from "./validadores.js";

/**
 * Clave de rastreo tal como la acepta Banxico.
 * - Sin espacios ni saltos de línea (las claves partidas en dos líneas se unen).
 * - NO se pasa a mayúsculas: Banxico distingue mayúsculas (Klar usa "27SsrAVom…").
 * - BBVA: después de "MBAN" siempre va un cero, así que "MBANO…" (letra O) se corrige a "MBAN0…".
 * - Algo de menos de 8 caracteres no es una clave (las claves reales tienen 15 o más): es otra cosa
 *   leída por error, como las iniciales del contacto ("GR").
 */
export function normalizarClaveRastreo(clave: string | null | undefined): string | null {
  if (!clave) return null;
  let limpia = clave.replace(/\s+/g, "");
  if (/^mban[o0]/i.test(limpia)) limpia = `MBAN0${limpia.slice(5)}`;
  // BanCoppel: "…TRANSBPI…"; el OCR lee la I como 1 o l.
  limpia = limpia.replace(/^(\d{8})TRANSBP[1l](\d{8})$/, "$1TRANSBPI$2");
  return limpia.length >= LARGO_MINIMO_CLAVE ? limpia : null;
}

const LARGO_MINIMO_CLAVE = 8;

/** yyyy-MM-dd → la fecha con el formato de la referencia habitual (aaMMdd, ddMMaa o ddMMaa0). */
function referenciaDeFecha(fechaIso: string, formato: "aaMMdd" | "ddMMaa" | "ddMMaa0"): string {
  const [anio, mes, dia] = fechaIso.split("-") as [string, string, string];
  const aa = anio.slice(2);
  if (formato === "aaMMdd") return `${aa}${mes}${dia}`;
  return formato === "ddMMaa" ? `${dia}${mes}${aa}` : `${dia}${mes}${aa}0`;
}

/**
 * Referencias aprendidas de pagos validados (las de tipo "semanal"): la del banco para un pago de esa
 * fecha (null = sin fecha: hoy). `rango` 0 = la más repetida en la última semana, 1 = la segunda, etc.;
 * null si no se conoce ninguna en ese puesto.
 */
export type ConsultaReferencias = (banco: ClaveBanco, fechaIso: string | null, rango?: number) => string | null;

/**
 * Referencia que la app del banco pone sola (BANCOS[…].referenciaHabitual), para buscar en Banxico
 * un comprobante que no muestra ninguna. `cuenta`: el número de nuestra cuenta que se va a consultar.
 */
export function referenciaHabitual(
  banco: ClaveBanco | null,
  fechaIso: string,
  cuenta: string,
  aprendidas?: ConsultaReferencias,
): string | null {
  const habitual = banco ? (BANCOS[banco] as DefinicionBanco).referenciaHabitual : undefined;
  switch (habitual?.tipo) {
    case "semanal":
      return aprendidas?.(banco!, fechaIso) ?? null;
    case "fija":
      return habitual.valor;
    case "fecha":
      return referenciaDeFecha(fechaIso, habitual.formato);
    case "cuentaDestino":
      return cuenta.slice(-7);
    default:
      return null;
  }
}

/** ¿Se puede buscar con la referencia habitual del banco? Las "semanal", solo si ya se aprendió una. */
export function tieneReferenciaHabitual(banco: ClaveBanco | null, aprendidas?: ConsultaReferencias, fechaIso: string | null = null): boolean {
  const habitual = banco ? (BANCOS[banco] as DefinicionBanco).referenciaHabitual : undefined;
  if (habitual?.tipo === "semanal") return !!aprendidas?.(banco!, fechaIso);
  return habitual !== undefined;
}

/**
 * La 2ª referencia semanal más repetida en los últimos 7 días, para una consulta extra (solo BBVA y
 * similares, de tipo "semanal"). null si el banco no cambia su referencia por semana o si no hay una 2ª.
 */
export function referenciaSemanalSecundaria(banco: ClaveBanco | null, fechaIso: string, aprendidas?: ConsultaReferencias): string | null {
  const habitual = banco ? (BANCOS[banco] as DefinicionBanco).referenciaHabitual : undefined;
  if (habitual?.tipo !== "semanal") return null;
  return aprendidas?.(banco!, fechaIso, 1) ?? null;
}

/** Dígitos del número de comprobante de Mercado Pago ("#182949974794"), si tiene al menos 7. */
function digitosComprobante(numeroOperacion: string | null | undefined): string | null {
  const digitos = numeroOperacion?.replace(/\D/g, "") ?? "";
  return digitos.length >= 7 ? digitos : null;
}

/**
 * Mercado Pago: la clave de rastreo es "CPO" más el número de comprobante
 * ("#182949974794" → "CPO182949974794"). Es lo primero que se prueba en Banxico.
 */
export function claveDesdeOperacionMercadoPago(numeroOperacion: string | null | undefined): string | null {
  const digitos = digitosComprobante(numeroOperacion);
  return digitos ? `CPO${digitos}` : null;
}

/**
 * Mercado Pago: si el comprobante no trae referencia, la referencia son los últimos 7 dígitos del
 * número de comprobante ("#182949974794" → "9974794"). Se prueba si la clave no aparece.
 */
export function referenciaDesdeOperacionMercadoPago(numeroOperacion: string | null | undefined): string | null {
  return digitosComprobante(numeroOperacion)?.slice(-7) ?? null;
}

/** Monto con 2 decimales y sin separadores: 1032 → "1032.00". */
export function normalizarMonto(monto: number | null | undefined): string | null {
  if (monto === null || monto === undefined || !Number.isFinite(monto) || monto <= 0) return null;
  return (Math.round(Math.abs(monto) * 100) / 100).toFixed(2);
}

/** Fecha ISO válida (yyyy-MM-dd) o null. */
export function normalizarFechaIso(fecha: string | null | undefined): string | null {
  const m = fecha?.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const [anio, mes, dia] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const f = new Date(Date.UTC(anio, mes - 1, dia));
  if (f.getUTCFullYear() !== anio || f.getUTCMonth() !== mes - 1 || f.getUTCDate() !== dia) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** yyyy-MM-dd → dd-MM-yyyy (formato de Banxico). */
export function fechaParaBanxico(fechaIso: string): string {
  const [anio, mes, dia] = fechaIso.split("-");
  return `${dia}-${mes}-${anio}`;
}

/** yyyy-MM-dd más (o menos) los días indicados. */
export function sumarDias(fechaIso: string, dias: number): string {
  const [a, m, d] = fechaIso.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(a, m - 1, d + dias)).toISOString().slice(0, 10);
}

/** yyyy-MM-dd → dd/MM/yyyy. */
export const fechaLegible = (fechaIso: string) => fechaIso.split("-").reverse().join("/");

/**
 * Fechas revisadas en palabras, para el mensaje: "el 02/10/2026", "del 30/09 al 04/10/2026" (días
 * seguidos) o "el 30/09, 02/10 y 15/10/2026".
 */
export function describirFechas(fechasIso: readonly string[]): string {
  const fechas = [...new Set(fechasIso)].sort();
  if (fechas.length === 0) return "";
  const ultima = fechas.at(-1)!;
  if (fechas.length === 1) return `el ${fechaLegible(ultima)}`;
  const mismoAnio = fechas[0]!.slice(0, 4) === ultima.slice(0, 4);
  const corta = (f: string) => (mismoAnio ? fechaLegible(f).slice(0, 5) : fechaLegible(f));
  const seguidas = fechas.every((f, i) => i === 0 || sumarDias(fechas[i - 1]!, 1) === f);
  if (seguidas) return `del ${corta(fechas[0]!)} al ${fechaLegible(ultima)}`;
  return `el ${fechas.slice(0, -1).map(corta).join(", ")} y ${fechaLegible(ultima)}`;
}

/**
 * Fecha del pago que lleva la clave de rastreo (BANCOS[…].fechaEnClave), o null si el banco no la
 * pone o la clave no tiene esa forma. Spin la lleva en UTC: se pasa a la fecha de CDMX.
 */
export function fechaDesdeClave(banco: ClaveBanco | null, clave: string | null): string | null {
  const definicion = banco ? (BANCOS[banco] as DefinicionBanco).fechaEnClave : undefined;
  const valor = clave && definicion?.patron.exec(clave)?.[1];
  if (!definicion || !valor) return null;
  if (definicion.formato === "aaMMdd") return normalizarFechaIso(`20${valor.slice(0, 2)}-${valor.slice(2, 4)}-${valor.slice(4, 6)}`);
  if (definicion.formato === "ddMMyyyy") return normalizarFechaIso(`${valor.slice(4, 8)}-${valor.slice(2, 4)}-${valor.slice(0, 2)}`);
  const fecha = normalizarFechaIso(`${valor.slice(0, 4)}-${valor.slice(4, 6)}-${valor.slice(6, 8)}`);
  if (!fecha || definicion.formato === "aaaaMMdd") return fecha;
  const momento = new Date(`${fecha}T${valor.slice(8, 10)}:${valor.slice(10, 12)}:${valor.slice(12, 14)}Z`);
  return Number.isNaN(momento.getTime()) ? null : formatInTimeZone(momento, ZONA_HORARIA, "yyyy-MM-dd");
}

/** Hora en 24 h con segundos: "16:52" → "16:52:00". */
export function normalizarHora(hora: string | null | undefined): string | null {
  const m = hora?.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return `${m[1]!.padStart(2, "0")}:${m[2]}:${m[3] ?? "00"}`;
}

/** Solo los dígitos de la cuenta (sin espacios, guiones ni asteriscos). */
export function normalizarCuenta(cuenta: string | null | undefined): string | null {
  const digitos = cuenta?.replace(/\D/g, "") ?? "";
  return digitos || null;
}

/** Referencia numérica de hasta 7 dígitos (límite de Banxico). */
export function normalizarReferencia(referencia: string | null | undefined): string | null {
  const digitos = referencia?.replace(/\D/g, "") ?? "";
  return digitos.length >= 1 && digitos.length <= 7 ? digitos : null;
}

/**
 * Normaliza todos los campos. En Mercado Pago la clave "CPO" + número de comprobante va primero
 * (Banxico prueba la clave antes que la referencia); la referencia que trae el comprobante tiene
 * prioridad sobre la de los últimos 7 dígitos.
 */
export function normalizarDatos(datos: DatosExtraidos): DatosNormalizados {
  const claveComprobante = normalizarClaveRastreo(datos.claveRastreo);
  const claveMercadoPago = datos.esMercadoPago ? claveDesdeOperacionMercadoPago(datos.numeroOperacion) : null;
  const referenciaComprobante = normalizarReferencia(datos.referencia);
  const referenciaMercadoPago = datos.esMercadoPago ? referenciaDesdeOperacionMercadoPago(datos.numeroOperacion) : null;
  const fecha = normalizarFechaIso(datos.fecha);
  return {
    claveRastreo: claveMercadoPago ?? claveComprobante,
    origenClave: claveMercadoPago ? "mercado_pago" : claveComprobante ? "comprobante" : null,
    referencia: referenciaComprobante ?? referenciaMercadoPago,
    origenReferencia: referenciaComprobante ? "comprobante" : referenciaMercadoPago ? "mercado_pago" : null,
    monto: normalizarMonto(datos.monto),
    fecha,
    fechaBanxico: fecha ? fechaParaBanxico(fecha) : null,
    hora: normalizarHora(datos.hora),
    cuentaDestino: normalizarCuenta(datos.cuentaDestino),
  };
}

// --- Banco → nombre exacto del catálogo de Banxico ----------------------------------

export type Institucion = { codigo: string; nombre: string };
export type CatalogoInstituciones = readonly (readonly [string, string])[];

/**
 * Busca un banco de BANCOS en el catálogo de una fecha concreta. Prueba su nombre vigente y luego
 * los históricos (ej. Nu: "NUBANK" en 2026, "NU MEXICO" en 2024).
 */
export function institucionDeBanco(banco: ClaveBanco, catalogo: CatalogoInstituciones): Institucion | null {
  for (const nombre of BANCOS[banco].catalogo as readonly string[]) {
    const fila = catalogo.find(([, n]) => n === nombre);
    if (fila) return { codigo: fila[0], nombre: fila[1] };
  }
  return null;
}

const PALABRAS_VACIAS = new Set(["banco", "bank", "de", "del", "la", "el", "mexico", "s", "a", "sa", "cv", "ib", "institucion", "banca", "multiple"]);
const palabrasSignificativas = (texto: string) =>
  new Set(normalizarTexto(texto).split(" ").filter((p) => p && !PALABRAS_VACIAS.has(p)));

/**
 * Busca un nombre libre (banco fuera del mapa) en el catálogo: coincidencia exacta normalizada o
 * mismas palabras significativas ("Banco Multiva" ↔ "MULTIVA BANCO"). Solo si el resultado es único.
 */
export function institucionPorNombre(nombre: string, catalogo: CatalogoInstituciones): Institucion | null {
  const norm = normalizarTexto(nombre);
  const exacta = catalogo.find(([, n]) => normalizarTexto(n) === norm);
  if (exacta) return { codigo: exacta[0], nombre: exacta[1] };

  const buscadas = palabrasSignificativas(nombre);
  if (buscadas.size === 0) return null;
  const candidatas = catalogo.filter(([, n]) => {
    const propias = palabrasSignificativas(n);
    if (propias.size === 0) return false;
    const contiene = (a: Set<string>, b: Set<string>) => [...b].every((p) => a.has(p));
    return contiene(buscadas, propias) || contiene(propias, buscadas);
  });
  return candidatas.length === 1 ? { codigo: candidatas[0]![0], nombre: candidatas[0]![1] } : null;
}
