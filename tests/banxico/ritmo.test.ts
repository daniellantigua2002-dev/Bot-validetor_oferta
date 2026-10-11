import { describe, expect, it } from "vitest";
import { Ritmo } from "../../src/banxico/ritmo.js";
import { BANXICO, REGLAS } from "../../src/config.js";

const MIN = 60_000;

/** Ritmo con un reloj simulado: dormir adelanta el reloj y anota cuánto se durmió. */
function ritmoFalso() {
  let ahora = 1_800_000_000_000;
  const dormidos: number[] = [];
  const avisos: string[] = [];
  const ritmo = new Ritmo(
    () => ahora,
    async (ms) => {
      dormidos.push(ms);
      ahora += ms;
    },
  );
  ritmo.alAvisar((m) => avisos.push(m));
  const avanzar = (ms: number) => {
    ahora += ms;
  };
  return { ritmo, dormidos, avisos, avanzar };
}

describe("Ritmo: turno global de Banxico", () => {
  it("la primera petición va de inmediato; la siguiente espera la pausa entre consultas", async () => {
    const { ritmo, dormidos } = ritmoFalso();
    await ritmo.turno();
    await ritmo.turno();
    expect(dormidos).toEqual([REGLAS.pausaEntreConsultasMs]);
  });

  it("si ya pasó la pausa desde la última petición, no espera", async () => {
    const { ritmo, dormidos, avanzar } = ritmoFalso();
    await ritmo.turno();
    avanzar(REGLAS.pausaEntreConsultasMs);
    await ritmo.turno();
    expect(dormidos).toEqual([]);
  });

  it("varias peticiones a la vez se atienden en fila, cada una con su pausa", async () => {
    const { ritmo, dormidos } = ritmoFalso();
    await Promise.all([ritmo.turno(), ritmo.turno(), ritmo.turno()]);
    expect(dormidos).toEqual([REGLAS.pausaEntreConsultasMs, REGLAS.pausaEntreConsultasMs]);
  });
});

describe("Ritmo: enfriamiento por captcha", () => {
  it("tras un captcha nadie consulta durante 2 min y después la pausa sube a 10 s por 30 min", async () => {
    const { ritmo, dormidos, avanzar } = ritmoFalso();
    await ritmo.turno();
    ritmo.registrarCaptcha("consulta");
    expect(ritmo.enfriamiento()).toBe(2 * MIN);
    await ritmo.turno();
    expect(dormidos).toEqual([2 * MIN]);
    expect(ritmo.enfriamiento()).toBe(0);
    expect(ritmo.pausa()).toBe(BANXICO.pausaTrasCaptchaMs);
    avanzar(BANXICO.duracionPausaTrasCaptchaMs);
    expect(ritmo.pausa()).toBe(REGLAS.pausaEntreConsultasMs);
  });

  it("si vuelve a pedir captcha dentro de la media hora, el enfriamiento crece: 2, 5 y 10 min (y no pasa de 10)", () => {
    const { ritmo, avanzar } = ritmoFalso();
    const minutos: number[] = [];
    for (let i = 0; i < 4; i++) {
      ritmo.registrarCaptcha("consulta");
      minutos.push(ritmo.enfriamiento() / MIN);
      avanzar(ritmo.enfriamiento() + MIN);
    }
    expect(minutos).toEqual([...BANXICO.enfriamientoCaptchaMin, 10]);
    expect(BANXICO.enfriamientoCaptchaMin).toEqual([2, 5, 10]);
  });

  it("un captcha más de media hora después del anterior vuelve a empezar en 2 min", () => {
    const { ritmo, avanzar } = ritmoFalso();
    ritmo.registrarCaptcha("consulta");
    avanzar(BANXICO.duracionPausaTrasCaptchaMs + MIN);
    ritmo.registrarCaptcha("consulta");
    expect(ritmo.enfriamiento()).toBe(2 * MIN);
  });

  it("los captchas de la misma racha (durante el enfriamiento) no lo alargan", () => {
    const { ritmo, avisos, avanzar } = ritmoFalso();
    ritmo.registrarCaptcha("consulta");
    avanzar(MIN);
    ritmo.registrarCaptcha("foto en el sitio");
    expect(ritmo.enfriamiento()).toBe(1 * MIN);
    expect(avisos).toHaveLength(1);
  });

  it("el aviso dice cuántas peticiones hubo en los últimos 10 min (para conocer el límite real)", async () => {
    const { ritmo, avisos, avanzar } = ritmoFalso();
    await ritmo.turno();
    await ritmo.turno();
    await ritmo.turno();
    avanzar(11 * MIN); // estas tres ya no cuentan
    await ritmo.turno();
    await ritmo.turno();
    ritmo.registrarCaptcha("consulta");
    expect(avisos[0]).toMatch(/^Banxico pidió captcha \(consulta\) tras 2 peticiones en los últimos 10 min \(pausa de 6 s\)\. No se le consulta nada durante 2 min/);
  });
});
