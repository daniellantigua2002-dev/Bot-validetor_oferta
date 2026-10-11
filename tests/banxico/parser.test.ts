import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { decodificarEntidades, estadoDesdeTexto, parsearRespuesta } from "../../src/banxico/parser.js";

const fixture = (nombre: string) => readFileSync(new URL(`../fixtures/banxico/${nombre}`, import.meta.url), "utf8");

describe("parsearRespuesta con respuestas reales de Banxico", () => {
  it("tabla vertical con cuenta y monto (Spin → Banorte)", () => {
    expect(parsearRespuesta(fixture("valida-consulta-encontrado-spin-banorte.html"))).toEqual({
      tipo: "PAGOS",
      pagos: [
        {
          estado: "LIQUIDADO",
          referencia: "7454748",
          claveRastreo: "SPIN-20261008200443959PNEB9",
          emisor: "SPIN BY OXXO",
          receptor: "BANORTE",
          cuentaBeneficiaria: "072650010004755884",
          monto: "400.00",
          fechaRecepcion: "08/10/2026 14:04:47",
          fechaProcesamiento: "08/10/2026 14:04:48",
        },
      ],
    });
  });

  it("tabla vertical con clave mixta (Klar → Banamex) y con tarjeta (Azteca → Inbursa)", () => {
    const klar = parsearRespuesta(fixture("valida-consulta-encontrado-klar-banamex.html"));
    expect(klar).toMatchObject({ tipo: "PAGOS", pagos: [{ claveRastreo: "27SsrAVomLDdm0HAqpDehA", monto: "1352.00", emisor: "KLAR" }] });
    const azteca = parsearRespuesta(fixture("valida-consulta-encontrado-azteca-inbursa.html"));
    expect(azteca).toMatchObject({ tipo: "PAGOS", pagos: [{ cuentaBeneficiaria: "4658280004936574", estado: "LIQUIDADO" }] });
  });

  it("sin cuenta ni monto la tabla no trae esas filas", () => {
    const r = parsearRespuesta(fixture("valida-consulta-encontrado-sin-cuenta-monto.html"));
    expect(r).toMatchObject({ tipo: "PAGOS", pagos: [{ cuentaBeneficiaria: null, monto: null, estado: "LIQUIDADO" }] });
  });

  it("tabla horizontal: varios pagos con la misma referencia", () => {
    const r = parsearRespuesta(fixture("valida-consulta-varios-pagos-referencia.html"));
    expect(r.tipo).toBe("PAGOS");
    if (r.tipo !== "PAGOS") return;
    expect(r.pagos).toHaveLength(2);
    expect(r.pagos.map((p) => p.claveRastreo)).toEqual(["261008011286812472I", "261008011287636711I"]);
    expect(r.pagos[1]).toEqual({
      estado: "LIQUIDADO",
      referencia: "4936574",
      claveRastreo: "261008011287636711I",
      emisor: "AZTECA",
      receptor: "INBURSA",
      cuentaBeneficiaria: "4658280004936574",
      monto: "890.00",
      fechaRecepcion: "08/10/2026 17:11:34",
      fechaProcesamiento: "08/10/2026 17:11:35",
    });
  });

  it("no encontrado (el mensaje también viene comentado y se ignora el comentario)", () => {
    expect(parsearRespuesta(fixture("valida-no-encontrado-consulta.html"))).toMatchObject({ tipo: "NO_ENCONTRADO" });
    const r = parsearRespuesta(fixture("valida-no-encontrado-descarga.html"));
    expect(r).toMatchObject({ tipo: "NO_ENCONTRADO" });
    expect(r.tipo === "NO_ENCONTRADO" && r.mensaje).toMatch(/^Lo sentimos/);
  });

  it("captcha requerido", () => {
    expect(parsearRespuesta(fixture("valida-error-captcha-requerido.html"))).toEqual({
      tipo: "CAPTCHA",
      mensaje: "La imagen de seguridad no fue ingresada correctamente. Favor de validar.",
    });
    expect(parsearRespuesta(fixture("valida-error-captcha.html")).tipo).toBe("CAPTCHA");
  });

  it.each([
    ["valida-error-fecha.html", "La fecha ingresada es inválida. Favor de verificar."],
    ["valida-error-instituciones-iguales.html", "Las instituciones financieras emisora y receptora seleccionadas son iguales y deben ser diferentes. Favor de verificar."],
    ["valida-error-sin-criterio.html", "No existe un tipo de criterio"],
  ])("error de validación: %s", (archivo, mensaje) => {
    expect(parsearRespuesta(fixture(archivo))).toEqual({ tipo: "ERROR", mensaje });
  });

  it("CEP disponible (Descargar CEP)", () => {
    expect(parsearRespuesta(fixture("valida-descarga-disponible.html"))).toEqual({ tipo: "CEP_DISPONIBLE" });
  });

  it("HTML desconocido → ERROR", () => {
    expect(parsearRespuesta("<html>mantenimiento</html>")).toMatchObject({ tipo: "ERROR" });
  });
});

describe("utilidades", () => {
  it("decodifica entidades HTML", () => {
    expect(decodificarEntidades("Instituci&oacute;n &#233; &#xF1; SPEI&reg;")).toBe("Institución é ñ SPEI®");
  });

  it.each([
    ["Liquidado", "LIQUIDADO"],
    ["En proceso", "EN_PROCESO"],
    ["En proceso de devolución", "EN_PROCESO_DEVOLUCION"],
    ["No liquidado", "NO_LIQUIDADO"],
    ["Devuelto", "DEVUELTO"],
    ["Cancelado", "CANCELADO"],
    ["Rechazado", "RECHAZADO"],
    ["Retornado", "RETORNADO"],
    ["Algo raro", "ERROR"],
  ])("estado %s → %s", (texto, estado) => {
    expect(estadoDesdeTexto(texto)).toBe(estado);
  });
});
