import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Catalogos, institucionEmisora } from "../../src/banxico/catalogo.js";
import { consultarValida, ErrorRedBanxico, formularioConsulta, type ConsultaBanxico, type Fetch } from "../../src/banxico/cliente.js";

const fixture = (nombre: string) => readFileSync(new URL(`../fixtures/banxico/${nombre}`, import.meta.url), "utf8");

const CONSULTA: ConsultaBanxico = {
  tipoCriterio: "T",
  fecha: "08-10-2026",
  criterio: "SPIN-20261008200443959PNEB9",
  emisor: { codigo: "90728", nombre: "SPIN BY OXXO" },
  receptor: { codigo: "40072", nombre: "BANORTE" },
  cuenta: "072000000000000012",
  monto: "400.00",
  tipoConsulta: 0,
};

/** fetch simulado: devuelve las respuestas en orden y registra las peticiones. */
function fetchFalso(respuestas: (Response | Error)[]) {
  const peticiones: { url: string; init: RequestInit }[] = [];
  const f: Fetch = async (url, init) => {
    peticiones.push({ url: String(url), init: init ?? {} });
    const r = respuestas.shift();
    if (!r) throw new Error("sin respuestas preparadas");
    if (r instanceof Error) throw r;
    return r;
  };
  return { f, peticiones };
}

const sinEspera = async () => {};

describe("formulario de valida.do", () => {
  it("envía exactamente los campos del sitio, con Pago a banco desmarcado y captcha=c", () => {
    expect(formularioConsulta(CONSULTA).toString()).toBe(
      "tipoCriterio=T&fecha=08-10-2026&criterio=SPIN-20261008200443959PNEB9&emisor=90728&receptor=40072" +
        "&cuenta=072000000000000012&receptorParticipante=0&monto=400.00&captcha=c&tipoConsulta=0",
    );
  });
});

describe("consultarValida", () => {
  it("hace POST a valida.do sin cookies", async () => {
    const { f, peticiones } = fetchFalso([new Response("<html>ok</html>")]);
    expect(await consultarValida(CONSULTA, { fetch: f, esperar: sinEspera })).toBe("<html>ok</html>");
    expect(peticiones[0]!.url).toBe("https://www.banxico.org.mx/cep/valida.do");
    expect(peticiones[0]!.init.method).toBe("POST");
    const headers = peticiones[0]!.init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toMatch(/x-www-form-urlencoded/);
    expect(headers.Cookie).toBeUndefined();
  });

  it("reintenta errores de red y 5xx", async () => {
    const { f, peticiones } = fetchFalso([new Error("ECONNRESET"), new Response("", { status: 503 }), new Response("bien")]);
    expect(await consultarValida(CONSULTA, { fetch: f, esperar: sinEspera, reintentos: 3 })).toBe("bien");
    expect(peticiones).toHaveLength(3);
  });

  it("tras agotar los reintentos lanza ErrorRedBanxico", async () => {
    const { f } = fetchFalso([new Error("a"), new Error("b"), new Error("c")]);
    await expect(consultarValida(CONSULTA, { fetch: f, esperar: sinEspera, reintentos: 3 })).rejects.toBeInstanceOf(ErrorRedBanxico);
  });

  it("no reintenta un 4xx", async () => {
    const { f, peticiones } = fetchFalso([new Response("", { status: 404 })]);
    await expect(consultarValida(CONSULTA, { fetch: f, esperar: sinEspera })).rejects.toThrow(/HTTP 404/);
    expect(peticiones).toHaveLength(1);
  });
});

describe("Catalogos", () => {
  const json = (archivo: string) => new Response(fixture(archivo), { headers: { "Content-Type": "application/json" } });

  it("descarga el catálogo de la fecha y lo guarda en caché", async () => {
    const { f, peticiones } = fetchFalso([json("catalogo-08-10-2026.json")]);
    const catalogos = new Catalogos({ fetch: f, esperar: sinEspera });
    const a = await catalogos.obtener("08-10-2026");
    const b = await catalogos.obtener("08-10-2026");
    expect(a).toBe(b);
    expect(peticiones).toHaveLength(1);
    expect(peticiones[0]!.url).toBe("https://www.banxico.org.mx/cep/instituciones.do?fecha=08-10-2026");
    expect(a.instituciones).toHaveLength(97);
    expect(a.overrideCaptcha).toBe(true);
  });

  it("fecha futura → catálogo vacío", async () => {
    const { f } = fetchFalso([json("catalogo-fecha-futura.json")]);
    expect((await new Catalogos({ fetch: f, esperar: sinEspera }).obtener("20-10-2026")).instituciones).toEqual([]);
  });

  it("si falla no queda en caché", async () => {
    const { f, peticiones } = fetchFalso([new Response("", { status: 404 }), json("catalogo-08-10-2026.json")]);
    const catalogos = new Catalogos({ fetch: f, esperar: sinEspera });
    await expect(catalogos.obtener("08-10-2026")).rejects.toThrow();
    expect((await catalogos.obtener("08-10-2026")).instituciones).toHaveLength(97);
    expect(peticiones).toHaveLength(2);
  });

  it("resuelve el emisor por el mapa o por nombre libre", async () => {
    const { f } = fetchFalso([json("catalogo-08-10-2026.json")]);
    const cat = await new Catalogos({ fetch: f, esperar: sinEspera }).obtener("08-10-2026");
    expect(institucionEmisora({ clave: "SPIN", nombreLibre: null }, cat)).toEqual({ codigo: "90728", nombre: "SPIN BY OXXO" });
    expect(institucionEmisora({ clave: null, nombreLibre: "Banco Multiva" }, cat)).toEqual({ codigo: "40132", nombre: "MULTIVA BANCO" });
  });

  it("con el captcha activado no queda en caché: la próxima vez se vuelve a pedir", async () => {
    const conCaptcha = new Response(JSON.stringify({ instituciones: [["40072", "BANORTE"]], overrideCaptcha: false }));
    const { f, peticiones } = fetchFalso([conCaptcha, json("catalogo-08-10-2026.json")]);
    const catalogos = new Catalogos({ fetch: f, esperar: sinEspera });
    expect((await catalogos.obtener("08-10-2026")).overrideCaptcha).toBe(false);
    expect((await catalogos.obtener("08-10-2026")).overrideCaptcha).toBe(true);
    expect(peticiones).toHaveLength(2);
  });

  it("vivo: siempre lo pide a Banxico (para saber si responde) y deja el nuevo en caché", async () => {
    const { f, peticiones } = fetchFalso([json("catalogo-08-10-2026.json"), json("catalogo-08-10-2026.json")]);
    const catalogos = new Catalogos({ fetch: f, esperar: sinEspera });
    await catalogos.obtener("08-10-2026");
    const vivo = await catalogos.vivo("08-10-2026");
    expect(peticiones).toHaveLength(2);
    expect(await catalogos.obtener("08-10-2026")).toBe(vivo);
  });
});

describe("Catalogos en disco (días pasados)", () => {
  const json = (archivo: string) => new Response(fixture(archivo), { headers: { "Content-Type": "application/json" } });
  let carpeta = "";
  beforeEach(async () => {
    carpeta = await mkdtemp(join(tmpdir(), "catalogos-"));
  });
  afterEach(async () => {
    await rm(carpeta, { recursive: true, force: true });
  });
  /** Hoy es el 09-oct en CDMX. */
  const disco = () => ({ carpeta, hoy: () => "2026-10-09" });

  it("el de un día pasado se guarda y, aunque el bot se reinicie, no se vuelve a pedir", async () => {
    const primero = fetchFalso([json("catalogo-08-10-2026.json")]);
    const antes = await new Catalogos({ fetch: primero.f, esperar: sinEspera }, disco()).obtener("08-10-2026");
    expect(existsSync(join(carpeta, "2026-10-08.json"))).toBe(true);

    const despues = fetchFalso([]);
    const leido = await new Catalogos({ fetch: despues.f, esperar: sinEspera }, disco()).obtener("08-10-2026");
    expect(despues.peticiones).toHaveLength(0);
    expect(leido).toEqual({ fecha: "08-10-2026", instituciones: antes.instituciones, overrideCaptcha: true });
  });

  it("el de hoy no se guarda: todavía puede cambiar", async () => {
    const { f } = fetchFalso([json("catalogo-08-10-2026.json")]);
    await new Catalogos({ fetch: f, esperar: sinEspera }, disco()).obtener("09-10-2026");
    expect(await readdir(carpeta)).toEqual([]);
  });

  it("un catálogo vacío o con el captcha activado no se guarda", async () => {
    const vacio = new Response(JSON.stringify({ overrideCaptcha: true }));
    const conCaptcha = new Response(JSON.stringify({ overrideCaptcha: false }));
    const { f } = fetchFalso([vacio, conCaptcha]);
    const catalogos = new Catalogos({ fetch: f, esperar: sinEspera }, disco());
    await catalogos.obtener("07-10-2026");
    await catalogos.obtener("06-10-2026");
    expect(await readdir(carpeta)).toEqual([]);
  });

  it("un archivo dañado se ignora y se pide a Banxico", async () => {
    await writeFile(join(carpeta, "2026-10-08.json"), "{ esto no es json", "utf8");
    const { f, peticiones } = fetchFalso([json("catalogo-08-10-2026.json")]);
    const cat = await new Catalogos({ fetch: f, esperar: sinEspera }, disco()).obtener("08-10-2026");
    expect(peticiones).toHaveLength(1);
    expect(cat.instituciones).toHaveLength(97);
  });
});
