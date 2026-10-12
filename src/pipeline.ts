/**
 * Orquestador: imagen → extracción → normalización → reglas → Banxico → registro → foto del resultado.
 *
 * Ruta rápida: la IA tarda 10–60 s, el OCR local 1–2 s. Apenas termina el OCR, si leyó todos los
 * datos y las reglas pasan, se hace UNA consulta a Banxico con esos datos. Si Banxico da una
 * respuesta definitiva (validado, ya usado, no liquidado) se responde sin esperar a la IA. Es seguro:
 * Banxico exige que la clave, la cuenta y el monto coincidan con un pago real, así que un error del
 * OCR solo produce "no encontrado" y entonces se sigue con los datos de la IA.
 */
import type { ConsultaBanxico } from "./banxico/cliente.js";
import { buscarEnBanxico, type EntradaBusqueda, type ResultadoBusqueda } from "./banxico/reintentos.js";
import { capturarResultado, nombreBase, type Captura } from "./capture/screenshot.js";
import { formatInTimeZone } from "date-fns-tz";
import { BANCOS, CUENTAS_DESTINO, REGLAS, ZONA_HORARIA, type ClaveBanco, type DefinicionBanco } from "./config.js";
import { evaluarBancoEmisor, type EvaluacionBanco } from "./extraction/banco-emisor.js";
import { extraerDeTexto } from "./extraction/campos-texto.js";
import { iniciarExtraccion, type ExtraccionEnCurso, type ResultadoExtraccion } from "./extraction/index.js";
import { aplicarNota, type DatosNota } from "./extraction/nota.js";
import { resolverBanco } from "./normalize/banco.js";
import { normalizarCuenta, normalizarDatos, normalizarFechaIso, normalizarMonto, type ConsultaReferencias } from "./normalize/index.js";
import {
  buscarCuentasDestino,
  buscarCuentasParecidas,
  cuentasDelBancoDestino,
  cuentasDelBeneficiario,
  esPagoReciente,
  evaluarReglas,
  mensajeDuplicado,
  type Confirmaciones,
  type CuentaParecida,
  type ReglasAprobadas,
  type ReglasRechazadas,
} from "./rules/index.js";
import { ReferenciasAprendidas } from "./storage/referencias.js";
import { AlmacenUsados, type RegistroUsado } from "./storage/usados.js";
import type {
  BancoEmisor,
  CodigoResultado,
  CoincidenciaCuenta,
  CuentaDestino,
  DatosNormalizados,
  IntentoBanxico,
  PagoBanxico,
  ReglaAplicada,
} from "./types.js";

export type Etapa = "LEYENDO" | "REGLAS" | "BANXICO" | "CAPTURA";

export interface Progreso {
  etapa: Etapa;
  /** Número de consulta a Banxico (etapa BANXICO). */
  consulta?: number;
  /** Etapa CAPTURA: clave con la que el pago ya quedó registrado en data/usados.json. */
  clave?: string;
}

export interface OpcionesValidacion {
  /** Quién valida (id de Telegram o "cli"). */
  usuario: string;
  /** Respuestas a una pregunta anterior (banco o cuenta). */
  confirmaciones?: Confirmaciones;
  /** Extracción ya hecha: al responder una confirmación no se vuelve a leer la imagen. */
  extraccion?: ResultadoExtraccion;
  /** Guardar el pago validado en data/usados.json (por defecto sí). */
  registrar?: boolean;
  /** Generar la foto del resultado (por defecto sí). */
  capturar?: boolean;
  /** Intentar la ruta rápida con el OCR (por defecto REGLAS.rutaRapida). */
  rutaRapida?: boolean;
  alProgreso?: (p: Progreso) => void;
  ahora?: Date;
  /**
   * Cancelación (tiempo máximo de la cola): se revisa entre etapas y entre consultas a Banxico, y
   * nunca se registra un pago después de cancelar.
   */
  signal?: AbortSignal;
  /**
   * Clave que esta misma validación ya registró antes de un reinicio del bot: su propio registro no
   * cuenta como duplicado y no se registra dos veces.
   */
  claveYaRegistrada?: string;
  /** Datos que la persona escribió en la nota de la foto: mandan sobre los de la imagen. */
  nota?: DatosNota;
  /** Probar en Banxico solo las primeras N fechas del plan (al reintentar un pago reciente). */
  maxFechas?: number;
  /**
   * Buscar en todas las fechas aunque el pago sea de hace minutos (la última revisión de un pago reciente).
   * Si no, un pago de hace minutos se busca solo en la fecha más probable: hoy.
   */
  busquedaCompleta?: boolean;
  /**
   * Hasta cuándo (epoch ms) se puede consultar Banxico (el tiempo máximo de la cola): la búsqueda
   * termina con lo que alcanzó a revisar en lugar de cortarse a la mitad.
   */
  limite?: number;
}

export interface ResultadoValidacion {
  codigo: CodigoResultado;
  /** Mensaje para el usuario. */
  mensaje: string;
  /** "rapida" si se resolvió con los datos del OCR sin esperar a la IA. */
  ruta?: "rapida" | "normal";
  extraccion?: ResultadoExtraccion;
  normalizados?: DatosNormalizados;
  coincidencia?: CoincidenciaCuenta;
  bancoEmisor?: BancoEmisor;
  reglas: ReglaAplicada[];
  intentos: IntentoBanxico[];
  pago?: PagoBanxico;
  consulta?: ConsultaBanxico;
  captura?: Captura;
  /** Error al generar la foto (el pago sí quedó validado). */
  errorCaptura?: string;
  faltantes?: string[];
  candidatosBanco?: ClaveBanco[];
  candidatosCuenta?: CuentaDestino[];
  duplicado?: RegistroUsado;
  /** Fechas (yyyy-MM-dd) en las que se buscó el pago en Banxico. */
  fechasRevisadas?: string[];
  /** La clave del comprobante no existe en Banxico en ninguna de las fechas revisadas. */
  claveInexistente?: boolean;
  /** La búsqueda se cortó porque se acababa el tiempo máximo. */
  busquedaIncompleta?: boolean;
  /** El monto leído no coincidía en Banxico y el pago apareció con otro de los montos leídos (el del OCR o el de la imagen). */
  montoCorregido?: MontoCorregido;
  /** La cuenta leída no era nuestra pero se parecía a uno de nuestros números, y se buscó con él. */
  cuentaParecida?: CuentaParecidaUsada;
  /** La cuenta leída no era nuestra, pero el beneficiario era uno de nuestros titulares y se buscó en su cuenta. */
  cuentaPorBeneficiario?: CuentaPorBeneficiario;
  /** Milisegundos por etapa. */
  tiempos: Partial<Record<"lectura" | "reglas" | "banxico" | "captura" | "total", number>>;
}

export interface DependenciasPipeline {
  iniciarExtraccion: (imagen: Buffer) => ExtraccionEnCurso;
  buscar: (entrada: EntradaBusqueda) => Promise<ResultadoBusqueda>;
  capturar: (consulta: ConsultaBanxico, base: string, html?: string) => Promise<Captura>;
  /** Pagos ya validados. null: no se revisan ni se guardan (REGLAS.bloquearDuplicados = false). */
  almacen: Pick<AlmacenUsados, "leer" | "registrar"> | null;
  /** Referencias que cambian con el tiempo (BBVA), aprendidas de los pagos validados. */
  referencias?: Pick<ReferenciasAprendidas, "cargar" | "para" | "aprender"> | null;
}

export const DEPENDENCIAS_PIPELINE: DependenciasPipeline = {
  iniciarExtraccion: (imagen) => iniciarExtraccion(imagen),
  buscar: (entrada) => buscarEnBanxico(entrada),
  capturar: (consulta, base, html) => capturarResultado(consulta, base, html),
  almacen: REGLAS.bloquearDuplicados ? new AlmacenUsados() : null,
  referencias: new ReferenciasAprendidas(),
};

/** Consulta de las referencias aprendidas (sin fecha: la de hoy en CDMX). */
function consultaReferencias(deps: DependenciasPipeline, ahora = new Date()): ConsultaReferencias | undefined {
  const referencias = deps.referencias;
  if (!referencias) return undefined;
  const hoy = formatInTimeZone(ahora, ZONA_HORARIA, "yyyy-MM-dd");
  return (banco, fechaIso) => referencias.para(banco, fechaIso ?? hoy);
}

/** Bancos posibles que se prueban en Banxico antes de preguntar el banco (o de decir "mismo banco"). */
const MAX_BANCOS_A_PROBAR = 3;
/** Al probar un banco o varias cuentas posibles, solo las primeras fechas del plan (las más probables). */
const FECHAS_POR_OPCION = 2;

/** dd-MM-yyyy → yyyy-MM-dd */
const isoDesdeBanxico = (fecha: string) => fecha.split("-").reverse().join("-");

/** Resultados de Banxico que no cambiarían con otros datos: el pago encontrado coincide en clave, cuenta y monto. */
const DEFINITIVOS: ReadonlySet<ResultadoBusqueda["estado"]> = new Set(["VALIDADO", "DUPLICADO", "NO_LIQUIDADO"]);

/**
 * Al probar opciones (bancos, cuentas o montos posibles), resultados que ya dicen qué pasó con el pago: los
 * definitivos, la detección temprana (la clave existe con ese banco, pero con otro monto o a otra cuenta) y
 * Banxico caído (el comprobante se revisa solo más tarde).
 */
const CONCLUYENTES: ReadonlySet<ResultadoBusqueda["estado"]> = new Set([
  ...DEFINITIVOS,
  "MONTO_NO_COINCIDE",
  "CUENTA_INCORRECTA",
  "BANXICO_NO_DISPONIBLE",
]);

export interface MontoCorregido {
  /** El monto con el que Banxico dijo que no coincide. */
  leido: string;
  /** El otro monto leído, con el que sí apareció el pago. */
  banxico: string;
}

/** Estados de un pago devuelto: se responde también con la foto de la tabla de Banxico. */
const DEVUELTOS: ReadonlySet<PagoBanxico["estado"]> = new Set(["DEVUELTO", "EN_PROCESO_DEVOLUCION", "RETORNADO"]);

/**
 * Otras fechas posibles del pago, además de la que se usa: la de la imagen si la nota trae otra, y la
 * del OCR si no coincide con la de la IA (una de las dos se leyó mal). Se prueban después de la principal.
 */
export function fechasAlternativas(extraccion: ResultadoExtraccion, fecha: string | null): string[] {
  const fechas = [extraccion.notaAplicada?.fechaImagen];
  if (extraccion.origen === "nvidia" && extraccion.textoOcr) fechas.push(normalizarFechaIso(extraerDeTexto(extraccion.textoOcr).fecha) ?? undefined);
  return [...new Set(fechas)].filter((f): f is string => !!f && f !== fecha);
}

/**
 * Otros montos posibles del pago, además del que se usa: el de la imagen si la nota trae otro, y el del OCR si
 * no coincide con el de la IA (uno de los dos se leyó mal). Se prueban si Banxico tiene la clave con otro monto.
 */
export function montosAlternativos(extraccion: ResultadoExtraccion): string[] {
  const montos: (number | null | undefined)[] = [extraccion.notaAplicada?.montoImagen];
  if (extraccion.origen === "nvidia" && extraccion.textoOcr) montos.push(extraerDeTexto(extraccion.textoOcr).monto);
  const usado = normalizarMonto(extraccion.datos.monto);
  return [...new Set(montos.map((m) => normalizarMonto(m)))].filter((m): m is string => !!m && m !== usado);
}

/**
 * Bancos emisores posibles distintos del elegido, del indicio más fuerte al más débil: la forma de la clave
 * de rastreo, el diseño del comprobante, la IA y el texto del OCR.
 */
export function otrosEmisores(banco: EvaluacionBanco): ClaveBanco[] {
  const { clave, firma, modelo, texto } = banco.senales;
  return [...new Set([clave, firma, modelo, texto, ...banco.candidatos])].filter((b): b is ClaveBanco => !!b && b !== banco.banco);
}

/** ¿La persona escribió la cuenta en la nota (el número o "cuenta Banorte")? Entonces no se cambia. */
const cuentaEnNota = (nota: DatosNota | undefined) => !!(nota?.cuentaDestino || nota?.cuentaBanco);

/** Número nuestro que se parece a la cuenta leída (y con cuál lectura, la de la IA o la del OCR). */
interface Parecida extends CuentaParecida {
  leida: string;
}

/** La cuenta leída no era nuestra, pero se parecía a uno de nuestros números y se buscó con él. */
export interface CuentaParecidaUsada {
  /** Lo que se leyó en el comprobante. */
  leida: string;
  /** Nuestro número con el que se buscó en Banxico. */
  usada: string;
}

/** La cuenta leída no era nuestra, pero el beneficiario era uno de nuestros titulares y se buscó en su cuenta. */
export interface CuentaPorBeneficiario {
  /** El beneficiario que dice el comprobante. */
  beneficiario: string;
  /** El banco de nuestra cuenta en la que se buscó. */
  banco: ClaveBanco;
}

/** Una opción que se prueba en Banxico: un banco o una cuenta (todos sus números), o un número parecido al leído. */
interface OpcionVerificacion {
  confirmaciones: Confirmaciones;
  /** Se busca con este número nuestro en lugar de la cuenta leída. */
  parecida?: Parecida;
  /** Se prueba porque el beneficiario es el titular de esta cuenta. */
  porBeneficiario?: string;
  /** Cómo buscar con esta opción, si no es como las demás (Verificacion). */
  maxFechas?: number;
  soloClave?: boolean;
}

/** Opciones (banco o cuenta) que se prueban en Banxico antes de preguntar o de rechazar, y cómo buscar con cada una. */
interface Verificacion {
  opciones: OpcionVerificacion[];
  maxFechas?: number;
  soloClave?: boolean;
}

/**
 * Números nuestros que se parecen a la cuenta leída por la IA o por el OCR (buscarCuentasParecidas), sin
 * repetir: el número de cuenta suelto cuenta como su CLABE, que es con la que se busca.
 */
export function numerosParecidos(extraccion: ResultadoExtraccion, n: DatosNormalizados): Parecida[] {
  const lecturas = [n.cuentaDestino];
  if (extraccion.origen === "nvidia" && extraccion.textoOcr) lecturas.push(normalizarCuenta(extraerDeTexto(extraccion.textoOcr).cuentaDestino));
  const porNumero = new Map<string, Parecida>();
  for (const leida of lecturas) {
    if (!leida) continue;
    for (const p of buscarCuentasParecidas(leida)) {
      const numero = p.tipo === "cuenta" ? p.cuenta.clabe : p.numero;
      const previa = porNumero.get(numero);
      if (!previa || p.errores < previa.errores) porNumero.set(numero, { ...p, leida });
    }
  }
  return [...porNumero.values()].sort((a, b) => a.errores - b.errores);
}

/**
 * Antes de preguntar o de rechazar, qué se prueba en Banxico (es seguro: Banxico solo encuentra el pago con
 * el banco emisor y la cuenta correctos):
 * - banco emisor dudoso: los bancos posibles;
 * - mismo banco, pero con clave de rastreo: una transferencia entre cuentas del mismo banco no pasa por SPEI
 *   y no trae clave, así que el banco emisor pudo leerse mal; se prueban los otros bancos que indican las
 *   señales y, si ninguno aparece, sí es del mismo banco;
 * - cuenta que no es nuestra: pudo leerse mal.
 *   - con clave, nuestra cuenta del banco destino si es uno de los nuestros (todos sus números);
 *   - con o sin clave, cada número nuestro que se PARECE a lo leído (numerosParecidos: un dígito mal leído,
 *     recortado, enmascarado), con ese número: si se parece a la tarjeta Banorte, con la tarjeta Banorte;
 *   - con clave, si el comprobante no dice el banco destino y el beneficiario es uno de nuestros titulares
 *     (cuentasDelBeneficiario), sus cuentas, rápido y después de las anteriores: el pago era para nosotros y
 *     la cuenta se leyó muy mal. El nombre nunca sirve para rechazar;
 *   - si nada de eso, "Cuentas incorrectas" sin consultar;
 * - cuenta que no se ve ni se pudo deducir, con clave: nuestras cuentas posibles, antes de preguntar.
 * No se cambia lo que la persona eligió con los botones o escribió en la nota.
 */
function verificacionPrevia(
  reglas: ReglasRechazadas,
  extraccion: ResultadoExtraccion,
  n: DatosNormalizados,
  opciones: OpcionesValidacion,
): Verificacion | null {
  const confirmaciones = opciones.confirmaciones ?? {};
  const conBanco = (clave: ClaveBanco): OpcionVerificacion => ({ confirmaciones: { ...confirmaciones, banco: { clave, nombreLibre: null } } });
  const conCuenta = (cuenta: CuentaDestino): OpcionVerificacion => ({ confirmaciones: { ...confirmaciones, cuentaClabe: cuenta.clabe } });
  const conClave = !!n.claveRastreo;
  // Una sola opción se busca completa; varias, con clave, rápido: solo la clave en las fechas más probables.
  // Sin clave no hay búsqueda rápida (la referencia no tiene sondeo): cada una completa.
  const probar = (lista: OpcionVerificacion[]): Verificacion =>
    lista.length > 1 && conClave ? { opciones: lista, maxFechas: FECHAS_POR_OPCION, soloClave: true } : { opciones: lista };
  switch (reglas.codigo) {
    case "REQUIERE_CONFIRMACION_BANCO":
      // Rápido (solo la clave): si ninguno aparece se pregunta el banco y entonces se hace la búsqueda completa.
      if (confirmaciones.banco) return null;
      return {
        opciones: (reglas.candidatosBanco ?? []).slice(0, MAX_BANCOS_A_PROBAR).map(conBanco),
        maxFechas: FECHAS_POR_OPCION,
        soloClave: true,
      };
    case "MISMO_BANCO":
      if (!conClave || confirmaciones.banco || opciones.nota?.banco) return null;
      return { opciones: otrosEmisores(extraccion.banco).slice(0, MAX_BANCOS_A_PROBAR).map(conBanco), maxFechas: FECHAS_POR_OPCION };
    case "CUENTA_INCORRECTA": {
      if (confirmaciones.cuentaClabe || cuentaEnNota(opciones.nota)) return null;
      const bancoDestino = extraccion.datos.bancoDestino;
      const delBanco = conClave ? cuentasDelBancoDestino(bancoDestino) : [];
      // Las parecidas de una cuenta que ya se prueba entera (la del banco destino) no se repiten.
      const parecidas = numerosParecidos(extraccion, n).filter((p) => !delBanco.includes(p.cuenta));
      const verificacion = probar([...delBanco.map(conCuenta), ...parecidas.map((parecida): OpcionVerificacion => ({ confirmaciones, parecida }))]);
      // Las del beneficiario van al final y siempre rápido (es la pista más débil). Sin clave no: con varias
      // cuentas del mismo titular, buscar por referencia en todas costaría ~30 consultas.
      if (conClave && !resolverBanco(bancoDestino)) {
        // El nombre de la IA y, de segunda lectura, el del OCR.
        const nombres = [extraccion.datos.beneficiario, beneficiarioSegunOcr(extraccion)];
        const beneficiario = nombres.find((nombre): nombre is string => !!nombre && cuentasDelBeneficiario(nombre).length > 0);
        for (const cuenta of beneficiario ? cuentasDelBeneficiario(...nombres) : []) {
          verificacion.opciones.push({ ...conCuenta(cuenta), porBeneficiario: beneficiario, maxFechas: FECHAS_POR_OPCION, soloClave: true });
        }
      }
      return verificacion.opciones.length ? verificacion : null;
    }
    case "REQUIERE_CONFIRMACION_CUENTA":
      if (!conClave || confirmaciones.cuentaClabe) return null;
      return probar((reglas.candidatosCuenta?.length ? reglas.candidatosCuenta : CUENTAS_DESTINO).map(conCuenta));
    default:
      return null;
  }
}

/** El beneficiario según el OCR, si la lectura fue de la IA (segunda lectura del nombre). */
function beneficiarioSegunOcr(extraccion: ResultadoExtraccion): string | null {
  return extraccion.origen === "nvidia" && extraccion.textoOcr ? extraerDeTexto(extraccion.textoOcr).beneficiario : null;
}

/** Los datos leídos con nuestro número parecido en lugar de la cuenta leída (Banxico verifica el número completo). */
function conNumeroParecido(extraccion: ResultadoExtraccion, n: DatosNormalizados, parecida: Parecida | undefined) {
  if (!parecida) return { extraccion, normalizados: n };
  return {
    extraccion: { ...extraccion, datos: { ...extraccion.datos, cuentaDestino: parecida.numero } },
    normalizados: { ...n, cuentaDestino: parecida.numero },
  };
}

/** Una búsqueda hecha y con qué datos (el monto puede ser otro de los leídos). */
interface BusquedaHecha {
  busqueda: ResultadoBusqueda;
  normalizados: DatosNormalizados;
  montoCorregido?: MontoCorregido;
}

/**
 * Busca en Banxico y, si la clave existe con otro monto (MONTO_NO_COINCIDE), antes de rechazar prueba los
 * otros montos leídos, solo en la fecha en que Banxico tiene la clave y solo con la clave. Es seguro:
 * Banxico solo devuelve el pago con su monto real.
 */
async function buscarConSegundaOpinion(entrada: EntradaBusqueda, montos: readonly string[], deps: DependenciasPipeline): Promise<BusquedaHecha> {
  const primera = await deps.buscar(entrada);
  const { fechaClave } = primera;
  if (primera.estado !== "MONTO_NO_COINCIDE" || !fechaClave) return { busqueda: primera, normalizados: entrada.normalizados };
  let intentos = primera.intentos;
  let consultadas = primera.consultadas ?? [];
  for (const monto of montos) {
    if (monto === entrada.normalizados.monto) continue;
    const otra = await deps.buscar({
      ...entrada,
      // Sin la hora, que cambiaría el orden de las fechas (BBVA de noche): solo la fecha de la clave.
      normalizados: { ...entrada.normalizados, monto, fecha: fechaClave, hora: null },
      fechasAlternativas: [],
      maxFechas: 1,
      soloClave: true,
      claveExisteEn: fechaClave, // ya se sabe: no se vuelve a preguntar
      yaConsultadas: new Set([...(entrada.yaConsultadas ?? []), ...consultadas]),
      alIntentar: (i, numero) => entrada.alIntentar?.(i, intentos.length + numero),
    });
    intentos = [...intentos, ...otra.intentos];
    consultadas = [...consultadas, ...(otra.consultadas ?? [])];
    if (otra.estado === "MONTO_NO_COINCIDE" || !CONCLUYENTES.has(otra.estado)) continue;
    // Con este monto el pago existe (validado, devuelto, a otra cuenta…), o Banxico dejó de responder.
    const busqueda = { ...otra, intentos, consultadas };
    if (!DEFINITIVOS.has(otra.estado)) return { busqueda, normalizados: entrada.normalizados };
    return { busqueda, normalizados: { ...entrada.normalizados, monto }, montoCorregido: { leido: entrada.normalizados.monto!, banxico: monto } };
  }
  return { busqueda: { ...primera, intentos, consultadas }, normalizados: entrada.normalizados };
}

interface Evaluacion {
  extraccion: ResultadoExtraccion;
  normalizados: DatosNormalizados;
  reglas: ReglasAprobadas;
  busqueda: ResultadoBusqueda;
  montoCorregido?: MontoCorregido;
  cuentaParecida?: CuentaParecidaUsada;
  cuentaPorBeneficiario?: CuentaPorBeneficiario;
}

export async function validarComprobante(
  imagen: Buffer | null,
  opciones: OpcionesValidacion,
  deps: DependenciasPipeline = DEPENDENCIAS_PIPELINE,
): Promise<ResultadoValidacion> {
  const inicio = Date.now();
  const tiempos: ResultadoValidacion["tiempos"] = {};
  const terminar = (r: Omit<ResultadoValidacion, "tiempos">): ResultadoValidacion => ({
    ...r,
    tiempos: { ...tiempos, total: Date.now() - inicio },
  });
  const progreso = (p: Progreso) => opciones.alProgreso?.(p);
  const alIntentar = (_i: IntentoBanxico, numero: number) => progreso({ etapa: "BANXICO", consulta: numero + 1 });

  progreso({ etapa: "LEYENDO" });
  await deps.referencias?.cargar();
  const referenciasAprendidas = consultaReferencias(deps, opciones.ahora);
  const usados = deps.almacen
    ? (await deps.almacen.leer()).filter((r) => !opciones.claveYaRegistrada || r.claveRastreo !== opciones.claveYaRegistrada)
    : [];

  // 1. Lectura (y ruta rápida con el OCR, si aplica).
  let extraccion = opciones.extraccion;
  let yaConsultadas: Set<string> | undefined;
  if (!extraccion) {
    if (!imagen) throw new Error("Falta la imagen del comprobante");
    const proceso = deps.iniciarExtraccion(imagen);

    if (opciones.rutaRapida ?? REGLAS.rutaRapida) {
      const texto = await proceso.ocr.catch(() => null);
      tiempos.lectura = Date.now() - inicio;
      const tRapida = Date.now();
      const rapida = texto ? await rutaRapida(texto, usados, opciones, deps, alIntentar).catch(() => null) : null;
      if (rapida) tiempos.banxico = Date.now() - tRapida;
      if (rapida && DEFINITIVOS.has(rapida.busqueda.estado)) {
        return terminar(await finalizar(rapida, "rapida", opciones, deps, tiempos));
      }
      // Lo que ya se consultó sin éxito no se repite con los datos de la IA.
      if (rapida?.busqueda.estado === "NO_ENCONTRADO") yaConsultadas = new Set(rapida.busqueda.consultadas ?? []);
    }

    const t = Date.now();
    extraccion = await proceso.completa;
    tiempos.lectura = (tiempos.lectura ?? 0) + (Date.now() - t);
  }
  opciones.signal?.throwIfAborted();
  extraccion = completarConOcr(extraccion);
  if (opciones.nota) extraccion = aplicarNota(extraccion, opciones.nota);

  // 2. Reglas.
  progreso({ etapa: "REGLAS" });
  const t0 = Date.now();
  const evaluar = (e: ResultadoExtraccion, n: DatosNormalizados, confirmaciones = opciones.confirmaciones) =>
    evaluarReglas({
      datos: e.datos,
      normalizados: n,
      banco: e.banco,
      usados,
      confirmaciones,
      ahora: opciones.ahora,
      bloquearDuplicados: deps.almacen !== null,
      referenciasAprendidas,
    });
  let normalizados = normalizarDatos(extraccion.datos);
  let reglas = evaluar(extraccion, normalizados);
  // Si la cuenta la escribió la persona en la nota, no se cambia por la del OCR.
  if (!reglas.aprobado && reglas.codigo === "CUENTA_INCORRECTA" && !cuentaEnNota(opciones.nota)) {
    const corregida = cuentaSegunOcr(extraccion);
    if (corregida) {
      extraccion = corregida;
      normalizados = normalizarDatos(extraccion.datos);
      reglas = evaluar(extraccion, normalizados);
    }
  }
  tiempos.reglas = Date.now() - t0;
  const alternativas = fechasAlternativas(extraccion, normalizados.fecha);
  const montos = montosAlternativos(extraccion);
  // Un pago de hace minutos que Banxico todavía no publica no puede estar en días anteriores: se busca
  // solo hoy. El bot lo vuelve a revisar a los 5 y 10 min, y la última revisión busca en todas las fechas.
  const soloHoy = !opciones.busquedaCompleta && esPagoReciente(normalizados, opciones.ahora ?? new Date());
  const maxFechas = opciones.maxFechas ?? (soloHoy ? 1 : undefined);
  const busquedaCon = (aprobadas: ReglasAprobadas, extra: Partial<EntradaBusqueda> = {}): EntradaBusqueda => ({
    normalizados,
    coincidencia: aprobadas.coincidencia,
    bancoEmisor: aprobadas.bancoEmisor,
    cuentaDeducida: aprobadas.cuentaDeducida,
    referenciasAprendidas,
    usados,
    ahora: opciones.ahora,
    yaConsultadas,
    maxFechas,
    fechasAlternativas: alternativas,
    limite: opciones.limite,
    alIntentar,
    signal: opciones.signal,
    ...extra,
  });

  // Antes de preguntar (banco o cuenta) o de rechazar (cuenta incorrecta, mismo banco con clave de rastreo),
  // se prueban en Banxico las opciones posibles (ver verificacionPrevia).
  const intentosPrevios: IntentoBanxico[] = [];
  const verificacion = reglas.aprobado ? null : verificacionPrevia(reglas, extraccion, normalizados, opciones);
  if (verificacion?.opciones.length) {
    progreso({ etapa: "BANXICO", consulta: 1 });
    const t1 = Date.now();
    for (const opcion of verificacion.opciones) {
      const { confirmaciones, parecida, porBeneficiario } = opcion;
      opciones.signal?.throwIfAborted();
      // Con un número parecido, las reglas y la búsqueda usan ese número en lugar de la cuenta leída.
      const conNumero = conNumeroParecido(extraccion, normalizados, parecida);
      const conOpcion = evaluar(conNumero.extraccion, conNumero.normalizados, confirmaciones);
      if (!conOpcion.aprobado) continue; // por ejemplo, ese banco sería el mismo que el destino
      const previos = intentosPrevios.length;
      const hecha = await buscarConSegundaOpinion(
        busquedaCon(conOpcion, {
          normalizados: conNumero.normalizados,
          maxFechas: opcion.maxFechas ?? verificacion.maxFechas ?? maxFechas,
          soloClave: opcion.soloClave ?? verificacion.soloClave,
          alIntentar: (i, numero) => alIntentar(i, previos + numero),
        }),
        montos,
        deps,
      );
      intentosPrevios.push(...hecha.busqueda.intentos);
      yaConsultadas = new Set([...(yaConsultadas ?? []), ...(hecha.busqueda.consultadas ?? [])]);
      if (CONCLUYENTES.has(hecha.busqueda.estado)) {
        tiempos.banxico = (tiempos.banxico ?? 0) + (Date.now() - t1);
        const busqueda = { ...hecha.busqueda, intentos: intentosPrevios };
        const cuentaParecida = parecida ? { leida: parecida.leida, usada: parecida.numero } : undefined;
        const cuentaPorBeneficiario = porBeneficiario ? { beneficiario: porBeneficiario, banco: conOpcion.coincidencia.cuenta.banco } : undefined;
        return terminar(
          await finalizar({ ...hecha, extraccion, reglas: conOpcion, busqueda, cuentaParecida, cuentaPorBeneficiario }, "normal", opciones, deps, tiempos),
        );
      }
    }
    tiempos.banxico = (tiempos.banxico ?? 0) + (Date.now() - t1);
  }

  if (!reglas.aprobado) {
    return terminar({
      ruta: "normal",
      extraccion,
      normalizados,
      reglas: reglas.reglas,
      intentos: intentosPrevios,
      codigo: reglas.codigo,
      mensaje: reglas.mensaje,
      faltantes: reglas.faltantes,
      candidatosBanco: reglas.candidatosBanco,
      candidatosCuenta: reglas.candidatosCuenta,
      duplicado: reglas.duplicado,
    });
  }

  // 3. Banxico (búsqueda completa con reintentos y, si el monto no coincide, con los otros montos leídos).
  progreso({ etapa: "BANXICO", consulta: 1 });
  const t1 = Date.now();
  const hecha = await buscarConSegundaOpinion(busquedaCon(reglas), montos, deps);
  tiempos.banxico = (tiempos.banxico ?? 0) + (Date.now() - t1);
  return terminar(await finalizar({ ...hecha, extraccion, reglas }, "normal", opciones, deps, tiempos));
}

/**
 * Segunda opinión antes de rechazar por "cuenta incorrecta": si la IA leyó una cuenta que no es
 * nuestra pero el OCR leyó una que sí, se usa la del OCR. Es seguro: Banxico verifica la cuenta
 * completa, así que una lectura equivocada solo termina en "no encontrado".
 */
export function cuentaSegunOcr(extraccion: ResultadoExtraccion): ResultadoExtraccion | null {
  if (extraccion.origen !== "nvidia" || !extraccion.textoOcr) return null;
  const cuenta = normalizarCuenta(extraerDeTexto(extraccion.textoOcr).cuentaDestino);
  if (!cuenta || cuenta.length < REGLAS.minDigitosTerminacion || buscarCuentasDestino(cuenta).length === 0) return null;
  if (cuenta === normalizarCuenta(extraccion.datos.cuentaDestino)) return null;
  return {
    ...extraccion,
    datos: { ...extraccion.datos, cuentaDestino: cuenta },
    cuentaCorregida: { ia: extraccion.datos.cuentaDestino, ocr: cuenta },
  };
}

/** Campos que se completan con el OCR si la IA los dejó vacíos. */
const COMPLETABLES = ["fecha", "monto", "claveRastreo", "referencia", "numeroOperacion", "bancoDestino"] as const;

/**
 * Datos que la IA dejó vacíos y el OCR sí leyó (por ejemplo la fecha "02/oct/26") se toman del OCR.
 * Es seguro: Banxico verifica todo. La hora solo acompaña a la fecha del OCR (si no, podría ser la
 * de la barra del celular) y la cuenta solo si es una de las nuestras.
 */
export function completarConOcr(extraccion: ResultadoExtraccion): ResultadoExtraccion {
  if (extraccion.origen !== "nvidia" || !extraccion.textoOcr || extraccion.completadoConOcr) return extraccion;
  const ocr = extraerDeTexto(extraccion.textoOcr);
  const datos = { ...extraccion.datos };
  const completados: string[] = [];
  for (const campo of COMPLETABLES) {
    if (datos[campo] == null && ocr[campo] != null) {
      Object.assign(datos, { [campo]: ocr[campo] });
      completados.push(campo);
    }
  }
  if (completados.includes("fecha") && !datos.hora && ocr.hora) {
    datos.hora = ocr.hora;
    completados.push("hora");
  }
  const cuenta = normalizarCuenta(ocr.cuentaDestino);
  if (!datos.cuentaDestino && cuenta && cuenta.length >= REGLAS.minDigitosTerminacion && buscarCuentasDestino(cuenta).length === 1) {
    datos.cuentaDestino = cuenta;
    completados.push("cuentaDestino");
  }
  return completados.length ? { ...extraccion, datos, completadoConOcr: completados } : extraccion;
}

/** Una sola consulta a Banxico con los datos del OCR, si están completos y pasan las reglas. */
async function rutaRapida(
  textoOcr: string,
  usados: RegistroUsado[],
  opciones: OpcionesValidacion,
  deps: DependenciasPipeline,
  alIntentar: (i: IntentoBanxico, n: number) => void,
): Promise<Evaluacion | null> {
  const datosOcr = extraerDeTexto(textoOcr);
  let lectura: ResultadoExtraccion = { datos: datosOcr, origen: "ocr", textoOcr, banco: evaluarBancoEmisor(datosOcr, textoOcr, "ocr") };
  if (opciones.nota) lectura = aplicarNota(lectura, opciones.nota);
  const { datos, banco } = lectura;
  if (!datos.esComprobante || !banco.suficiente) return null;
  const normalizados = normalizarDatos(datos);
  // Sin monto no se consulta; lo demás (fecha, referencia, cuenta) lo resuelven las reglas y la búsqueda.
  if (!normalizados.monto) return null;

  const referenciasAprendidas = consultaReferencias(deps, opciones.ahora);
  const reglas = evaluarReglas({
    datos,
    normalizados,
    banco,
    usados,
    ahora: opciones.ahora,
    bloquearDuplicados: deps.almacen !== null,
    referenciasAprendidas,
  });
  if (!reglas.aprobado) return null;

  opciones.alProgreso?.({ etapa: "BANXICO", consulta: 1 });
  const busqueda = await deps.buscar({
    normalizados,
    coincidencia: reglas.coincidencia,
    bancoEmisor: reglas.bancoEmisor,
    cuentaDeducida: reglas.cuentaDeducida,
    referenciasAprendidas,
    usados,
    ahora: opciones.ahora,
    soloPrimerIntento: true,
    alIntentar,
    signal: opciones.signal,
  });
  return { extraccion: lectura, normalizados, reglas, busqueda };
}

/**
 * Si el banco cambia su referencia con el tiempo (BBVA), se anota la de este pago validado: así el
 * siguiente comprobante de ese banco sin referencia se puede buscar con ella.
 */
async function aprenderReferencia(banco: BancoEmisor, pago: PagoBanxico, consulta: ConsultaBanxico, deps: DependenciasPipeline): Promise<void> {
  const habitual = banco.clave ? (BANCOS[banco.clave] as DefinicionBanco).referenciaHabitual : undefined;
  if (habitual?.tipo !== "semanal" || !pago.referencia || !deps.referencias) return;
  await deps.referencias.aprender(banco.clave!, pago.referencia, isoDesdeBanxico(consulta.fecha)).catch(() => undefined);
}

/** Resultado de Banxico → registro en usados (si se validó) → foto. */
async function finalizar(
  { extraccion, normalizados, reglas, busqueda, montoCorregido, cuentaParecida, cuentaPorBeneficiario }: Evaluacion,
  ruta: "rapida" | "normal",
  opciones: OpcionesValidacion,
  deps: DependenciasPipeline,
  tiempos: ResultadoValidacion["tiempos"],
): Promise<Omit<ResultadoValidacion, "tiempos">> {
  const resultado = {
    ...(montoCorregido ? { montoCorregido } : {}),
    ...(cuentaParecida ? { cuentaParecida } : {}),
    ...(cuentaPorBeneficiario ? { cuentaPorBeneficiario } : {}),
    ruta,
    extraccion,
    normalizados,
    reglas: reglas.reglas,
    coincidencia: reglas.coincidencia,
    bancoEmisor: reglas.bancoEmisor,
    intentos: busqueda.intentos,
    pago: busqueda.pago,
    consulta: busqueda.consulta,
    duplicado: busqueda.duplicado,
    mensaje: busqueda.mensaje,
    fechasRevisadas: busqueda.fechasRevisadas,
    claveInexistente: busqueda.claveInexistente,
    busquedaIncompleta: busqueda.incompleta,
  };

  // Pago devuelto: además del aviso, la foto de la tabla de Banxico para ver la devolución.
  const { pago: encontrado, consulta: conLaQue } = busqueda;
  if (busqueda.estado === "NO_LIQUIDADO" && encontrado && conLaQue && DEVUELTOS.has(encontrado.estado) && opciones.capturar !== false) {
    opciones.alProgreso?.({ etapa: "CAPTURA" });
    const t = Date.now();
    try {
      const base = nombreBase(isoDesdeBanxico(conLaQue.fecha), `${encontrado.claveRastreo ?? conLaQue.criterio}_devuelto`);
      return { ...resultado, codigo: "NO_LIQUIDADO", captura: await deps.capturar(conLaQue, base, busqueda.html) };
    } catch (e) {
      return { ...resultado, codigo: "NO_LIQUIDADO", errorCaptura: (e as Error).message };
    } finally {
      tiempos.captura = Date.now() - t;
    }
  }

  if (busqueda.estado !== "VALIDADO" || !busqueda.pago || !busqueda.consulta) {
    return { ...resultado, codigo: busqueda.estado === "VALIDADO" ? "NO_ENCONTRADO" : busqueda.estado };
  }

  // Registro con la clave REAL que devolvió Banxico (es única por pago), antes de la foto:
  // si algo falla después, el pago ya no se puede volver a usar.
  const { pago, consulta } = busqueda;
  await aprenderReferencia(reglas.bancoEmisor, pago, consulta, deps);
  const clave = pago.claveRastreo ?? consulta.criterio;
  const yaEraNuestro = clave === opciones.claveYaRegistrada;
  const almacen = deps.almacen;
  if (almacen && opciones.registrar !== false && !yaEraNuestro) {
    opciones.signal?.throwIfAborted();
    const previo = (await almacen.leer()).find((r) => r.claveRastreo === clave);
    if (previo) return { ...resultado, codigo: "DUPLICADO", mensaje: mensajeDuplicado(previo), duplicado: previo };
    await almacen.registrar({
      claveRastreo: clave,
      referencia: pago.referencia,
      monto: pago.monto ?? normalizados.monto!,
      fecha: isoDesdeBanxico(consulta.fecha),
      cuenta: consulta.cuenta,
      emisor: consulta.emisor.nombre,
      usuario: opciones.usuario,
      validadoEn: new Date().toISOString(),
    });
  }

  if (opciones.capturar === false) return { ...resultado, codigo: "VALIDADO" };
  opciones.alProgreso?.({ etapa: "CAPTURA", clave });
  const t = Date.now();
  try {
    const captura = await deps.capturar(consulta, nombreBase(isoDesdeBanxico(consulta.fecha), clave), busqueda.html);
    return { ...resultado, codigo: "VALIDADO", captura };
  } catch (e) {
    return { ...resultado, codigo: "VALIDADO", errorCaptura: (e as Error).message };
  } finally {
    tiempos.captura = Date.now() - t;
  }
}
