import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReferenciasAprendidas } from "../../src/storage/referencias.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "referencias-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("ReferenciasAprendidas (la referencia de BBVA cambia según la semana)", () => {
  it("sin archivo no sabe ninguna", async () => {
    const r = new ReferenciasAprendidas(join(dir, "no-existe.json"));
    await r.cargar();
    expect(r.para("BBVA", "2026-10-09")).toBeNull();
  });

  it("aprende de un pago validado y la usa para pagos de fechas cercanas (±7 días)", async () => {
    const r = new ReferenciasAprendidas(join(dir, "ref.json"));
    await r.aprender("BBVA", "2309260", "2026-10-08");
    expect(r.para("BBVA", "2026-10-09")).toBe("2309260");
    expect(r.para("BBVA", "2026-10-15")).toBe("2309260");
    expect(r.para("BBVA", "2026-10-20")).toBeNull();
    expect(r.para("BANORTE", "2026-10-09")).toBeNull();
  });

  it("si cambia, gana la más vista cerca de la fecha (una referencia escrita a mano no la reemplaza)", async () => {
    const r = new ReferenciasAprendidas(join(dir, "ref.json"));
    await r.aprender("BBVA", "2309260", "2026-10-07");
    await r.aprender("BBVA", "2309260", "2026-10-08");
    await r.aprender("BBVA", "1234567", "2026-10-09");
    expect(r.para("BBVA", "2026-10-09")).toBe("2309260");
    // La semana siguiente aparece la nueva y la vieja ya no aplica.
    await r.aprender("BBVA", "3009260", "2026-10-15");
    expect(r.para("BBVA", "2026-10-16")).toBe("3009260");
  });

  it("se guarda en el disco y se vuelve a leer al reiniciar", async () => {
    const ruta = join(dir, "data", "ref.json");
    await new ReferenciasAprendidas(ruta).aprender("BBVA", "2309260", "2026-10-08");
    const json = JSON.parse(await readFile(ruta, "utf8"));
    expect(json).toEqual([{ banco: "BBVA", referencia: "2309260", fecha: "2026-10-08", veces: 1 }]);
    const otra = new ReferenciasAprendidas(ruta);
    await otra.cargar();
    expect(otra.para("BBVA", "2026-10-09")).toBe("2309260");
  });

  it("olvida las que llevan más de 30 días sin verse; un archivo dañado empieza vacío", async () => {
    const ruta = join(dir, "ref.json");
    const r = new ReferenciasAprendidas(ruta);
    await r.aprender("BBVA", "1111111", "2026-08-01");
    await r.aprender("BBVA", "2309260", "2026-10-08");
    expect(JSON.parse(await readFile(ruta, "utf8"))).toHaveLength(1);
    await writeFile(ruta, "{no es json");
    const danada = new ReferenciasAprendidas(ruta);
    await danada.cargar();
    expect(danada.para("BBVA", "2026-10-08")).toBeNull();
  });
});
