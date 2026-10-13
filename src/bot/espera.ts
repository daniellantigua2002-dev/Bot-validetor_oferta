/**
 * Comprobantes que se vuelven a revisar solos, en vez de responder de inmediato que no se encontró:
 * - RECIENTE: el pago es de hace pocos minutos y Banxico todavía no lo publica (los bancos avisan que
 *   tarda hasta 5 o 10 minutos, y el 12-oct BanCoppel lo envió 9 minutos tarde). Se busca otra vez a los 5 y
 *   a los 10 minutos (solo hoy) y a los 15 (en todas las fechas).
 * - BANXICO: Banxico no respondió (o pidió captcha). El vigía (vigia.ts) lo revisa con una sola petición
 *   cada 3 minutos para todos los que esperan; cuando responde, vuelven a la cola. Como mucho 1 hora.
 */
import type { ResultadoValidacion } from "../pipeline.js";
import { esPagoReciente } from "../rules/index.js";

// Viven en las reglas porque la búsqueda también los usa (un pago de hace minutos se busca solo hoy).
export { esPagoReciente, minutosDesdeElPago, MINUTOS_PAGO_RECIENTE } from "../rules/index.js";

export type MotivoEspera = "RECIENTE" | "BANXICO";

/** Estado de un comprobante que espera para volver a revisarse (se guarda con él en data/cola.json). */
export interface Espera {
  motivo: MotivoEspera;
  /** Reintentos ya programados por este motivo. */
  reintentos: number;
  /** Desde cuándo espera (epoch ms). */
  desde: number;
  /** Cuándo toca el siguiente intento (epoch ms). */
  proxima: number;
}

export const ESPERA_PAGO_RECIENTE_MS = 5 * 60_000;
/** 3 desde el 13-oct (antes 2): el BanCoppel del 12-oct (18:11) llegó a Banxico a las 18:21 y a las 18:23 aún no salía. */
export const MAX_REINTENTOS_RECIENTE = 3;
export const ESPERA_BANXICO_MS = 3 * 60_000;
export const MAX_ESPERA_BANXICO_MS = 60 * 60_000;
/**
 * Al revisar otra vez un pago de hace minutos basta con la fecha más probable (hoy); la última revisión
 * (MAX_REINTENTOS_RECIENTE) busca en todas las fechas, por si la fecha estaba mal leída.
 */
export const FECHAS_AL_REINTENTAR_RECIENTE = 1;

/**
 * ¿Hay que volver a revisar el comprobante solo? Devuelve la siguiente espera o null (responder ya).
 * `previa`: la espera con la que se hizo este intento, si es un reintento.
 */
export function decidirEspera(
  r: Pick<ResultadoValidacion, "codigo" | "normalizados">,
  previa: Espera | undefined,
  ahora: Date,
): Espera | null {
  const momento = ahora.getTime();
  // FECHA_FUTURA también: un BBVA de noche (fecha de mañana) que no aparece ahora responde "valida mañana" (13-oct),
  // pero si el pago es de hace minutos se sigue revisando solo, como antes.
  if (r.codigo === "NO_ENCONTRADO" || r.codigo === "COMPROBANTE_NOCTURNO" || r.codigo === "FECHA_FUTURA") {
    // Lo "reciente" se decide en el primer intento; después se completan los reintentos.
    const sigue = previa?.motivo === "RECIENTE" ? previa.reintentos < MAX_REINTENTOS_RECIENTE : !previa && !!r.normalizados && esPagoReciente(r.normalizados, ahora);
    if (!sigue) return null;
    const reintentos = (previa?.motivo === "RECIENTE" ? previa.reintentos : 0) + 1;
    return { motivo: "RECIENTE", reintentos, desde: previa?.desde ?? momento, proxima: momento + ESPERA_PAGO_RECIENTE_MS };
  }
  if (r.codigo === "BANXICO_NO_DISPONIBLE") {
    const desde = previa?.motivo === "BANXICO" ? previa.desde : momento;
    if (momento - desde >= MAX_ESPERA_BANXICO_MS) return null;
    const reintentos = (previa?.motivo === "BANXICO" ? previa.reintentos : 0) + 1;
    return { motivo: "BANXICO", reintentos, desde, proxima: momento + ESPERA_BANXICO_MS };
  }
  return null;
}
