/**
 * Estrategia de búsqueda en Banxico.
 *
 * Qué se prueba:
 *   1. Fechas (fechasAIntentar): la del comprobante y REGLAS.diasAlrededor días antes y después, más las
 *      otras fechas posibles (la de la imagen si la nota trae otra, la del OCR, la de la clave de rastreo)
 *      con sus días alrededor; hoy en CDMX, sin duplicados ni fechas futuras. Sin fecha: hoy y los N días
 *      anteriores. Fecha posterior a hoy: los N días anteriores a ella que ya pasaron. BBVA de noche:
 *      primero el día anterior.
 *   2. Criterio: clave de rastreo y, si no aparece, número de referencia (la del comprobante o, si no
 *      trae, la que la app del banco pone sola: BANCOS[…].referenciaHabitual).
 *   3. Cuenta (cuentasAIntentar): si se vio en el comprobante, solo ese número. Si no se vio (se dedujo
 *      del banco o la eligió la persona): todos sus números.
 *
 * En qué orden, para encontrar pronto lo más probable y caber en el tiempo máximo de la cola:
 *   a. la fecha más probable, completa;
 *   b. con clave, en las demás fechas primero la clave sola (sin cuenta ni monto): ¿existe ese día? Si no
 *      existe, la consulta completa tampoco lo encontraría y no se hace; si existe, se busca con nuestras
 *      cuentas y, si no aparece, el comprobante tiene alterado el monto o la cuenta;
 *      sin clave, en las demás fechas la consulta más probable y después las demás cuentas;
 *   c. la referencia (por si la clave se leyó mal) en las demás fechas solo si la fecha o la clave son
 *      dudosas (ver fechasConReferencia): que estén mal las dos a la vez es muy raro.
 * Si se acaba el tiempo (EntradaBusqueda.limite), termina con lo revisado en lugar de quedar a medias.
 * Si Banxico pide captcha no se insiste: se avisa al ritmo global (enfriamiento) y termina como
 * BANXICO_NO_DISPONIBLE, para revisar el comprobante solo más tarde.
 *
 * Cada consulta es "Consultar Pago" con cuenta y monto: Banxico solo devuelve el pago si ambos
 * coinciden (y filtra por cada uno por separado, lo que permite la detección temprana).
 * El pago se aprueba si está LIQUIDADO y el monto devuelto es el del comprobante.
 */
import { formatInTimeZone } from "date-fns-tz";
import { join } from "node:path";
import { BANCOS, BANXICO, REGLAS, ZONA_HORARIA, type DefinicionBanco } from "../config.js";
import {
  describirFechas,
  detectarBancoPorClave,
  fechaDesdeClave,
  fechaLegible,
  fechaParaBanxico,
  referenciaHabitual,
  referenciaSemanalSecundaria,
  sumarDias,
  tieneReferenciaHabitual,
  type ConsultaReferencias,
  type Institucion,
} from "../normalize/index.js";
import { esFechaPosterior, esNocturno, imprimeFechaSiguienteDeNoche, MENSAJES, mensajeDuplicado } from "../rules/index.js";
import type { RegistroUsado } from "../storage/usados.js";
import type {
  BancoEmisor,
  CoincidenciaCuenta,
  CriterioBusqueda,
  DatosNormalizados,
  EstadoPago,
  IntentoBanxico,
  PagoBanxico,
  TipoCuenta,
} from "../types.js";
import { Catalogos, institucionEmisora, institucionReceptora, type CatalogoBanxico } from "./catalogo.js";
import { consultarValida, esperar, ErrorRedBanxico, type ConsultaBanxico } from "./cliente.js";
import { parsearRespuesta, type RespuestaBanxico } from "./parser.js";
import { RITMO, turnoBanxico } from "./ritmo.js";

/** Tolerancia para elegir entre varios pagos idénticos por la hora del comprobante. */
const TOLERANCIA_HORA_MIN = 15;

export const NOMBRE_ESTADO: Record<EstadoPago, string> = {
  LIQUIDADO: "Liquidado",
  EN_PROCESO: "En proceso",
  DEVUELTO: "Devuelto",
  EN_PROCESO_DEVOLUCION: "En proceso de devolución",
  CANCELADO: "Cancelado",
  RECHAZADO: "Rechazado",
  NO_LIQUIDADO: "No liquidado",
  RETORNADO: "Retornado",
  NO_ENCONTRADO: "No encontrado",
  ERROR: "Desconocido",
};

// --- Plan de intentos ------------------------------------------------------------------

/** Un intento concreto: fecha, criterio y cuenta. */
export interface PasoPlan {
  /** dd-MM-yyyy */
  fecha: string;
  criterio: CriterioBusqueda;
  valor: string;
  cuenta: string;
  tipoCuenta: TipoCuenta;
}

export { esFechaPosterior, esNocturno, imprimeFechaSiguienteDeNoche };

/** Fechas como máximo en una búsqueda (con varias fechas posibles, las más probables primero). */
const MAX_FECHAS = 8;

/**
 * No se empieza una consulta que no alcance a terminar antes del tiempo máximo (la pausa entre
 * consultas más este margen para la consulta misma): la búsqueda termina con lo que ya revisó.
 */
export const MARGEN_LIMITE_MS = 15_000;

export interface OpcionesFechas {
  /** Comprobante de noche (desde REGLAS.horaInicioNocturno). */
  nocturno?: boolean;
  /**
   * BBVA de noche: el comprobante puede traer la fecha de operación, la del día siguiente, y Banxico
   * lo registra con la del día del pago. "antes": primero D−1 y después D; "despues": primero D y
   * después D−1 (cuando la hora no deja claro cuál es).
   */
  diaAnterior?: "antes" | "despues" | null;
  /** Otras fechas posibles del pago: la de la imagen si la nota trae otra, la del OCR, la de la clave. */
  alternativas?: readonly (string | null | undefined)[];
}

/**
 * Fechas ISO a consultar, las más probables primero, sin repetir, nunca futuras y como máximo MAX_FECHAS:
 * - Con fecha: la del comprobante y REGLAS.diasAlrededor días antes y después (D, D−1, D+1, D−2, D+2).
 *   Las otras fechas posibles van justo después de la del comprobante y luego todas con sus días alrededor.
 * - Comprobante nocturno: Banxico puede registrarlo con la fecha del día siguiente, así que D+1 va justo
 *   después de D. Si es de hoy, D+1 sería futura: solo se prueba hoy.
 * - BBVA de noche (diaAnterior): primero D−1 y D, en el orden indicado.
 * - Sin fecha: alrededor de las otras fechas posibles (la de la clave) y luego hoy y los
 *   REGLAS.diasHaciaAtras días anteriores.
 * - Fecha posterior a hoy (mal leída, o el reloj del celular): de hoy hacia atrás hasta REGLAS.diasHaciaAtras
 *   días antes de esa fecha (12-oct con hoy 10 → 10 y 9). Si ninguno de esos días ya pasó, la fecha está
 *   mal leída: de hoy hacia atrás, como sin fecha.
 */
export function fechasAIntentar(fecha: string | null, ahora: Date, opciones: OpcionesFechas = {}): string[] {
  const { nocturno = false, diaAnterior = null } = opciones;
  const hoy = formatInTimeZone(ahora, ZONA_HORARIA, "yyyy-MM-dd");
  const plan: string[] = [];
  const agregar = (...fechas: string[]) => {
    for (const f of fechas) if (f <= hoy && !plan.includes(f)) plan.push(f);
  };
  /** Cada fecha y luego sus vecinas: un día antes y uno después de cada una, después dos… */
  const alrededorDe = (centros: string[]) => {
    agregar(...centros);
    for (let d = 1; d <= REGLAS.diasAlrededor; d++) for (const c of centros) agregar(sumarDias(c, -d), sumarDias(c, d));
  };
  /** De hoy hacia atrás hasta `desde` (incluido). */
  const deHoyHasta = (desde: string) => {
    for (let f = hoy; f >= desde; f = sumarDias(f, -1)) agregar(f);
  };
  const otras = [...new Set(opciones.alternativas)].filter((f): f is string => !!f && f !== fecha && f <= hoy);

  if (!fecha) {
    alrededorDe(otras);
    deHoyHasta(sumarDias(hoy, -REGLAS.diasHaciaAtras));
  } else if (esFechaPosterior(fecha, hoy, diaAnterior !== null)) {
    const desde = sumarDias(fecha, -REGLAS.diasHaciaAtras);
    deHoyHasta(desde <= hoy ? desde : sumarDias(hoy, -REGLAS.diasHaciaAtras));
    alrededorDe(otras);
  } else if (nocturno && !diaAnterior && fecha === hoy) {
    agregar(hoy);
    alrededorDe(otras);
  } else {
    const anterior = sumarDias(fecha, -1);
    if (diaAnterior) agregar(...(diaAnterior === "antes" ? [anterior, fecha] : [fecha, anterior]));
    else agregar(fecha, ...(nocturno ? [sumarDias(fecha, 1)] : []));
    alrededorDe([fecha, ...otras]);
  }
  return plan.slice(0, MAX_FECHAS);
}

/**
 * Si no se vio la cuenta, todos sus números, el número de cuenta al final. 13-oct: el usuario confirma que un pago
 * también puede ir al número de cuenta, en los 4 bancos; y Banxico acepta consultar con uno de 7, 10 u 11 dígitos
 * (responde "Operación no encontrada" normal, sin error: prueba del 13-oct).
 */
const ORDEN_CUENTA_DEDUCIDA: TipoCuenta[] = ["tarjeta", "clabe", "cuenta"];

/**
 * Números de nuestra cuenta a consultar (regla del usuario, 11-oct: si se tiene la cuenta, solo esa; si solo
 * se sabe el banco, todos sus números; 13-oct: un pago puede ir a la tarjeta, a la CLABE o al número de cuenta):
 * - la cuenta se vio en el comprobante: ese número. En los comprobantes reales, Banxico siempre tuvo el número que
 *   se veía (tarjeta → tarjeta, CLABE → CLABE, cuenta → cuenta: 12-oct, …3306 → 1000473306). Si se ve el número de
 *   cuenta, también su CLABE, después;
 * - no se vio (se dedujo del banco o la eligió la persona): todos sus números (tarjeta, CLABE y número de cuenta),
 *   empezando por el de la coincidencia. Inbursa no tiene tarjeta: CLABE y cuenta.
 */
export function cuentasAIntentar(c: CoincidenciaCuenta, deducida = false): [string, TipoCuenta][] {
  const numeros = c.cuenta as Partial<Record<TipoCuenta, string>>;
  const tipos: TipoCuenta[] = deducida
    ? [...(c.tipo === "cuenta" ? [] : [c.tipo]), ...ORDEN_CUENTA_DEDUCIDA]
    : c.tipo === "cuenta"
      ? ["cuenta", "clabe"]
      : [c.tipo];
  const lista: [string, TipoCuenta][] = [];
  for (const tipo of tipos) {
    const numero = tipo === c.tipo ? c.numero : numeros[tipo];
    if (numero && !lista.some(([n]) => n === numero)) lista.push([numero, tipo]);
  }
  return lista;
}

/**
 * ¿La clave de rastreo pudo cortarse o leerse mal? Entonces la referencia se busca en todas las fechas.
 * - Mercado Pago: la clave no se lee, se arma con el número de comprobante ("CPO" + número).
 * - Su banco tiene un largo conocido de clave (BANCOS[…].largosClave) y esta mide otra cosa: la imagen
 *   la cortó, o al leerla sobraron o faltaron caracteres.
 */
export function claveDudosa(n: Pick<DatosNormalizados, "claveRastreo" | "origenClave">, banco: BancoEmisor): boolean {
  if (!n.claveRastreo) return false;
  if (n.origenClave === "mercado_pago") return true;
  const largos = banco.clave ? (BANCOS[banco.clave] as DefinicionBanco).largosClave : undefined;
  return !!largos && !largos.includes(n.claveRastreo.length);
}

/**
 * ¿La clave leída es más corta que las de su banco? (BBVA: 24 caracteres; "MBAN010026101300585519" mide 22.) Suele
 * ser la imagen que la cortó. Cuántos caracteres se leyeron y cuántos tiene la clave del banco, o null.
 */
export function claveCortada(n: Pick<DatosNormalizados, "claveRastreo" | "origenClave">, banco: BancoEmisor): { leidos: number; largo: number } | null {
  if (!n.claveRastreo || n.origenClave !== "comprobante") return null;
  const largos = banco.clave ? (BANCOS[banco.clave] as DefinicionBanco).largosClave : undefined;
  if (!largos?.length) return null;
  const largo = Math.min(...largos);
  return n.claveRastreo.length < largo ? { leidos: n.claveRastreo.length, largo } : null;
}

/** Identifica una consulta concreta (para no repetirla). */
export const claveDeConsulta = (c: ConsultaBanxico) =>
  [c.fecha, c.tipoCriterio, c.criterio, c.cuenta, c.monto, c.emisor.codigo, c.receptor.codigo].join("|");


// --- Elección del pago entre los que devuelve Banxico ------------------------------------

type Eleccion =
  | { tipo: "uno"; pago: PagoBanxico }
  | { tipo: "ninguno"; motivo: string }
  | { tipo: "varios"; cantidad: number }
  /** El pago existe, pero su clave ya se validó antes. */
  | { tipo: "usado"; pago: PagoBanxico; registro: RegistroUsado };

const segundosDelDia = (hora: string) => {
  const [h, m, s] = hora.split(":").map(Number) as [number, number, number?];
  return h * 3600 + m * 60 + (s ?? 0);
};

/** Pliega las confusiones típicas de lectura (O/0, I/l/1) y las mayúsculas, solo para comparar. */
const plegarClave = (clave: string) => clave.toUpperCase().replace(/O/g, "0").replace(/[IL]/g, "1");

/** Distancia de edición (Levenshtein) entre dos claves ya plegadas. */
export function distanciaClaves(a: string, b: string): number {
  const x = plegarClave(a);
  const y = plegarClave(b);
  let previa = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const actual = [i];
    for (let j = 1; j <= y.length; j++) {
      actual[j] = Math.min(previa[j]! + 1, actual[j - 1]! + 1, previa[j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1));
    }
    previa = actual;
  }
  return previa[y.length]!;
}

/** Diferencias toleradas entre la clave del comprobante y la de Banxico (errores de lectura, no otra clave). */
const MAX_DIFERENCIAS_CLAVE = 2;
/** Largo mínimo de una clave cortada (imagen recortada) para aceptarla como el inicio de la de Banxico. */
const MIN_LARGO_CLAVE_CORTADA = 16;

/**
 * Como distanciaClaves, pero si la clave del comprobante es el inicio de la de Banxico (la imagen la
 * cortó: "MBAN0100261009008941" de "MBAN01002610090089417907"), cuenta como coincidencia.
 */
function distanciaConRecorte(banxico: string, comprobante: string): number {
  const cortada = comprobante.length >= MIN_LARGO_CLAVE_CORTADA && plegarClave(banxico).startsWith(plegarClave(comprobante));
  return cortada ? 0 : distanciaClaves(banxico, comprobante);
}

/**
 * Elige el pago entre los que devuelve Banxico. La clave de rastreo es única por pago:
 * - Si el comprobante trae clave, solo vale el pago con esa clave (exacta o casi, por errores de lectura).
 *   Una clave distinta es otro pago, aunque coincidan referencia, monto y cuenta.
 * - Si el comprobante no trae clave, cualquier pago aún no usado sirve: se registra su clave
 *   real de Banxico y así ese pago no se puede validar dos veces.
 */
export function elegirPago(
  pagos: readonly PagoBanxico[],
  n: DatosNormalizados,
  paso: PasoPlan,
  usados: ReadonlyMap<string, RegistroUsado>,
): Eleccion {
  const candidatos = pagos.filter(
    (p) => p.monto === n.monto && (!p.cuentaBeneficiaria || p.cuentaBeneficiaria === paso.cuenta),
  );
  if (candidatos.length === 0) return { tipo: "ninguno", motivo: "los pagos devueltos no coinciden en monto o cuenta" };

  const verificarUso = (pago: PagoBanxico): Eleccion => {
    const registro = pago.claveRastreo ? usados.get(pago.claveRastreo) : undefined;
    return registro ? { tipo: "usado", pago, registro } : { tipo: "uno", pago };
  };

  if (n.claveRastreo) {
    const clave = n.claveRastreo;
    const exacto = candidatos.find((p) => p.claveRastreo === clave);
    if (exacto) return verificarUso(exacto);
    const similares = candidatos
      .map((p) => ({ p, d: p.claveRastreo ? distanciaConRecorte(p.claveRastreo, clave) : Infinity }))
      .filter((x) => x.d <= MAX_DIFERENCIAS_CLAVE)
      .sort((a, b) => a.d - b.d);
    if (similares.length === 1 || (similares.length > 1 && similares[0]!.d < similares[1]!.d)) {
      return verificarUso(similares[0]!.p);
    }
    if (similares.length > 1) return { tipo: "varios", cantidad: similares.length };
    return { tipo: "ninguno", motivo: "ningún pago de Banxico tiene la clave de rastreo del comprobante" };
  }

  // Sin clave en el comprobante: pagos aún no usados, el más cercano a la hora si se conoce.
  const libres = candidatos.filter((p) => !p.claveRastreo || !usados.has(p.claveRastreo));
  if (libres.length === 0) return verificarUso(candidatos[0]!);
  if (libres.length > 1 && n.hora) {
    const objetivo = segundosDelDia(n.hora);
    // El celular puede estar en otra zona horaria (una hora antes o después que CDMX).
    const cercano = libres
      .map((p) => {
        const hora = p.fechaRecepcion?.split(" ")[1];
        if (!hora) return { p, diff: Infinity };
        const diff = Math.abs(segundosDelDia(hora) - objetivo);
        return { p, diff: Math.min(diff, Math.abs(diff - 3600)) };
      })
      .filter((x) => x.diff <= TOLERANCIA_HORA_MIN * 60)
      .sort((a, b) => a.diff - b.diff)[0];
    if (cercano) return { tipo: "uno", pago: cercano.p };
  }
  return { tipo: "uno", pago: libres[0]! };
}

// --- Búsqueda ----------------------------------------------------------------------------

export type EstadoBusqueda =
  | "VALIDADO"
  | "NO_LIQUIDADO"
  | "NO_ENCONTRADO"
  | "DUPLICADO"
  /** Detección temprana: la clave existe en Banxico pero con otro monto. */
  | "MONTO_NO_COINCIDE"
  /** Detección temprana: la clave existe en Banxico pero el pago fue a otra cuenta. */
  | "CUENTA_INCORRECTA"
  /** Comprobante nocturno de hoy que todavía no aparece con la fecha de hoy. */
  | "COMPROBANTE_NOCTURNO"
  /** La fecha del comprobante es posterior a hoy y el pago no aparece en los días anteriores que ya pasaron. */
  | "FECHA_FUTURA"
  | "BANXICO_NO_DISPONIBLE";

export interface ResultadoBusqueda {
  estado: EstadoBusqueda;
  mensaje: string;
  intentos: IntentoBanxico[];
  pago?: PagoBanxico;
  /** La combinación de datos que funcionó (para reproducirla en la captura). */
  consulta?: ConsultaBanxico;
  /** Registro previo cuando el pago encontrado ya se había validado. */
  duplicado?: RegistroUsado;
  /** HTML de la respuesta de Banxico con el pago encontrado (validado o devuelto), para dibujar la captura. */
  html?: string;
  /** Consultas hechas a Banxico (ver claveDeConsulta). */
  consultadas?: string[];
  /** Fechas (yyyy-MM-dd) en las que se consultó Banxico, en orden. */
  fechasRevisadas?: string[];
  /** La clave del comprobante no existe en Banxico en ninguna de las fechas revisadas. */
  claveInexistente?: boolean;
  /** Se cortó antes de terminar porque se acababa el tiempo máximo. */
  incompleta?: boolean;
  /** Detección temprana (MONTO_NO_COINCIDE, CUENTA_INCORRECTA): fecha (yyyy-MM-dd) en la que Banxico tiene la clave. */
  fechaClave?: string;
  /** La clave leída es más corta que las de su banco (ver claveCortada): el mensaje ya pide la captura completa. */
  claveCortada?: boolean;
}

export interface DependenciasBusqueda {
  consultar: (c: ConsultaBanxico) => Promise<string>;
  catalogos: { obtener(fecha: string): Promise<CatalogoBanxico> };
  esperar: (ms: number) => Promise<void>;
  /** Reloj en epoch ms, para el tiempo máximo (por defecto Date.now). */
  reloj?: () => number;
  /** Milisegundos que faltan del enfriamiento por captcha (ver ritmo.ts): mientras dure no se consulta. */
  enfriamiento?: () => number;
  /** Banxico pidió captcha: empieza el enfriamiento global. */
  alCaptcha?: (origen: string) => void;
}

export interface EntradaBusqueda {
  normalizados: DatosNormalizados;
  coincidencia: CoincidenciaCuenta;
  bancoEmisor: BancoEmisor;
  /** Comprobantes ya validados: la clave real de Banxico no se puede usar dos veces. */
  usados?: readonly RegistroUsado[];
  ahora?: Date;
  /** Avisa de cada consulta (para mostrar el progreso). */
  alIntentar?: (intento: IntentoBanxico, numero: number) => void;
  /** Ruta rápida: hacer solo la primera consulta (fecha del comprobante, clave, cuenta y monto). */
  soloPrimerIntento?: boolean;
  /** Consultas ya hechas sin resultado (ruta rápida): no se repiten. */
  yaConsultadas?: ReadonlySet<string>;
  /** Cancelación: si se aborta, no se hace ninguna consulta más (se lanza el motivo). */
  signal?: AbortSignal;
  /**
   * La cuenta destino no se vio en el comprobante (se dedujo del banco destino o de la referencia,
   * o la eligió la persona): se prueban todos sus números.
   */
  cuentaDeducida?: boolean;
  /** Referencias aprendidas de pagos validados (BBVA, que cambia la suya según la semana). */
  referenciasAprendidas?: ConsultaReferencias;
  /** Probar solo las primeras N fechas del plan (al probar varios bancos posibles, o al reintentar). */
  maxFechas?: number;
  /** Otras fechas posibles del pago: la de la imagen si la nota trae otra, la del OCR si no coincide con la de la IA. */
  fechasAlternativas?: readonly string[];
  /** Hasta cuándo (epoch ms) se puede consultar: no se empieza una consulta que no alcance a terminar. */
  limite?: number;
  /**
   * Solo con la clave de rastreo, sin la referencia (si el comprobante trae clave): para probar rápido
   * varias de nuestras cuentas, o un monto distinto en la fecha en que ya se sabe que existe la clave.
   */
  soloClave?: boolean;
  /** Fecha (yyyy-MM-dd) en la que ya se sabe que Banxico tiene la clave: ahí no se vuelve a preguntar. */
  claveExisteEn?: string;
  /**
   * La clave leída no aparece en el texto del OCR: la IA pudo tomar otro dato por la clave (12-oct: el folio de un
   * comprobante de Plata, que no trae clave). Si además Banxico dice que esa clave no existe ese día, el pago que
   * trae la referencia se elige como en un comprobante sin clave (ver intentar).
   */
  claveSinRespaldo?: boolean;
}

/**
 * Catálogos compartidos entre validaciones: en memoria mientras viva el proceso y, los de días pasados,
 * en disco. Cada petición respeta el turno global.
 */
export const CATALOGOS = new Catalogos({ turno: turnoBanxico }, { carpeta: join(BANXICO.carpetaDisco, "catalogos") });

const DEPENDENCIAS: DependenciasBusqueda = {
  consultar: (c) => consultarValida(c, { turno: turnoBanxico }),
  catalogos: CATALOGOS,
  esperar,
  enfriamiento: () => RITMO.enfriamiento(),
  alCaptcha: (origen) => RITMO.registrarCaptcha(origen),
};

/** Lo que se le dice a la persona mientras Banxico pide captcha. */
const TEXTO_LIMITANDO = "Banxico está limitando las consultas (pide captcha); intenta de nuevo en unos minutos.";

/** Estados de un pago que el banco regresó (el dinero no llegó). */
const DEVUELTOS: ReadonlySet<EstadoPago> = new Set(["DEVUELTO", "EN_PROCESO_DEVOLUCION", "RETORNADO"]);

/** El principio del texto de una página (sin etiquetas), para anotar en la consola qué mandó Banxico. */
const inicioDelTexto = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || "(vacía)";

export interface SaludBanxico {
  ok: boolean;
  /** Por qué no responde. */
  motivo?: string;
}

/**
 * Revisión liviana de Banxico mientras hay comprobantes esperándolo: UNA petición, el catálogo de hoy pedido
 * en ese momento (respeta el turno global y su enfriamiento). Dice si responde y si activó el captcha en el
 * sitio. Así no reintenta cada comprobante por su cuenta.
 */
export async function revisarBanxico(
  opciones: { ahora?: Date; catalogos?: Pick<Catalogos, "vivo">; alCaptcha?: (origen: string) => void } = {},
): Promise<SaludBanxico> {
  const { ahora = new Date(), catalogos = CATALOGOS, alCaptcha = (origen) => RITMO.registrarCaptcha(origen) } = opciones;
  try {
    const catalogo = await catalogos.vivo(fechaParaBanxico(formatInTimeZone(ahora, ZONA_HORARIA, "yyyy-MM-dd")));
    if (!catalogo.overrideCaptcha) {
      alCaptcha("revisión de Banxico");
      return { ok: false, motivo: "activó el captcha en el sitio" };
    }
    return catalogo.instituciones.length ? { ok: true } : { ok: false, motivo: "el catálogo llegó vacío" };
  } catch (e) {
    return { ok: false, motivo: (e as Error).message };
  }
}

const PESOS = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" });

/** Una consulta terminó la búsqueda (validado, devuelto, duplicado, Banxico caído…). */
type Fin = { fin: ResultadoBusqueda };

/** Criterios en orden: la clave, la referencia del comprobante o, si no trae, la habitual del banco. */
type Criterio = "CLAVE" | "REFERENCIA" | "HABITUAL";
/** Un número de nuestra cuenta y de qué tipo es. */
type NumeroCuenta = [string, TipoCuenta];
/** Lo necesario para consultar una fecha: sus instituciones en el catálogo de Banxico de ese día. */
interface Contexto {
  /** dd-MM-yyyy */
  fecha: string;
  emisor: Institucion;
  receptor: Institucion;
  nombres: { emisor: string; receptor: string };
}

/** dd-MM-yyyy → yyyy-MM-dd */
const isoDesdeBanxico = (fecha: string) => fecha.split("-").reverse().join("-");

/**
 * Busca el pago en Banxico.
 *
 * Detección temprana: si la clave no aparece con nuestra cuenta y el monto, se consulta la clave sola
 * en esa fecha. Si existe, el comprobante tiene alterado el monto o la cuenta, y una consulta más con
 * solo el monto dice cuál de los dos. Si no existe, no se pierde tiempo probando la misma clave con
 * otras cuentas, y si no existe en ninguna fecha el mensaje lo dice.
 */
export async function buscarEnBanxico(
  entrada: EntradaBusqueda,
  deps: DependenciasBusqueda = DEPENDENCIAS,
): Promise<ResultadoBusqueda> {
  const consultadas: string[] = [];
  const resultado = await buscar(entrada, deps, consultadas);
  return { ...resultado, consultadas };
}

async function buscar(entrada: EntradaBusqueda, deps: DependenciasBusqueda, consultadas: string[]): Promise<ResultadoBusqueda> {
  const { normalizados: n, coincidencia, bancoEmisor } = entrada;
  const monto = n.monto!;
  const usados = new Map((entrada.usados ?? []).filter((r) => r.claveRastreo).map((r) => [r.claveRastreo!, r]));
  const intentos: IntentoBanxico[] = [];
  const registrar = (intento: IntentoBanxico) => {
    intentos.push(intento);
    entrada.alIntentar?.(intento, intentos.length);
  };
  const noDisponible = (mensaje: string): Fin => ({ fin: { estado: "BANXICO_NO_DISPONIBLE", mensaje, intentos } });
  const reloj = deps.reloj ?? Date.now;
  // Banxico se está enfriando después de un captcha: no se le pide nada (ni el catálogo).
  if ((deps.enfriamiento?.() ?? 0) > 0) return noDisponible(TEXTO_LIMITANDO).fin;

  // Criterios en orden: la clave, la referencia del comprobante o, si no trae, la que pone sola la app
  // del banco (BANCOS[…].referenciaHabitual; puede depender de la fecha y de la cuenta consultada).
  const criterios: Criterio[] = [];
  if (n.claveRastreo) criterios.push("CLAVE");
  if (!(entrada.soloClave && n.claveRastreo)) {
    if (n.referencia) criterios.push("REFERENCIA");
    else if (tieneReferenciaHabitual(bancoEmisor.clave, entrada.referenciasAprendidas, n.fecha)) criterios.push("HABITUAL");
  }
  if (criterios.length === 0) throw new Error("Sin clave de rastreo ni referencia no se puede buscar en Banxico");
  const valorCriterio = (criterio: Criterio, fechaIso: string, cuenta: string): [CriterioBusqueda, string | null] =>
    criterio === "CLAVE"
      ? ["CLAVE_RASTREO", n.claveRastreo]
      : ["REFERENCIA", criterio === "REFERENCIA" ? n.referencia : referenciaHabitual(bancoEmisor.clave, fechaIso, cuenta, entrada.referenciasAprendidas)];
  const cuentas: NumeroCuenta[] = cuentasAIntentar(coincidencia, entrada.cuentaDeducida);
  const [primerCriterio, ...otrosCriterios] = criterios as [Criterio, ...Criterio[]];
  const [primeraCuenta, ...otrasCuentas] = cuentas as [NumeroCuenta, ...NumeroCuenta[]];

  const ahora = entrada.ahora ?? new Date();
  const hoy = formatInTimeZone(ahora, ZONA_HORARIA, "yyyy-MM-dd");
  const nocturno = esNocturno(n.hora);
  // BBVA de noche: desde REGLAS.horaDiaAnteriorPrimero se prueba primero el día anterior; antes, después.
  const fechaSiguiente = imprimeFechaSiguienteDeNoche(bancoEmisor, n.hora);
  const diaAnterior = !fechaSiguiente ? null : n.hora! >= REGLAS.horaDiaAnteriorPrimero ? "antes" : "despues";
  const posterior = esFechaPosterior(n.fecha, hoy, fechaSiguiente);
  // Fecha posterior a hoy sin ninguno de sus días anteriores ya pasado: está mal leída.
  const malLeida = posterior && sumarDias(n.fecha!, -REGLAS.diasHaciaAtras) > hoy;
  const alternativas = [...(entrada.fechasAlternativas ?? []), fechaDesdeClave(bancoEmisor.clave, n.claveRastreo)];
  const fechas = fechasAIntentar(n.fecha, ahora, { nocturno, diaAnterior, alternativas }).slice(0, entrada.maxFechas);
  // La referencia encuentra el pago si la clave se leyó mal. En una fecha vecina solo haría falta si además
  // la fecha estuviera mal, así que ahí se omite, salvo que la fecha o la clave sean dudosas (sin fecha,
  // fecha posterior a hoy, claveDudosa). Siempre va en la fecha principal, en las otras fechas leídas
  // (nota, OCR) y, de noche, en los dos días posibles.
  const referenciaEnTodas = !n.fecha || posterior || claveDudosa(n, bancoEmisor);
  const fechasConReferencia = new Set<string | undefined>(
    referenciaEnTodas ? fechas : [fechas[0], ...(diaAnterior || nocturno ? [fechas[1]] : []), ...(entrada.fechasAlternativas ?? [])],
  );

  let consultasHechas = 0;
  let huboVarios = false;
  let ultimoHtml = "";
  /** Fechas (yyyy-MM-dd) en las que se consultó, en orden. */
  const revisadas: string[] = [];
  const anotarRevisada = (fecha: string) => {
    const iso = isoDesdeBanxico(fecha);
    if (!revisadas.includes(iso)) revisadas.push(iso);
  };
  /** Por fecha: ¿existe la clave del comprobante ese día? (consulta con la clave sola; null = no se sabe). */
  const claveEnFecha = new Map<string, boolean | null>();

  /** No se encontró: el mensaje dice qué fechas se revisaron y, si se sabe, por qué no aparece. */
  function sinEncontrar(incompleta = false): ResultadoBusqueda {
    const total = intentos.filter((i) => i.resultado !== "OMITIDO").length;
    const busque = revisadas.length ? `busqué ${describirFechas(revisadas)} (${total} consultas)` : "no se pudo consultar ninguna fecha";
    const cortada = claveCortada(n, bancoEmisor);
    const base = { intentos, fechasRevisadas: [...revisadas], ...(incompleta ? { incompleta } : {}), ...(cortada ? { claveCortada: true } : {}) };
    const corte = incompleta ? " Se acabó el tiempo antes de revisar todas las combinaciones." : "";
    // Clave cortada por la imagen (pedido del usuario, 13-oct): se dice al final, cuando tampoco apareció con la referencia.
    const conReferencia = intentos.some((i) => i.criterio === "REFERENCIA" && i.resultado !== "OMITIDO");
    const avisoCortada = cortada
      ? ` La clave de rastreo está incompleta: se leen ${cortada.leidos} de sus ${cortada.largo} caracteres (puede estar cortada en la imagen)` +
        `${conReferencia ? " y con la referencia tampoco apareció" : ""}. Envía la captura completa o escribe la clave completa en la nota.`
      : "";
    // Fecha de mañana (BBVA de noche la imprime así): después de las consultas normales, "valida mañana" (pedido del
    // usuario, 13-oct). Va antes que la de 1 o 2 días: también es una fecha posterior a hoy.
    if (n.fecha && n.fecha === sumarDias(hoy, 1)) {
      const mensaje = `${MENSAJES.FECHA_MANANA}: la fecha del comprobante (${fechaLegible(n.fecha)}) es la de mañana y el pago todavía no aparece en Banxico; ${busque}.${avisoCortada}${corte}`;
      return { estado: "FECHA_FUTURA", mensaje, ...base };
    }
    if (posterior && !malLeida) {
      const mensaje = `${MENSAJES.FECHA_FUTURA}: la fecha del comprobante (${fechaLegible(n.fecha!)}) es posterior a hoy y el pago todavía no aparece en Banxico; ${busque}.${avisoCortada}`;
      return { estado: "FECHA_FUTURA", mensaje, ...base };
    }
    if (nocturno && n.fecha === hoy && !fechaSiguiente) {
      // Pago de hoy, de noche, que todavía no aparece: ya no se dice "valídalo mañana" (Banxico lo registra con la fecha
      // del día del pago; el 12-oct BanCoppel 18:11 y STP 18:07 aparecieron así), sino que vuelva a enviarlo en un rato.
      const mensaje = `${MENSAJES.COMPROBANTE_NOCTURNO} ${busque.charAt(0).toUpperCase()}${busque.slice(1)}.${avisoCortada}${corte}`;
      return { estado: "COMPROBANTE_NOCTURNO", mensaje, ...base };
    }
    // Con la clave cortada no se dice "Banxico no tiene ningún pago con la clave": el aviso explica por qué no aparece.
    const claveInexistente = !cortada && !!n.claveRastreo && !incompleta && revisadas.length > 0 && revisadas.every((f) => claveEnFecha.get(f) === false);
    const motivo = claveInexistente
      ? `Banxico no tiene ningún pago con la clave de rastreo ${n.claveRastreo}: ${busque}.`
      : `No se encontró el pago en Banxico: ${busque}.`;
    const fecha = malLeida ? ` La fecha del comprobante (${fechaLegible(n.fecha!)}) es posterior a hoy: puede estar mal leída.` : "";
    const varios = huboVarios
      ? " Varios pagos tienen una clave de rastreo parecida a la del comprobante; revisa que la clave se lea completa."
      : "";
    return { estado: "NO_ENCONTRADO", mensaje: `${motivo}${fecha}${varios}${avisoCortada}${corte}`, ...base, ...(claveInexistente ? { claveInexistente } : {}) };
  }

  /** ¿Banxico se está enfriando después de un captcha? Mientras dure no se le consulta. */
  const enEnfriamiento = () => (deps.enfriamiento?.() ?? 0) > 0;

  /**
   * Una consulta a valida.do con pausa previa. Si Banxico pide captcha no se insiste: empieza el
   * enfriamiento global y la búsqueda termina (el comprobante se revisa solo más tarde).
   */
  async function consultar(consulta: ConsultaBanxico, base: IntentoBase): Promise<RespuestaBanxico | Fin> {
    const pausa = consultasHechas === 0 ? 0 : REGLAS.pausaEntreConsultasMs;
    // No se empieza una consulta que no alcance a terminar antes del tiempo máximo.
    if (entrada.limite !== undefined && reloj() + pausa + MARGEN_LIMITE_MS > entrada.limite) return { fin: sinEncontrar(true) };
    if (pausa) await deps.esperar(pausa);
    entrada.signal?.throwIfAborted();
    if (enEnfriamiento()) return noDisponible(TEXTO_LIMITANDO);
    consultasHechas++;
    anotarRevisada(consulta.fecha);
    let respuesta: RespuestaBanxico;
    try {
      consultadas.push(claveDeConsulta(consulta));
      ultimoHtml = await deps.consultar(consulta);
      respuesta = parsearRespuesta(ultimoHtml);
    } catch (e) {
      // Cualquier falla al consultar (sin red, tiempo agotado, HTTP 4xx o 5xx) es de Banxico, no del comprobante: la
      // búsqueda termina como "Banxico no disponible" y el comprobante se revisa solo más tarde. Hasta el 13-oct solo
      // la falla de red cortaba; un 403 (bloqueo) o un 429 (límite) seguía y terminaba en "no se encontró".
      const motivo = e instanceof ErrorRedBanxico ? "Banxico no responde" : `Banxico respondió con un error (${(e as Error).message})`;
      registrar({ ...base, resultado: "ERROR_RED", detalle: (e as Error).message });
      return noDisponible(`${motivo}; intenta de nuevo más tarde.`);
    }
    if (respuesta.tipo === "ERROR" && respuesta.desconocida) {
      // Una página que no es la del CEP (bloqueo del firewall, mantenimiento): tampoco es un "no se encontró".
      registrar({ ...base, resultado: "ERROR", detalle: `respuesta no reconocida: ${inicioDelTexto(ultimoHtml)}` });
      return noDisponible("Banxico respondió una página que no es la del CEP (bloqueo o mantenimiento); intenta de nuevo más tarde.");
    }
    if (respuesta.tipo !== "CAPTCHA") return respuesta;
    deps.alCaptcha?.("consulta");
    registrar({ ...base, resultado: "CAPTCHA", detalle: respuesta.mensaje });
    return noDisponible(TEXTO_LIMITANDO);
  }

  /** Consulta normal (con cuenta y monto). Devuelve Fin si la búsqueda termina, o si Banxico dijo "no encontrado". */
  async function intentar(consulta: ConsultaBanxico, base: IntentoBase, paso: PasoPlan): Promise<Fin | { noEncontrado: boolean }> {
    const respuesta = await consultar(consulta, base);
    if ("fin" in respuesta) return respuesta;
    if (respuesta.tipo === "NO_ENCONTRADO") {
      registrar({ ...base, resultado: "NO_ENCONTRADO" });
      return { noEncontrado: true };
    }
    if (respuesta.tipo !== "PAGOS") {
      registrar({ ...base, resultado: "ERROR", detalle: respuesta.tipo === "ERROR" ? respuesta.mensaje : respuesta.tipo });
      return { noEncontrado: false };
    }

    let eleccion = elegirPago(respuesta.pagos, n, paso, usados);
    // La clave leída no existe en Banxico ese día (lo dijo la consulta con la clave sola), no aparece en el texto del
    // comprobante, no tiene la forma de la clave de ningún banco (MBAN…, SPIN-…, …TRANSBPI…) y no está cortada: la IA
    // tomó otro dato por la clave (12-oct: el folio "ad4ff015" de un comprobante de Plata, que no trae clave). Entre los
    // pagos que trae la referencia se elige como en un comprobante sin clave. Si la clave se ve en la imagen o parece una
    // clave real (aunque esté cortada), sigue mandando: no se toma otro pago con el mismo monto a la misma cuenta.
    const claveFalsa =
      eleccion.tipo === "ninguno" &&
      paso.criterio === "REFERENCIA" &&
      entrada.claveSinRespaldo === true &&
      !!n.claveRastreo &&
      !detectarBancoPorClave(n.claveRastreo) &&
      !claveCortada(n, bancoEmisor) &&
      claveEnFecha.get(isoDesdeBanxico(paso.fecha)) === false;
    let porReferencia = "";
    if (claveFalsa) {
      const sinClave = elegirPago(respuesta.pagos, { ...n, claveRastreo: null }, paso, usados);
      if (sinClave.tipo === "uno") {
        eleccion = sinClave;
        porReferencia = `; la clave leída (${n.claveRastreo}) no existe en Banxico ni se ve en la imagen: se eligió por la referencia`;
      }
    }
    if (eleccion.tipo === "ninguno") {
      registrar({ ...base, resultado: "NO_ENCONTRADO", detalle: eleccion.motivo });
      return { noEncontrado: false };
    }
    if (eleccion.tipo === "varios") {
      huboVarios = true;
      registrar({ ...base, resultado: "VARIOS_PAGOS", detalle: `${eleccion.cantidad} pagos con una clave parecida a la del comprobante` });
      return { noEncontrado: false };
    }
    if (eleccion.tipo === "usado") {
      registrar({ ...base, resultado: eleccion.pago.estado, detalle: `${eleccion.pago.claveRastreo} ya validada` });
      const fin = { estado: "DUPLICADO" as const, mensaje: mensajeDuplicado(eleccion.registro), intentos };
      return { fin: { ...fin, pago: eleccion.pago, consulta, duplicado: eleccion.registro } };
    }

    const { pago } = eleccion;
    registrar({ ...base, resultado: pago.estado, detalle: `${pago.claveRastreo ?? ""}${porReferencia}` || undefined });
    if (pago.estado === "LIQUIDADO" && pago.monto === monto) {
      return { fin: { estado: "VALIDADO", mensaje: "Pago validado en Banxico: Liquidado.", intentos, pago, consulta, html: ultimoHtml } };
    }
    const extra = pago.estado === "EN_PROCESO" ? " Intenta de nuevo en unos minutos." : "";
    const mensaje = `El pago existe en Banxico pero su estado es "${NOMBRE_ESTADO[pago.estado]}".${extra}`;
    return { fin: { estado: "NO_LIQUIDADO", mensaje, intentos, pago, consulta, html: ultimoHtml } };
  }

  /**
   * Sondeo con la clave sola (o con la clave y el monto): ¿Banxico tiene un pago con esa clave?
   * existe = null si Banxico respondió con un error y no se sabe.
   */
  async function sondear(
    consulta: ConsultaBanxico,
    base: IntentoBase,
    tipo: TipoSondeo,
  ): Promise<Fin | { existe: boolean | null; pago?: PagoBanxico; html?: string }> {
    const conSondeo = { ...base, sondeo: tipo };
    const respuesta = await consultar(consulta, conSondeo);
    if ("fin" in respuesta) return respuesta;
    const etiqueta = tipo === "SIN_CUENTA_NI_MONTO" ? "sondeo solo con la clave" : `sondeo con la clave y el monto ${PESOS.format(Number(monto))}`;
    if (respuesta.tipo === "PAGOS") {
      registrar({ ...conSondeo, resultado: respuesta.pagos[0]?.estado ?? "LIQUIDADO", detalle: `${etiqueta}: la clave existe` });
      // El pago que encontró (sin la fila de la cuenta, que no se envió) y su tabla, por si hay que mostrarla.
      return { existe: true, pago: respuesta.pagos[0], html: ultimoHtml };
    }
    if (respuesta.tipo === "NO_ENCONTRADO") {
      registrar({ ...conSondeo, resultado: "NO_ENCONTRADO", detalle: `${etiqueta}: no aparece` });
      return { existe: false };
    }
    registrar({ ...conSondeo, resultado: "ERROR", detalle: `${etiqueta}: ${respuesta.tipo === "ERROR" ? respuesta.mensaje : respuesta.tipo}` });
    return { existe: null };
  }

  const contextos = new Map<string, Contexto | null>();
  /** Instituciones de la fecha (el catálogo de Banxico cambia con la fecha). null: el banco no está ese día. */
  async function contexto(fechaIso: string): Promise<Contexto | null | Fin> {
    const guardado = contextos.get(fechaIso);
    if (guardado !== undefined) return guardado;
    const fecha = fechaParaBanxico(fechaIso);
    let catalogo: CatalogoBanxico;
    try {
      catalogo = await deps.catalogos.obtener(fecha);
    } catch (e) {
      return noDisponible(`Banxico no responde (catálogo del ${fecha}): ${(e as Error).message}. Intenta más tarde.`);
    }
    if (!catalogo.overrideCaptcha) {
      deps.alCaptcha?.("catálogo");
      return noDisponible("Banxico activó el captcha en el sitio del CEP; por ahora no se puede consultar automáticamente.");
    }
    const emisor = institucionEmisora(bancoEmisor, catalogo);
    const receptor = institucionReceptora(coincidencia.cuenta.banco, catalogo);
    const nombres = {
      emisor: emisor?.nombre ?? bancoEmisor.nombreLibre ?? bancoEmisor.clave ?? "?",
      receptor: receptor?.nombre ?? coincidencia.cuenta.banco,
    };
    if (!emisor || !receptor) {
      const falta = !emisor ? `el emisor (${nombres.emisor})` : `el receptor (${nombres.receptor})`;
      const [criterio, valor] = valorCriterio(primerCriterio, fechaIso, primeraCuenta[0]);
      registrar({ fecha, criterio, valorCriterio: valor ?? "", cuenta: primeraCuenta[0], ...nombres, resultado: "OMITIDO", detalle: `${falta} no aparece en el catálogo de Banxico de esa fecha` });
      contextos.set(fechaIso, null);
      return null;
    }
    const ctx = { fecha, emisor, receptor, nombres };
    contextos.set(fechaIso, ctx);
    return ctx;
  }

  /** Consulta normal (criterio, cuenta y monto) en una fecha. null: ese criterio no tiene valor ese día. */
  async function consultaNormal(fechaIso: string, ctx: Contexto, tipo: Criterio, [cuenta, tipoCuenta]: NumeroCuenta): Promise<Fin | { noEncontrado: boolean } | null> {
    const [criterio, valor] = valorCriterio(tipo, fechaIso, cuenta);
    if (!valor) return null;
    const { fecha, emisor, receptor, nombres } = ctx;
    const paso: PasoPlan = { fecha, criterio, valor, cuenta, tipoCuenta };
    const base: IntentoBase = { fecha, criterio, valorCriterio: valor, cuenta, ...nombres };
    const consulta: ConsultaBanxico = {
      tipoCriterio: criterio === "CLAVE_RASTREO" ? "T" : "R",
      fecha,
      criterio: valor,
      emisor,
      receptor,
      cuenta,
      monto,
      tipoConsulta: 0,
    };
    if (entrada.yaConsultadas?.has(claveDeConsulta(consulta))) {
      anotarRevisada(fecha);
      registrar({ ...base, resultado: "NO_ENCONTRADO", detalle: "ya consultada en la ruta rápida" });
      return { noEncontrado: true };
    }
    const r = await intentar(consulta, base, paso);
    if (!("fin" in r) && entrada.soloPrimerIntento) {
      return { fin: { estado: "NO_ENCONTRADO", mensaje: "No se encontró el pago en la primera consulta.", intentos } };
    }
    return r;
  }

  /** Fechas cuya consulta más probable dio "no encontrado": ahí se pregunta si la clave existe ese día. */
  const sinPagoEnPrincipal = new Set<string>();

  /** La consulta más probable de una fecha: el primer criterio con la primera cuenta. */
  async function consultaPrincipal(fechaIso: string): Promise<Fin | void> {
    const ctx = await contexto(fechaIso);
    if (!ctx) return;
    if ("fin" in ctx) return ctx;
    const r = await consultaNormal(fechaIso, ctx, primerCriterio, primeraCuenta);
    if (r && "fin" in r) return r;
    if (r?.noEncontrado) sinPagoEnPrincipal.add(fechaIso);
  }

  /** La clave existe ese día pero no con nuestra cuenta y el monto: ¿qué no coincide? */
  async function detectarAlteracion(ctx: Contexto): Promise<Fin> {
    const clave = n.claveRastreo!;
    const { fecha, emisor, receptor, nombres } = ctx;
    const base: IntentoBase = { fecha, criterio: "CLAVE_RASTREO", valorCriterio: clave, cuenta: "", ...nombres };
    const consulta: ConsultaBanxico = { tipoCriterio: "T", fecha, criterio: clave, emisor, receptor, cuenta: "", monto, tipoConsulta: 0 };
    const s = await sondear(consulta, base, "SIN_CUENTA");
    if ("fin" in s) return s;
    const fechaClave = isoDesdeBanxico(fecha);
    if (s.existe === true) {
      // La clave existe con ese monto pero no a nuestra cuenta. Si el banco la devolvió, eso es lo que se dice, con la
      // foto de la tabla de Banxico: el dinero no llegó (12-oct: pagos a un número mal escrito que termina como el nuestro).
      if (s.pago && DEVUELTOS.has(s.pago.estado)) {
        const mensaje =
          `El pago existe en Banxico pero su estado es "${NOMBRE_ESTADO[s.pago.estado]}": no fue a nuestra cuenta ` +
          "(el número completo no es el nuestro) y el banco lo regresó, así que el dinero no llegó.";
        return { fin: { estado: "NO_LIQUIDADO", mensaje, intentos, pago: s.pago, consulta, html: s.html, fechaClave } };
      }
      return { fin: { estado: "CUENTA_INCORRECTA", mensaje: `${MENSAJES.CUENTA_INCORRECTA} (Banxico registra ese pago a otra cuenta).`, intentos, fechaClave } };
    }
    const mensaje =
      s.existe === false
        ? `El monto no coincide: en Banxico el pago con esa clave de rastreo no es por ${PESOS.format(Number(monto))}.`
        : "El pago con esa clave de rastreo existe en Banxico, pero el monto o la cuenta no coinciden con el comprobante.";
    return { fin: { estado: "MONTO_NO_COINCIDE", mensaje, intentos, fechaClave } };
  }

  /**
   * ¿Existe la clave del comprobante ese día? Sondeo con la clave sola (sin cuenta ni monto), salvo que ya
   * se sepa (EntradaBusqueda.claveExisteEn). existe = null si Banxico respondió con un error y no se sabe.
   */
  async function existeClave(fechaIso: string, ctx: Contexto): Promise<Fin | { existe: boolean | null }> {
    if (fechaIso === entrada.claveExisteEn) {
      claveEnFecha.set(fechaIso, true);
      return { existe: true };
    }
    const clave = n.claveRastreo!;
    const { fecha, emisor, receptor, nombres } = ctx;
    const base: IntentoBase = { fecha, criterio: "CLAVE_RASTREO", valorCriterio: clave, cuenta: "", ...nombres };
    const consulta: ConsultaBanxico = { tipoCriterio: "T", fecha, criterio: clave, emisor, receptor, cuenta: "", monto: "", tipoConsulta: 0 };
    const s = await sondear(consulta, base, "SIN_CUENTA_NI_MONTO");
    if (!("fin" in s)) claveEnFecha.set(fechaIso, s.existe);
    return s;
  }

  /** Con la clave, las demás cuentas y, si la clave existe ese día y no apareció, la detección temprana. */
  async function demasCuentasConClave(fechaIso: string, ctx: Contexto, existe: boolean | null): Promise<Fin | void> {
    for (const cuenta of otrasCuentas) {
      const r = await consultaNormal(fechaIso, ctx, "CLAVE", cuenta);
      if (r && "fin" in r) return r;
    }
    if (existe) return detectarAlteracion(ctx);
  }

  /**
   * Fecha principal, después de su consulta más probable: si no apareció, ¿existe la clave ese día? Si no
   * existe, no se prueba con las demás cuentas. Si existe, se prueban las demás cuentas y, si tampoco
   * aparece, el comprobante tiene alterado el monto o la cuenta.
   */
  async function claveSola(fechaIso: string): Promise<Fin | void> {
    if (primerCriterio !== "CLAVE") return;
    const ctx = await contexto(fechaIso);
    if (!ctx) return;
    if ("fin" in ctx) return ctx;
    let existe: boolean | null = null;
    if (sinPagoEnPrincipal.has(fechaIso)) {
      const s = await existeClave(fechaIso, ctx);
      if ("fin" in s) return s;
      existe = s.existe;
      if (existe === false) return;
    }
    return demasCuentasConClave(fechaIso, ctx, existe);
  }

  /**
   * Las demás fechas, con clave: primero si la clave existe ese día (1 consulta). Si no existe, la consulta
   * completa tampoco lo encontraría (es la misma con más filtros) y no se hace. Si existe, o no se sabe, se
   * busca con nuestras cuentas.
   */
  async function claveEnOtraFecha(fechaIso: string): Promise<Fin | void> {
    const ctx = await contexto(fechaIso);
    if (!ctx) return;
    if ("fin" in ctx) return ctx;
    const s = await existeClave(fechaIso, ctx);
    if ("fin" in s) return s;
    if (s.existe === false) return;
    const r = await consultaNormal(fechaIso, ctx, "CLAVE", primeraCuenta);
    if (r && "fin" in r) return r;
    return demasCuentasConClave(fechaIso, ctx, s.existe);
  }

  /**
   * Lo que falta en una fecha: el primer criterio con las demás cuentas (si no es la clave) y los demás
   * criterios (la referencia). Con clave, la referencia solo en las fechas donde hace falta (fechasConReferencia).
   */
  async function loQueFalta(fechaIso: string): Promise<Fin | void> {
    if (primerCriterio === "CLAVE" && !fechasConReferencia.has(fechaIso)) return;
    const ctx = await contexto(fechaIso);
    if (!ctx) return;
    if ("fin" in ctx) return ctx;
    const pendientes: [Criterio, NumeroCuenta][] = [
      ...(primerCriterio === "CLAVE" ? [] : otrasCuentas.map((c): [Criterio, NumeroCuenta] => [primerCriterio, c])),
      ...otrosCriterios.flatMap((criterio) => cuentas.map((c): [Criterio, NumeroCuenta] => [criterio, c])),
    ];
    for (const [criterio, cuenta] of pendientes) {
      const r = await consultaNormal(fechaIso, ctx, criterio, cuenta);
      if (r && "fin" in r) return r;
    }
  }

  /**
   * Consulta extra con la 2ª referencia semanal más repetida en los últimos 7 días (BBVA, cuando el
   * comprobante no trae referencia): una sola fecha —la del comprobante o, si no trae, la de hoy— y las
   * cuentas que apliquen (la vista en el comprobante, o todas si no se vio ninguna). Así, si la referencia
   * de la semana acaba de cambiar y la del flujo normal fue la que no era, esta otra todavía lo encuentra.
   */
  async function consultaReferenciaSecundaria(): Promise<Fin | void> {
    const fechaSecIso = n.fecha ?? hoy;
    const refSecundaria = referenciaSemanalSecundaria(bancoEmisor.clave, fechaSecIso, entrada.referenciasAprendidas);
    if (!refSecundaria) return;
    const ctx = await contexto(fechaSecIso);
    if (!ctx || "fin" in ctx) return ctx ?? undefined;
    const { fecha, emisor, receptor, nombres } = ctx;
    for (const [cuenta, tipoCuenta] of cuentas) {
      const consulta: ConsultaBanxico = { tipoCriterio: "R", fecha, criterio: refSecundaria, emisor, receptor, cuenta, monto, tipoConsulta: 0 };
      if (entrada.yaConsultadas?.has(claveDeConsulta(consulta))) continue;
      const base: IntentoBase = { fecha, criterio: "REFERENCIA", valorCriterio: refSecundaria, cuenta, ...nombres };
      const r = await intentar(consulta, base, { fecha, criterio: "REFERENCIA", valor: refSecundaria, cuenta, tipoCuenta });
      if ("fin" in r) return r;
    }
  }

  // La fecha más probable, completa. En las demás: con clave, primero si existe ese día (y solo entonces con
  // nuestras cuentas) y al final la referencia donde hace falta; sin clave, la consulta más probable y luego
  // las demás cuentas. Así un pago con la fecha mal impresa o mal leída aparece pronto.
  type Paso = (fechaIso: string) => Promise<Fin | void>;
  const [fechaPrincipal, ...otrasFechas] = fechas;
  const enOtrasFechas: Paso[] = primerCriterio === "CLAVE" ? [claveEnOtraFecha, loQueFalta] : [consultaPrincipal, loQueFalta];
  const pasos: [Paso, string][] = [
    ...(fechaPrincipal ? [consultaPrincipal, claveSola, loQueFalta].map((p): [Paso, string] => [p, fechaPrincipal]) : []),
    ...enOtrasFechas.flatMap((p) => otrasFechas.map((f): [Paso, string] => [p, f])),
  ];
  for (const [paso, fechaIso] of pasos) {
    const fin = await paso(fechaIso);
    if (fin) return fin.fin;
  }
  // Sin referencia en el comprobante y fuera de la ruta rápida: la consulta extra con la 2ª referencia semanal.
  if (!n.referencia && !entrada.soloPrimerIntento) {
    const fin = await consultaReferenciaSecundaria();
    if (fin) return fin.fin;
  }
  return sinEncontrar();
}

type TipoSondeo = NonNullable<IntentoBanxico["sondeo"]>;
type IntentoBase = Omit<IntentoBanxico, "resultado" | "detalle">;
