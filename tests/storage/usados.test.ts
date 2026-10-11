import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AlmacenUsados, buscarDuplicado } from "../../src/storage/usados.js";
import { registro } from "../helpers/registros.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "usados-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("AlmacenUsados", () => {
  it("un archivo inexistente es una lista vacía", async () => {
    expect(await new AlmacenUsados(join(dir, "no-existe.json")).leer()).toEqual([]);
  });

  it("registra y vuelve a leer, creando la carpeta si falta", async () => {
    const almacen = new AlmacenUsados(join(dir, "data", "usados.json"));
    await almacen.registrar(registro());
    expect(await almacen.leer()).toEqual([registro()]);
    const json = JSON.parse(await readFile(almacen.ruta, "utf8"));
    expect(json.registros).toHaveLength(1);
  });

  it("no deja archivos temporales", async () => {
    const almacen = new AlmacenUsados(join(dir, "usados.json"));
    await almacen.registrar(registro());
    expect(await readdir(dir)).toEqual(["usados.json"]);
  });

  it("las escrituras simultáneas no se pierden", async () => {
    const almacen = new AlmacenUsados(join(dir, "usados.json"));
    await Promise.all(Array.from({ length: 20 }, (_, i) => almacen.registrar(registro({ claveRastreo: `CLAVE${i}` }))));
    const claves = (await almacen.leer()).map((r) => r.claveRastreo).sort();
    expect(claves).toHaveLength(20);
  });

  it("un JSON dañado da un error claro (no se sobrescribe en silencio)", async () => {
    const ruta = join(dir, "usados.json");
    await writeFile(ruta, "{ dañado");
    await expect(new AlmacenUsados(ruta).leer()).rejects.toThrow(/No se pudo leer/);
  });
});

describe("buscarDuplicado", () => {
  const usados = [registro(), registro({ claveRastreo: "261008011286812472I", referencia: "4936574", monto: "890.00" })];

  it("por clave de rastreo exacta", () => {
    expect(buscarDuplicado(usados, { claveRastreo: "SPIN-20261008200443959PNEB9" })).toEqual(registro());
  });

  it("otra clave NO es duplicado aunque la referencia sea la misma (Azteca repite la referencia)", () => {
    expect(buscarDuplicado(usados, { claveRastreo: "261008011287636711I" })).toBeNull();
  });

  it("sin clave no se decide antes de Banxico", () => {
    expect(buscarDuplicado(usados, { claveRastreo: null })).toBeNull();
  });
});
