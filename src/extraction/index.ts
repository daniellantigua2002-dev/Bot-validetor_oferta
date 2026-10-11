/**
 * Extracción completa: imagen → datos del comprobante + evaluación del banco emisor.
 *
 * La IA (modelo principal y, si falla, el de respaldo) y el OCR local corren en paralelo:
 * - si la IA responde, sus datos mandan y el texto del OCR aporta la señal "texto" del banco;
 * - si la IA falla (red, 429, JSON inválido o sin API key), los datos salen del OCR.
 * El texto del OCR también queda disponible apenas termina, para la ruta rápida del pipeline.
 */
import { evaluarBancoEmisor, type EvaluacionBanco } from "./banco-emisor.js";
import { extraerDeTexto } from "./campos-texto.js";
import type { Diferencia } from "./nota.js";
import { extraerConModelos } from "./nvidia.js";
import { reconocerTexto } from "./ocr-fallback.js";
import type { DatosExtraidos } from "./schema.js";

export interface ResultadoExtraccion {
  datos: DatosExtraidos;
  origen: "nvidia" | "ocr";
  /** Modelo de NVIDIA que respondió (si origen es "nvidia"). */
  modelo?: string;
  textoOcr: string | null;
  banco: EvaluacionBanco;
  /** Motivo por el que no se usó NVIDIA, si aplica. */
  errorNvidia?: string;
  /** La cuenta que leyó la IA no era nuestra y se usó la que leyó el OCR (ver cuentaSegunOcr). */
  cuentaCorregida?: { ia: string | null; ocr: string };
  /** Campos que la IA dejó vacíos y se tomaron del OCR (ver completarConOcr). */
  completadoConOcr?: string[];
  /**
   * Ya se le aplicó la nota de la persona; `diferencias`: datos de la nota que contradicen la imagen.
   * `fechaImagen`: la fecha de la imagen cuando la nota trae otra (se prueba después de la de la nota).
   * `montoImagen`: el monto de la imagen cuando la nota trae otro (se prueba si Banxico no acepta el de la nota).
   */
  notaAplicada?: { diferencias: Diferencia[]; fechaImagen?: string; montoImagen?: number };
}

export interface DependenciasExtraccion {
  nvidia: (imagen: Buffer) => Promise<{ datos: DatosExtraidos; modelo: string }>;
  ocr: (imagen: Buffer) => Promise<string>;
}

const DEPENDENCIAS: DependenciasExtraccion = { nvidia: (img) => extraerConModelos(img), ocr: reconocerTexto };

export interface ExtraccionEnCurso {
  /** Texto del OCR (≈1–2 s). */
  ocr: Promise<string>;
  /** Resultado completo (espera a la IA). */
  completa: Promise<ResultadoExtraccion>;
}

/** Arranca la IA y el OCR en paralelo y devuelve ambas promesas. */
export function iniciarExtraccion(imagen: Buffer, deps: DependenciasExtraccion = DEPENDENCIAS): ExtraccionEnCurso {
  const nvidia = deps.nvidia(imagen);
  const ocr = deps.ocr(imagen);
  // Quien use solo una de las dos no debe provocar rechazos sin manejar.
  nvidia.catch(() => undefined);
  ocr.catch(() => undefined);

  const completa = (async (): Promise<ResultadoExtraccion> => {
    const [ia, texto] = await Promise.allSettled([nvidia, ocr]);
    const textoOcr = texto.status === "fulfilled" ? texto.value : null;

    if (ia.status === "fulfilled") {
      const { datos, modelo } = ia.value;
      return { datos, origen: "nvidia", modelo, textoOcr, banco: evaluarBancoEmisor(datos, textoOcr, "nvidia") };
    }

    const errorNvidia = (ia.reason as Error)?.message ?? String(ia.reason);
    if (textoOcr === null) {
      const errorOcr = (texto as PromiseRejectedResult).reason as Error;
      throw new Error(`No se pudo leer el comprobante. NVIDIA: ${errorNvidia}. OCR: ${errorOcr?.message ?? errorOcr}`);
    }
    const datos = extraerDeTexto(textoOcr);
    return { datos, origen: "ocr", textoOcr, banco: evaluarBancoEmisor(datos, textoOcr, "ocr"), errorNvidia };
  })();
  completa.catch(() => undefined);

  return { ocr, completa };
}

export async function extraerComprobante(
  imagen: Buffer,
  deps: DependenciasExtraccion = DEPENDENCIAS,
): Promise<ResultadoExtraccion> {
  return iniciarExtraccion(imagen, deps).completa;
}
