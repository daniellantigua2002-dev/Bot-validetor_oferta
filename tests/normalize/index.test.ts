import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  describirFechas,
  fechaDesdeClave,
  fechaParaBanxico,
  institucionDeBanco,
  institucionPorNombre,
  normalizarClaveRastreo,
  normalizarCuenta,
  normalizarDatos,
  normalizarFechaIso,
  normalizarHora,
  normalizarMonto,
  normalizarReferencia,
  claveDesdeOperacionMercadoPago,
  referenciaDesdeOperacionMercadoPago,
  referenciaHabitual,
  tieneReferenciaHabitual,
  type CatalogoInstituciones,
} from "../../src/normalize/index.js";
import { datosEjemplo } from "../extraction/datos.js";

const catalogo = (archivo: string): CatalogoInstituciones =>
  JSON.parse(readFileSync(new URL(`../fixtures/banxico/${archivo}`, import.meta.url), "utf8")).instituciones;
const cat2026 = catalogo("catalogo-08-10-2026.json");
const cat2024 = catalogo("catalogo-15-06-2024.json");

describe("normalizarClaveRastreo", () => {
  it("quita espacios y saltos de línea (clave partida en dos líneas)", () => {
    expect(normalizarClaveRastreo(" SPIN-20261008200443959\nPNEB9 ")).toBe("SPIN-20261008200443959PNEB9");
  });

  it("respeta mayúsculas y minúsculas (Banxico las distingue)", () => {
    expect(normalizarClaveRastreo("27SsrAVomLDdm0HAqpDehA")).toBe("27SsrAVomLDdm0HAqpDehA");
  });

  it("BBVA: MBANO (letra O) → MBAN0 (cero)", () => {
    expect(normalizarClaveRastreo("MBANO1002610080012345678")).toBe("MBAN01002610080012345678");
    expect(normalizarClaveRastreo("mban01002610080012345678")).toBe("MBAN01002610080012345678");
    expect(normalizarClaveRastreo("MBAN01002610080012345678")).toBe("MBAN01002610080012345678");
  });

  it("vacía o nula → null", () => {
    expect(normalizarClaveRastreo("  ")).toBeNull();
    expect(normalizarClaveRastreo(null)).toBeNull();
  });
});

describe("Mercado Pago", () => {
  it("la clave de rastreo es CPO + el número de comprobante", () => {
    expect(claveDesdeOperacionMercadoPago("#182949974794")).toBe("CPO182949974794");
    expect(claveDesdeOperacionMercadoPago("#12345")).toBeNull();
  });

  it("la clave CPO va primero, aunque se haya leído otra clave; la referencia queda de respaldo", () => {
    const n = normalizarDatos(datosEjemplo({ esMercadoPago: true, numeroOperacion: "#182949974794", claveRastreo: "OTRA", referencia: null }));
    expect(n).toMatchObject({ claveRastreo: "CPO182949974794", origenClave: "mercado_pago", referencia: "9974794", origenReferencia: "mercado_pago" });
  });

  it("la referencia son los últimos 7 dígitos del número de comprobante", () => {
    expect(referenciaDesdeOperacionMercadoPago("#182949974794")).toBe("9974794");
    expect(referenciaDesdeOperacionMercadoPago("#12345")).toBeNull();
  });

  it("si el comprobante trae su referencia, esa manda", () => {
    const n = normalizarDatos(datosEjemplo({ esMercadoPago: true, numeroOperacion: "#182949974794", referencia: "1234567" }));
    expect(n).toMatchObject({ referencia: "1234567", origenReferencia: "comprobante" });
  });

  it("solo aplica si el comprobante es de Mercado Pago", () => {
    const n = normalizarDatos(datosEjemplo({ esMercadoPago: false, numeroOperacion: "#182949974794", referencia: null }));
    expect(n).toMatchObject({ claveRastreo: "SPIN-20261008200443959PNEB9", origenClave: "comprobante", referencia: null, origenReferencia: null });
  });
});

describe("monto, fecha, cuenta y referencia", () => {
  it.each([
    [1032, "1032.00"],
    [250.5, "250.50"],
    [0.1 + 0.2, "0.30"],
    [1352.999, "1353.00"],
    [0, null],
    [null, null],
  ])("monto %s → %s", (monto, esperado) => {
    expect(normalizarMonto(monto)).toBe(esperado);
  });

  it("fecha ISO → dd-MM-yyyy y descarta fechas inválidas", () => {
    expect(normalizarFechaIso("2026-10-08")).toBe("2026-10-08");
    expect(fechaParaBanxico("2026-10-08")).toBe("08-10-2026");
    expect(normalizarFechaIso("2026-02-30")).toBeNull();
    expect(normalizarFechaIso("08/10/2026")).toBeNull();
  });

  it("hora: 24 h con segundos", () => {
    expect(normalizarHora("16:52")).toBe("16:52:00");
    expect(normalizarHora("9:05:07")).toBe("09:05:07");
    expect(normalizarHora("25:00")).toBeNull();
    expect(normalizarHora(null)).toBeNull();
  });

  it("cuenta: solo dígitos", () => {
    expect(normalizarCuenta("Inbursa ***574")).toBe("574");
    expect(normalizarCuenta("0720 0000 0000 0000 12")).toBe("072000000000000012");
    expect(normalizarCuenta("***")).toBeNull();
  });

  it("referencia: hasta 7 dígitos", () => {
    expect(normalizarReferencia("4936574")).toBe("4936574");
    expect(normalizarReferencia("0012")).toBe("0012");
    expect(normalizarReferencia("12345678")).toBeNull();
  });

  it("normalizarDatos arma todo junto", () => {
    expect(normalizarDatos(datosEjemplo())).toEqual({
      claveRastreo: "SPIN-20261008200443959PNEB9",
      origenClave: "comprobante",
      referencia: "7454748",
      origenReferencia: "comprobante",
      monto: "400.00",
      fecha: "2026-10-08",
      fechaBanxico: "08-10-2026",
      hora: "14:04:43",
      cuentaDestino: "072000000000000012",
    });
  });
});

describe("fechaDesdeClave (la fecha que lleva la clave de rastreo, de los comprobantes reales)", () => {
  it.each([
    ["BBVA", "MBAN01002610090085509456", "2026-10-09"],
    ["BBVA", "MBAN0100261009008941", "2026-10-09"], // clave cortada por la imagen
    ["AZTECA", "261008011287636711I", "2026-10-08"],
    ["AZTECA", "2610070111717922482H", "2026-10-07"],
    ["SANTANDER", "2026100340014BMOVP020431647380", "2026-10-03"],
    ["SCOTIABANK", "2026100740044B36L0000501290024", "2026-10-07"],
    ["BANORTE", "38432P04202610075861381568", "2026-10-07"],
    ["COMPARTAMOS", "9095381180120261007212220", "2026-10-07"],
    ["SPIN", "SPIN-20261008200443959PNEB9", "2026-10-08"], // 20:04 UTC = 14:04 en CDMX
    ["SPIN", "SPIN-20261010031500959PNEB9", "2026-10-09"], // 03:15 UTC del 10 = 21:15 en CDMX del 9
  ] as const)("%s %s → %s", (banco, clave, fecha) => {
    expect(fechaDesdeClave(banco, clave)).toBe(fecha);
  });

  it("null si el banco no la lleva, si la clave no tiene esa forma o si la fecha no es válida", () => {
    expect(fechaDesdeClave("MERCADO_PAGO", "CPO181053611151")).toBeNull();
    expect(fechaDesdeClave("BBVA", "CPO181053611151")).toBeNull();
    expect(fechaDesdeClave("BBVA", "MBAN01002613450085509456")).toBeNull(); // mes 13
    expect(fechaDesdeClave("SPIN", "SPIN-20261008250443959PNEB9")).toBeNull(); // 25 h
    expect(fechaDesdeClave(null, "MBAN01002610090085509456")).toBeNull();
    expect(fechaDesdeClave("BBVA", null)).toBeNull();
  });
});

describe("describirFechas (para el mensaje de 'no encontrado')", () => {
  it("una fecha, días seguidos o fechas sueltas", () => {
    expect(describirFechas([])).toBe("");
    expect(describirFechas(["2026-10-02"])).toBe("el 02/10/2026");
    expect(describirFechas(["2026-10-02", "2026-10-01", "2026-10-03", "2026-09-30", "2026-10-04"])).toBe("del 30/09 al 04/10/2026");
    expect(describirFechas(["2026-10-03", "2026-10-01", "2026-10-08"])).toBe("el 01/10, 03/10 y 08/10/2026");
    expect(describirFechas(["2026-01-01", "2025-12-31"])).toBe("del 31/12/2025 al 01/01/2026");
  });
});

describe("banco → institución del catálogo de la fecha", () => {
  it("usa el nombre vigente o el histórico según el catálogo", () => {
    expect(institucionDeBanco("NU", cat2026)).toEqual({ codigo: "40638", nombre: "NUBANK" });
    expect(institucionDeBanco("NU", cat2024)).toEqual({ codigo: "90638", nombre: "NU MEXICO" });
    expect(institucionDeBanco("UALA", cat2024)).toEqual({ codigo: "40138", nombre: "ABC CAPITAL" });
    expect(institucionDeBanco("BANAMEX", cat2026)).toEqual({ codigo: "40002", nombre: "BANAMEX" });
    expect(institucionDeBanco("MERCADO_PAGO", cat2026)).toEqual({ codigo: "90722", nombre: "Mercado Pago W" });
  });

  it("null si el banco no existe en ese catálogo o está pendiente", () => {
    expect(institucionDeBanco("SPIN", cat2024)).toBeNull();
    expect(institucionDeBanco("STORI", cat2026)).toBeNull();
  });

  it("nombres libres (bancos fuera del mapa)", () => {
    expect(institucionPorNombre("Banco Multiva", cat2026)).toEqual({ codigo: "40132", nombre: "MULTIVA BANCO" });
    expect(institucionPorNombre("Intercam", cat2026)).toEqual({ codigo: "40136", nombre: "INTERCAM BANCO" });
    expect(institucionPorNombre("Bank of America", cat2026)).toEqual({ codigo: "40106", nombre: "BANK OF AMERICA" });
    expect(institucionPorNombre("Banco", cat2026)).toBeNull();
    expect(institucionPorNombre("Banco Inexistente", cat2026)).toBeNull();
  });
});

describe("referenciaHabitual (la que pone sola la app del banco)", () => {
  it("BBVA: ninguna (la que pone cambia según la semana)", () => {
    expect(referenciaHabitual("BBVA", "2026-10-09", "4189000000000013")).toBeNull();
  });

  it("Banorte aaMMdd, Banamex ddMMaa, BanCoppel ddMMaa0", () => {
    expect(referenciaHabitual("BANORTE", "2026-10-07", "x")).toBe("261007");
    expect(referenciaHabitual("BANAMEX", "2026-10-05", "x")).toBe("051026");
    expect(referenciaHabitual("BANCOPPEL", "2026-10-03", "x")).toBe("0310260");
  });

  it("Azteca: los últimos 7 dígitos de la cuenta destino", () => {
    expect(referenciaHabitual("AZTECA", "2026-10-07", "4189000000000013")).toBe("0000013");
  });

  it("un banco sin referencia habitual → null", () => {
    expect(referenciaHabitual("SPIN", "2026-10-07", "x")).toBeNull();
    expect(referenciaHabitual(null, "2026-10-07", "x")).toBeNull();
    expect(tieneReferenciaHabitual("SPIN")).toBe(false);
    expect(tieneReferenciaHabitual("BBVA")).toBe(false);
    expect(tieneReferenciaHabitual("BANORTE")).toBe(true);
  });
});

describe("normalizarClaveRastreo: casos de los comprobantes reales", () => {
  it("BanCoppel: TRANSBP1 (OCR) → TRANSBPI", () => {
    expect(normalizarClaveRastreo("50110910TRANSBP119499334")).toBe("50110910TRANSBPI19499334");
  });

  it("algo de menos de 8 caracteres no es clave (las iniciales 'GR' del contacto)", () => {
    expect(normalizarClaveRastreo("GR")).toBeNull();
  });
});

describe("referencia semanal (BBVA): solo la aprendida de pagos validados", () => {
  const aprendidas = (banco: string, fecha: string | null) => (banco === "BBVA" && fecha === "2026-10-09" ? "2309260" : null);

  it("con una aprendida para esa fecha, se usa; sin ella, ninguna", () => {
    expect(referenciaHabitual("BBVA", "2026-10-09", "x", aprendidas)).toBe("2309260");
    expect(referenciaHabitual("BBVA", "2026-10-20", "x", aprendidas)).toBeNull();
    expect(tieneReferenciaHabitual("BBVA", aprendidas, "2026-10-09")).toBe(true);
    expect(tieneReferenciaHabitual("BBVA", aprendidas, "2026-10-20")).toBe(false);
  });
});
