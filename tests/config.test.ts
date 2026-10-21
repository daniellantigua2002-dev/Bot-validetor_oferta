import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { BANCOS, CUENTAS_DESTINO, REGLAS, type ClaveBanco, type DefinicionBanco } from "../src/config.js";
import { clabeValida, tarjetaValida } from "../src/normalize/validadores.js";

type Catalogo = { instituciones: [string, string][] };
const leerCatalogo = (archivo: string) =>
  new Map(
    (JSON.parse(readFileSync(new URL(`./fixtures/banxico/${archivo}`, import.meta.url), "utf8")) as Catalogo)
      .instituciones.map(([codigo, nombre]) => [nombre, codigo] as const),
  );
const catalogoActual = leerCatalogo("catalogo-08-10-2026.json");
const catalogo2024 = leerCatalogo("catalogo-15-06-2024.json");

const bancos = Object.entries(BANCOS) as [ClaveBanco, DefinicionBanco][];
const sinAcentos = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

describe("validadores", () => {
  it("valida el dígito de control de la CLABE", () => {
    expect(clabeValida("072000000000000012")).toBe(true);
    expect(clabeValida("072000000000000013")).toBe(false);
    expect(clabeValida("07200000000000001")).toBe(false);
  });

  it("valida tarjetas con Luhn", () => {
    expect(tarjetaValida("4189000000000013")).toBe(true);
    expect(tarjetaValida("4189000000000014")).toBe(false);
  });
});

describe("CUENTAS_DESTINO", () => {
  it.each(CUENTAS_DESTINO.map((c) => [c.banco, c] as const))("%s: datos coherentes", (_, cuenta) => {
    const banco: DefinicionBanco = BANCOS[cuenta.banco];
    expect(banco, "el banco debe existir en BANCOS").toBeDefined();
    expect(clabeValida(cuenta.clabe), "dígito de control de la CLABE").toBe(true);
    expect(cuenta.clabe.startsWith(banco.prefijoClabe ?? "-"), "la CLABE empieza con el prefijo del banco").toBe(true);
    if ("tarjeta" in cuenta) expect(tarjetaValida(cuenta.tarjeta), "Luhn de la tarjeta").toBe(true);
    if ("cuenta" in cuenta) expect(cuenta.cuenta).toMatch(/^\d+$/);
  });

  it("los bancos destino existen en el catálogo vigente de Banxico", () => {
    for (const c of CUENTAS_DESTINO) expect(catalogoActual.has(BANCOS[c.banco].catalogo[0]!)).toBe(true);
  });
});

describe("REGLAS", () => {
  it("tiene valores razonables", () => {
    expect(REGLAS.minDigitosTerminacion).toBeGreaterThanOrEqual(3);
    expect(REGLAS.diasHaciaAtras).toBeGreaterThanOrEqual(0);
    expect(REGLAS.pausaEntreConsultasMs).toBeGreaterThanOrEqual(1500);
  });
});

describe("BANCOS", () => {
  const conCatalogo = bancos.filter(([, b]) => b.catalogo.length > 0);

  it.each(conCatalogo)("%s: el nombre vigente existe en el catálogo actual", (_, banco) => {
    expect(catalogoActual.has(banco.catalogo[0]!)).toBe(true);
  });

  it.each(conCatalogo)("%s: los nombres históricos existen en algún catálogo", (_, banco) => {
    for (const nombre of banco.catalogo) expect(catalogoActual.has(nombre) || catalogo2024.has(nombre), nombre).toBe(true);
  });

  it.each(conCatalogo.filter(([, b]) => b.prefijoClabe))(
    "%s: el prefijo de CLABE coincide con el código de Banxico",
    (_, banco) => {
      const codigo = catalogoActual.get(banco.catalogo[0]!)!;
      expect(codigo.slice(-3)).toBe(banco.prefijoClabe);
    },
  );

  it("ningún alias apunta a dos bancos", () => {
    const vistos = new Map<string, ClaveBanco>();
    for (const [clave, banco] of bancos) {
      for (const alias of banco.alias) {
        const a = sinAcentos(alias);
        expect(vistos.get(a), `alias "${alias}" repetido`).toBeUndefined();
        vistos.set(a, clave);
      }
    }
  });

  it("los alias se escriben en minúsculas y sin acentos", () => {
    for (const [, banco] of bancos) for (const alias of banco.alias) expect(alias).toBe(sinAcentos(alias));
  });

  it("incluye todos los bancos pedidos", () => {
    const requeridos: ClaveBanco[] = [
      "BBVA", "AZTECA", "SPIN", "NU", "MERCADO_PAGO", "BANORTE", "INBURSA", "BANAMEX",
      "BANCOPPEL", "SANTANDER", "HSBC", "SCOTIABANK", "HEY_BANCO", "STORI", "KLAR", "OPENBANK",
    ];
    for (const r of requeridos) expect(BANCOS[r]).toBeDefined();
    expect(BANCOS.BBVA.prefijosClave).toContain("MBAN");
  });
});
