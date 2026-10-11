import { describe, expect, it } from "vitest";
import { evaluarBancoEmisor } from "../../src/extraction/banco-emisor.js";
import { datosEjemplo } from "./datos.js";
import { extraerDeTexto } from "../../src/extraction/campos-texto.js";
import { TEXTO_AZTECA, TEXTO_BBVA, TEXTO_KLAR, TEXTO_MERCADO_PAGO_TRANSFERENCIA, TEXTO_SANTANDER, TEXTO_SPIN } from "./textos-ocr.js";

const banco = (nombre: string | null, confianza = 0.95) =>
  ({ nombre, fuente: nombre ? "logo" : "desconocido", confianza }) as const;

describe("evaluarBancoEmisor", () => {
  it("3 señales coinciden (modelo, texto y clave)", () => {
    const r = evaluarBancoEmisor(datosEjemplo(), TEXTO_SPIN, "nvidia");
    expect(r).toMatchObject({ banco: "SPIN", suficiente: true, senales: { modelo: "SPIN", texto: "SPIN", clave: "SPIN" } });
  });

  it("Santander con un renglón 'Banco BANORTE' (destino): logo y texto coinciden, no pregunta", () => {
    const datos = datosEjemplo({ bancoEmisor: banco("Santander", 0.98), claveRastreo: null, referencia: "3315988" });
    const r = evaluarBancoEmisor(datos, TEXTO_SANTANDER, "nvidia");
    expect(r).toMatchObject({ banco: "SANTANDER", suficiente: true, senales: { modelo: "SANTANDER", texto: "SANTANDER" } });
  });

  it("2 contra 1: gana la mayoría", () => {
    const datos = datosEjemplo({ bancoEmisor: banco("Banco Azteca"), claveRastreo: "SPIN-2026" });
    const r = evaluarBancoEmisor(datos, TEXTO_AZTECA, "nvidia");
    expect(r).toMatchObject({ banco: "AZTECA", suficiente: true });
  });

  it("señales contradictorias sin mayoría → requiere confirmación con candidatos", () => {
    const datos = datosEjemplo({ bancoEmisor: banco("BBVA"), claveRastreo: "261008011287636711I" });
    const r = evaluarBancoEmisor(datos, "Banco Spin\nTransferencia", "nvidia");
    expect(r.suficiente).toBe(false);
    expect(r.candidatos.sort()).toEqual(["AZTECA", "BBVA", "SPIN"]);
    expect(r.motivo).toContain("contradictorias");
  });

  it("solo el modelo: depende de su confianza", () => {
    const datos = (c: number) => datosEjemplo({ bancoEmisor: banco("Klar", c), claveRastreo: "27SsrAVomLDdm0HAqpDehA" });
    expect(evaluarBancoEmisor(datos(0.9), TEXTO_KLAR, "nvidia")).toMatchObject({ banco: "KLAR", suficiente: true });
    expect(evaluarBancoEmisor(datos(0.5), TEXTO_KLAR, "nvidia")).toMatchObject({ banco: "KLAR", suficiente: false });
  });

  it("solo la clave de rastreo basta", () => {
    const datos = datosEjemplo({ bancoEmisor: banco(null, 0), claveRastreo: "MBAN01002610080012345678" });
    expect(evaluarBancoEmisor(datos, null, "nvidia")).toMatchObject({ banco: "BBVA", suficiente: true });
  });

  it("en el respaldo OCR no cuenta dos veces el texto (texto + clave = 2 señales)", () => {
    const datos = datosEjemplo({ bancoEmisor: banco("BBVA", 0.5), claveRastreo: "MBANO1002610080012345678" });
    const r = evaluarBancoEmisor(datos, TEXTO_BBVA, "ocr");
    expect(r).toMatchObject({ banco: "BBVA", suficiente: true, senales: { modelo: null, texto: "BBVA", clave: "BBVA" } });
  });

  it("en el respaldo OCR, solo el texto no basta", () => {
    const datos = datosEjemplo({ bancoEmisor: banco("Banco Azteca", 0.5), claveRastreo: null });
    expect(evaluarBancoEmisor(datos, "Banco Azteca\nTransferencia\n$100.00", "ocr")).toMatchObject({ banco: "AZTECA", suficiente: false });
  });

  it("en el respaldo OCR, el texto y el diseño del comprobante (firma) bastan", () => {
    const datos = datosEjemplo({ bancoEmisor: banco("Banco Azteca", 0.5), claveRastreo: null });
    expect(evaluarBancoEmisor(datos, TEXTO_AZTECA, "ocr")).toMatchObject({
      banco: "AZTECA",
      suficiente: true,
      senales: { texto: "AZTECA", firma: "AZTECA" },
    });
  });

  it("el texto que nombra al banco destino (según la IA) no contradice al logo (Santander → Banorte)", () => {
    const datos = datosEjemplo({ bancoEmisor: banco("Santander", 0.95), bancoDestino: "BANORTE - TDD **1871", claveRastreo: null });
    const r = evaluarBancoEmisor(datos, "Cuenta origen CTA **9087\nBanco BANORTE", "nvidia");
    expect(r).toMatchObject({ banco: "SANTANDER", suficiente: true, senales: { modelo: "SANTANDER", texto: null } });
  });

  it("la firma sola basta (comprobante sin el nombre del banco)", () => {
    const datos = datosEjemplo({ bancoEmisor: banco(null, 0), claveRastreo: null });
    const texto = "Transferencia exitosa\nMonto transferido\nOrigen Cuenta de Ahorro •2929\nDestino alejandro •8798";
    expect(evaluarBancoEmisor(datos, texto, "ocr")).toMatchObject({ banco: "BBVA", suficiente: true, senales: { firma: "BBVA" } });
  });

  it("banco fuera del mapa con buena confianza → nombre libre para buscar en el catálogo", () => {
    const datos = datosEjemplo({ bancoEmisor: banco("Banco Multiva", 0.9), claveRastreo: null });
    expect(evaluarBancoEmisor(datos, null, "nvidia")).toMatchObject({
      banco: null,
      nombreLibre: "Banco Multiva",
      suficiente: true,
    });
  });

  it("Mercado Pago marcado aunque el modelo no dé el nombre", () => {
    const datos = datosEjemplo({ bancoEmisor: banco(null, 0.9), esMercadoPago: true, claveRastreo: null });
    expect(evaluarBancoEmisor(datos, null, "nvidia").senales.modelo).toBe("MERCADO_PAGO");
  });

  it("sin ninguna señal → no suficiente", () => {
    const datos = datosEjemplo({ bancoEmisor: banco(null, 0), claveRastreo: null });
    expect(evaluarBancoEmisor(datos, null, "nvidia")).toMatchObject({ banco: null, suficiente: false });
  });
});

describe("evaluarBancoEmisor: Mercado Pago solo con el OCR", () => {
  it("el texto y la clave CPO coinciden: banco suficiente (permite la ruta rápida)", () => {
    const datos = extraerDeTexto(TEXTO_MERCADO_PAGO_TRANSFERENCIA);
    expect(evaluarBancoEmisor(datos, TEXTO_MERCADO_PAGO_TRANSFERENCIA, "ocr")).toMatchObject({
      banco: "MERCADO_PAGO",
      suficiente: true,
      senales: { texto: "MERCADO_PAGO", clave: "MERCADO_PAGO" },
    });
  });
});
