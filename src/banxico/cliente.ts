/**
 * Cliente HTTP del CEP de Banxico (docs/banxico-cep.md).
 * Cada petición va sin cookies, es decir, con una sesión nueva: tras ciertas consultas Banxico
 * exige captcha dentro de la misma sesión.
 */
import { BANXICO } from "../config.js";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";

/** Datos de una consulta a valida.do. */
export interface ConsultaBanxico {
  tipoCriterio: "T" | "R";
  /** dd-MM-yyyy */
  fecha: string;
  criterio: string;
  emisor: { codigo: string; nombre: string };
  receptor: { codigo: string; nombre: string };
  cuenta: string;
  /** "400.00" */
  monto: string;
  /** 0 = Consultar Pago (tabla con estado), 1 = Descargar CEP. */
  tipoConsulta: 0 | 1;
}

/** Banxico no respondió (red o 5xx) tras los reintentos. */
export class ErrorRedBanxico extends Error {
  constructor(mensaje: string, readonly causa?: unknown) {
    super(mensaje);
    this.name = "ErrorRedBanxico";
  }
}

export type Fetch = typeof fetch;

export interface OpcionesHttp {
  fetch?: Fetch;
  reintentos?: number;
  timeoutMs?: number;
  /** Espera entre reintentos (se inyecta en los tests). */
  esperar?: (ms: number) => Promise<void>;
  /**
   * Se espera antes de cada intento, también de los reintentos: el turno global de Banxico (pausa entre
   * peticiones y enfriamiento tras un captcha, ver ritmo.ts). Sin él, no se espera.
   */
  turno?: () => Promise<void>;
}

export const esperar = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Petición con timeout y reintentos con espera creciente ante errores de red o 5xx. */
export async function peticion(url: string, init: RequestInit, opciones: OpcionesHttp = {}): Promise<Response> {
  const {
    fetch: f = fetch,
    reintentos = BANXICO.reintentosRed,
    timeoutMs = BANXICO.timeoutMs,
    esperar: dormir = esperar,
    turno,
  } = opciones;
  let ultimo: unknown;
  for (let intento = 1; intento <= reintentos; intento++) {
    await turno?.();
    try {
      const r = await f(url, {
        ...init,
        headers: { "User-Agent": USER_AGENT, Referer: BANXICO.urlBase, ...init.headers },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (r.status < 500) return r;
      ultimo = new Error(`HTTP ${r.status}`);
    } catch (e) {
      ultimo = e;
    }
    if (intento < reintentos) await dormir(2000 * intento);
  }
  throw new ErrorRedBanxico(`Banxico no respondió tras ${reintentos} intentos: ${(ultimo as Error)?.message ?? ultimo}`, ultimo);
}

/** Campos del formulario tal como los envía el sitio. "Pago a banco" siempre desmarcado. */
export function formularioConsulta(c: ConsultaBanxico): URLSearchParams {
  return new URLSearchParams({
    tipoCriterio: c.tipoCriterio,
    fecha: c.fecha,
    criterio: c.criterio,
    emisor: c.emisor.codigo,
    receptor: c.receptor.codigo,
    cuenta: c.cuenta,
    receptorParticipante: "0",
    monto: c.monto,
    captcha: "c",
    tipoConsulta: String(c.tipoConsulta),
  });
}

function postValida(c: ConsultaBanxico, opciones: OpcionesHttp): Promise<Response> {
  return peticion(
    new URL("valida.do", BANXICO.urlBase).href,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
      },
      body: formularioConsulta(c),
    },
    opciones,
  );
}

/** POST valida.do. Devuelve el HTML de la respuesta. */
export async function consultarValida(c: ConsultaBanxico, opciones: OpcionesHttp = {}): Promise<string> {
  const r = await postValida(c, opciones);
  if (!r.ok) throw new Error(`valida.do respondió HTTP ${r.status}`);
  return r.text();
}

