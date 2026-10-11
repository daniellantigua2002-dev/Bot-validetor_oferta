import { describe, expect, it } from "vitest";
import { banxicoRespondio, EstadoBanxico } from "../../src/bot/estado-banxico.js";
import type { IntentoBanxico } from "../../src/types.js";

const intento = (resultado: IntentoBanxico["resultado"]) => ({ resultado }) as IntentoBanxico;

describe("banxicoRespondio", () => {
  it("Banxico no disponible → no respondió", () => {
    expect(banxicoRespondio({ codigo: "BANXICO_NO_DISPONIBLE", intentos: [intento("ERROR_RED")] })).toBe(false);
  });

  it("alguna consulta con respuesta real → respondió", () => {
    expect(banxicoRespondio({ codigo: "NO_ENCONTRADO", intentos: [intento("ERROR_RED"), intento("NO_ENCONTRADO")] })).toBe(true);
    expect(banxicoRespondio({ codigo: "VALIDADO", intentos: [intento("LIQUIDADO")] })).toBe(true);
  });

  it("sin consultas a Banxico (rechazo por reglas) → no se sabe", () => {
    expect(banxicoRespondio({ codigo: "CUENTA_INCORRECTA", intentos: [] })).toBeNull();
  });
});

describe("EstadoBanxico", () => {
  it("avisa una sola vez cuando se cae y una cuando vuelve", () => {
    const estado = new EstadoBanxico();
    expect(estado.registrar(true)).toBeNull();
    expect(estado.registrar(false)).toBe("CAYO");
    expect(estado.registrar(false)).toBeNull();
    expect(estado.registrar(null)).toBeNull();
    expect(estado.estaCaido).toBe(true);
    expect(estado.registrar(true)).toBe("VOLVIO");
    expect(estado.registrar(true)).toBeNull();
    expect(estado.estaCaido).toBe(false);
  });
});
