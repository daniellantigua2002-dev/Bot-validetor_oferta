/**
 * Prueba la extracción (Fase 3) con una imagen real e imprime el resultado.
 *
 * Uso: npm run extraer -- ./tests/fixtures/comprobantes/x.jpg [--solo-ocr]
 */
import { readFileSync } from "node:fs";
import { extraerComprobante } from "../src/extraction/index.js";
import { extraerConModelos } from "../src/extraction/nvidia.js";
import { reconocerTexto, terminarOcr } from "../src/extraction/ocr-fallback.js";

const ruta = process.argv[2];
if (!ruta) {
  console.error("Uso: npm run extraer -- <imagen> [--solo-ocr]");
  process.exit(1);
}
const soloOcr = process.argv.includes("--solo-ocr");

try {
  const inicio = Date.now();
  const r = await extraerComprobante(readFileSync(ruta), {
    nvidia: soloOcr ? async () => Promise.reject(new Error("omitido por --solo-ocr")) : (img) => extraerConModelos(img),
    ocr: reconocerTexto,
  });
  console.log(`Origen de los datos: ${r.origen}${r.modelo ? ` (${r.modelo})` : ""}${r.errorNvidia ? ` (NVIDIA no disponible: ${r.errorNvidia})` : ""}`);
  console.log(`Tiempo: ${Date.now() - inicio} ms\n`);
  console.log("Datos extraídos:");
  console.log(JSON.stringify(r.datos, null, 2));
  console.log("\nBanco emisor:");
  console.log(JSON.stringify(r.banco, null, 2));
  console.log("\nTexto del OCR:\n" + (r.textoOcr ?? "(sin OCR)"));
} finally {
  await terminarOcr();
}
