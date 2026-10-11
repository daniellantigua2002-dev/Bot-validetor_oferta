import { describe, expect, it } from "vitest";
import type { EvaluacionBanco } from "../../src/extraction/banco-emisor.js";
import type { ResultadoExtraccion } from "../../src/extraction/index.js";
import { aplicarNota, leerNota } from "../../src/extraction/nota.js";
import { normalizarDatos } from "../../src/normalize/index.js";
import type { DatosExtraidos } from "../../src/extraction/schema.js";
import { datosEjemplo } from "./datos.js";

// 10-oct-2026 01:00 en CDMX.
const HOY = new Date("2026-10-10T07:00:00Z");

describe("leerNota", () => {
  it("sin nota → null", () => {
    expect(leerNota(undefined)).toBeNull();
    expect(leerNota("   ")).toBeNull();
  });

  it("el ejemplo del formato: palabras clave separadas por coma", () => {
    expect(leerNota("ref 2309260, banco BBVA", HOY)).toEqual({
      datos: { referencia: "2309260", banco: "BBVA" },
      entendidos: ["ref 2309260", "banco BBVA"],
      noEntendidos: [],
    });
  });

  it("todas las palabras, en cualquier orden, con mayúsculas o dos puntos", () => {
    const nota = leerNota("Cuenta 1871, MONTO $1,032.50, clave: MBAN01002610090090453121, Fecha 09/10/2026, banco nu, ref 123", HOY);
    expect(nota?.datos).toEqual({
      cuentaDestino: "1871",
      monto: 1032.5,
      claveRastreo: "MBAN01002610090090453121",
      fecha: "2026-10-09",
      banco: "NU",
      referencia: "123",
    });
    expect(nota?.noEntendidos).toEqual([]);
  });

  it.each([
    ["09/10/2026", "2026-10-09"],
    ["9-10-26", "2026-10-09"],
    ["9/10", "2026-10-09"],
    ["31/12", "2025-12-31"], // sin año: si quedaría en el futuro, es del año pasado
    ["9 oct 2026", "2026-10-09"],
    ["8 de octubre de 2026", "2026-10-08"],
  ])("fecha %s → %s", (valor, iso) => {
    expect(leerNota(`fecha ${valor}`, HOY)?.datos.fecha).toBe(iso);
  });

  it.each([["400", 400], ["400.50", 400.5], ["$ 1,032.50", 1032.5], ["1032", 1032]])("monto %s → %d", (valor, monto) => {
    expect(leerNota(`monto ${valor}`, HOY)?.datos.monto).toBe(monto);
  });

  it("cuenta por terminación (con o sin punto) o por banco: se sabe la cuenta, no el número", () => {
    expect(leerNota("cuenta •1871", HOY)?.datos.cuentaDestino).toBe("1871");
    expect(leerNota("cuenta Banorte", HOY)).toEqual({ datos: { cuentaBanco: "BANORTE" }, entendidos: ["cuenta Banorte"], noEntendidos: [] });
    expect(leerNota("cuenta citibanamex", HOY)?.datos).toEqual({ cuentaBanco: "BANAMEX" });
    expect(leerNota("cuenta inbursa", HOY)?.datos).toEqual({ cuentaBanco: "INBURSA" });
  });

  it("cuenta de un banco donde no tenemos cuenta: no se entiende", () => {
    expect(leerNota("cuenta BBVA", HOY)).toMatchObject({ datos: {}, noEntendidos: ["cuenta BBVA"] });
  });

  it("si se escribe la cuenta dos veces, vale la última", () => {
    expect(leerNota("cuenta 1871, cuenta Banorte", HOY)?.datos).toEqual({ cuentaBanco: "BANORTE" });
    expect(leerNota("cuenta Banorte, cuenta 1871", HOY)?.datos).toEqual({ cuentaDestino: "1871" });
  });

  it("lo que no se entiende se devuelve tal cual, sin perder lo demás", () => {
    expect(leerNota("pago de Juan, mont 400, fecha 32/13/2026, ref 12345678, banco Patito, monto 400", HOY)).toEqual({
      datos: { monto: 400 },
      entendidos: ["monto $400.00"],
      noEntendidos: ["pago de Juan", "mont 400", "fecha 32/13/2026", "ref 12345678", "banco Patito"],
    });
  });

  it("también acepta un dato por renglón", () => {
    expect(leerNota("fecha 09/10/2026\nref 2309260", HOY)?.datos).toEqual({ fecha: "2026-10-09", referencia: "2309260" });
  });
});

const bancoBbva: EvaluacionBanco = {
  banco: "BBVA",
  nombreLibre: null,
  suficiente: true,
  senales: { modelo: "BBVA", texto: "BBVA", clave: "BBVA", firma: null },
  candidatos: ["BBVA"],
  motivo: "prueba",
};
const lectura = (cambios: Partial<DatosExtraidos> = {}, banco = bancoBbva): ResultadoExtraccion => ({
  datos: datosEjemplo(cambios),
  origen: "nvidia",
  textoOcr: null,
  banco,
});

describe("aplicarNota", () => {
  it("completa lo que no aparece en la imagen, sin avisos", () => {
    const e = aplicarNota(lectura({ fecha: null, referencia: null }), { fecha: "2026-10-09", referencia: "2309260" });
    expect(e.datos).toMatchObject({ fecha: "2026-10-09", referencia: "2309260" });
    expect(e.notaAplicada).toEqual({ diferencias: [] });
  });

  it("la nota manda sobre la imagen, y se anota la diferencia para avisar", () => {
    const e = aplicarNota(lectura({ monto: 400, fecha: "2026-10-08" }), { monto: 500, fecha: "2026-10-09" });
    expect(e.datos).toMatchObject({ monto: 500, fecha: "2026-10-09" });
    expect(e.notaAplicada?.diferencias).toEqual([
      { campo: "fecha", nota: "09/10/2026", imagen: "08/10/2026" },
      { campo: "monto", nota: "$500.00", imagen: "$400.00" },
    ]);
    // La fecha de la imagen se guarda para probarla después de la de la nota; el monto, por si Banxico
    // tiene la clave con otro monto.
    expect(e.notaAplicada?.fechaImagen).toBe("2026-10-08");
    expect(e.notaAplicada?.montoImagen).toBe(400);
  });

  it("el mismo monto en la nota y en la imagen no se guarda como otro monto posible", () => {
    const e = aplicarNota(lectura({ monto: 400 }), { monto: 400 });
    expect(e.notaAplicada).toEqual({ diferencias: [] });
  });

  it("el mismo dato escrito de otra forma no es diferencia (clave MBANO/MBAN0, cuenta Banorte = tarjeta …1871)", () => {
    const e = aplicarNota(lectura({ claveRastreo: "MBANO1002610090090453121", cuentaDestino: "1871" }), {
      claveRastreo: "MBAN01002610090090453121",
      cuentaDestino: "072650010004755884",
    });
    expect(e.notaAplicada?.diferencias).toEqual([]);
  });

  describe("'cuenta Banorte': se sabe la cuenta, no el número", () => {
    it("sin número en la imagen: queda el banco destino para probar todos los números de esa cuenta", () => {
      const e = aplicarNota(lectura({ cuentaDestino: null, bancoDestino: null }), { cuentaBanco: "BANORTE" });
      expect(e.datos).toMatchObject({ cuentaDestino: null, bancoDestino: "Banorte" });
      expect(e.notaAplicada?.diferencias).toEqual([]);
    });

    it("la imagen muestra un número de esa misma cuenta (…1871): se conserva, es más preciso", () => {
      const e = aplicarNota(lectura({ cuentaDestino: "1871" }), { cuentaBanco: "BANORTE" });
      expect(e.datos).toMatchObject({ cuentaDestino: "1871", bancoDestino: "Banorte" });
      expect(e.notaAplicada?.diferencias).toEqual([]);
    });

    it("vale para cualquiera de nuestros bancos (BanCoppel …4988)", () => {
      const e = aplicarNota(lectura({ cuentaDestino: "4988" }), { cuentaBanco: "BANCOPPEL" });
      expect(e.datos).toMatchObject({ cuentaDestino: "4988", bancoDestino: "BanCoppel" });
    });

    it("la imagen muestra otra cuenta (nuestra o ajena): la nota manda y se avisa la diferencia", () => {
      const nuestra = aplicarNota(lectura({ cuentaDestino: "5884" }), { cuentaBanco: "INBURSA" });
      expect(nuestra.datos).toMatchObject({ cuentaDestino: null, bancoDestino: "Inbursa" });
      expect(nuestra.notaAplicada?.diferencias).toEqual([{ campo: "cuenta", nota: "Inbursa", imagen: "…5884" }]);
      const ajena = aplicarNota(lectura({ cuentaDestino: "8852" }), { cuentaBanco: "BANCOPPEL" });
      expect(ajena.datos).toMatchObject({ cuentaDestino: null, bancoDestino: "BanCoppel" });
      expect(ajena.notaAplicada?.diferencias).toEqual([{ campo: "cuenta", nota: "BanCoppel", imagen: "…8852" }]);
    });
  });

  it("el banco de la nota decide el banco emisor aunque la imagen no lo dejara claro", () => {
    const dudoso: EvaluacionBanco = { ...bancoBbva, banco: null, suficiente: false, candidatos: ["BBVA", "NU"] };
    const e = aplicarNota(lectura({}, dudoso), { banco: "NU" });
    expect(e.banco).toMatchObject({ banco: "NU", suficiente: true, candidatos: ["NU"] });
    expect(e.notaAplicada?.diferencias).toEqual([]);
  });

  it("un banco distinto al que se ve en la imagen se avisa", () => {
    const e = aplicarNota(lectura(), { banco: "NU" });
    expect(e.notaAplicada?.diferencias).toEqual([{ campo: "banco", nota: "Nu México", imagen: "BBVA" }]);
  });

  it("la ref escrita manda sobre la de Mercado Pago (últimos 7 dígitos del número de comprobante)", () => {
    const e = aplicarNota(lectura({ esMercadoPago: true, numeroOperacion: "#182949974794", referencia: null }), {
      referencia: "1234567",
    });
    expect(normalizarDatos(e.datos).referencia).toBe("1234567");
  });

  it("la clave escrita manda sobre la CPO de Mercado Pago, y la referencia de 7 dígitos queda de respaldo", () => {
    const e = aplicarNota(lectura({ esMercadoPago: true, numeroOperacion: "#182949974794", claveRastreo: null, referencia: null }), {
      claveRastreo: "ABC123456",
    });
    expect(normalizarDatos(e.datos)).toMatchObject({ claveRastreo: "ABC123456", referencia: "9974794" });
  });

  it("si ya se aplicó, no se vuelve a aplicar (respuesta a una pregunta de banco o cuenta)", () => {
    const una = aplicarNota(lectura({ monto: 400 }), { monto: 500 });
    expect(aplicarNota(una, { monto: 500 })).toBe(una);
  });
});
