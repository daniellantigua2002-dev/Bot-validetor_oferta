import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SaludBanxico } from "../../src/banxico/reintentos.js";
import { ESPERA_BANXICO_MS } from "../../src/bot/espera.js";
import { VigiaBanxico } from "../../src/bot/vigia.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** Vigía con revisiones simuladas: `salud` es lo que responde Banxico y `quedan` si siguen comprobantes esperando. */
function vigiaFalso(opciones: { salud?: SaludBanxico | Error; quedan?: boolean | Error } = {}) {
  const revisiones: number[] = [];
  const resultados: SaludBanxico[] = [];
  const vigia = new VigiaBanxico(
    async () => {
      revisiones.push(Date.now());
      const s = opciones.salud ?? { ok: true };
      if (s instanceof Error) throw s;
      return s;
    },
    async (salud) => {
      resultados.push(salud);
      const q = opciones.quedan ?? false;
      if (q instanceof Error) throw q;
      return q;
    },
  );
  return { vigia, revisiones, resultados };
}

describe("VigiaBanxico", () => {
  it("varios comprobantes esperando: una sola revisión, a la hora de la primera que se programó", async () => {
    const { vigia, revisiones } = vigiaFalso();
    const inicio = Date.now();
    const a = vigia.programar();
    const b = vigia.programar(inicio + 10 * 60_000);
    expect(b).toBe(a);
    expect(a).toBe(inicio + ESPERA_BANXICO_MS);
    expect(vigia.proxima).toBe(a);
    await vi.advanceTimersByTimeAsync(ESPERA_BANXICO_MS);
    expect(revisiones).toEqual([a]);
  });

  it("Banxico responde y ya no queda nadie esperando: deja de vigilar", async () => {
    const { vigia, revisiones } = vigiaFalso({ salud: { ok: true }, quedan: false });
    vigia.programar();
    await vi.advanceTimersByTimeAsync(ESPERA_BANXICO_MS * 3);
    expect(revisiones).toHaveLength(1);
    expect(vigia.proxima).toBeNull();
  });

  it("si siguen esperando, vuelve a revisar cada 3 min", async () => {
    const { vigia, revisiones, resultados } = vigiaFalso({ salud: { ok: false, motivo: "timeout" }, quedan: true });
    vigia.programar();
    await vi.advanceTimersByTimeAsync(ESPERA_BANXICO_MS * 3);
    expect(revisiones).toHaveLength(3);
    expect(resultados.every((s) => !s.ok)).toBe(true);
    vigia.detener();
    expect(vigia.proxima).toBeNull();
    await vi.advanceTimersByTimeAsync(ESPERA_BANXICO_MS * 3);
    expect(revisiones).toHaveLength(3);
  });

  it("si la revisión lanza un error, cuenta como 'no responde' con el motivo", async () => {
    const { vigia, resultados } = vigiaFalso({ salud: new Error("ECONNRESET") });
    vigia.programar();
    await vi.advanceTimersByTimeAsync(ESPERA_BANXICO_MS);
    expect(resultados).toEqual([{ ok: false, motivo: "ECONNRESET" }]);
  });

  it("un error al avisar no deja a nadie esperando para siempre: sigue vigilando", async () => {
    const { vigia, revisiones } = vigiaFalso({ quedan: new Error("Telegram 429") });
    vigia.programar();
    await vi.advanceTimersByTimeAsync(ESPERA_BANXICO_MS * 2);
    expect(revisiones).toHaveLength(2);
    vigia.detener();
  });

  it("una hora ya pasada se revisa de inmediato", async () => {
    const { vigia, revisiones } = vigiaFalso();
    vigia.programar(Date.now() - 60_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(revisiones).toHaveLength(1);
  });

  it("si llega otro comprobante mientras revisa, vuelve a programar aunque la revisión dijera que no queda nadie", async () => {
    let soltar: (s: SaludBanxico) => void = () => undefined;
    const revisiones: number[] = [];
    const vigia = new VigiaBanxico(
      () => {
        revisiones.push(Date.now());
        return new Promise<SaludBanxico>((r) => (soltar = r));
      },
      async () => false,
    );
    vigia.programar(Date.now());
    await vi.advanceTimersByTimeAsync(0);
    expect(revisiones).toHaveLength(1);
    vigia.programar(); // llega mientras la revisión está en curso
    soltar({ ok: false, motivo: "timeout" });
    await vi.advanceTimersByTimeAsync(0);
    expect(vigia.proxima).not.toBeNull();
    vigia.detener();
  });
});
