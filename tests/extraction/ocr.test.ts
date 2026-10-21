/**
 * Prueba de integración con Tesseract real sobre comprobantes sintéticos.
 * La primera ejecución descarga el modelo de español a .cache/tesseract.
 */
import { afterAll, describe, expect, it } from "vitest";
import { extraerConOcr, terminarOcr } from "../../src/extraction/ocr-fallback.js";
import { imagenConTexto } from "../helpers/imagen-sintetica.js";
import { TEXTO_KLAR, TEXTO_SPIN } from "./textos-ocr.js";

afterAll(terminarOcr);

describe("OCR con Tesseract", () => {
  it("lee un comprobante claro (Spin)", { timeout: 180_000 }, async () => {
    const { datos } = await extraerConOcr(await imagenConTexto(TEXTO_SPIN.split("\n")));
    expect(datos).toMatchObject({
      esComprobante: true,
      bancoEmisor: { nombre: "Spin by OXXO" },
      cuentaDestino: "072000000000000012",
      claveRastreo: "SPIN-20261008200443959PNEB9",
      referencia: "7454748",
      fecha: "2026-10-08",
      monto: 400,
    });
  });

  it("lee una captura en modo oscuro (Klar)", { timeout: 180_000 }, async () => {
    const { datos } = await extraerConOcr(await imagenConTexto(TEXTO_KLAR.split("\n"), { oscuro: true }));
    // La clave mixta de Klar no se exige: el OCR confunde 0/O (por eso NVIDIA es la vía principal).
    expect(datos).toMatchObject({
      esComprobante: true,
      cuentaDestino: "012180001234567890",
      referencia: "5214022",
      fecha: "2026-09-22",
      monto: 1352,
    });
  });
});
