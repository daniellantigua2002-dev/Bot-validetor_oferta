/**
 * Tipos compartidos entre módulos.
 */
import type { ClaveBanco, CUENTAS_DESTINO } from "./config.js";

export type { ClaveBanco } from "./config.js";
export type { DatosExtraidos } from "./extraction/schema.js";

export type CuentaDestino = (typeof CUENTAS_DESTINO)[number];
export type TipoCuenta = "clabe" | "tarjeta" | "cuenta";

/** Coincidencia de la terminación del comprobante con una de nuestras cuentas. */
export interface CoincidenciaCuenta {
  cuenta: CuentaDestino;
  tipo: TipoCuenta;
  /** Número completo que coincidió (el que se envía a Banxico). */
  numero: string;
}

/** Datos del comprobante ya normalizados, listos para las reglas y Banxico. */
export interface DatosNormalizados {
  /** Clave tal como la acepta Banxico (respeta mayúsculas). */
  claveRastreo: string | null;
  /** De dónde salió la clave: del comprobante o del número de comprobante de Mercado Pago ("CPO…"). */
  origenClave: "comprobante" | "mercado_pago" | null;
  /** Solo dígitos, hasta 7. */
  referencia: string | null;
  /** De dónde salió la referencia: del comprobante o del número de comprobante de Mercado Pago. */
  origenReferencia: "comprobante" | "mercado_pago" | null;
  /** Monto con 2 decimales, por ejemplo "1032.00". */
  monto: string | null;
  /** Fecha ISO yyyy-MM-dd. */
  fecha: string | null;
  /** Fecha para Banxico: dd-MM-yyyy. */
  fechaBanxico: string | null;
  /** Hora del comprobante HH:mm:ss (24 h). */
  hora: string | null;
  /** Dígitos visibles de la cuenta destino. */
  cuentaDestino: string | null;
}

/** Banco emisor decidido: uno del mapa BANCOS o un nombre libre a buscar en el catálogo. */
export interface BancoEmisor {
  clave: ClaveBanco | null;
  nombreLibre: string | null;
}

/** Resultado final de validar un comprobante. */
export type CodigoResultado =
  | "VALIDADO"
  | "NO_ES_COMPROBANTE"
  | "DATOS_INSUFICIENTES"
  | "CUENTA_INCORRECTA"
  | "REQUIERE_CONFIRMACION_CUENTA"
  | "REQUIERE_CONFIRMACION_BANCO"
  | "MISMO_BANCO"
  | "FECHA_FUTURA"
  | "DUPLICADO"
  /** Banxico encontró el pago, pero no está liquidado (devuelto, en proceso, etc.). */
  | "NO_LIQUIDADO"
  /** La clave existe en Banxico pero con otro monto (comprobante alterado). */
  | "MONTO_NO_COINCIDE"
  /** Pago de noche de hoy: Banxico lo registra con la fecha del día siguiente. */
  | "COMPROBANTE_NOCTURNO"
  | "NO_ENCONTRADO"
  /** Banxico pidió captcha o no respondió tras los reintentos. */
  | "BANXICO_NO_DISPONIBLE";

/** Estados del pago según Banxico (docs/banxico-cep.md §2.4). */
export type EstadoPago =
  | "LIQUIDADO"
  | "EN_PROCESO"
  | "DEVUELTO"
  | "EN_PROCESO_DEVOLUCION"
  | "CANCELADO"
  | "RECHAZADO"
  | "NO_LIQUIDADO"
  | "RETORNADO"
  | "NO_ENCONTRADO"
  | "ERROR";

export type CriterioBusqueda = "CLAVE_RASTREO" | "REFERENCIA";

/** Un pago tal como lo reporta la tabla de Banxico. */
export interface PagoBanxico {
  estado: EstadoPago;
  referencia: string | null;
  claveRastreo: string | null;
  emisor: string | null;
  receptor: string | null;
  cuentaBeneficiaria: string | null;
  monto: string | null;
  fechaRecepcion: string | null;
  fechaProcesamiento: string | null;
}

/** Registro de cada consulta hecha a Banxico. */
export interface IntentoBanxico {
  /** dd-MM-yyyy */
  fecha: string;
  criterio: CriterioBusqueda;
  valorCriterio: string;
  cuenta: string;
  emisor: string;
  receptor: string;
  /**
   * Estado del pago encontrado, o qué pasó con el intento: CAPTCHA (Banxico limitó), ERROR_RED,
   * VARIOS_PAGOS (la referencia devolvió varios pagos sin poder elegir uno) u OMITIDO (el banco
   * no existe en el catálogo de esa fecha).
   */
  resultado: EstadoPago | "CAPTCHA" | "ERROR_RED" | "VARIOS_PAGOS" | "OMITIDO";
  detalle?: string;
  /** Consulta de detección temprana: solo con la clave, o con la clave y el monto (sin cuenta). */
  sondeo?: "SIN_CUENTA_NI_MONTO" | "SIN_CUENTA";
}

/** Una regla evaluada (para mostrar en la CLI). */
export interface ReglaAplicada {
  regla: string;
  paso: boolean;
  detalle?: string;
}
