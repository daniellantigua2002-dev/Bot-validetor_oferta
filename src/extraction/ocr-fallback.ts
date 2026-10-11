/**
 * Respaldo local con Tesseract.js (español) cuando NVIDIA no está disponible.
 * El texto reconocido se convierte en campos con extraerDeTexto().
 */
import sharp from "sharp";
import { createWorker, PSM, type Worker } from "tesseract.js";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { extraerDeTexto } from "./campos-texto.js";
import type { DatosExtraidos } from "./schema.js";

/** Carpeta donde Tesseract guarda el modelo de idioma descargado (spa.traineddata). */
const CACHE_TESSERACT = resolve(".cache/tesseract");
const ANCHO_MAXIMO_OCR = 3200;
const UMBRAL_BINARIZACION = 165;
/** Brillo medio por debajo del cual se considera una captura en modo oscuro. */
const BRILLO_MODO_OSCURO = 110;

/** Escala de grises, inversión si es modo oscuro, ×2 y umbral. */
export async function preprocesarParaOcr(imagen: Buffer): Promise<Buffer> {
  const gris = await sharp(imagen).rotate().grayscale().toBuffer();
  const { channels } = await sharp(gris).stats();
  const { width = 1000 } = await sharp(gris).metadata();
  let p = sharp(gris);
  if ((channels[0]?.mean ?? 255) < BRILLO_MODO_OSCURO) p = p.negate({ alpha: false });
  return p
    .resize({ width: Math.min(width * 2, ANCHO_MAXIMO_OCR) })
    .normalise()
    .threshold(UMBRAL_BINARIZACION)
    .png()
    .toBuffer();
}

let worker: Promise<Worker> | null = null;

function obtenerWorker(): Promise<Worker> {
  if (!worker) {
    mkdirSync(CACHE_TESSERACT, { recursive: true });
    worker = createWorker("spa", undefined, { cachePath: CACHE_TESSERACT }).catch((e) => {
      worker = null;
      throw e;
    });
  }
  return worker;
}

/** Las lecturas van una detrás de otra: cada una fija su modo antes de leer. */
let turno: Promise<unknown> = Promise.resolve();

function leer(imagen: Buffer, modo: PSM): Promise<string> {
  const lectura = turno.then(async () => {
    const w = await obtenerWorker();
    await w.setParameters({ tessedit_pageseg_mode: modo });
    const { data } = await w.recognize(imagen);
    return data.text;
  });
  turno = lectura.catch(() => undefined);
  return lectura;
}

/**
 * Texto reconocido en la imagen. Se lee la página como un solo bloque (el modo de siempre); si así
 * no aparece el monto, se lee otra vez en modo automático, que sí ve los montos en letra muy grande
 * ("$ 690 MXN" de Mercado Pago), y se agregan solo los renglones con importe.
 */
export async function reconocerTexto(imagen: Buffer): Promise<string> {
  const preparada = await preprocesarParaOcr(imagen);
  const texto = await leer(preparada, PSM.SINGLE_BLOCK);
  if (extraerDeTexto(texto).monto !== null) return texto;
  const conImporte = (await leer(preparada, PSM.AUTO)).split("\n").filter((l) => /\$\s?\d/.test(l));
  return conImporte.length ? `${texto}\n${conImporte.join("\n")}` : texto;
}

/** OCR + expresiones regulares. */
export async function extraerConOcr(imagen: Buffer): Promise<{ datos: DatosExtraidos; texto: string }> {
  const texto = await reconocerTexto(imagen);
  return { datos: extraerDeTexto(texto), texto };
}

/** Libera el worker de Tesseract (al terminar la CLI o los tests). */
export async function terminarOcr(): Promise<void> {
  if (!worker) return;
  const w = await worker.catch(() => null);
  worker = null;
  await w?.terminate();
}
