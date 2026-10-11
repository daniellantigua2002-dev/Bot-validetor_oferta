import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ColaGuardada } from "../../src/bot/cola-guardada.js";

interface T {
  id: string;
  dato: string;
}

let carpeta: string;
beforeEach(async () => {
  carpeta = await mkdtemp(join(tmpdir(), "cola-"));
});
afterEach(async () => {
  await rm(carpeta, { recursive: true, force: true });
});

describe("ColaGuardada", () => {
  it("sin archivo no hay pendientes", async () => {
    expect(await new ColaGuardada<T>(join(carpeta, "cola.json")).cargar()).toEqual([]);
  });

  it("guarda, actualiza y quita trabajos; otro proceso los lee al arrancar", async () => {
    const ruta = join(carpeta, "cola.json");
    const cola = new ColaGuardada<T>(ruta);
    await cola.cargar();
    await cola.guardar({ id: "a", dato: "1" });
    await cola.guardar({ id: "b", dato: "2" });
    await cola.guardar({ id: "a", dato: "1 actualizado" });
    await cola.quitar("b");
    expect(await new ColaGuardada<T>(ruta).cargar()).toEqual([{ id: "a", dato: "1 actualizado" }]);
  });

  it("al cargar conserva lo pendiente aunque después se guarden trabajos nuevos", async () => {
    const ruta = join(carpeta, "cola.json");
    await writeFile(ruta, JSON.stringify([{ id: "viejo", dato: "x" }]));
    const cola = new ColaGuardada<T>(ruta);
    expect(await cola.cargar()).toEqual([{ id: "viejo", dato: "x" }]);
    await cola.guardar({ id: "nuevo", dato: "y" });
    expect(JSON.parse(await readFile(ruta, "utf8"))).toEqual([
      { id: "viejo", dato: "x" },
      { id: "nuevo", dato: "y" },
    ]);
  });

  it("quitar algo que no existe no escribe nada", async () => {
    const ruta = join(carpeta, "cola.json");
    await new ColaGuardada<T>(ruta).quitar("nada");
    await expect(readFile(ruta, "utf8")).rejects.toThrow();
  });
});
