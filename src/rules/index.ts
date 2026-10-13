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
  // La fecha del comprobante es la de mañana (BBVA de noche la imprime así) y el pago no apareció en los días que ya
  // pasaron. Pedido del usuario (13-oct): después de las consultas normales, "valida mañana".
  FECHA_MANANA: "Valida este comprobante mañana",
  // Pago de hoy, de noche, que todavía no aparece. Hasta el 13-oct decía "Banxico lo registra con la fecha del día
  // siguiente. Valídalo mañana", pero el 12-oct BanCoppel (18:11) y STP (18:07) aparecieron con la fecha de ese día:
  // el banco los envió con retraso.
  COMPROBANTE_NOCTURNO: "Banxico todavía no tiene este pago: algunos bancos lo envían con retraso. Vuelve a enviarlo en 15 a 30 minutos.",
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

/** Un número nuestro que se parece al leído, y a cuántos errores de lectura está (0 = enmascarado en medio). */
export type CuentaParecida = CoincidenciaCuenta & { errores: number };

/** Menos dígitos que estos no bastan para decir que se parece: con 3, uno de cada 5 números ajenos se parecería. */
const MIN_DIGITOS_PARECIDO = 4;
/** Desde estos dígitos el número leído puede ser un pedazo de cualquier parte del nuestro (la imagen cortó el final). */
const MIN_DIGITOS_RECORTE = 8;

/**
 * Menor número de errores de lectura (un dígito cambiado, de más o de menos) entre `leido` y un pedazo de
 * `numero`: su final si `alFinal` (las cuentas se enmascaran por el principio: "****1871"), o cualquier parte.
 */
function erroresDeLectura(leido: string, numero: string, alFinal: boolean): number {
  // Distancia de edición con el inicio libre en `numero` (y el final libre si no tiene que ser al final).
  let fila = Array.from({ length: numero.length + 1 }, () => 0);
  for (let i = 1; i <= leido.length; i++) {
    const nueva = [i];
    for (let j = 1; j <= numero.length; j++) {
      const cambio = fila[j - 1]! + (leido[i - 1] === numero[j - 1] ? 0 : 1);
      nueva[j] = Math.min(cambio, fila[j]! + 1, nueva[j - 1]! + 1);
    }
    fila = nueva;
  }
  return alFinal ? fila[numero.length]! : Math.min(...fila);
}

/** "41891871" = la tarjeta 4189 •••• •••• 1871 con la máscara de en medio quitada (el principio y el final del número). */
function enmascaradaEnMedio(leido: string, numero: string): boolean {
  if (leido.length < 6 || leido.length >= numero.length) return false;
  for (let k = 2; k <= leido.length - 3; k++) {
    if (numero.startsWith(leido.slice(0, k)) && numero.endsWith(leido.slice(k))) return true;
  }
  return false;
}

/**
 * Números nuestros que se PARECEN a la cuenta leída sin coincidir con ella: un dígito mal leído (1874 por
 * 1871), uno de más o de menos, el número recortado por la imagen o enmascarado en medio. Pedido del
 * usuario (11-oct): si se parece a uno de nuestros números, probar con ese número. Va de los más parecidos
 * a los menos. Banxico verifica después el número completo, el monto y la clave: es seguro.
 * - Con menos de 4 dígitos no se busca parecido.
 * - Errores permitidos: 1 hasta 9 dígitos leídos, 2 desde 10.
 */
export function buscarCuentasParecidas(digitos: string | null | undefined): CuentaParecida[] {
  const leido = digitos?.replace(/\D/g, "") ?? "";
  if (leido.length < MIN_DIGITOS_PARECIDO) return [];
  const permitidos = leido.length >= 10 ? 2 : 1;
  const parecidas: CuentaParecida[] = [];
  for (const cuenta of CUENTAS_DESTINO) {
    for (const tipo of ORDEN_TIPOS) {
      const numero = (cuenta as Partial<Record<TipoCuenta, string>>)[tipo];
      if (!numero || numero.endsWith(leido)) continue; // coincide: no es "parecida"
      const errores = enmascaradaEnMedio(leido, numero)
        ? 0
        : Math.min(
            erroresDeLectura(leido, numero, true),
            leido.length >= MIN_DIGITOS_RECORTE ? erroresDeLectura(leido, numero, false) : Infinity,
          );
      if (errores <= permitidos) parecidas.push({ cuenta, tipo, numero, errores });
    }
  }
  return parecidas.sort((a, b) => a.errores - b.errores);
}

/** Palabras de un nombre en minúsculas, sin acentos ni signos: "GABRIEL F**" → ["gabriel", "f"]. */
function palabrasDeNombre(nombre: string): string[] {
  return nombre
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-zñ\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * ¿El nombre leído es el de este titular? Cada palabra completa que coincide vale 1 y cada inicial que
 * coincide con otra palabra del titular, ½ ("GABRIEL F" = 1½). Un titular de una sola palabra (una empresa,
 * "MEXIOFERTAS") con esa palabra; uno de varias, con 1½ o más y al menos una palabra completa: un nombre de
 * pila solo ("Gabriel") no basta.
 */
function esElTitular(leido: string[], titular: string[]): boolean {
  const pendientes = [...titular];
  let completas = 0;
  let iniciales = 0;
  for (const palabra of leido.filter((p) => p.length > 1)) {
    const i = pendientes.indexOf(palabra);
    if (i >= 0) {
      pendientes.splice(i, 1);
      completas++;
    }
  }
  for (const inicial of leido.filter((p) => p.length === 1)) {
    const i = pendientes.findIndex((p) => p.startsWith(inicial));
    if (i >= 0) {
      pendientes.splice(i, 1);
      iniciales++;
    }
  }
  if (titular.length === 1) return completas === 1;
  return completas >= 1 && completas + iniciales / 2 >= 1.5;
}

/**
 * Nuestras cuentas cuyo titular es el beneficiario que dice el comprobante ("Gabriel Alejandro Fondacaro" →
 * Banorte, Banamex y BanCoppel; "MEXIOFERTAS" → Inbursa). Pedido del usuario (11-oct): el nombre es solo una
 * pista para decidir si vale la pena buscar más cuando la cuenta leída no es nuestra; **nunca** sirve para
 * rechazar (el usuario no quiere que se revise el titular).
 */
export function cuentasDelBeneficiario(...nombres: (string | null | undefined)[]): CuentaDestino[] {
  const leidos = nombres.filter((n): n is string => !!n?.trim()).map(palabrasDeNombre);
  return CUENTAS_DESTINO.filter((c) => leidos.some((leido) => esElTitular(leido, palabrasDeNombre(c.titular))));
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

/** Banco destino que el comprobante nombra y donde no tenemos cuenta ("BBVA"); null si es nuestro o no se reconoce. */
function bancoDestinoAjeno(bancoDestino: string | null | undefined): ClaveBanco | null {
  const banco = resolverBanco(bancoDestino);
  return banco && !CUENTAS_DESTINO.some((c) => c.banco === banco) ? banco : null;
}

/**
 * Nuestras cuentas en las que vale la pena buscar en Banxico un pago cuya cuenta visible no es nuestra
 * (puede estar mal leída): la del banco destino si es uno de los nuestros (se sabe el banco). Si el
 * comprobante no dice el banco destino, o dice otro, ninguna (regla del usuario, 11-oct: si se tiene la
 * cuenta, no se prueban otras).
 */
export function cuentasDelBancoDestino(bancoDestino: string | null | undefined): CuentaDestino[] {
  const banco = resolverBanco(bancoDestino);
  return banco ? CUENTAS_DESTINO.filter((c) => c.banco === banco) : [];
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
      // El comprobante dice que fue a un banco donde no tenemos cuenta (por ejemplo BBVA): no es nuestra
      // cuenta. Se rechaza sin consultar ni preguntar (regla del usuario, 11-oct).
      const ajeno = deducida ? null : bancoDestinoAjeno(datos.bancoDestino);
      if (ajeno) {
        reglas.push({ regla: "Cuenta destino", paso: false, detalle: `el banco destino es ${BANCOS[ajeno].nombre}, donde no tenemos cuenta` });
        return rechazar("CUENTA_INCORRECTA", MENSAJES.CUENTA_INCORRECTA);
      }
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
