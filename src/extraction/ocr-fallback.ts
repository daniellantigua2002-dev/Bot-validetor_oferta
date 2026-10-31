/**
 * Respaldo local con Tesseract (español) cuando NVIDIA no está disponible.
 * Cada lectura es un proceso `tesseract` aparte: al terminar, el sistema recupera toda su memoria (con
 * Tesseract.js el motor vivía dentro del bot y la memoria iba creciendo). El modelo es el mismo de
 * Tesseract.js (4.0.0_best_int de @tesseract.js-data/spa), que deja npm run preparar-tessdata en TESSDATA_DIR.
 * El texto reconocido se convierte en campos con extraerDeTexto().
 */
import sharp from "sharp";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { entorno } from "../entorno.js";
import { extraerDeTexto } from "./campos-texto.js";
import type { DatosExtraidos } from "./schema.js";

const ANCHO_MAXIMO_OCR = 3200;
const UMBRAL_BINARIZACION = 165;
/** Brillo medio por debajo del cual se considera una captura en modo oscuro. */
const BRILLO_MODO_OSCURO = 110;
/** Si Tesseract tarda más que esto en una lectura, se mata el proceso. */
const LIMITE_LECTURA_MS = 20_000;

/** Modos de segmentación de página de Tesseract (--psm). */
const PSM_BLOQUE = 6; // la página como un solo bloque de texto
const PSM_AUTO = 3; // segmentación automática

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

/** Proceso de la lectura en curso (para poder matarlo al cerrar). */
let enCurso: ChildProcess | null = null;

/** Imagen por stdin, texto por stdout. */
function ejecutarTesseract(imagen: Buffer, psm: number): Promise<string> {
  return new Promise((resolver, rechazar) => {
    const args = ["stdin", "stdout", "-l", "spa", "--oem", "1", "--psm", String(psm), "--tessdata-dir", resolve(entorno.tessdataDir)];
    // Con un solo hilo es más rápido: con varios, OpenMP gasta más en coordinarlos de lo que gana.
    const proceso = spawn(entorno.tesseractCmd, args, { env: { ...process.env, OMP_THREAD_LIMIT: "1" }, windowsHide: true });
    enCurso = proceso;
    const salida: Buffer[] = [];
    const errores: Buffer[] = [];
    let vencido = false;
    const limite = setTimeout(() => {
      vencido = true;
      proceso.kill("SIGKILL");
    }, LIMITE_LECTURA_MS);
    const fin = () => {
      clearTimeout(limite);
      if (enCurso === proceso) enCurso = null;
    };
    proceso.stdout.on("data", (b: Buffer) => salida.push(b));
    proceso.stderr.on("data", (b: Buffer) => errores.push(b));
    // No se pudo iniciar (por ejemplo, Tesseract no está instalado).
    proceso.on("error", (e) => {
      fin();
      rechazar(new Error(`No se pudo ejecutar Tesseract (${entorno.tesseractCmd}): ${e.message}`));
    });
    proceso.on("close", (codigo, senal) => {
      fin();
      const stderr = Buffer.concat(errores).toString("utf8").trim();
      if (vencido) rechazar(new Error(`Tesseract tardó más de ${LIMITE_LECTURA_MS / 1000} s`));
      else if (codigo !== 0) rechazar(new Error(`Tesseract terminó con ${codigo ?? senal}${stderr ? `: ${stderr}` : ""}`));
      // En Windows, Tesseract escribe los saltos de línea como \r\n.
      else resolver(Buffer.concat(salida).toString("utf8").replace(/\r\n/g, "\n"));
    });
    // Si el proceso muere antes de leer toda la imagen, escribir da EPIPE: el error ya lo informa "close".
    proceso.stdin.on("error", () => undefined);
    proceso.stdin.end(imagen);
  });
}

/** Las lecturas van una detrás de otra: un solo proceso de Tesseract a la vez. */
let turno: Promise<unknown> = Promise.resolve();

function leer(imagen: Buffer, psm: number): Promise<string> {
  const lectura = turno.then(() => ejecutarTesseract(imagen, psm));
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
  const texto = await leer(preparada, PSM_BLOQUE);
  if (extraerDeTexto(texto).monto !== null) return texto;
  const conImporte = (await leer(preparada, PSM_AUTO)).split("\n").filter((l) => /\$\s?\d/.test(l));
  return conImporte.length ? `${texto}\n${conImporte.join("\n")}` : texto;
}

/** OCR + expresiones regulares. */
export async function extraerConOcr(imagen: Buffer): Promise<{ datos: DatosExtraidos; texto: string }> {
  const texto = await reconocerTexto(imagen);
  return { datos: extraerDeTexto(texto), texto };
}

/** Mata la lectura en curso, si la hay (al terminar la CLI, el bot o los tests). */
export async function terminarOcr(): Promise<void> {
  enCurso?.kill("SIGKILL");
  enCurso = null;
}
