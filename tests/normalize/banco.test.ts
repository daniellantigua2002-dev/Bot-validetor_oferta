import { describe, expect, it } from "vitest";
import {
  bancoPorFirma,
  bancoPorReferencia,
  bancosEnLinea,
  detectarBancoPorClave,
  normalizarTexto,
  resolverBanco,
} from "../../src/normalize/banco.js";

describe("normalizarTexto", () => {
  it("quita acentos, signos y mayúsculas", () => {
    expect(normalizarTexto("  Nu México, S.A. ")).toBe("nu mexico s a");
  });
});

describe("resolverBanco", () => {
  it.each([
    ["Banco Azteca", "AZTECA"],
    ["AZTECA", "AZTECA"],
    ["CITIBANAMEX", "BANAMEX"],
    ["Citi Banamex", "BANAMEX"],
    ["Nu México", "NU"],
    ["NUBANK", "NU"],
    ["NU MEXICO", "NU"],
    ["BBVA Bancomer", "BBVA"],
    ["BBVA MEXICO", "BBVA"],
    ["Spin by OXXO", "SPIN"],
    ["Mercado Pago W", "MERCADO_PAGO"],
    ["HEY, BANCO", "HEY_BANCO"],
    ["Ualá", "UALA"],
    ["ABC CAPITAL", "UALA"],
  ])("%s → %s", (nombre, esperado) => {
    expect(resolverBanco(nombre)).toBe(esperado);
  });

  it.each([[""], [null], ["Banco Multiva"], ["CITI MEXICO"], ["Banco"]])("%s → null", (nombre) => {
    expect(resolverBanco(nombre)).toBeNull();
  });
});

describe("bancosEnLinea", () => {
  it("cuenta cada banco una vez y prefiere el alias más largo", () => {
    expect(bancosEnLinea("Spin by OXXO")).toEqual(["SPIN"]);
    expect(bancosEnLinea("BANORTE - 072000000000000012")).toEqual(["BANORTE"]);
    expect(bancosEnLinea("De Banco Azteca a Inbursa")).toEqual(["AZTECA", "INBURSA"]);
  });

  it("no confunde palabras que contienen un alias", () => {
    expect(bancosEnLinea("Nueva transferencia número 5")).toEqual([]);
  });
});

describe("detectarBancoPorClave", () => {
  it.each([
    ["MBAN01002610080012345678", "BBVA"],
    ["MBANO1002610080012345678", "BBVA"],
    ["SPIN-20261008200443959PNEB9", "SPIN"],
    ["261008011287636711I", "AZTECA"],
    ["2026100640014TRAPP020406130600", "SANTANDER"],
  ])("%s → %s", (clave, esperado) => {
    expect(detectarBancoPorClave(clave)).toBe(esperado);
  });

  it("respeta mayúsculas y devuelve null si no reconoce la clave", () => {
    expect(detectarBancoPorClave("spin-20261008200443959pneb9")).toBeNull();
    expect(detectarBancoPorClave("27SsrAVomLDdm0HAqpDehA")).toBeNull();
    expect(detectarBancoPorClave(null)).toBeNull();
  });
});

describe("firmas y patrones de los comprobantes reales", () => {
  it("bancoPorFirma reconoce el diseño aunque no diga el nombre del banco", () => {
    expect(bancoPorFirma("¡Tu transferencia fue exitosa!\nTransferir a otros\nEnvié $300.00")).toBe("BANORTE");
    expect(bancoPorFirma("Ref. SuperMóvil 3315988")).toBe("SANTANDER");
    expect(bancoPorFirma("Cuenta origen\nCUENTA EFECTIVA DIGITAL *9091")).toBe("BANCOPPEL");
    expect(bancoPorFirma("Cuenta origen\nGuardadito ***2415")).toBe("AZTECA");
    expect(bancoPorFirma("Lugar o canal MBAN BANCA MOV")).toBe("BBVA");
    expect(bancoPorFirma("Transferencia\n$100.00")).toBeNull();
  });

  it("forma de la clave: BanCoppel, Citibanamex y Azteca con 19 dígitos", () => {
    expect(detectarBancoPorClave("50110910TRANSBPI19499334")).toBe("BANCOPPEL");
    expect(detectarBancoPorClave("085908810424327763")).toBe("BANAMEX");
    expect(detectarBancoPorClave("2610070111717922482H")).toBe("AZTECA");
  });

  it("bancoPorReferencia: los últimos 7 dígitos de una cuenta nuestra son el diseño de Azteca", () => {
    expect(bancoPorReferencia("8178789")).toBe("AZTECA"); // últimos 7 de la CLABE de Inbursa (…0708178789)
    expect(bancoPorReferencia("9395151")).toBe("AZTECA"); // últimos 7 de la CLABE de Citibanamex (…1849395151)
    expect(bancoPorReferencia("2309260")).toBeNull();
  });

  it("'NU' suelto dentro de un renglón no es Nu México (el OCR lee así otros logos)", () => {
    expect(bancosEnLinea("NU")).toEqual([]);
    expect(bancosEnLinea("Nu México")).toEqual(["NU"]);
    expect(resolverBanco("nu")).toBe("NU");
  });
});
