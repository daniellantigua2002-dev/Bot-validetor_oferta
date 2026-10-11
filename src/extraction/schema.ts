/**
 * Schema Zod del JSON que devuelve la extracción (modelo de visión u OCR de respaldo).
 */
import { z } from "zod";

export const FUENTES_BANCO = ["logo", "texto", "clave_rastreo", "desconocido"] as const;

export const DatosExtraidosSchema = z.object({
  esComprobante: z.boolean(),
  /** Logo, colores y diseño observados, antes de decidir el banco. */
  descripcionVisual: z.string(),
  bancoEmisor: z.object({
    nombre: z.string().nullable(),
    fuente: z.enum(FUENTES_BANCO),
    confianza: z.number().min(0).max(1),
  }),
  esMercadoPago: z.boolean(),
  /** Solo los dígitos visibles de la cuenta destino (completa o terminación). */
  cuentaDestino: z.string().nullable(),
  /**
   * Banco de la cuenta destino ("Banco destino: Banorte"). Sirve para saber a cuál de nuestras
   * cuentas fue el pago cuando el comprobante no muestra el número. Opcional: el modelo puede omitirlo.
   */
  bancoDestino: z.string().nullable().optional(),
  claveRastreo: z.string().nullable(),
  referencia: z.string().nullable(),
  /** Número de operación, por ejemplo "#182949974794" (Mercado Pago). */
  numeroOperacion: z.string().nullable(),
  /** Fecha ISO yyyy-mm-dd. */
  fecha: z.string().nullable(),
  hora: z.string().nullable(),
  monto: z.number().nullable(),
  beneficiario: z.string().nullable(),
});

export type DatosExtraidos = z.infer<typeof DatosExtraidosSchema>;
