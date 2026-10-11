import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { CatalogoBanxico } from "../../src/banxico/catalogo.js";
import { ErrorRedBanxico, type ConsultaBanxico } from "../../src/banxico/cliente.js";
import {
  buscarEnBanxico,
  claveDeConsulta,
  cuentasAIntentar,
  distanciaClaves,
  fechasAIntentar,
  revisarBanxico,
  type DependenciasBusqueda,
  type EntradaBusqueda,
} from "../../src/banxico/reintentos.js";
import { CUENTAS_DESTINO, REGLAS } from "../../src/config.js";
import type { DatosExtraidos } from "../../src/extraction/schema.js";
import { normalizarDatos } from "../../src/normalize/index.js";
import { MENSAJES } from "../../src/rules/index.js";
import type { CoincidenciaCuenta } from "../../src/types.js";
import { datosEjemplo } from "../extraction/datos.js";
import { registro } from "../helpers/registros.js";

const fixture = (nombre: string) => readFileSync(new URL(`../fixtures/banxico/${nombre}`, import.meta.url), "utf8");
const catalogo = (archivo: string, fecha: string): CatalogoBanxico => ({
  fecha,
  instituciones: JSON.parse(fixture(archivo)).instituciones,
  overrideCaptcha: true,
});

/** 09-oct-2026 12:00 en CDMX. */
const AHORA = new Date("2026-10-09T18:00:00Z");
const [BANORTE, INBURSA] = CUENTAS_DESTINO;
const NO_ENCONTRADO = fixture("valida-no-encontrado-consulta.html");
const CAPTCHA = fixture("valida-error-captcha-requerido.html");

/** Un pago tal como lo tiene registrado el Banxico simulado. */
interface PagoFalso {
  fecha: string;
  clave: string;
  referencia: string;
  emisor: string;
  receptor: string;
  cuenta: string;
  monto: string;
  estado?: string;
  hora?: string;
}

const SPIN_BANORTE: PagoFalso = {
  fecha: "08-10-2026",
  clave: "SPIN-20261008200443959PNEB9",
  referencia: "7454748",
  emisor: "90728",
  receptor: "40072",
  cuenta: BANORTE.clabe,
  monto: "400.00",
  hora: "14:04:47",
};

function tablaVertical(p: PagoFalso): string {
  const fecha = `${p.fecha.replace(/-/g, "/")} ${p.hora ?? "12:00:00"}`;
  return `<div id="consultaMISPEI"><table id="xxx" class="styled-table vertical"><tbody>
<tr><td>Número de Referencia</td><td>${p.referencia}</td></tr>
<tr><td>Clave de Rastreo</td><td>${p.clave}</td></tr>
<tr><td>Instituci&oacute;n emisora del pago</td><td>EMISOR</td></tr>
<tr><td>Instituci&oacute;n receptora del pago</td><td>RECEPTOR</td></tr>
<tr><td>Estado del pago en Banxico</td><td>${p.estado ?? "Liquidado"}</td></tr>
<tr><td>Fecha y hora de recepción</td><td>${fecha}</td></tr>
<tr><td>Fecha y hora de procesamiento</td><td>${fecha}</td></tr>
<tr class="columna-cuenta"><td>Cuenta Beneficiaria</td><td>${p.cuenta}</td></tr>
<tr class="columna-monto"><td>Monto</td><td>${p.monto}</td></tr>
</tbody></table></div>`;
}

/**
 * Banxico simulado: busca en `pagos` igual que valida.do (fecha, criterio, bancos, cuenta y monto;
 * una cuenta o un monto vacíos no filtran, como en el sitio real). `forzadas` se devuelven antes, en orden.
 */
function banxicoFalso(pagos: PagoFalso[], forzadas: (string | Error)[] = [], catalogos: Record<string, CatalogoBanxico> = {}) {
  const consultas: ConsultaBanxico[] = [];
  const esperas: number[] = [];
  const deps: DependenciasBusqueda = {
    consultar: async (c) => {
      consultas.push(c);
      const f = forzadas.shift();
      if (f instanceof Error) throw f;
      if (f !== undefined) return f;
      const hallado = pagos.find(
        (p) =>
          p.fecha === c.fecha &&
          p.emisor === c.emisor.codigo &&
          p.receptor === c.receptor.codigo &&
          (c.cuenta === "" || p.cuenta === c.cuenta) &&
          (c.monto === "" || p.monto === c.monto) &&
          (c.tipoCriterio === "T" ? p.clave === c.criterio : p.referencia === c.criterio),
      );
      return hallado ? tablaVertical(hallado) : NO_ENCONTRADO;
    },
    catalogos: { obtener: async (fecha) => catalogos[fecha] ?? catalogo("catalogo-08-10-2026.json", fecha) },
    esperar: async (ms) => {
      esperas.push(ms);
    },
  };
  return { deps, consultas, esperas };
}

const coincidenciaClabe: CoincidenciaCuenta = { cuenta: BANORTE, tipo: "clabe", numero: BANORTE.clabe };
const coincidenciaTarjeta: CoincidenciaCuenta = { cuenta: BANORTE, tipo: "tarjeta", numero: BANORTE.tarjeta };

function entrada(cambios: Partial<DatosExtraidos> = {}, extra: Partial<EntradaBusqueda> = {}): EntradaBusqueda {
  return {
    normalizados: normalizarDatos(datosEjemplo(cambios)),
    coincidencia: coincidenciaClabe,
    bancoEmisor: { clave: "SPIN", nombreLibre: null },
    ahora: AHORA,
    ...extra,
  };
}

/** Resumen legible de las consultas: "fecha criterio cuenta monto". */
const resumen = (consultas: ConsultaBanxico[]) =>
  consultas.map((c) => `${c.fecha} ${c.tipoCriterio} ${c.cuenta || "-"} ${c.monto || "-"}`);

/** 10-oct-2026 12:00 en CDMX (el día en que llegó el comprobante viejo de Mercado Pago del 02-oct). */
const AHORA_10 = new Date("2026-10-10T18:00:00Z");

describe("fechasAIntentar: ±2 días alrededor de la fecha del comprobante (pedido del usuario, 11-oct)", () => {
  it("la del comprobante, un día antes, uno después, dos antes y dos después; nunca futuras", () => {
    expect(REGLAS.diasAlrededor).toBe(2);
    expect(fechasAIntentar("2026-10-08", AHORA)).toEqual(["2026-10-08", "2026-10-07", "2026-10-09", "2026-10-06"]);
    expect(fechasAIntentar("2026-10-09", AHORA)).toEqual(["2026-10-09", "2026-10-08", "2026-10-07"]);
  });

  it("un comprobante viejo se busca alrededor de su fecha, no desde hoy (Mercado Pago del 02-oct enviado el 10-oct)", () => {
    expect(fechasAIntentar("2026-10-02", AHORA_10)).toEqual(["2026-10-02", "2026-10-01", "2026-10-03", "2026-09-30", "2026-10-04"]);
  });

  it("'hoy' es el de CDMX", () => {
    // 09-oct 05:39 UTC = 08-oct 23:39 en CDMX: hoy es el 8 y el 9 todavía es futuro.
    expect(fechasAIntentar("2026-10-08", new Date("2026-10-09T05:39:00Z"))).toEqual(["2026-10-08", "2026-10-07", "2026-10-06"]);
  });

  it("sin fecha: hoy y los 3 días anteriores", () => {
    expect(REGLAS.diasHaciaAtras).toBe(3);
    expect(fechasAIntentar(null, AHORA)).toEqual(["2026-10-09", "2026-10-08", "2026-10-07", "2026-10-06"]);
  });

  it("fecha posterior a hoy: de hoy hacia atrás hasta 3 días antes de ella (12-oct con hoy 10 → 10 y 9)", () => {
    expect(fechasAIntentar("2026-10-12", AHORA_10)).toEqual(["2026-10-10", "2026-10-09"]);
    expect(fechasAIntentar("2026-10-11", AHORA_10)).toEqual(["2026-10-10", "2026-10-09", "2026-10-08"]);
    // Más de 3 días adelante: ninguno de sus días anteriores ya pasó; está mal leída y se busca como sin fecha.
    expect(fechasAIntentar("2026-10-20", AHORA_10)).toEqual(["2026-10-10", "2026-10-09", "2026-10-08", "2026-10-07"]);
  });

  it("otras fechas posibles (la de la imagen, la del OCR o la de la clave) van después de la del comprobante, con sus días alrededor", () => {
    expect(fechasAIntentar("2026-10-08", AHORA, { alternativas: ["2026-10-02", "2026-10-08", null, "2026-10-15"] })).toEqual([
      "2026-10-08", "2026-10-02", "2026-10-07", "2026-10-09", "2026-10-01", "2026-10-03", "2026-10-06", "2026-09-30",
    ]);
    // Sin fecha pero con la de la clave: primero alrededor de ella y luego de hoy hacia atrás (máximo 8 fechas).
    expect(fechasAIntentar(null, AHORA, { alternativas: ["2026-10-01"] })).toEqual([
      "2026-10-01", "2026-09-30", "2026-10-02", "2026-09-29", "2026-10-03", "2026-10-09", "2026-10-08", "2026-10-07",
    ]);
    // Con una fecha posterior a hoy, la otra fecha posible va después de los días anteriores a ella.
    expect(fechasAIntentar("2026-10-12", AHORA_10, { alternativas: ["2026-10-02"] })).toEqual([
      "2026-10-10", "2026-10-09", "2026-10-02", "2026-10-01", "2026-10-03", "2026-09-30", "2026-10-04",
    ]);
  });
});

describe("distanciaClaves", () => {
  it("ignora confusiones de lectura O/0 e I/l/1 y mayúsculas", () => {
    expect(distanciaClaves("SPIN-2026100820O443959PNEB9", "SPIN-20261008200443959PNEB9")).toBe(0);
    expect(distanciaClaves("27SsrAVomLDdmOHAqgpDehA", "27SsrAVomLDdm0HAqpDehA")).toBe(1);
  });

  it("dos pagos distintos de Azteca están lejos", () => {
    expect(distanciaClaves("261008011286812472I", "261008011287636711I")).toBeGreaterThan(2);
  });
});

describe("buscarEnBanxico: búsqueda normal", () => {
  it("encontrado a la primera: una consulta, sin esperas, y con los datos correctos", async () => {
    const { deps, consultas, esperas } = banxicoFalso([SPIN_BANORTE]);
    const r = await buscarEnBanxico(entrada(), deps);
    expect(r).toMatchObject({ estado: "VALIDADO", pago: { estado: "LIQUIDADO", monto: "400.00" } });
    expect(r.intentos).toHaveLength(1);
    expect(esperas).toEqual([]);
    expect(consultas[0]).toEqual({
      tipoCriterio: "T",
      fecha: "08-10-2026",
      criterio: "SPIN-20261008200443959PNEB9",
      emisor: { codigo: "90728", nombre: "SPIN BY OXXO" },
      receptor: { codigo: "40072", nombre: "BANORTE" },
      cuenta: "072650010004755884",
      monto: "400.00",
      tipoConsulta: 0,
    });
    expect(r.consulta).toEqual(consultas[0]);
  });

  it("si no está en la fecha del comprobante, en las vecinas primero pregunta si la clave existe ese día (con pausa entre consultas)", async () => {
    const { deps, consultas, esperas } = banxicoFalso([{ ...SPIN_BANORTE, fecha: "07-10-2026" }]);
    const r = await buscarEnBanxico(entrada(), deps);
    expect(r.estado).toBe("VALIDADO");
    expect(resumen(consultas)).toEqual([
      "08-10-2026 T 072650010004755884 400.00",
      "08-10-2026 T - -", // sondeo: la clave no existe ese día
      "08-10-2026 R 072650010004755884 400.00",
      "07-10-2026 T - -", // sondeo: la clave existe el 07…
      "07-10-2026 T 072650010004755884 400.00", // …y aparece con nuestra cuenta y el monto
    ]);
    expect(esperas).toEqual(Array(4).fill(REGLAS.pausaEntreConsultasMs));
  });

  it("clave mal leída: lo encuentra por referencia y devuelve la clave real", async () => {
    const { deps } = banxicoFalso([SPIN_BANORTE]);
    const r = await buscarEnBanxico(entrada({ claveRastreo: "SPIN-2026100820O443959PNEB9" }), deps);
    expect(r.estado).toBe("VALIDADO");
    expect(r.pago?.claveRastreo).toBe("SPIN-20261008200443959PNEB9");
    expect(r.intentos.map((i) => `${i.criterio}${i.sondeo ? " (sondeo)" : ""}`)).toEqual([
      "CLAVE_RASTREO",
      "CLAVE_RASTREO (sondeo)",
      "REFERENCIA",
    ]);
  });

  it("coincidencia por tarjeta y pago hecho a la CLABE: el sondeo confirma la clave y la CLABE lo encuentra", async () => {
    const { deps, consultas } = banxicoFalso([SPIN_BANORTE]);
    const r = await buscarEnBanxico(entrada({}, { coincidencia: coincidenciaTarjeta }), deps);
    expect(r.estado).toBe("VALIDADO");
    expect(resumen(consultas)).toEqual([
      `08-10-2026 T ${BANORTE.tarjeta} 400.00`,
      "08-10-2026 T - -",
      `08-10-2026 T ${BANORTE.clabe} 400.00`,
    ]);
  });

  it("coincidencia por tarjeta y clave inexistente: no gasta la consulta con la CLABE para esa clave", async () => {
    const { deps, consultas } = banxicoFalso([]);
    await buscarEnBanxico(entrada({}, { coincidencia: coincidenciaTarjeta }), deps);
    expect(resumen(consultas).slice(0, 4)).toEqual([
      `08-10-2026 T ${BANORTE.tarjeta} 400.00`,
      "08-10-2026 T - -",
      `08-10-2026 R ${BANORTE.tarjeta} 400.00`,
      `08-10-2026 R ${BANORTE.clabe} 400.00`,
    ]);
  });

  it("nada en ninguna fecha → NO_ENCONTRADO: la clave sola en cada fecha confirma que no existe y el mensaje lo dice", async () => {
    const { deps, consultas } = banxicoFalso([]);
    const avisos: number[] = [];
    const r = await buscarEnBanxico(entrada({}, { alIntentar: (_, n) => avisos.push(n) }), deps);
    expect(r).toMatchObject({ estado: "NO_ENCONTRADO", claveInexistente: true, fechasRevisadas: ["2026-10-08", "2026-10-07", "2026-10-09", "2026-10-06"] });
    // 08 completa (clave, clave sola, referencia). En 07, 09 y 06 solo la clave sola: no existe, así que la consulta
    // completa tampoco lo encontraría, y la referencia no hace falta (ni la fecha ni la clave son dudosas).
    expect(resumen(consultas)).toEqual([
      "08-10-2026 T 072650010004755884 400.00",
      "08-10-2026 T - -",
      "08-10-2026 R 072650010004755884 400.00",
      "07-10-2026 T - -",
      "09-10-2026 T - -",
      "06-10-2026 T - -",
    ]);
    expect(r.mensaje).toBe("Banxico no tiene ningún pago con la clave de rastreo SPIN-20261008200443959PNEB9: busqué del 06/10 al 09/10/2026 (6 consultas).");
    expect(avisos).toEqual(Array.from({ length: 6 }, (_, i) => i + 1));
  });

  it("clave dudosa (cortada por la imagen) y pago en una fecha vecina: ahí también se prueba la referencia", async () => {
    const { deps, consultas } = banxicoFalso([{ ...SPIN_BANORTE, fecha: "07-10-2026" }]);
    // Spin tiene claves de 27 caracteres: esta mide 21.
    const r = await buscarEnBanxico(entrada({ claveRastreo: "SPIN-2026100820044395" }), deps);
    expect(r).toMatchObject({ estado: "VALIDADO", pago: { claveRastreo: "SPIN-20261008200443959PNEB9" } });
    expect(resumen(consultas).at(-1)).toBe("07-10-2026 R 072650010004755884 400.00");
  });

  it("sin clave: no se puede afirmar que no existe; el mensaje dice qué fechas se revisaron", async () => {
    const { deps } = banxicoFalso([]);
    const r = await buscarEnBanxico(entrada({ claveRastreo: null }), deps);
    expect(r.claveInexistente).toBeUndefined();
    expect(r.mensaje).toBe("No se encontró el pago en Banxico: busqué del 06/10 al 09/10/2026 (4 consultas).");
  });
});

describe("comprobantes viejos y con fecha mal impresa o mal leída", () => {
  const TARJETA = coincidenciaTarjeta;
  /** El comprobante real de Mercado Pago: $990 del 02-oct, #181053611151, a la tarjeta Banorte …1871. */
  const mercadoPago = (cambios: Partial<DatosExtraidos> = {}, extra: Partial<EntradaBusqueda> = {}) =>
    entrada(
      { claveRastreo: "CPO181053611151", referencia: "3611151", fecha: "2026-10-02", hora: "13:59", monto: 990, ...cambios },
      { coincidencia: TARJETA, bancoEmisor: { clave: "MERCADO_PAGO", nombreLibre: null }, ahora: AHORA_10, ...extra },
    );
  const PAGO_MP: PagoFalso = {
    fecha: "03-10-2026",
    clave: "CPO181053611151",
    referencia: "3611151",
    emisor: "90722",
    receptor: "40072",
    cuenta: BANORTE.tarjeta,
    monto: "990.00",
  };

  it("registrado un día después del impreso: la fecha del comprobante completa y en las vecinas primero la clave sola", async () => {
    const { deps, consultas } = banxicoFalso([PAGO_MP]);
    const r = await buscarEnBanxico(mercadoPago(), deps);
    expect(r.estado).toBe("VALIDADO");
    expect(resumen(consultas)).toEqual([
      `02-10-2026 T ${BANORTE.tarjeta} 990.00`,
      "02-10-2026 T - -",
      `02-10-2026 R ${BANORTE.tarjeta} 990.00`,
      `02-10-2026 R ${BANORTE.clabe} 990.00`,
      "01-10-2026 T - -", // la clave no existe el 01: ese día no se consulta más
      "03-10-2026 T - -", // existe el 03…
      `03-10-2026 T ${BANORTE.tarjeta} 990.00`, // …y aparece con nuestra tarjeta y el monto
    ]);
  });

  it("no existe en ninguna fecha: ya no se gasta en 07–09 oct; dice que la clave no existe del 30/09 al 04/10", async () => {
    const { deps, consultas } = banxicoFalso([]);
    const r = await buscarEnBanxico(mercadoPago(), deps);
    expect(r).toMatchObject({ estado: "NO_ENCONTRADO", claveInexistente: true });
    expect(new Set(consultas.map((c) => c.fecha))).toEqual(new Set(["02-10-2026", "01-10-2026", "03-10-2026", "30-09-2026", "04-10-2026"]));
    // El 02 completo (4) y la clave sola en las otras 4 fechas.
    expect(r.mensaje).toBe("Banxico no tiene ningún pago con la clave de rastreo CPO181053611151: busqué del 30/09 al 04/10/2026 (8 consultas).");
  });

  it("la clave existe en una fecha vecina pero con otra cuenta → CUENTA_INCORRECTA (detección temprana en cualquier fecha)", async () => {
    const { deps } = banxicoFalso([{ ...PAGO_MP, cuenta: "012180000000000001" }]);
    const r = await buscarEnBanxico(mercadoPago(), deps);
    expect(r.estado).toBe("CUENTA_INCORRECTA");
  });

  it("sin fecha, la de la clave de rastreo: Spin del 01-oct se busca ese día y no de hoy hacia atrás", async () => {
    const pago = { ...SPIN_BANORTE, fecha: "01-10-2026", clave: "SPIN-20261001200443959PNEB9" };
    const { deps, consultas } = banxicoFalso([pago]);
    const r = await buscarEnBanxico(entrada({ fecha: null, claveRastreo: "SPIN-20261001200443959PNEB9" }), deps);
    expect(r.estado).toBe("VALIDADO");
    expect(consultas).toHaveLength(1);
    expect(consultas[0]?.fecha).toBe("01-10-2026");
  });

  it("fechas alternativas (la del OCR o la de la imagen) se prueban justo después de la del comprobante", async () => {
    const { deps, consultas } = banxicoFalso([{ ...PAGO_MP, fecha: "07-10-2026" }]);
    const r = await buscarEnBanxico(mercadoPago({}, { fechasAlternativas: ["2026-10-07"] }), deps);
    expect(r.estado).toBe("VALIDADO");
    expect(consultas.at(-1)?.fecha).toBe("07-10-2026");
    expect(consultas).toHaveLength(6); // 02 completa (4) y en la del 07 la clave sola y la principal
  });
});

describe("fecha posterior a hoy: antes de decir 'valida en 1 o 2 días' se buscan los días que ya pasaron", () => {
  // Sin clave (solo la referencia) para que la fecha de la clave no agregue otras fechas.
  it("dice 12-oct y hoy es 10: lo encuentra hoy", async () => {
    const { deps, consultas } = banxicoFalso([{ ...SPIN_BANORTE, fecha: "10-10-2026" }]);
    const r = await buscarEnBanxico(entrada({ fecha: "2026-10-12", claveRastreo: null }, { ahora: AHORA_10 }), deps);
    expect(r.estado).toBe("VALIDADO");
    expect(consultas.map((c) => c.fecha)).toEqual(["10-10-2026"]);
  });

  it("si no aparece el 10 ni el 9 → FECHA_FUTURA con el mensaje de siempre y qué se revisó", async () => {
    const { deps, consultas } = banxicoFalso([]);
    const r = await buscarEnBanxico(entrada({ fecha: "2026-10-12", claveRastreo: null }, { ahora: AHORA_10 }), deps);
    expect(r.estado).toBe("FECHA_FUTURA");
    expect(consultas.map((c) => c.fecha)).toEqual(["10-10-2026", "09-10-2026"]);
    expect(r.mensaje).toBe(
      `${MENSAJES.FECHA_FUTURA}: la fecha del comprobante (12/10/2026) es posterior a hoy y el pago todavía no aparece en Banxico; busqué del 09/10 al 10/10/2026 (2 consultas).`,
    );
  });

  it("muy adelantada (20-oct con hoy 10): está mal leída; se busca de hoy hacia atrás y se avisa", async () => {
    const { deps, consultas } = banxicoFalso([]);
    const r = await buscarEnBanxico(entrada({ fecha: "2026-10-20", claveRastreo: null }, { ahora: AHORA_10 }), deps);
    expect(r.estado).toBe("NO_ENCONTRADO");
    expect(new Set(consultas.map((c) => c.fecha))).toEqual(new Set(["10-10-2026", "09-10-2026", "08-10-2026", "07-10-2026"]));
    expect(r.mensaje).toContain("La fecha del comprobante (20/10/2026) es posterior a hoy: puede estar mal leída.");
  });
});

describe("tiempo máximo: la búsqueda termina con lo revisado en lugar de quedar a medias", () => {
  it("no empieza una consulta que no alcance a terminar; responde NO_ENCONTRADO 'incompleta'", async () => {
    const { deps, consultas } = banxicoFalso([]);
    let ahora = 0;
    deps.reloj = () => ahora;
    deps.esperar = async (ms) => {
      ahora += ms;
    };
    // 30 s: caben la primera (sin pausa) y dos más (6 s de pausa + 15 s de margen cada una).
    const r = await buscarEnBanxico(entrada({}, { limite: 30_000 }), deps);
    expect(consultas).toHaveLength(3);
    expect(r).toMatchObject({ estado: "NO_ENCONTRADO", incompleta: true });
    expect(r.claveInexistente).toBeUndefined();
    expect(r.mensaje).toBe("No se encontró el pago en Banxico: busqué el 08/10/2026 (3 consultas). Se acabó el tiempo antes de revisar todas las combinaciones.");
  });
});

describe("buscarEnBanxico: detección temprana de comprobantes alterados", () => {
  it("monto alterado → MONTO_NO_COINCIDE en 3 consultas", async () => {
    const { deps, consultas } = banxicoFalso([SPIN_BANORTE]);
    const r = await buscarEnBanxico(entrada({ monto: 450 }), deps);
    // Con la fecha en que existe la clave, para probar ahí los otros montos leídos (segunda opinión).
    expect(r).toMatchObject({ estado: "MONTO_NO_COINCIDE", fechaClave: "2026-10-08" });
    expect(r.mensaje).toBe("El monto no coincide: en Banxico el pago con esa clave de rastreo no es por $450.00.");
    expect(resumen(consultas)).toEqual([
      "08-10-2026 T 072650010004755884 450.00",
      "08-10-2026 T - -", // la clave existe
      "08-10-2026 T - 450.00", // pero no con ese monto
    ]);
  });

  it("cuenta alterada (el pago fue a otra cuenta) → CUENTA_INCORRECTA", async () => {
    const { deps, consultas } = banxicoFalso([{ ...SPIN_BANORTE, cuenta: "012180000000000001" }]);
    const r = await buscarEnBanxico(entrada(), deps);
    expect(r).toMatchObject({ estado: "CUENTA_INCORRECTA", fechaClave: "2026-10-08" });
    expect(r.mensaje).toContain(MENSAJES.CUENTA_INCORRECTA);
    expect(consultas).toHaveLength(3);
  });

  it("soloClave: no prueba la referencia (para revisar rápido varias cuentas o un monto distinto)", async () => {
    // La clave del comprobante está mal leída (una O por un 0): con la referencia sí aparecería.
    const malLeida = "SPIN-2026100820O443959PNEB9";
    const normal = await buscarEnBanxico(entrada({ claveRastreo: malLeida }), banxicoFalso([SPIN_BANORTE]).deps);
    expect(normal.estado).toBe("VALIDADO");

    const soloClave = banxicoFalso([SPIN_BANORTE]);
    const r = await buscarEnBanxico(entrada({ claveRastreo: malLeida }, { soloClave: true, maxFechas: 1 }), soloClave.deps);
    expect(r.estado).toBe("NO_ENCONTRADO");
    expect(soloClave.consultas.every((c) => c.tipoCriterio === "T")).toBe(true);
    // Sin clave en el comprobante no aplica: se busca con la referencia.
    const sinClave = await buscarEnBanxico(entrada({ claveRastreo: null }, { soloClave: true }), banxicoFalso([SPIN_BANORTE]).deps);
    expect(sinClave.estado).toBe("VALIDADO");
  });

  it("por tarjeta: antes de concluir que la cuenta no coincide, prueba la CLABE", async () => {
    const { deps, consultas } = banxicoFalso([{ ...SPIN_BANORTE, monto: "999.00" }]);
    const r = await buscarEnBanxico(entrada({}, { coincidencia: coincidenciaTarjeta }), deps);
    expect(r.estado).toBe("MONTO_NO_COINCIDE");
    expect(resumen(consultas)).toEqual([
      `08-10-2026 T ${BANORTE.tarjeta} 400.00`,
      "08-10-2026 T - -",
      `08-10-2026 T ${BANORTE.clabe} 400.00`,
      "08-10-2026 T - 400.00",
    ]);
  });

  it("si el segundo sondeo falla, avisa que no coinciden el monto o la cuenta", async () => {
    const error = fixture("valida-error-fecha.html");
    const { deps } = banxicoFalso([SPIN_BANORTE], [NO_ENCONTRADO, tablaVertical(SPIN_BANORTE), error]);
    const r = await buscarEnBanxico(entrada({ monto: 450 }), deps);
    expect(r).toMatchObject({ estado: "MONTO_NO_COINCIDE" });
    expect(r.mensaje).toMatch(/monto o la cuenta no coinciden/);
  });
});

describe("buscarEnBanxico: captcha, red y estados", () => {
  it("captcha: no insiste; avisa al ritmo global (enfriamiento) y termina como BANXICO_NO_DISPONIBLE, no 'no encontrado'", async () => {
    const captchas: string[] = [];
    const { deps, esperas, consultas } = banxicoFalso([SPIN_BANORTE], [CAPTCHA]);
    const r = await buscarEnBanxico(entrada(), { ...deps, alCaptcha: (origen) => captchas.push(origen) });
    expect(r).toMatchObject({ estado: "BANXICO_NO_DISPONIBLE" });
    expect(r.mensaje).toMatch(/limitando/);
    expect(r.intentos.at(-1)?.resultado).toBe("CAPTCHA");
    expect(consultas).toHaveLength(1);
    expect(esperas).toEqual([]);
    expect(captchas).toEqual(["consulta"]);
  });

  it("durante el enfriamiento por captcha no se le pide nada a Banxico, ni el catálogo", async () => {
    let catalogosPedidos = 0;
    const { deps, consultas } = banxicoFalso([SPIN_BANORTE]);
    const catalogos = { obtener: (fecha: string) => (catalogosPedidos++, deps.catalogos.obtener(fecha)) };
    const r = await buscarEnBanxico(entrada(), { ...deps, catalogos, enfriamiento: () => 60_000 });
    expect(r).toMatchObject({ estado: "BANXICO_NO_DISPONIBLE" });
    expect(r.mensaje).toMatch(/limitando/);
    expect(consultas).toHaveLength(0);
    expect(catalogosPedidos).toBe(0);
  });

  it("si el enfriamiento empieza a mitad de la búsqueda (captcha de otra petición), no se hace la siguiente consulta", async () => {
    const { deps, consultas } = banxicoFalso([{ ...SPIN_BANORTE, fecha: "07-10-2026" }]);
    const r = await buscarEnBanxico(entrada(), { ...deps, enfriamiento: () => (consultas.length >= 1 ? 60_000 : 0) });
    expect(r).toMatchObject({ estado: "BANXICO_NO_DISPONIBLE" });
    expect(consultas).toHaveLength(1);
  });

  it("catálogo con el captcha activado: también avisa al ritmo global", async () => {
    const captchas: string[] = [];
    const cat = { ...catalogo("catalogo-08-10-2026.json", "08-10-2026"), overrideCaptcha: false };
    const { deps } = banxicoFalso([SPIN_BANORTE], [], { "08-10-2026": cat });
    await buscarEnBanxico(entrada(), { ...deps, alCaptcha: (origen) => captchas.push(origen) });
    expect(captchas).toEqual(["catálogo"]);
  });

  it("Banxico sin red → BANXICO_NO_DISPONIBLE", async () => {
    const { deps } = banxicoFalso([], [new ErrorRedBanxico("timeout")]);
    const r = await buscarEnBanxico(entrada(), deps);
    expect(r).toMatchObject({ estado: "BANXICO_NO_DISPONIBLE", intentos: [{ resultado: "ERROR_RED" }] });
  });

  it("catálogo con el captcha activado → BANXICO_NO_DISPONIBLE sin consultar", async () => {
    const cat = { ...catalogo("catalogo-08-10-2026.json", "08-10-2026"), overrideCaptcha: false };
    const { deps, consultas } = banxicoFalso([SPIN_BANORTE], [], { "08-10-2026": cat });
    expect((await buscarEnBanxico(entrada(), deps)).estado).toBe("BANXICO_NO_DISPONIBLE");
    expect(consultas).toHaveLength(0);
  });

  it("pago devuelto → NO_LIQUIDADO con el estado", async () => {
    const { deps } = banxicoFalso([{ ...SPIN_BANORTE, estado: "Devuelto" }]);
    const r = await buscarEnBanxico(entrada(), deps);
    expect(r).toMatchObject({ estado: "NO_LIQUIDADO", pago: { estado: "DEVUELTO" } });
    expect(r.mensaje).toContain('"Devuelto"');
  });

  it("emisor ausente del catálogo de una fecha: esa fecha se omite y sigue con las demás", async () => {
    const sinSpin = catalogo("catalogo-15-06-2024.json", "08-10-2026");
    const { deps, consultas } = banxicoFalso([{ ...SPIN_BANORTE, fecha: "07-10-2026" }], [], { "08-10-2026": sinSpin });
    const r = await buscarEnBanxico(entrada(), deps);
    expect(r.estado).toBe("VALIDADO");
    expect(r.intentos[0]).toMatchObject({ fecha: "08-10-2026", resultado: "OMITIDO" });
    expect(consultas).toHaveLength(2); // en el 07: la clave sola y la principal
  });
});

describe("la clave de rastreo es única", () => {
  it("si el pago encontrado ya se validó (aunque la clave del comprobante esté mal leída) → DUPLICADO", async () => {
    const { deps } = banxicoFalso([SPIN_BANORTE]);
    const r = await buscarEnBanxico(
      entrada({ claveRastreo: "SPIN-2026100820O443959PNEB9" }, { usados: [registro({ validadoEn: "2026-10-08T20:10:00.000Z" })] }),
      deps,
    );
    expect(r).toMatchObject({ estado: "DUPLICADO", pago: { claveRastreo: "SPIN-20261008200443959PNEB9" } });
    expect(r.mensaje).toBe("Este comprobante ya fue validado el 08/10/2026 a las 14:10 (hora de CDMX).");
  });
});

describe("varios pagos con la misma referencia (Azteca → Inbursa, respuesta real)", () => {
  const VARIOS = fixture("valida-consulta-varios-pagos-referencia.html");
  const tarjetaInbursa: CoincidenciaCuenta = { cuenta: INBURSA, tipo: "tarjeta", numero: "4658280004936574" };
  const azteca = (cambios: Partial<DatosExtraidos>, extra: Partial<EntradaBusqueda> = {}) =>
    entrada(
      { claveRastreo: null, referencia: "4936574", monto: 890, fecha: "2026-10-08", ...cambios },
      { coincidencia: tarjetaInbursa, bancoEmisor: { clave: "AZTECA", nombreLibre: null }, ...extra },
    );

  it("con clave en el comprobante: solo vale el pago con esa clave", async () => {
    const { deps } = banxicoFalso([], [VARIOS]);
    const r = await buscarEnBanxico(azteca({ claveRastreo: "261008011286812472I", hora: "17:09:36" }), deps);
    // Aunque la hora apunte al otro pago, la clave manda.
    expect(r).toMatchObject({ estado: "VALIDADO", pago: { claveRastreo: "261008011286812472I" } });
  });

  it("con clave mal leída: el pago cuya clave difiere solo en errores de lectura", async () => {
    const { deps } = banxicoFalso([], [VARIOS]);
    const r = await buscarEnBanxico(azteca({ claveRastreo: "26100801128763671lI" }), deps);
    expect(r).toMatchObject({ estado: "VALIDADO", pago: { claveRastreo: "261008011287636711I" } });
  });

  it("con una clave que no es de ninguno de esos pagos → no se acepta (evita tomar el pago de otra persona)", async () => {
    // Como en Banxico: con esa clave no hay nada; con la referencia, los pagos de otras personas.
    const { deps } = banxicoFalso([]);
    const consultar = async (c: ConsultaBanxico) => (c.tipoCriterio === "R" ? VARIOS : NO_ENCONTRADO);
    const r = await buscarEnBanxico(azteca({ claveRastreo: "261008099999999999I" }), { ...deps, consultar });
    expect(r.estado).toBe("NO_ENCONTRADO");
    expect(r.pago).toBeUndefined();
    expect(r.intentos.find((i) => i.criterio === "REFERENCIA")?.detalle).toMatch(/clave de rastreo del comprobante/);
  });

  it("sin clave: el más cercano a la hora del comprobante", async () => {
    const { deps } = banxicoFalso([], [VARIOS]);
    const r = await buscarEnBanxico(azteca({ hora: "17:09:36" }), deps);
    expect(r).toMatchObject({ estado: "VALIDADO", pago: { claveRastreo: "261008011287636711I" } });
  });

  it("sin clave: descarta los ya usados y toma otro pago idéntico", async () => {
    const { deps } = banxicoFalso([], [VARIOS]);
    const r = await buscarEnBanxico(azteca({ hora: null }, { usados: [registro({ claveRastreo: "261008011287636711I" })] }), deps);
    expect(r).toMatchObject({ estado: "VALIDADO", pago: { claveRastreo: "261008011286812472I" } });
  });

  it("sin clave ni hora: cualquiera no usado (su clave real queda registrada)", async () => {
    const { deps } = banxicoFalso([], [VARIOS]);
    const r = await buscarEnBanxico(azteca({ hora: null }), deps);
    expect(r).toMatchObject({ estado: "VALIDADO", pago: { claveRastreo: "261008011286812472I" } });
  });

  it("sin clave y con todos los pagos ya usados → DUPLICADO", async () => {
    const { deps } = banxicoFalso([], [VARIOS]);
    const usados = [registro({ claveRastreo: "261008011286812472I" }), registro({ claveRastreo: "261008011287636711I" })];
    expect((await buscarEnBanxico(azteca({ hora: null }, { usados }), deps)).estado).toBe("DUPLICADO");
  });
});

describe("comprobante nocturno (desde REGLAS.horaInicioNocturno)", () => {
  // AHORA = 09-oct 12:00 en CDMX.
  it("fechas: si es de hoy solo se prueba hoy; si es de antes, el día siguiente justo después", () => {
    expect(REGLAS.horaInicioNocturno).toBe("18:00");
    expect(fechasAIntentar("2026-10-09", AHORA, { nocturno: true })).toEqual(["2026-10-09"]);
    expect(fechasAIntentar("2026-10-08", AHORA, { nocturno: true })).toEqual(["2026-10-08", "2026-10-09", "2026-10-07", "2026-10-06"]);
  });

  it("nocturno de hoy que no aparece → COMPROBANTE_NOCTURNO (valídalo mañana), sin buscar días anteriores", async () => {
    const { deps, consultas } = banxicoFalso([]);
    // 23:15 de CDMX del 09 = 05:15 UTC del 10: la clave de Spin lleva la misma fecha que el comprobante.
    const r = await buscarEnBanxico(entrada({ fecha: "2026-10-09", hora: "23:15:00", claveRastreo: "SPIN-20261010051500959PNEB9" }), deps);
    expect(r).toMatchObject({ estado: "COMPROBANTE_NOCTURNO", mensaje: MENSAJES.COMPROBANTE_NOCTURNO });
    expect(consultas.every((c) => c.fecha === "09-10-2026")).toBe(true);
    expect(consultas).toHaveLength(3); // clave, sondeo y referencia
  });

  it("nocturno de hoy que sí aparece hoy → VALIDADO", async () => {
    const { deps } = banxicoFalso([{ ...SPIN_BANORTE, fecha: "09-10-2026" }]);
    const r = await buscarEnBanxico(entrada({ fecha: "2026-10-09", hora: "19:30:00" }), deps);
    expect(r.estado).toBe("VALIDADO");
  });

  it("nocturno de ayer registrado con la fecha de hoy → lo encuentra en D+1", async () => {
    const { deps, consultas } = banxicoFalso([{ ...SPIN_BANORTE, fecha: "09-10-2026" }]);
    const r = await buscarEnBanxico(entrada({ fecha: "2026-10-08", hora: "23:50:00" }), deps);
    expect(r.estado).toBe("VALIDADO");
    expect(consultas.at(-1)?.fecha).toBe("09-10-2026");
  });

  it("de día no cambia nada (a las 17:59 no es nocturno)", async () => {
    const { deps } = banxicoFalso([]);
    const r = await buscarEnBanxico(entrada({ fecha: "2026-10-09", hora: "17:59:59" }), deps);
    expect(r.estado).toBe("NO_ENCONTRADO");
  });

  it("un monto alterado en un comprobante nocturno se sigue detectando", async () => {
    const { deps } = banxicoFalso([{ ...SPIN_BANORTE, fecha: "09-10-2026" }]);
    const r = await buscarEnBanxico(entrada({ fecha: "2026-10-09", hora: "22:00:00", monto: 450 }), deps);
    expect(r.estado).toBe("MONTO_NO_COINCIDE");
  });
});

describe("opciones para la ruta rápida", () => {
  it("soloPrimerIntento: una sola consulta y devuelve cuál fue", async () => {
    const { deps, consultas } = banxicoFalso([]);
    const r = await buscarEnBanxico(entrada({}, { soloPrimerIntento: true }), deps);
    expect(r.estado).toBe("NO_ENCONTRADO");
    expect(consultas).toHaveLength(1);
    expect(r.consultadas).toEqual([claveDeConsulta(consultas[0]!)]);
  });

  it("yaConsultadas: no repite esa consulta y sigue con la búsqueda", async () => {
    const primera = banxicoFalso([]);
    const rapida = await buscarEnBanxico(entrada({}, { soloPrimerIntento: true }), primera.deps);
    const { deps, consultas } = banxicoFalso([{ ...SPIN_BANORTE, fecha: "07-10-2026" }]);
    const r = await buscarEnBanxico(entrada({}, { yaConsultadas: new Set(rapida.consultadas) }), deps);
    expect(r.estado).toBe("VALIDADO");
    expect(r.intentos[0]).toMatchObject({ resultado: "NO_ENCONTRADO", detalle: "ya consultada en la ruta rápida" });
    expect(consultas.some((c) => claveDeConsulta(c) === rapida.consultadas![0])).toBe(false);
  });
});

describe("buscarEnBanxico: cancelación (tiempo máximo de la cola)", () => {
  it("si se cancela, no hace ninguna consulta más", async () => {
    const { deps, consultas } = banxicoFalso([]);
    const controlador = new AbortController();
    const consultar = deps.consultar;
    deps.consultar = async (c) => {
      const html = await consultar(c);
      controlador.abort(new Error("tiempo agotado"));
      return html;
    };
    await expect(buscarEnBanxico(entrada({}, { signal: controlador.signal }), deps)).rejects.toThrow("tiempo agotado");
    expect(consultas).toHaveLength(1);
  });
});

describe("lo aprendido de los comprobantes reales (Imagenes de prueba, confirmado en Banxico)", () => {
  const BBVA = { clave: "BBVA" as const, nombreLibre: null };
  const BBVA_NOCHE: PagoFalso = {
    fecha: "08-10-2026",
    clave: "MBAN01002610090085509456",
    referencia: "2309260",
    emisor: "40012",
    receptor: "40072",
    cuenta: BANORTE.clabe,
    monto: "1089.00",
    hora: "21:09:01",
  };
  const bbva = (cambios: Partial<DatosExtraidos> = {}, extra: Partial<EntradaBusqueda> = {}) =>
    entrada(
      { claveRastreo: "MBAN01002610090085509456", referencia: null, monto: 1089, fecha: "2026-10-09", hora: "21:08", ...cambios },
      { bancoEmisor: BBVA, ...extra },
    );

  it("fechas: sin fecha, hoy y los 3 días anteriores; BBVA de noche, primero el día anterior", () => {
    expect(fechasAIntentar(null, AHORA)).toEqual(["2026-10-09", "2026-10-08", "2026-10-07", "2026-10-06"]);
    expect(fechasAIntentar("2026-10-09", AHORA, { nocturno: true, diaAnterior: "antes" })).toEqual(["2026-10-08", "2026-10-09", "2026-10-07"]);
    expect(fechasAIntentar("2026-10-09", AHORA, { nocturno: true, diaAnterior: "despues" })).toEqual(["2026-10-09", "2026-10-08", "2026-10-07"]);
    // Pagado hoy de noche: BBVA imprime la fecha de mañana (no cuenta como posterior a hoy) y se busca hoy.
    expect(fechasAIntentar("2026-10-10", AHORA, { nocturno: true, diaAnterior: "antes" })).toEqual(["2026-10-09", "2026-10-08"]);
  });

  it("BBVA '09 octubre 21:08': Banxico lo tiene el 08-10 y se encuentra en la primera consulta", async () => {
    const { deps, consultas } = banxicoFalso([BBVA_NOCHE]);
    const r = await buscarEnBanxico(bbva(), deps);
    expect(r.estado).toBe("VALIDADO");
    expect(resumen(consultas)).toEqual([`08-10-2026 T ${BANORTE.clabe} 1089.00`]);
  });

  it("BBVA a las 18:26 (el celular 1 h adelante): primero la fecha impresa, que es la buena", async () => {
    const pago: PagoFalso = { ...BBVA_NOCHE, fecha: "09-10-2026", clave: "MBAN01002610090090453121", monto: "400.00" };
    const { deps, consultas } = banxicoFalso([pago]);
    const r = await buscarEnBanxico(bbva({ claveRastreo: "MBAN01002610090090453121", fecha: "2026-10-09", hora: "18:26", monto: 400 }), deps);
    expect(r.estado).toBe("VALIDADO");
    expect(consultas).toHaveLength(1);
  });

  it("BBVA de noche de hoy (fecha de mañana): no es 'valídalo mañana', se busca hoy", async () => {
    const { deps } = banxicoFalso([{ ...BBVA_NOCHE, fecha: "09-10-2026" }]);
    const r = await buscarEnBanxico(bbva({ fecha: "2026-10-10" }), deps);
    expect(r.estado).toBe("VALIDADO");
  });

  it("BBVA sin clave pero con la referencia de la nota: se busca por esa referencia (BBVA no tiene referencia fija)", async () => {
    const { deps, consultas } = banxicoFalso([BBVA_NOCHE]);
    const r = await buscarEnBanxico(bbva({ claveRastreo: null, referencia: "2309260", fecha: "2026-10-08", hora: null }), deps);
    expect(r.estado).toBe("VALIDADO");
    expect(consultas[0]).toMatchObject({ tipoCriterio: "R", criterio: "2309260", fecha: "08-10-2026" });
  });

  it("Banorte sin referencia ni fecha: prueba la fecha aaMMdd de cada día, de hoy hacia atrás", async () => {
    const pago: PagoFalso = { fecha: "07-10-2026", clave: "38432P04202610075861381568", referencia: "261007", emisor: "40072", receptor: "40036", cuenta: INBURSA.clabe, monto: "300.00" };
    const { deps, consultas } = banxicoFalso([pago]);
    const r = await buscarEnBanxico(
      entrada(
        { claveRastreo: null, referencia: null, fecha: null, hora: null, monto: 300 },
        { coincidencia: { cuenta: INBURSA, tipo: "clabe", numero: INBURSA.clabe }, bancoEmisor: { clave: "BANORTE", nombreLibre: null } },
      ),
      deps,
    );
    expect(r.estado).toBe("VALIDADO");
    expect(consultas.map((c) => `${c.fecha} ${c.criterio}`)).toEqual(["09-10-2026 261009", "08-10-2026 261008", "07-10-2026 261007"]);
  });

  it("Azteca sin referencia legible: los últimos 7 dígitos del número de cuenta que se consulta", async () => {
    const pago: PagoFalso = { fecha: "07-10-2026", clave: "261007011275748950I", referencia: "7841871", emisor: "40127", receptor: "40072", cuenta: BANORTE.tarjeta, monto: "990.00" };
    const { deps, consultas } = banxicoFalso([pago]);
    const r = await buscarEnBanxico(
      entrada(
        { claveRastreo: null, referencia: null, fecha: "2026-10-07", monto: 990 },
        { coincidencia: coincidenciaClabe, cuentaDeducida: true, bancoEmisor: { clave: "AZTECA", nombreLibre: null } },
      ),
      deps,
    );
    expect(r.estado).toBe("VALIDADO");
    expect(consultas.map((c) => `${c.criterio} ${c.cuenta}`)).toEqual([`4755884 ${BANORTE.clabe}`, `7841871 ${BANORTE.tarjeta}`]);
  });

  it("cuenta deducida: se prueban todos sus números; vista: el que coincidió y la CLABE", () => {
    expect(cuentasAIntentar(coincidenciaTarjeta, true)).toEqual([
      [BANORTE.tarjeta, "tarjeta"],
      [BANORTE.clabe, "clabe"],
      [BANORTE.cuenta, "cuenta"],
    ]);
    expect(cuentasAIntentar(coincidenciaTarjeta)).toEqual([
      [BANORTE.tarjeta, "tarjeta"],
      [BANORTE.clabe, "clabe"],
    ]);
  });

  it("clave cortada por la imagen: vale el pago cuya clave empieza igual", async () => {
    const pago: PagoFalso = { ...BBVA_NOCHE, fecha: "09-10-2026", clave: "MBAN01002610090089417907", monto: "590.00" };
    const { deps } = banxicoFalso([pago]);
    const cortada = { claveRastreo: "MBAN0100261009008941", referencia: "2309260", fecha: "2026-10-09", hora: "15:06", monto: 590 };
    const r = await buscarEnBanxico(bbva(cortada), deps);
    expect(r).toMatchObject({ estado: "VALIDADO", pago: { claveRastreo: "MBAN01002610090089417907" } });
  });

  it("una clave corta que no es el inicio de la de Banxico no se acepta", async () => {
    const pago: PagoFalso = { ...BBVA_NOCHE, fecha: "09-10-2026", clave: "MBAN01002610090089417907", monto: "590.00" };
    const { deps } = banxicoFalso([pago]);
    const otra = { claveRastreo: "MBAN0100261009009999", referencia: "2309260", fecha: "2026-10-09", hora: "15:06", monto: 590 };
    const r = await buscarEnBanxico(bbva(otra), deps);
    expect(r.estado).toBe("NO_ENCONTRADO");
  });
});

describe("varios pagos idénticos: el celular puede estar una hora adelante", () => {
  const VARIOS = fixture("valida-consulta-varios-pagos-referencia.html");
  const tarjetaInbursa: CoincidenciaCuenta = { cuenta: INBURSA, tipo: "tarjeta", numero: "4658280004936574" };

  it("18:09 en el celular = 17:09 en CDMX: elige el pago de las 17:11", async () => {
    const { deps } = banxicoFalso([], [VARIOS]);
    const r = await buscarEnBanxico(
      entrada(
        { claveRastreo: null, referencia: "4936574", monto: 890, fecha: "2026-10-08", hora: "18:09:36" },
        { coincidencia: tarjetaInbursa, bancoEmisor: { clave: "AZTECA", nombreLibre: null } },
      ),
      deps,
    );
    expect(r).toMatchObject({ estado: "VALIDADO", pago: { claveRastreo: "261008011287636711I" } });
  });
});

describe("revisarBanxico: la revisión liviana del vigía (una sola petición)", () => {
  const conCatalogo = (respuesta: CatalogoBanxico | Error) => {
    const pedidos: string[] = [];
    const vivo = async (fecha: string) => {
      pedidos.push(fecha);
      if (respuesta instanceof Error) throw respuesta;
      return respuesta;
    };
    return { catalogos: { vivo }, pedidos };
  };

  it("pide el catálogo de hoy en CDMX y, si llega con instituciones, Banxico responde", async () => {
    const { catalogos, pedidos } = conCatalogo(catalogo("catalogo-08-10-2026.json", "08-10-2026"));
    // 09-oct 05:39 UTC = 08-oct 23:39 en CDMX.
    expect(await revisarBanxico({ ahora: new Date("2026-10-09T05:39:00Z"), catalogos })).toEqual({ ok: true });
    expect(pedidos).toEqual(["08-10-2026"]);
  });

  it("captcha activado en el sitio: no responde y avisa al ritmo global", async () => {
    const captchas: string[] = [];
    const { catalogos } = conCatalogo({ ...catalogo("catalogo-08-10-2026.json", "08-10-2026"), overrideCaptcha: false });
    const salud = await revisarBanxico({ ahora: AHORA, catalogos, alCaptcha: (o) => captchas.push(o) });
    expect(salud).toEqual({ ok: false, motivo: "activó el captcha en el sitio" });
    expect(captchas).toEqual(["revisión de Banxico"]);
  });

  it("catálogo vacío o error de red: no responde, con el motivo", async () => {
    const vacio = conCatalogo({ fecha: "09-10-2026", instituciones: [], overrideCaptcha: true });
    expect(await revisarBanxico({ ahora: AHORA, catalogos: vacio.catalogos })).toEqual({ ok: false, motivo: "el catálogo llegó vacío" });
    const caido = conCatalogo(new ErrorRedBanxico("Banxico no respondió tras 3 intentos: timeout"));
    expect(await revisarBanxico({ ahora: AHORA, catalogos: caido.catalogos })).toEqual({
      ok: false,
      motivo: "Banxico no respondió tras 3 intentos: timeout",
    });
  });
});
