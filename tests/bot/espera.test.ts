import { describe, expect, it } from "vitest";
import {
  decidirEspera,
  ESPERA_BANXICO_MS,
  ESPERA_PAGO_RECIENTE_MS,
  esPagoReciente,
  MAX_ESPERA_BANXICO_MS,
  minutosDesdeElPago,
  type Espera,
} from "../../src/bot/espera.js";

/** 09-oct-2026 17:30 en CDMX. */
const AHORA = new Date("2026-10-09T23:30:00Z");
const hoy = (hora: string | null, fecha: string | null = "2026-10-09") => ({ fecha, hora });

describe("minutosDesdeElPago", () => {
  it("minutos desde la hora del comprobante de hoy", () => {
    expect(minutosDesdeElPago(hoy("17:22:10"), AHORA)).toBe(8);
    expect(minutosDesdeElPago(hoy("17:31"), AHORA)).toBe(-1);
  });

  it("celular una hora adelante o atrás: toma la diferencia más chica", () => {
    expect(minutosDesdeElPago(hoy("18:25"), AHORA)).toBe(5);
    expect(minutosDesdeElPago(hoy("16:20"), AHORA)).toBe(10);
  });

  it("sin hora, o de otro día, no se sabe", () => {
    expect(minutosDesdeElPago(hoy(null), AHORA)).toBeNull();
    expect(minutosDesdeElPago(hoy("17:25", "2026-10-08"), AHORA)).toBeNull();
    // BBVA de noche imprime la fecha de mañana: cuenta como de hoy.
    expect(minutosDesdeElPago(hoy("17:25", "2026-10-10"), AHORA)).toBe(5);
    // Sin fecha pero con hora: se toma como de hoy.
    expect(minutosDesdeElPago(hoy("17:25", null), AHORA)).toBe(5);
  });

  it("reciente: de hace hasta 15 minutos", () => {
    expect(esPagoReciente(hoy("17:20"), AHORA)).toBe(true);
    expect(esPagoReciente(hoy("17:10"), AHORA)).toBe(false);
    expect(esPagoReciente(hoy("12:00"), AHORA)).toBe(false);
  });
});

describe("decidirEspera", () => {
  const momento = AHORA.getTime();
  const noEncontrado = (hora: string | null) => ({ codigo: "NO_ENCONTRADO" as const, normalizados: { ...base, hora } });
  const base = {
    claveRastreo: "X",
    origenClave: "comprobante" as const,
    referencia: null,
    origenReferencia: null,
    monto: "400.00",
    fecha: "2026-10-09",
    fechaBanxico: "09-10-2026",
    hora: null,
    cuentaDestino: "1871",
  };

  it("pago reciente no encontrado: se revisa otra vez en 5 minutos, hasta 2 veces", () => {
    const primera = decidirEspera(noEncontrado("17:25"), undefined, AHORA);
    expect(primera).toEqual({ motivo: "RECIENTE", reintentos: 1, desde: momento, proxima: momento + ESPERA_PAGO_RECIENTE_MS });
    // En el reintento ya no es "reciente" por la hora, pero se completan los 2 reintentos.
    const segunda = decidirEspera(noEncontrado("17:25"), primera!, new Date(momento + 20 * 60_000));
    expect(segunda).toMatchObject({ motivo: "RECIENTE", reintentos: 2, desde: momento });
    expect(decidirEspera(noEncontrado("17:25"), segunda!, AHORA)).toBeNull();
  });

  it("un pago viejo no encontrado se responde ya", () => {
    expect(decidirEspera(noEncontrado("10:00"), undefined, AHORA)).toBeNull();
    expect(decidirEspera(noEncontrado(null), undefined, AHORA)).toBeNull();
  });

  it("validado u otro resultado: nunca espera", () => {
    expect(decidirEspera({ codigo: "VALIDADO", normalizados: { ...base, hora: "17:25" } }, undefined, AHORA)).toBeNull();
    expect(decidirEspera({ codigo: "CUENTA_INCORRECTA" }, undefined, AHORA)).toBeNull();
  });

  it("Banxico no responde: cada 3 minutos durante 1 hora como máximo", () => {
    const primera = decidirEspera({ codigo: "BANXICO_NO_DISPONIBLE" }, undefined, AHORA);
    expect(primera).toEqual({ motivo: "BANXICO", reintentos: 1, desde: momento, proxima: momento + ESPERA_BANXICO_MS });
    const despues = new Date(momento + 30 * 60_000);
    expect(decidirEspera({ codigo: "BANXICO_NO_DISPONIBLE" }, primera!, despues)).toMatchObject({ reintentos: 2, desde: momento });
    const vencida: Espera = { ...primera!, reintentos: 20 };
    expect(decidirEspera({ codigo: "BANXICO_NO_DISPONIBLE" }, vencida, new Date(momento + MAX_ESPERA_BANXICO_MS))).toBeNull();
  });
});
