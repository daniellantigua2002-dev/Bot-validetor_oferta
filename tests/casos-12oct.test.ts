/**
 * Los 5 comprobantes que no se validaron el 12-oct (carpeta Errores/), con un Banxico simulado que responde como
 * el real según los logs de Render, y los controles de que lo que ya funcionaba sigue igual.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { CatalogoBanxico } from "../src/banxico/catalogo.js";
import { ErrorRedBanxico, type ConsultaBanxico } from "../src/banxico/cliente.js";
import { parsearRespuesta } from "../src/banxico/parser.js";
import { buscarEnBanxico, claveCortada, type DependenciasBusqueda, type EntradaBusqueda } from "../src/banxico/reintentos.js";
import { respuestaFinal, resumenIntentos, resumenLectura } from "../src/bot/mensajes.js";
import { CUENTAS_DESTINO } from "../src/config.js";
import { evaluarBancoEmisor } from "../src/extraction/banco-emisor.js";
import type { ResultadoExtraccion } from "../src/extraction/index.js";
import type { DatosExtraidos } from "../src/extraction/schema.js";
import { normalizarDatos } from "../src/normalize/index.js";
import { MENSAJES } from "../src/rules/index.js";
import { claveSinRespaldo, validarComprobante, type DependenciasPipeline, type ResultadoValidacion } from "../src/pipeline.js";
import type { CoincidenciaCuenta } from "../src/types.js";
import { datosEjemplo } from "./extraction/datos.js";

const fixture = (nombre: string) => readFileSync(new URL(`./fixtures/banxico/${nombre}`, import.meta.url), "utf8");
const CATALOGO: CatalogoBanxico["instituciones"] = JSON.parse(fixture("catalogo-08-10-2026.json")).instituciones;
const NO_ENCONTRADO = fixture("valida-no-encontrado-consulta.html");
const [BANORTE, , BANAMEX] = CUENTAS_DESTINO;
const REF_BBVA = "1210260";
/** Hora de CDMX del 12-oct (UTC-6). */
const CDMX = (hhmm: string, dia = "12") => new Date(`2026-10-${dia}T${hhmm}:00-06:00`);

interface PagoFalso {
  fecha: string;
  clave: string;
  referencia: string;
  emisor: string;
  receptor: string;
  cuenta: string;
  monto: string;
  estado?: string;
}

/** La tabla de valida.do: las filas de cuenta y monto solo salen si se enviaron (como en el sitio real). */
function tabla(p: PagoFalso, c: ConsultaBanxico): string {
  return `<table id="xxx" class="styled-table vertical"><tbody>
<tr><td>Número de Referencia</td><td>${p.referencia}</td></tr>
<tr><td>Clave de Rastreo</td><td>${p.clave}</td></tr>
<tr><td>Estado del pago en Banxico</td><td>${p.estado ?? "Liquidado"}</td></tr>
<tr><td>Fecha y hora de recepción</td><td>${p.fecha.replace(/-/g, "/")} 12:00:00</td></tr>
${c.cuenta ? `<tr><td>Cuenta Beneficiaria</td><td>${p.cuenta}</td></tr>` : ""}${c.monto ? `<tr><td>Monto</td><td>${p.monto}</td></tr>` : ""}
</tbody></table>`;
}

function banxico(pagos: PagoFalso[], falla?: () => string | Error) {
  const consultas: ConsultaBanxico[] = [];
  const deps: DependenciasBusqueda = {
    consultar: async (c) => {
      consultas.push(c);
      const f = falla?.();
      if (f instanceof Error) throw f;
      if (f !== undefined) return f;
      const p = pagos.find(
        (x) =>
          x.fecha === c.fecha &&
          x.emisor === c.emisor.codigo &&
          x.receptor === c.receptor.codigo &&
          (c.cuenta === "" || x.cuenta === c.cuenta) &&
          (c.monto === "" || x.monto === c.monto) &&
          (c.tipoCriterio === "T" ? x.clave === c.criterio : x.referencia === c.criterio),
      );
      return p ? tabla(p, c) : NO_ENCONTRADO;
    },
    catalogos: { obtener: async (fecha) => ({ fecha, instituciones: CATALOGO, overrideCaptcha: true }) },
    esperar: async () => undefined,
  };
  return { deps, consultas };
}

const tarjeta: CoincidenciaCuenta = { cuenta: BANORTE, tipo: "tarjeta", numero: BANORTE.tarjeta };
const cuentaSuelta: CoincidenciaCuenta = { cuenta: BANORTE, tipo: "cuenta", numero: BANORTE.cuenta };
const clabeBanamex: CoincidenciaCuenta = { cuenta: BANAMEX, tipo: "clabe", numero: BANAMEX.clabe };
const BBVA = { clave: "BBVA" as const, nombreLibre: null };

function entrada(datos: Partial<DatosExtraidos>, extra: Partial<EntradaBusqueda>): EntradaBusqueda {
  return {
    normalizados: normalizarDatos(datosEjemplo({ referencia: null, ...datos })),
    coincidencia: tarjeta,
    bancoEmisor: BBVA,
    referenciasAprendidas: (banco, _fecha, rango = 0) => (banco === "BBVA" && rango === 0 ? REF_BBVA : null),
    ...extra,
  };
}

describe("caso 1 (BBVA $990, 20:29): la clave existe con ese monto pero DEVUELTA a otro número", () => {
  const pago: PagoFalso = { fecha: "12-10-2026", clave: "MBAN01002610130058919438", referencia: REF_BBVA, emisor: "40012", receptor: "40072", cuenta: "4189140000001871", monto: "990.00", estado: "Devuelto" };
  const caso1 = () => entrada({ claveRastreo: pago.clave, fecha: "2026-10-13", hora: "20:29", monto: 990, cuentaDestino: "1871" }, { ahora: CDMX("20:35") });

  it("antes decía 'Cuentas incorrectas'; ahora 'Devuelto', con la tabla del sondeo para la foto", async () => {
    const { deps } = banxico([pago]);
    const r = await buscarEnBanxico(caso1(), deps);
    expect(r.estado).toBe("NO_LIQUIDADO");
    expect(r.pago?.estado).toBe("DEVUELTO");
    expect(r.mensaje).toMatch(/"Devuelto": no fue a nuestra cuenta/);
    expect(r.html).toContain("Devuelto");
    expect(r.consulta).toMatchObject({ criterio: pago.clave, cuenta: "" });
  });

  it("si la clave está LIQUIDADA a otra cuenta, sigue siendo 'Cuentas incorrectas'", async () => {
    const { deps } = banxico([{ ...pago, estado: "Liquidado" }]);
    const r = await buscarEnBanxico(caso1(), deps);
    expect(r.estado).toBe("CUENTA_INCORRECTA");
  });
});

describe("caso 2 (BBVA $1,290, 19:33, impreso el 13): clave cortada por la imagen", () => {
  const caso2 = (ahora = CDMX("19:45")) =>
    entrada({ claveRastreo: "MBAN010026101300585519", fecha: "2026-10-13", hora: "19:33", monto: 1290, cuentaDestino: "1871" }, { ahora });

  it("detecta la clave incompleta (22 de 24)", () => {
    expect(claveCortada(caso2().normalizados, BBVA)).toEqual({ leidos: 22, largo: 24 });
    expect(claveCortada(normalizarDatos(datosEjemplo({ claveRastreo: "MBAN01002610130058919438" })), BBVA)).toBeNull();
  });

  it("después de las consultas normales: 'valida mañana' (fecha de mañana) y el aviso de la clave cortada (también probó la referencia)", async () => {
    const { deps, consultas } = banxico([]);
    const r = await buscarEnBanxico(caso2(), deps);
    expect(r.estado).toBe("FECHA_FUTURA");
    expect(r.claveCortada).toBe(true);
    expect(r.mensaje.startsWith(`${MENSAJES.FECHA_MANANA}: la fecha del comprobante (13/10/2026) es la de mañana`)).toBe(true);
    expect(r.mensaje).toContain("se leen 22 de sus 24 caracteres");
    expect(r.mensaje).toContain("y con la referencia tampoco apareció");
    expect(consultas.some((c) => c.tipoCriterio === "R")).toBe(true);
  });

  it("con el pago a la tarjeta y esa referencia, se sigue validando por el inicio de la clave (como antes)", async () => {
    const { deps } = banxico([{ fecha: "12-10-2026", clave: "MBAN01002610130058551947", referencia: REF_BBVA, emisor: "40012", receptor: "40072", cuenta: BANORTE.tarjeta, monto: "1290.00" }]);
    expect((await buscarEnBanxico(caso2(), deps)).estado).toBe("VALIDADO");
  });

  it("otro pago igual (mismo monto, tarjeta, referencia y día) cuya clave NO empieza igual no se valida", async () => {
    const otro: PagoFalso = { fecha: "12-10-2026", clave: "MBAN01002610130099999999", referencia: REF_BBVA, emisor: "40012", receptor: "40072", cuenta: BANORTE.tarjeta, monto: "1290.00" };
    const { deps } = banxico([otro]);
    expect((await buscarEnBanxico(caso2(), deps)).estado).not.toBe("VALIDADO");
    // Ni aunque el OCR no hubiera alcanzado a leer la clave: tiene la forma de una clave BBVA (MBAN…) y está cortada,
    // así que sigue mandando (el respaldo por la referencia del caso 4 es solo para claves que no parecen claves).
    const sinOcr = banxico([otro]);
    expect((await buscarEnBanxico(caso2(CDMX("19:45")), sinOcr.deps)).estado).not.toBe("VALIDADO");
    const conRespaldoFalso = banxico([otro]);
    expect((await buscarEnBanxico({ ...caso2(), claveSinRespaldo: true }, conRespaldoFalso.deps)).estado).not.toBe("VALIDADO");
  });

  it("de un día que no es mañana (clave cortada): 'no se encontró' con el aviso, sin sugerir otra fecha", async () => {
    const { deps } = banxico([]);
    const r = await buscarEnBanxico(entrada({ claveRastreo: "MBAN010026101200585519", fecha: "2026-10-12", hora: "12:00", monto: 1290, cuentaDestino: "1871" }, { ahora: CDMX("15:00") }), deps);
    expect(r).toMatchObject({ estado: "NO_ENCONTRADO", claveCortada: true });
    expect(r.claveInexistente).toBeUndefined();
    const texto = respuestaFinal({ codigo: "NO_ENCONTRADO", mensaje: r.mensaje, claveCortada: true, normalizados: normalizarDatos(datosEjemplo({ claveRastreo: "MBAN010026101200585519" })), reglas: [], intentos: r.intentos, tiempos: {} }).texto;
    expect(texto).toContain("Envía la captura completa");
    expect(texto).not.toContain("💡");
  });
});

describe("caso 3 (BBVA a •3306): pagado al número de cuenta 1000473306, devuelto", () => {
  const pago: PagoFalso = { fecha: "12-10-2026", clave: "MBAN01002610120061131425", referencia: REF_BBVA, emisor: "40012", receptor: "40072", cuenta: BANORTE.cuenta, monto: "1490.00", estado: "Devuelto" };

  it("sin clave ni fecha: con la referencia y el número de cuenta aparece 'Devuelto' en la primera consulta", async () => {
    const { deps, consultas } = banxico([pago]);
    const r = await buscarEnBanxico(entrada({ claveRastreo: null, fecha: null, hora: null, monto: 1490, cuentaDestino: "3306" }, { coincidencia: cuentaSuelta, ahora: CDMX("18:34") }), deps);
    expect(r).toMatchObject({ estado: "NO_LIQUIDADO", pago: { estado: "DEVUELTO" } });
    expect(consultas.map((c) => c.cuenta)).toEqual([BANORTE.cuenta]);
  });

  it("con la clave (intento de las 18:32): 'Devuelto', ya no 'Cuentas incorrectas'", async () => {
    const { deps } = banxico([pago]);
    const r = await buscarEnBanxico(entrada({ claveRastreo: pago.clave, fecha: "2026-10-12", hora: "11:29", monto: 1490, cuentaDestino: "3306" }, { coincidencia: cuentaSuelta, ahora: CDMX("18:32") }), deps);
    expect(r).toMatchObject({ estado: "NO_LIQUIDADO", pago: { estado: "DEVUELTO" } });
  });
});

describe("caso 4 (Plata/STP $1,000): la IA tomó el folio como clave de rastreo", () => {
  const pago: PagoFalso = { fecha: "12-10-2026", clave: "2026101290646PLATAwfc7XxVEMOxX", referencia: "1234567", emisor: "90646", receptor: "40002", cuenta: BANAMEX.clabe, monto: "1000.00" };
  const caso4 = (extra: Partial<EntradaBusqueda> = {}) =>
    entrada(
      { claveRastreo: "ad4ff015", referencia: "1234567", fecha: "2026-10-12", hora: "18:07", monto: 1000, cuentaDestino: BANAMEX.clabe },
      { coincidencia: clabeBanamex, bancoEmisor: { clave: "STP", nombreLibre: null }, ahora: CDMX("18:27"), ...extra },
    );

  it("antes descartaba el pago que traía la referencia; ahora lo valida (la clave no existe en Banxico ni se ve en la imagen)", async () => {
    const { deps } = banxico([pago]);
    const r = await buscarEnBanxico(caso4({ claveSinRespaldo: true }), deps);
    expect(r).toMatchObject({ estado: "VALIDADO", pago: { claveRastreo: pago.clave } });
    expect(resumenIntentos(r, { detalle: true })).toContain("no existe en Banxico ni se ve en la imagen");
  });

  it("si la clave leída se ve en la imagen, sigue mandando: no se toma el pago por la referencia", async () => {
    const { deps } = banxico([pago]);
    expect((await buscarEnBanxico(caso4(), deps)).estado).not.toBe("VALIDADO");
  });

  it("si la clave existe en Banxico ese día (no es inventada), sigue mandando aunque no se vea", async () => {
    // Hay un pago con esa clave (otro monto): la clave es real y no se cambia por la referencia.
    const { deps } = banxico([pago, { ...pago, clave: "ad4ff015", referencia: "7654321", monto: "50.00" }]);
    expect((await buscarEnBanxico(caso4({ claveSinRespaldo: true }), deps)).estado).not.toBe("VALIDADO");
  });

  it("claveSinRespaldo: la clave de la IA no aparece en el texto del OCR", () => {
    const lectura = (claveRastreo: string | null, textoOcr: string | null): ResultadoExtraccion => {
      const datos = datosEjemplo({ claveRastreo });
      return { datos, origen: "nvidia", textoOcr, banco: evaluarBancoEmisor(datos, textoOcr, "nvidia") };
    };
    const plata = "Transferencia por SPEI\nFolio\nad4ff015\nCLABE\n002 180 7021 2461 6185\nReferencia\n1234567";
    const conClave = "Clave de rastreo\n2026101290646PLATAwfc7XxVEMOxX\nReferencia\n1234567";
    const n = (l: ResultadoExtraccion) => normalizarDatos(l.datos);
    const sinClaveEnOcr = lectura("ad4ff015", plata);
    expect(claveSinRespaldo(sinClaveEnOcr, n(sinClaveEnOcr), undefined)).toBe(true);
    const visible = lectura("2026101290646PLATAwfc7XxVEMOxX", conClave);
    expect(claveSinRespaldo(visible, n(visible), undefined)).toBe(false);
    // Sin texto del OCR no se puede afirmar; y si la clave la escribió la persona en la nota, manda.
    const sinOcr = lectura("ad4ff015", null);
    expect(claveSinRespaldo(sinOcr, n(sinOcr), undefined)).toBe(false);
    expect(claveSinRespaldo(sinClaveEnOcr, n(sinClaveEnOcr), { claveRastreo: "ad4ff015" })).toBe(false);
  });

  it("de punta a punta: la persona pulsa STP y se valida con la foto", async () => {
    const datos = datosEjemplo({ bancoEmisor: { nombre: "STP", fuente: "texto", confianza: 0.7 }, claveRastreo: "ad4ff015", referencia: "1234567", fecha: "2026-10-12", hora: "18:07", monto: 1000, cuentaDestino: BANAMEX.clabe, bancoDestino: "Banamex" });
    const textoOcr = "Transferencia por SPEI\nFolio\nad4ff015\nBeneficiario\nCLABE\n002 180 7021 2461 6185\nInstitución\nBanamex\nReferencia\n1234567";
    const extraccion: ResultadoExtraccion = { datos, origen: "nvidia", textoOcr, banco: evaluarBancoEmisor(datos, textoOcr, "nvidia") };
    const { deps: banxicoDeps } = banxico([pago]);
    const capturas: string[] = [];
    const deps: DependenciasPipeline = {
      iniciarExtraccion: () => ({ ocr: Promise.resolve(textoOcr), completa: Promise.resolve(extraccion) }),
      buscar: (e) => buscarEnBanxico(e, banxicoDeps),
      capturar: async (_c, base) => (capturas.push(base), { ruta: `${base}.png`, metodo: "local" }),
      almacen: null,
      referencias: null,
    };
    const r = await validarComprobante(null, { usuario: "t", extraccion, confirmaciones: { banco: { clave: "STP", nombreLibre: null } }, ahora: CDMX("18:27"), rutaRapida: false }, deps);
    expect(r.codigo).toBe("VALIDADO");
    expect(capturas).toHaveLength(1);
  });
});

describe("caso 5 (BanCoppel 18:11, BanCoppel lo envió 9 min tarde)", () => {
  const caso5 = (ahora: Date) =>
    entrada(
      { claveRastreo: "50111763TRANSBPI61946455", referencia: "1210262", fecha: "2026-10-12", hora: "18:11:54", monto: 1290, cuentaDestino: "1871" },
      { bancoEmisor: { clave: "BANCOPPEL", nombreLibre: null }, ahora },
    );

  it("de hoy, de noche, y todavía no aparece: ya no 'valídalo mañana' sino 'vuelve a enviarlo en un rato'", async () => {
    const { deps } = banxico([]);
    const r = await buscarEnBanxico(caso5(CDMX("18:23")), deps);
    expect(r.estado).toBe("COMPROBANTE_NOCTURNO");
    expect(r.mensaje).toContain("algunos bancos lo envían con retraso");
    expect(r.mensaje).not.toMatch(/mañana/);
  });

  it("cuando Banxico ya lo publica (revisión de los 15 min), se valida", async () => {
    const { deps } = banxico([{ fecha: "12-10-2026", clave: "50111763TRANSBPI61946455", referencia: "1210262", emisor: "40137", receptor: "40072", cuenta: BANORTE.tarjeta, monto: "1290.00" }]);
    expect((await buscarEnBanxico(caso5(CDMX("18:28")), deps)).estado).toBe("VALIDADO");
  });
});

describe("fallas de Banxico: nunca terminan en 'no se encontró'", () => {
  const comprobante = () =>
    entrada({ claveRastreo: "50117509TRANSBPI56022323", referencia: "1210260", fecha: "2026-10-12", hora: "14:00", monto: 1290, cuentaDestino: "5884" }, {
      coincidencia: { cuenta: BANORTE, tipo: "clabe", numero: BANORTE.clabe },
      bancoEmisor: { clave: "BANCOPPEL", nombreLibre: null },
      ahora: CDMX("16:00"),
    });

  it("HTTP 403 (bloqueo) o 429 (límite): Banxico no disponible, sin seguir consultando", async () => {
    for (const estado of [403, 429]) {
      const { deps, consultas } = banxico([], () => new Error(`valida.do respondió HTTP ${estado}`));
      const r = await buscarEnBanxico(comprobante(), deps);
      expect(r.estado).toBe("BANXICO_NO_DISPONIBLE");
      expect(consultas).toHaveLength(1);
    }
  });

  it("una página que no es la del CEP (bloqueo del firewall o mantenimiento): Banxico no disponible", async () => {
    const pagina = "<html><title>Request Rejected</title><body>The requested URL was rejected.</body></html>";
    expect(parsearRespuesta(pagina)).toMatchObject({ tipo: "ERROR", desconocida: true });
    const { deps } = banxico([], () => pagina);
    const r = await buscarEnBanxico(comprobante(), deps);
    expect(r.estado).toBe("BANXICO_NO_DISPONIBLE");
    expect(r.intentos[0]?.detalle).toContain("Request Rejected");
  });

  it("sin red, como antes: Banxico no disponible", async () => {
    const { deps } = banxico([], () => new ErrorRedBanxico("timeout"));
    expect((await buscarEnBanxico(comprobante(), deps)).estado).toBe("BANXICO_NO_DISPONIBLE");
  });

  it("un mensaje de error de Banxico (con su texto) no es una caída: la búsqueda sigue como antes", async () => {
    expect(parsearRespuesta(fixture("valida-error-fecha.html"))).not.toHaveProperty("desconocida");
    let veces = 0;
    const { deps } = banxico([], () => (veces++ === 0 ? fixture("valida-error-fecha.html") : NO_ENCONTRADO));
    expect((await buscarEnBanxico(comprobante(), deps)).estado).toBe("NO_ENCONTRADO");
  });
});

describe("mensajes y consola", () => {
  const base = (cambios: Partial<ResultadoValidacion>): ResultadoValidacion => ({
    codigo: "NO_ENCONTRADO",
    mensaje: "No se encontró el pago en Banxico: busqué el 12/10/2026 (3 consultas).",
    normalizados: normalizarDatos(datosEjemplo()),
    reglas: [],
    intentos: [],
    tiempos: {},
    ...cambios,
  });
  const extraccion = (errorNvidia?: string): ResultadoExtraccion => ({ datos: datosEjemplo(), origen: errorNvidia ? "ocr" : "nvidia", textoOcr: "", banco: evaluarBancoEmisor(datosEjemplo(), "", "nvidia"), ...(errorNvidia ? { errorNvidia } : {}) });

  it("si la IA no respondió y se rechaza, se avisa que se leyó con un método más simple", () => {
    const aviso = "El servicio que lee los comprobantes no respondió";
    expect(respuestaFinal(base({ extraccion: extraccion("NVIDIA HTTP 503") })).texto).toContain(aviso);
    expect(respuestaFinal(base({ extraccion: extraccion() })).texto).not.toContain(aviso);
    expect(respuestaFinal(base({ codigo: "VALIDADO", extraccion: extraccion("NVIDIA HTTP 503") })).texto).not.toContain(aviso);
  });

  it("la consola anota lo leído y el detalle de cada consulta (referencia usada y el porqué)", () => {
    const r = base({ bancoEmisor: { clave: "STP", nombreLibre: null } });
    expect(resumenLectura(r)).toBe("clave=SPIN-20261008200443959PNEB9 ref=7454748 monto=400.00 fecha=2026-10-08 hora=14:04:43 cuenta=072650010004755884 emisor=STP");
    const intentos = [{ fecha: "12-10-2026", criterio: "REFERENCIA" as const, valorCriterio: "1234567", cuenta: BANAMEX.clabe, emisor: "STP", receptor: "BANAMEX", resultado: "NO_ENCONTRADO" as const, detalle: "ningún pago de Banxico tiene la clave de rastreo del comprobante" }];
    expect(resumenIntentos({ intentos }, { detalle: true })).toBe("• 12-10-2026 · referencia 1234567 · …6185 → no encontrado (ningún pago de Banxico tiene la clave de rastreo del comprobante)");
    // Sin detalle, igual que antes.
    expect(resumenIntentos({ intentos })).toBe("• 12-10-2026 · referencia · …6185 → no encontrado");
  });
});

describe("consulta extra con la 2ª referencia semanal (BBVA sin referencia en el comprobante)", () => {
  const dosReferencias = (primera: string, segunda: string | null): EntradaBusqueda =>
    entrada(
      { claveRastreo: null, referencia: null, fecha: "2026-10-16", hora: "12:00", monto: 490, cuentaDestino: "1871" },
      {
        ahora: CDMX("12:30", "16"),
        referenciasAprendidas: (banco, _fecha, rango = 0) => (banco === "BBVA" ? (rango === 0 ? primera : rango === 1 ? segunda : null) : null),
      },
    );

  it("si la 1ª (más repetida) no encuentra, la 2ª lo valida en una sola consulta con la fecha del comprobante", async () => {
    const pago: PagoFalso = { fecha: "16-10-2026", clave: "MBAN01002610160012345678", referencia: "2222222", emisor: "40012", receptor: "40072", cuenta: BANORTE.tarjeta, monto: "490.00" };
    const { deps, consultas } = banxico([pago]);
    const r = await buscarEnBanxico(dosReferencias("1111111", "2222222"), deps);
    expect(r.estado).toBe("VALIDADO");
    // La 1ª referencia se probó en varias fechas; la extra usó la 2ª y una sola fecha (la del comprobante).
    expect(consultas.some((c) => c.criterio === "1111111")).toBe(true);
    const extra = consultas.filter((c) => c.criterio === "2222222");
    expect(extra).toHaveLength(1);
    expect(extra[0]).toMatchObject({ tipoCriterio: "R", fecha: "16-10-2026", cuenta: BANORTE.tarjeta });
  });

  it("sin una 2ª referencia no hace la consulta extra", async () => {
    const { deps, consultas } = banxico([]);
    const r = await buscarEnBanxico(dosReferencias("1111111", null), deps);
    expect(r.estado).toBe("NO_ENCONTRADO");
    expect(consultas.every((c) => c.criterio === "1111111")).toBe(true);
  });

  it("si no se vio la cuenta en el comprobante, la consulta extra prueba todas las cuentas de ese banco", async () => {
    const pago: PagoFalso = { fecha: "16-10-2026", clave: "MBAN01002610160087654321", referencia: "2222222", emisor: "40012", receptor: "40072", cuenta: BANORTE.clabe, monto: "490.00" };
    const { deps, consultas } = banxico([pago]);
    const sinCuenta = entrada(
      { claveRastreo: null, referencia: null, fecha: "2026-10-16", hora: "12:00", monto: 490, cuentaDestino: null },
      {
        coincidencia: { cuenta: BANORTE, tipo: "clabe", numero: BANORTE.clabe },
        cuentaDeducida: true,
        ahora: CDMX("12:30", "16"),
        referenciasAprendidas: (banco, _fecha, rango = 0) => (banco === "BBVA" ? (rango === 0 ? "1111111" : rango === 1 ? "2222222" : null) : null),
      },
    );
    const r = await buscarEnBanxico(sinCuenta, deps);
    expect(r.estado).toBe("VALIDADO");
    const extra = consultas.filter((c) => c.criterio === "2222222");
    expect(extra.map((c) => c.cuenta)).toContain(BANORTE.clabe);
    expect(extra.every((c) => c.fecha === "16-10-2026")).toBe(true);
  });
});
