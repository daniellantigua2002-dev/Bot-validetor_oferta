/**
 * Nota del comprobante: el texto que la persona escribe al enviar la foto, sobre todo para dar los
 * datos que no aparecen en la imagen. Palabras clave separadas por coma, en cualquier orden:
 *
 *   ref 2309260, banco BBVA, fecha 09/10/2026
 *
 * Palabras clave: fecha, monto, clave, ref, banco, cuenta. Los datos de la nota tienen prioridad
 * sobre los que se leen de la imagen; si la contradicen, la respuesta lo avisa.
 */
import { formatInTimeZone } from "date-fns-tz";
import { BANCOS, CUENTAS_DESTINO, REGLAS, ZONA_HORARIA, type ClaveBanco } from "../config.js";
import { resolverBanco } from "../normalize/banco.js";
import {
  normalizarClaveRastreo,
  normalizarCuenta,
  normalizarFechaIso,
  normalizarMonto,
  normalizarReferencia,
  referenciaDesdeOperacionMercadoPago,
} from "../normalize/index.js";
import { buscarCuentasDestino } from "../rules/index.js";
import { fechaEnLinea } from "./campos-texto.js";
import type { ResultadoExtraccion } from "./index.js";

export interface DatosNota {
  /** yyyy-MM-dd */
  fecha?: string;
  monto?: number;
  claveRastreo?: string;
  referencia?: string;
  banco?: ClaveBanco;
  /** Dígitos de la cuenta destino (terminación o completa). */
  cuentaDestino?: string;
  /**
   * "cuenta Banorte": se sabe a cuál de nuestras cuentas fue, pero no con qué número. Se prueban todos sus
   * números (tarjeta y CLABE), salvo que la imagen ya muestre uno de esa misma cuenta.
   */
  cuentaBanco?: ClaveBanco;
}

export interface NotaLeida {
  datos: DatosNota;
  /** Lo que se entendió, para mostrarlo ("fecha 09/10/2026"). */
  entendidos: string[];
  /** Partes que no se entendieron, tal como se escribieron. */
  noEntendidos: string[];
}

type Campo = "fecha" | "monto" | "clave" | "ref" | "banco" | "cuenta";

/** Un dato de la nota que no coincide con lo que se leyó en la imagen. */
export interface Diferencia {
  campo: Campo;
  nota: string;
  imagen: string;
}

const PARTE = /^(fecha|monto|clave|referencia|ref|banco|cuenta)\b\s*:?\s*(.*)$/i;
const PESOS = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" });

/** yyyy-MM-dd → dd/MM/yyyy */
const fechaLegible = (iso: string) => iso.split("-").reverse().join("/");

/** "…1871", o el banco si es la CLABE completa de una de nuestras cuentas. */
function cuentaLegible(digitos: string): string {
  const nuestra = CUENTAS_DESTINO.find((c) => c.clabe === digitos);
  if (nuestra) return BANCOS[nuestra.banco].nombre;
  return digitos.length <= 4 ? `…${digitos}` : digitos;
}

/** "09/10/2026", "9-10-26", "9/10" (año actual; si quedaría en el futuro, el anterior) o "9 oct 2026". */
function leerFecha(valor: string, hoy: Date): string | null {
  const m = valor.match(/^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{4}|\d{2}))?$/);
  if (!m) return fechaEnLinea(valor);
  const [dia, mes] = [m[1]!.padStart(2, "0"), m[2]!.padStart(2, "0")];
  const hoyIso = formatInTimeZone(hoy, ZONA_HORARIA, "yyyy-MM-dd");
  if (m[3]) return normalizarFechaIso(`${m[3].length === 2 ? `20${m[3]}` : m[3]}-${mes}-${dia}`);
  const anio = Number(hoyIso.slice(0, 4));
  const esteAnio = normalizarFechaIso(`${anio}-${mes}-${dia}`);
  return esteAnio && esteAnio > hoyIso ? normalizarFechaIso(`${anio - 1}-${mes}-${dia}`) : esteAnio;
}

/** "400", "400.50", "$1,032.50" → número. */
function leerMonto(valor: string): number | null {
  const limpio = valor.replace(/[$\s]/g, "");
  if (!/^(\d{1,3}(,\d{3})+|\d+)(\.\d{1,2})?$/.test(limpio)) return null;
  const monto = Number(limpio.replace(/,/g, ""));
  return monto > 0 ? monto : null;
}

/** Interpreta una parte "palabra valor". Devuelve false si el valor no se entiende. */
function interpretar(campo: Campo, valor: string, nota: NotaLeida, hoy: Date): boolean {
  const { datos, entendidos } = nota;
  switch (campo) {
    case "fecha": {
      const fecha = leerFecha(valor, hoy);
      if (!fecha) return false;
      datos.fecha = fecha;
      entendidos.push(`fecha ${fechaLegible(fecha)}`);
      return true;
    }
    case "monto": {
      const monto = leerMonto(valor);
      if (monto === null) return false;
      datos.monto = monto;
      entendidos.push(`monto ${PESOS.format(monto)}`);
      return true;
    }
    case "clave": {
      const clave = valor.replace(/\s+/g, "");
      if (!/^[A-Za-z0-9-]{6,30}$/.test(clave) || !/\d/.test(clave)) return false;
      datos.claveRastreo = clave;
      entendidos.push(`clave ${clave}`);
      return true;
    }
    case "ref": {
      const referencia = /^[\d\s]+$/.test(valor) ? normalizarReferencia(valor) : null;
      if (!referencia) return false;
      datos.referencia = referencia;
      entendidos.push(`ref ${referencia}`);
      return true;
    }
    case "banco": {
      const banco = resolverBanco(valor);
      if (!banco) return false;
      datos.banco = banco;
      entendidos.push(`banco ${BANCOS[banco].nombre}`);
      return true;
    }
    case "cuenta": {
      // Terminación o número ("1871", "•1871") o el banco de una de nuestras cuentas ("Banorte"). Si se
      // escribe dos veces, vale la última.
      if (/^[\d\s*•·.-]+$/.test(valor)) {
        const digitos = normalizarCuenta(valor);
        if (!digitos || digitos.length < 3) return false;
        datos.cuentaDestino = digitos;
        delete datos.cuentaBanco;
        entendidos.push(`cuenta ${cuentaLegible(digitos)}`);
        return true;
      }
      const banco = resolverBanco(valor);
      if (!banco || !CUENTAS_DESTINO.some((c) => c.banco === banco)) return false;
      datos.cuentaBanco = banco;
      delete datos.cuentaDestino;
      entendidos.push(`cuenta ${BANCOS[banco].nombre}`);
      return true;
    }
  }
}

/** Lee la nota de la foto. null si no hay nota. */
export function leerNota(texto: string | null | undefined, hoy = new Date()): NotaLeida | null {
  if (!texto?.trim()) return null;
  const partes: string[] = [];
  for (const cruda of texto.split(/[,\n]/)) {
    const parte = cruda.trim();
    if (!parte) continue;
    // "monto 1,032.50": la coma de los miles partió el monto en dos.
    const anterior = partes.at(-1);
    if (anterior && /^monto\b.*\d$/i.test(anterior) && /^\d{3}(\.\d{1,2})?$/.test(parte)) {
      partes[partes.length - 1] = `${anterior},${parte}`;
      continue;
    }
    partes.push(parte);
  }

  const nota: NotaLeida = { datos: {}, entendidos: [], noEntendidos: [] };
  for (const parte of partes) {
    const m = parte.match(PARTE);
    let entendida = false;
    if (m) {
      // "referencia" (palabra completa) vale igual que "ref".
      const campo = (m[1]!.toLowerCase() === "referencia" ? "ref" : m[1]!.toLowerCase()) as Campo;
      entendida = interpretar(campo, m[2]!.trim(), nota, hoy);
    }
    if (!entendida) nota.noEntendidos.push(parte);
  }
  return nota;
}

/** ¿Los dígitos de la nota y los de la imagen son la misma cuenta? ("1871" y la tarjeta …1871 de Banorte). */
function mismaCuenta(a: string, b: string): boolean {
  if (a.endsWith(b) || b.endsWith(a)) return true;
  const deA = buscarCuentasDestino(a).map((c) => c.cuenta.clabe);
  return buscarCuentasDestino(b).some((c) => deA.includes(c.cuenta.clabe));
}

/**
 * Pone los datos de la nota sobre los que se leyeron de la imagen (la nota tiene prioridad) y
 * anota los que no coinciden con la imagen para avisarlo. Si ya se aplicó, no hace nada.
 */
export function aplicarNota(extraccion: ResultadoExtraccion, nota: DatosNota): ResultadoExtraccion {
  if (extraccion.notaAplicada) return extraccion;
  const imagen = extraccion.datos;
  const datos = { ...imagen };
  let banco = extraccion.banco;
  const diferencias: Diferencia[] = [];
  let fechaImagen: string | undefined;
  let montoImagen: number | undefined;
  const comparar = (campo: Campo, deNota: string, deImagen: string | null, iguales: (a: string, b: string) => boolean = (a, b) => a === b) => {
    if (deImagen && !iguales(deNota, deImagen)) diferencias.push({ campo, nota: deNota, imagen: deImagen });
  };

  if (nota.fecha) {
    const deImagen = normalizarFechaIso(imagen.fecha);
    comparar("fecha", fechaLegible(nota.fecha), deImagen && fechaLegible(deImagen));
    if (deImagen && deImagen !== nota.fecha) fechaImagen = deImagen;
    datos.fecha = nota.fecha;
  }
  if (nota.monto !== undefined) {
    const deImagen = normalizarMonto(imagen.monto);
    comparar("monto", PESOS.format(nota.monto), deImagen && PESOS.format(Number(deImagen)));
    if (deImagen && deImagen !== normalizarMonto(nota.monto)) montoImagen = imagen.monto!;
    datos.monto = nota.monto;
  }
  if (nota.claveRastreo) {
    comparar("clave", normalizarClaveRastreo(nota.claveRastreo)!, normalizarClaveRastreo(imagen.claveRastreo));
    datos.claveRastreo = nota.claveRastreo;
    if (imagen.esMercadoPago) {
      // La clave escrita manda sobre la "CPO…" que se calcula del número de comprobante; la
      // referencia de sus últimos 7 dígitos se conserva como respaldo.
      datos.referencia ??= referenciaDesdeOperacionMercadoPago(imagen.numeroOperacion);
      datos.numeroOperacion = null;
    }
  }
  if (nota.referencia) {
    comparar("ref", nota.referencia, normalizarReferencia(imagen.referencia));
    datos.referencia = nota.referencia;
  }
  if (nota.cuentaDestino) {
    const deImagen = normalizarCuenta(imagen.cuentaDestino);
    if (deImagen && !mismaCuenta(nota.cuentaDestino, deImagen)) {
      diferencias.push({ campo: "cuenta", nota: cuentaLegible(nota.cuentaDestino), imagen: cuentaLegible(deImagen) });
    }
    datos.cuentaDestino = nota.cuentaDestino;
  }
  if (nota.cuentaBanco) {
    const deImagen = normalizarCuenta(imagen.cuentaDestino);
    const visible = deImagen && deImagen.length >= REGLAS.minDigitosTerminacion ? deImagen : null;
    const deEsaCuenta = !!visible && buscarCuentasDestino(visible).some((c) => c.cuenta.banco === nota.cuentaBanco);
    if (visible && !deEsaCuenta) {
      diferencias.push({ campo: "cuenta", nota: BANCOS[nota.cuentaBanco].nombre, imagen: cuentaLegible(visible) });
    }
    // Un número de esa misma cuenta en la imagen es más preciso que el banco: se conserva. Si no hay, se
    // deduce del banco destino, como cuando el comprobante dice "Banco destino: Banorte" (todos sus números).
    if (!deEsaCuenta) datos.cuentaDestino = null;
    datos.bancoDestino = BANCOS[nota.cuentaBanco].nombre;
  }
  if (nota.banco) {
    if (banco.suficiente && banco.banco) comparar("banco", BANCOS[nota.banco].nombre, BANCOS[banco.banco].nombre);
    banco = { ...banco, banco: nota.banco, nombreLibre: null, suficiente: true, candidatos: [nota.banco], motivo: "indicado en la nota" };
    datos.bancoEmisor = { nombre: BANCOS[nota.banco].nombre, fuente: "texto", confianza: 1 };
  }
  const imagenDistinta = { ...(fechaImagen ? { fechaImagen } : {}), ...(montoImagen !== undefined ? { montoImagen } : {}) };
  return { ...extraccion, datos, banco, notaAplicada: { diferencias, ...imagenDistinta } };
}
