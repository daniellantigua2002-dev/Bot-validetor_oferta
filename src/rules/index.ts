/**
 * Motor de reglas del comprobante (antes de consultar Banxico). Orden exacto:
 *
 * Paso A, condiciones del comprobante:
 *   1. esComprobante falso → NO_ES_COMPROBANTE
 *   2. Falta monto, fecha, o clave y referencia a la vez → DATOS_INSUFICIENTES
 *      (si faltan clave y referencia, antes se revisa si la cuenta no es nuestra o si es el mismo
 *      banco: las transferencias entre cuentas del mismo banco no pasan por SPEI y no traen clave)
 * Paso B, restricciones:
 *   3. Cuenta destino contra nuestras cuentas → CUENTA_INCORRECTA / REQUIERE_CONFIRMACION_CUENTA
 *   4. Banco emisor igual al destino → MISMO_BANCO (si el emisor no es seguro → REQUIERE_CONFIRMACION_BANCO)
 *   5. Fecha posterior a hoy (CDMX): no se rechaza; la búsqueda prueba los días anteriores que ya pasaron
 *      y, si no aparece, responde FECHA_FUTURA
 *   6. Ya validado antes → DUPLICADO
 */
import { formatInTimeZone } from "date-fns-tz";
import { BANCOS, CUENTAS_DESTINO, REGLAS, ZONA_HORARIA, type ClaveBanco, type DefinicionBanco } from "../config.js";
import type { EvaluacionBanco } from "../extraction/banco-emisor.js";
import type { DatosExtraidos } from "../extraction/schema.js";
import { resolverBanco, sumarDias, tieneReferenciaHabitual, type ConsultaReferencias } from "../normalize/index.js";
import { buscarDuplicado, type RegistroUsado } from "../storage/usados.js";
import type {
  BancoEmisor,
  CodigoResultado,
  CoincidenciaCuenta,
  CuentaDestino,
  DatosNormalizados,
  ReglaAplicada,
  TipoCuenta,
} from "../types.js";

export const MENSAJES = {
  NO_ES_COMPROBANTE: "La imagen no parece un comprobante de transferencia.",
  CUENTA_INCORRECTA: "Cuentas incorrectas: el depósito no fue a ninguna de nuestras cuentas",
  REQUIERE_CONFIRMACION_CUENTA: "¿A cuál de nuestras cuentas se hizo el depósito?",
  REQUIERE_CONFIRMACION_BANCO: "¿Desde qué banco se hizo la transferencia?",
  MISMO_BANCO: "Este comprobante no se valida: el banco emisor y el de destino coinciden",
  FECHA_FUTURA: "Valida este comprobante en 1 o 2 días",
  COMPROBANTE_NOCTURNO: "Comprobante nocturno: Banxico lo registra con la fecha del día siguiente. Valídalo mañana.",
} as const;

/** ¿El comprobante es de noche? (desde REGLAS.horaInicioNocturno; "HH:mm:ss" se compara como texto). */
export const esNocturno = (hora: string | null | undefined) => !!hora && hora >= REGLAS.horaInicioNocturno;

/** ¿El banco imprime de noche la fecha del día siguiente? (BBVA: "09 octubre" para un pago del 8 a las 21:08) */
export const imprimeFechaSiguienteDeNoche = (banco: BancoEmisor, hora: string | null | undefined) =>
  esNocturno(hora) && !!banco.clave && (BANCOS[banco.clave] as DefinicionBanco).fechaSiguienteDeNoche === true;

/** ¿La fecha del comprobante es posterior a hoy? La de mañana en BBVA de noche no cuenta (es su fecha de operación). */
export function esFechaPosterior(fecha: string | null, hoy: string, bbvaDeNoche: boolean): boolean {
  return !!fecha && fecha > hoy && !(bbvaDeNoche && fecha === sumarDias(hoy, 1));
}

/** Un pago es reciente si su hora es de hace hasta estos minutos (o hasta 5 minutos "en el futuro": relojes desfasados). */
export const MINUTOS_PAGO_RECIENTE = 15;

/**
 * Minutos desde la hora del comprobante hasta ahora (CDMX). El celular puede ir una hora adelante o
 * atrás: de las tres diferencias posibles se toma la más cercana a cero. null si no trae hora o si
 * la fecha no es de hoy (o de mañana: BBVA de noche imprime la del día siguiente).
 */
export function minutosDesdeElPago(n: Pick<DatosNormalizados, "fecha" | "hora">, ahora: Date): number | null {
  if (!n.hora) return null;
  const hoy = formatInTimeZone(ahora, ZONA_HORARIA, "yyyy-MM-dd");
  if (n.fecha && n.fecha !== hoy && n.fecha !== sumarDias(hoy, 1)) return null;
  const [h, m] = n.hora.split(":").map(Number) as [number, number];
  const [hAhora, mAhora] = formatInTimeZone(ahora, ZONA_HORARIA, "HH:mm").split(":").map(Number) as [number, number];
  const diferencia = hAhora * 60 + mAhora - (h * 60 + m);
  return [diferencia, diferencia - 60, diferencia + 60].reduce((mejor, d) => (Math.abs(d) < Math.abs(mejor) ? d : mejor));
}

/** ¿El pago es de hace pocos minutos? (Banxico puede tardar hasta 10 en publicarlo.) */
export const esPagoReciente = (n: Pick<DatosNormalizados, "fecha" | "hora">, ahora: Date) => {
  const minutos = minutosDesdeElPago(n, ahora);
  return minutos !== null && minutos >= -5 && minutos <= MINUTOS_PAGO_RECIENTE;
};

export function mensajeDuplicado(previo: RegistroUsado): string {
  const cuando = formatInTimeZone(new Date(previo.validadoEn), ZONA_HORARIA, "dd/MM/yyyy 'a las' HH:mm");
  return `Este comprobante ya fue validado el ${cuando} (hora de CDMX).`;
}

/** Respuestas del usuario a una pregunta anterior (botones del bot). */
export interface Confirmaciones {
  banco?: BancoEmisor;
  /** CLABE de la cuenta destino elegida. */
  cuentaClabe?: string;
}

export interface EntradaReglas {
  datos: DatosExtraidos;
  normalizados: DatosNormalizados;
  banco: EvaluacionBanco;
  usados: readonly RegistroUsado[];
  confirmaciones?: Confirmaciones;
  /** Momento actual (se inyecta en los tests). */
  ahora?: Date;
  /** Revisar si el comprobante ya se validó (por defecto REGLAS.bloquearDuplicados). */
  bloquearDuplicados?: boolean;
  /** Referencias aprendidas de pagos validados (BBVA). */
  referenciasAprendidas?: ConsultaReferencias;
}

/** Códigos que decide el motor de reglas (los demás salen de Banxico). */
export type CodigoRechazo = Exclude<
  CodigoResultado,
  "VALIDADO" | "NO_LIQUIDADO" | "MONTO_NO_COINCIDE" | "COMPROBANTE_NOCTURNO" | "FECHA_FUTURA" | "NO_ENCONTRADO" | "BANXICO_NO_DISPONIBLE"
>;

export interface ReglasAprobadas {
  aprobado: true;
  reglas: ReglaAplicada[];
  coincidencia: CoincidenciaCuenta;
  bancoEmisor: BancoEmisor;
  /** La cuenta no se vio en el comprobante (se dedujo o la eligió la persona): se prueban todos sus números. */
  cuentaDeducida: boolean;
}

export interface DetalleRechazo {
  faltantes?: string[];
  candidatosCuenta?: CuentaDestino[];
  candidatosBanco?: ClaveBanco[];
  duplicado?: RegistroUsado;
}

export interface ReglasRechazadas extends DetalleRechazo {
  aprobado: false;
  codigo: CodigoRechazo;
  mensaje: string;
  reglas: ReglaAplicada[];
}

export type ResultadoReglas = ReglasAprobadas | ReglasRechazadas;

// --- Regla 3: cuenta destino --------------------------------------------------------

const ORDEN_TIPOS: TipoCuenta[] = ["clabe", "tarjeta", "cuenta"];

/**
 * Cuentas cuyo CLABE, tarjeta o número de cuenta termina con los dígitos visibles.
 * Devuelve una coincidencia por cuenta (la primera en orden CLABE, tarjeta, cuenta).
 */
export function buscarCuentasDestino(digitos: string): CoincidenciaCuenta[] {
  const coincidencias: CoincidenciaCuenta[] = [];
  for (const cuenta of CUENTAS_DESTINO) {
    for (const tipo of ORDEN_TIPOS) {
      const numero = (cuenta as Partial<Record<TipoCuenta, string>>)[tipo];
      if (numero?.endsWith(digitos)) {
        coincidencias.push({ cuenta, tipo, numero });
        break;
      }
    }
  }
  return coincidencias;
}

/** Primer número de una cuenta para consultar cuando no se vio cuál: la tarjeta si tiene, si no la CLABE. */
function coincidenciaDeCuenta(cuenta: CuentaDestino): CoincidenciaCuenta {
  const tarjeta = (cuenta as Partial<Record<TipoCuenta, string>>).tarjeta;
  return tarjeta ? { cuenta, tipo: "tarjeta", numero: tarjeta } : { cuenta, tipo: "clabe", numero: cuenta.clabe };
}

/**
 * Cuenta destino cuando el comprobante no muestra su número (o la terminación es de varias cuentas):
 * 1. por el banco destino ("Banco destino: Banorte"): nuestra única cuenta en ese banco;
 * 2. por la referencia: Banco Azteca usa los últimos 7 dígitos de la cuenta destino ("7841871").
 * Banxico verifica después el número completo.
 */
function deducirCuenta(
  datos: DatosExtraidos,
  n: DatosNormalizados,
  candidatas: CoincidenciaCuenta[] | null,
): { coincidencia: CoincidenciaCuenta; motivo: string } | null {
  const posibles: CuentaDestino[] = candidatas?.map((c) => c.cuenta) ?? [...CUENTAS_DESTINO];
  const bancoDestino = resolverBanco(datos.bancoDestino);
  const delBanco = bancoDestino ? posibles.filter((c) => c.banco === bancoDestino) : [];
  if (delBanco.length === 1) {
    const cuenta = delBanco[0]!;
    const coincidencia = candidatas?.find((c) => c.cuenta === cuenta) ?? coincidenciaDeCuenta(cuenta);
    return { coincidencia, motivo: `${cuenta.banco} (deducida del banco destino)` };
  }
  if (n.referencia?.length === 7) {
    const porReferencia = buscarCuentasDestino(n.referencia).filter((c) => posibles.includes(c.cuenta));
    if (porReferencia.length === 1) {
      const c = porReferencia[0]!;
      return { coincidencia: c, motivo: `${c.cuenta.banco} (la referencia son los últimos 7 dígitos de su ${c.tipo})` };
    }
  }
  return null;
}

/**
 * Nuestras cuentas en las que vale la pena buscar en Banxico un pago cuya cuenta visible no es nuestra
 * (puede estar mal leída): la del banco destino si es uno de los nuestros; si el comprobante no dice el
 * banco destino, todas; si dice otro banco, ninguna (el pago fue a ese banco).
 */
export function cuentasDelBancoDestino(bancoDestino: string | null | undefined): CuentaDestino[] {
  if (!bancoDestino?.trim()) return [...CUENTAS_DESTINO];
  const banco = resolverBanco(bancoDestino);
  return CUENTAS_DESTINO.filter((c) => c.banco === banco);
}

// --- Utilidades -----------------------------------------------------------------------

const hoyCdmx = (ahora: Date) => formatInTimeZone(ahora, ZONA_HORARIA, "yyyy-MM-dd");

function unirConY(partes: string[]): string {
  return partes.length <= 1 ? (partes[0] ?? "") : `${partes.slice(0, -1).join(", ")} y ${partes.at(-1)}`;
}

function nombreBanco(b: BancoEmisor): string {
  return b.clave ? BANCOS[b.clave].nombre : (b.nombreLibre ?? "desconocido");
}

/**
 * Rechazo que se puede dar aunque el comprobante no traiga clave ni referencia, sin hacerle
 * preguntas al usuario: la cuenta no es nuestra, o el emisor es el mismo banco que el destino.
 */
function rechazoSinCriterio(
  datos: DatosExtraidos,
  n: DatosNormalizados,
  banco: EvaluacionBanco,
  confirmaciones: Confirmaciones,
): { codigo: "CUENTA_INCORRECTA" | "MISMO_BANCO"; mensaje: string; regla: ReglaAplicada } | null {
  let destino: CuentaDestino | undefined;
  if (confirmaciones.cuentaClabe) {
    destino = CUENTAS_DESTINO.find((c) => c.clabe === confirmaciones.cuentaClabe);
  } else if (n.cuentaDestino && n.cuentaDestino.length >= REGLAS.minDigitosTerminacion) {
    const encontradas = buscarCuentasDestino(n.cuentaDestino);
    if (encontradas.length === 0) {
      const regla = { regla: "Cuenta destino", paso: false, detalle: `ninguna cuenta termina en ${n.cuentaDestino}` };
      return { codigo: "CUENTA_INCORRECTA", mensaje: MENSAJES.CUENTA_INCORRECTA, regla };
    }
    if (encontradas.length === 1) destino = encontradas[0]!.cuenta;
  } else if (!n.cuentaDestino) {
    // Sin número visible, el banco destino ("Banco destino: Banorte" o "cuenta Banorte" en la nota).
    destino = deducirCuenta(datos, n, null)?.coincidencia.cuenta;
  }

  const emisor = confirmaciones.banco ?? (banco.suficiente ? { clave: banco.banco, nombreLibre: banco.nombreLibre } : null);
  if (REGLAS.rechazarMismoBanco && destino && emisor?.clave === destino.banco) {
    const regla = { regla: "Bancos distintos", paso: false, detalle: `${nombreBanco(emisor)} → ${BANCOS[destino.banco].nombre} (sin clave: no pasó por SPEI)` };
    return { codigo: "MISMO_BANCO", mensaje: MENSAJES.MISMO_BANCO, regla };
  }
  return null;
}

// --- Motor ------------------------------------------------------------------------------

export function evaluarReglas(entrada: EntradaReglas): ResultadoReglas {
  const { datos, normalizados: n, banco, usados, confirmaciones = {} } = entrada;
  const ahora = entrada.ahora ?? new Date();
  const reglas: ReglaAplicada[] = [];
  const rechazar = (codigo: CodigoRechazo, mensaje: string, extra: DetalleRechazo = {}): ReglasRechazadas => ({
    aprobado: false,
    codigo,
    mensaje,
    reglas,
    ...extra,
  });

  // 1. ¿Es comprobante?
  reglas.push({ regla: "Es un comprobante", paso: datos.esComprobante });
  if (!datos.esComprobante) return rechazar("NO_ES_COMPROBANTE", MENSAJES.NO_ES_COMPROBANTE);

  // 2. Datos mínimos. Sin fecha se busca hoy y los días anteriores. Sin clave ni referencia se usa la
  // referencia que la app del banco pone sola, si se conoce (si el banco es dudoso, se preguntará).
  const emisorSeguro = confirmaciones.banco?.clave ?? (banco.suficiente ? banco.banco : null);
  const habitual = (b: ClaveBanco | null) => tieneReferenciaHabitual(b, entrada.referenciasAprendidas, n.fecha);
  const conHabitual = confirmaciones.banco || banco.suficiente ? habitual(emisorSeguro) : banco.candidatos.some(habitual);
  const sinCriterio = !n.claveRastreo && !n.referencia && !conHabitual;
  const faltantes: string[] = [];
  if (!n.monto) faltantes.push("el monto");
  if (sinCriterio) faltantes.push("la clave de rastreo o el número de referencia");
  const supuestos: string[] = [];
  if (!n.fecha) supuestos.push("sin fecha: se busca de hoy hacia atrás");
  if (!n.claveRastreo && !n.referencia && conHabitual) supuestos.push("sin clave ni referencia: se usa la referencia habitual del banco");
  reglas.push({
    regla: "Datos mínimos",
    paso: faltantes.length === 0,
    detalle: faltantes.length ? `falta ${unirConY(faltantes)}` : supuestos.join("; ") || undefined,
  });
  if (faltantes.length) {
    // Sin clave ni referencia no se puede consultar Banxico, pero antes de decir "datos insuficientes"
    // se revisan los rechazos que no las necesitan. Las transferencias entre cuentas del mismo banco
    // no pasan por SPEI y por eso no traen clave: lo correcto es decir "mismo banco".
    if (sinCriterio) {
      const previo = rechazoSinCriterio(datos, n, banco, confirmaciones);
      if (previo) {
        reglas.push(previo.regla);
        return rechazar(previo.codigo, previo.mensaje);
      }
    }
    return rechazar("DATOS_INSUFICIENTES", `Datos insuficientes: no se pudo leer ${unirConY(faltantes)}.`, { faltantes });
  }

  // 3. Cuenta destino. Si no se ve o la terminación es de varias cuentas, se deduce (deducirCuenta);
  // si tampoco se puede, se pregunta. Banxico verificará la cuenta completa.
  let coincidencia: CoincidenciaCuenta | undefined;
  let cuentaDeducida = false;
  if (confirmaciones.cuentaClabe) {
    const cuenta = CUENTAS_DESTINO.find((c) => c.clabe === confirmaciones.cuentaClabe);
    if (cuenta) coincidencia = coincidenciaDeCuenta(cuenta);
    cuentaDeducida = true;
    reglas.push({ regla: "Cuenta destino", paso: !!cuenta, detalle: cuenta ? `confirmada por el usuario: ${cuenta.banco}` : "confirmación inválida" });
  } else {
    const digitos = n.cuentaDestino;
    const visibles = digitos && digitos.length >= REGLAS.minDigitosTerminacion ? buscarCuentasDestino(digitos) : null;
    if (visibles?.length === 0) {
      reglas.push({ regla: "Cuenta destino", paso: false, detalle: `ninguna cuenta termina en ${digitos}` });
      return rechazar("CUENTA_INCORRECTA", MENSAJES.CUENTA_INCORRECTA);
    }
    if (visibles?.length === 1) {
      coincidencia = visibles[0]!;
      reglas.push({ regla: "Cuenta destino", paso: true, detalle: `${coincidencia.cuenta.banco} (${coincidencia.tipo} …${digitos})` });
    } else {
      const deducida = deducirCuenta(datos, n, visibles);
      if (!deducida) {
        const detalle = visibles
          ? `${visibles.length} cuentas terminan en ${digitos}`
          : digitos
            ? `solo ${digitos.length} dígitos visibles`
            : "no visible en el comprobante";
        reglas.push({ regla: "Cuenta destino", paso: false, detalle });
        return rechazar("REQUIERE_CONFIRMACION_CUENTA", MENSAJES.REQUIERE_CONFIRMACION_CUENTA, {
          candidatosCuenta: visibles?.map((e) => e.cuenta) ?? [...CUENTAS_DESTINO],
        });
      }
      coincidencia = deducida.coincidencia;
      cuentaDeducida = true;
      reglas.push({ regla: "Cuenta destino", paso: true, detalle: deducida.motivo });
    }
  }
  if (!coincidencia) return rechazar("REQUIERE_CONFIRMACION_CUENTA", MENSAJES.REQUIERE_CONFIRMACION_CUENTA, { candidatosCuenta: [...CUENTAS_DESTINO] });

  // 4. Mismo banco (necesita un banco emisor confiable).
  let bancoEmisor: BancoEmisor;
  if (confirmaciones.banco) {
    bancoEmisor = confirmaciones.banco;
  } else if (banco.suficiente) {
    bancoEmisor = { clave: banco.banco, nombreLibre: banco.nombreLibre };
  } else {
    reglas.push({ regla: "Banco emisor", paso: false, detalle: banco.motivo });
    return rechazar("REQUIERE_CONFIRMACION_BANCO", MENSAJES.REQUIERE_CONFIRMACION_BANCO, { candidatosBanco: banco.candidatos });
  }
  const mismo = REGLAS.rechazarMismoBanco && bancoEmisor.clave === coincidencia.cuenta.banco;
  reglas.push({ regla: "Bancos distintos", paso: !mismo, detalle: `${nombreBanco(bancoEmisor)} → ${BANCOS[coincidencia.cuenta.banco].nombre}` });
  if (mismo) return rechazar("MISMO_BANCO", MENSAJES.MISMO_BANCO);

  // 5. Fecha posterior a hoy (CDMX): ya no se rechaza sin consultar. Puede estar mal leída o ser el reloj
  // del celular, así que se busca en los días anteriores a ella que ya pasaron y, si no aparece, la
  // búsqueda responde FECHA_FUTURA ("valida en 1 o 2 días"). BBVA de noche imprime la fecha de mañana y
  // esa no cuenta como posterior.
  const hoy = hoyCdmx(ahora);
  const posterior = esFechaPosterior(n.fecha, hoy, imprimeFechaSiguienteDeNoche(bancoEmisor, n.hora));
  reglas.push({
    regla: "Fecha",
    paso: true,
    detalle: posterior ? `${n.fecha} es posterior a hoy (${hoy}): se busca en los días anteriores` : `${n.fecha ?? "sin fecha"} (hoy ${hoy})`,
  });

  // 6. Duplicado.
  if (entrada.bloquearDuplicados ?? REGLAS.bloquearDuplicados) {
    const previo = buscarDuplicado(usados, n);
    reglas.push({ regla: "No usado antes", paso: !previo });
    if (previo) return rechazar("DUPLICADO", mensajeDuplicado(previo), { duplicado: previo });
  }

  return { aprobado: true, reglas, coincidencia, bancoEmisor, cuentaDeducida };
}
