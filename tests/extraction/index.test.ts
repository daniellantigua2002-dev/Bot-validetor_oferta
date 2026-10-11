import { describe, expect, it } from "vitest";
import { extraerComprobante } from "../../src/extraction/index.js";
import { ErrorExtraccion } from "../../src/extraction/nvidia.js";
import { datosEjemplo } from "./datos.js";
import { TEXTO_AZTECA, TEXTO_SPIN } from "./textos-ocr.js";

const imagen = Buffer.from("imagen");

describe("extraerComprobante", () => {
  it("usa NVIDIA cuando responde y el OCR como señal de texto", async () => {
    const r = await extraerComprobante(imagen, {
      nvidia: async () => ({ datos: datosEjemplo(), modelo: "modelo/prueba" }),
      ocr: async () => TEXTO_SPIN,
    });
    expect(r.origen).toBe("nvidia");
    expect(r.modelo).toBe("modelo/prueba");
    expect(r.datos).toEqual(datosEjemplo());
    expect(r.banco).toMatchObject({ banco: "SPIN", suficiente: true });
  });

  it("si NVIDIA falla, usa el OCR", async () => {
    const r = await extraerComprobante(imagen, {
      nvidia: async () => {
        throw new ErrorExtraccion("Falló la llamada a NVIDIA (HTTP 429)");
      },
      ocr: async () => TEXTO_AZTECA,
    });
    expect(r.origen).toBe("ocr");
    expect(r.errorNvidia).toContain("429");
    expect(r.datos).toMatchObject({ claveRastreo: "261008011287636711I", monto: 890, cuentaDestino: "574" });
    // Texto + patrón de clave de Azteca = 2 señales.
    expect(r.banco).toMatchObject({ banco: "AZTECA", suficiente: true });
  });

  it("NVIDIA funciona aunque el OCR falle", async () => {
    const r = await extraerComprobante(imagen, {
      nvidia: async () => ({ datos: datosEjemplo(), modelo: "modelo/prueba" }),
      ocr: async () => {
        throw new Error("sin OCR");
      },
    });
    expect(r).toMatchObject({ origen: "nvidia", textoOcr: null });
  });

  it("si fallan los dos, lanza un error con ambos motivos", async () => {
    await expect(
      extraerComprobante(imagen, {
        nvidia: async () => {
          throw new Error("sin red");
        },
        ocr: async () => {
          throw new Error("imagen corrupta");
        },
      }),
    ).rejects.toThrow(/sin red.*imagen corrupta/);
  });
});
