import { describe, expect, it } from "vitest";
import { Cola, TiempoAgotado } from "../../src/bot/cola.js";

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Cola", () => {
  it("procesa una tarea a la vez, en orden de llegada", async () => {
    const cola = new Cola();
    const eventos: string[] = [];
    const tarea = (nombre: string, ms: number) => async () => {
      eventos.push(`inicio ${nombre}`);
      await dormir(ms);
      eventos.push(`fin ${nombre}`);
      return nombre;
    };
    const resultados = await Promise.all([cola.agregar(tarea("a", 30)), cola.agregar(tarea("b", 5)), cola.agregar(tarea("c", 1))]);
    expect(resultados).toEqual(["a", "b", "c"]);
    expect(eventos).toEqual(["inicio a", "fin a", "inicio b", "fin b", "inicio c", "fin c"]);
  });

  it("un error no detiene la cola y se informa a quien encoló", async () => {
    const cola = new Cola();
    const falla = cola.agregar(async () => {
      throw new Error("falló");
    });
    const sigue = cola.agregar(async () => "ok");
    await expect(falla).rejects.toThrow("falló");
    await expect(sigue).resolves.toBe("ok");
  });

  it("cuenta las tareas en espera", async () => {
    const cola = new Cola();
    const a = cola.agregar(() => dormir(20));
    cola.agregar(() => dormir(1));
    expect(cola.enEspera).toBe(2);
    await a;
    await dormir(10);
    expect(cola.enEspera).toBe(0);
  });

  it("cuenta las tareas de cada persona (en curso y esperando)", async () => {
    const cola = new Cola();
    const a = cola.agregar(() => dormir(20), { usuario: "ana" });
    const b = cola.agregar(() => dormir(1), { usuario: "ana" });
    cola.agregar(() => dormir(1), { usuario: "beto" });
    expect(cola.deUsuario("ana")).toBe(2);
    expect(cola.deUsuario("beto")).toBe(1);
    await a;
    expect(cola.deUsuario("ana")).toBe(1);
    await b;
    expect(cola.deUsuario("ana")).toBe(0);
  });

  it("al avanzar la fila avisa a cada tarea en espera su nuevo lugar", async () => {
    const cola = new Cola();
    const posiciones: string[] = [];
    const a = cola.agregar(() => dormir(10));
    const b = cola.agregar(() => dormir(10), { alCambiarPosicion: (n) => posiciones.push(`b:${n}`) });
    const c = cola.agregar(() => dormir(1), { alCambiarPosicion: (n) => posiciones.push(`c:${n}`) });
    await a;
    expect(posiciones).toEqual(["c:1"]); // b ya está empezando: no se le avisa
    await Promise.all([b, c]);
    expect(posiciones).toEqual(["c:1"]);
  });

  it("tiempo máximo: cancela la tarea, avisa con TiempoAgotado y sigue con la siguiente", async () => {
    const cola = new Cola();
    let senal: AbortSignal | undefined;
    const trabada = cola.agregar(
      ({ signal }) => {
        senal = signal;
        return new Promise<never>(() => undefined);
      },
      { limiteMs: 20 },
    );
    const siguiente = cola.agregar(async () => "ok");
    await expect(trabada).rejects.toBeInstanceOf(TiempoAgotado);
    expect(senal?.aborted).toBe(true);
    expect(senal?.reason).toBeInstanceOf(TiempoAgotado);
    await expect(siguiente).resolves.toBe("ok");
  });

  it("una tarea puede quitarse el tiempo máximo (por ejemplo, después de registrar el pago)", async () => {
    const cola = new Cola();
    const r = cola.agregar(
      async ({ quitarLimite, signal }) => {
        quitarLimite();
        await dormir(40);
        return signal.aborted ? "cancelada" : "terminó";
      },
      { limiteMs: 20 },
    );
    await expect(r).resolves.toBe("terminó");
  });
});
