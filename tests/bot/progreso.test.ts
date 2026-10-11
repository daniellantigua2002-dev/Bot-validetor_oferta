import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GrammyError, type Api } from "grammy";
import { IndicadorProgreso, siguientePorcentaje } from "../../src/bot/progreso.js";

/** Api de Telegram simulada: guarda las ediciones y acciones de chat. */
function apiFalsa(fallas: unknown[] = []) {
  const ediciones: string[] = [];
  const acciones: string[] = [];
  const api = {
    editMessageText: vi.fn(async (_chat: number, _msg: number, texto: string) => {
      const f = fallas.shift();
      if (f) throw f;
      ediciones.push(texto);
      return true;
    }),
    sendChatAction: vi.fn(async (_chat: number, accion: string) => {
      acciones.push(accion);
      return true;
    }),
  } as unknown as Api;
  return { api, ediciones, acciones };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("siguientePorcentaje", () => {
  it("avanza dentro de la etapa sin pasar el tope y nunca retrocede", () => {
    expect(siguientePorcentaje(0, "LEYENDO", 0)).toBe(10);
    expect(siguientePorcentaje(10, "LEYENDO", 5)).toBe(25);
    expect(siguientePorcentaje(25, "LEYENDO", 100)).toBe(45);
    expect(siguientePorcentaje(45, "BANXICO", 0)).toBe(55);
    expect(siguientePorcentaje(80, "REGLAS", 0)).toBe(80);
  });
});

describe("IndicadorProgreso", () => {
  it("anima el mensaje (reloj, barra y segundos) y muestra 'escribiendo…'", async () => {
    const { api, ediciones, acciones } = apiFalsa();
    const indicador = new IndicadorProgreso(api, 1, 2);
    indicador.iniciar();
    await vi.advanceTimersByTimeAsync(4600);
    await indicador.detener();

    expect(ediciones.length).toBeGreaterThanOrEqual(3);
    expect(ediciones[0]).toContain("🕐 <b>Leyendo los datos de la imagen…</b>");
    expect(ediciones.at(-1)).toMatch(/🕓 <b>Leyendo los datos de la imagen…<\/b>/);
    expect(ediciones.at(-1)).toMatch(/⏱ [45] s/);
    expect(acciones[0]).toBe("typing");
  });

  it("al cambiar de etapa marca los pasos anteriores como hechos", async () => {
    const { api, ediciones, acciones } = apiFalsa();
    const indicador = new IndicadorProgreso(api, 1, 2);
    indicador.iniciar();
    await vi.advanceTimersByTimeAsync(10);
    indicador.actualizar({ etapa: "CAPTURA" });
    await vi.advanceTimersByTimeAsync(4600);
    await indicador.detener();
    expect(ediciones.at(-1)).toContain("✅ Consultando Banxico");
    expect(ediciones.at(-1)).toContain("<b>Generando la captura…</b>");
    expect(acciones).toContain("upload_photo");
  });

  it("al detenerse ya no edita más", async () => {
    const { api, ediciones } = apiFalsa();
    const indicador = new IndicadorProgreso(api, 1, 2);
    indicador.iniciar();
    await vi.advanceTimersByTimeAsync(10);
    await indicador.detener();
    const antes = ediciones.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ediciones.length).toBe(antes);
  });

  it("detenido, tampoco edita si el pipeline sigue avisando etapas (validación cancelada por tiempo)", async () => {
    const { api, ediciones } = apiFalsa();
    const indicador = new IndicadorProgreso(api, 1, 2);
    indicador.iniciar();
    await vi.advanceTimersByTimeAsync(10);
    await indicador.detener();
    const antes = ediciones.length;
    indicador.actualizar({ etapa: "BANXICO", consulta: 3 });
    await vi.advanceTimersByTimeAsync(10);
    expect(ediciones.length).toBe(antes);
  });

  it("si Telegram responde 429 espera el tiempo indicado", async () => {
    const limite = new GrammyError("Too Many Requests", { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 6 } }, "editMessageText", {});
    const { api, ediciones } = apiFalsa([limite]);
    const indicador = new IndicadorProgreso(api, 1, 2);
    indicador.iniciar();
    await vi.advanceTimersByTimeAsync(4600); // dentro de la pausa de 6 s: no edita
    expect(ediciones).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(3000);
    await indicador.detener();
    expect(ediciones.length).toBeGreaterThan(0);
  });
});
