/**
 * Ritmo global de las peticiones a Banxico: consultas, catálogos, los estilos de la foto y el navegador.
 *
 * Banxico activa el captcha si recibe peticiones muy seguidas desde la misma IP (docs/banxico-cep.md §5):
 * - Turno: entre el inicio de una petición y el de la siguiente pasan al menos REGLAS.pausaEntreConsultasMs
 *   (BANXICO.pausaTrasCaptchaMs durante un rato después de un captcha). Vale también entre comprobantes
 *   distintos de la cola.
 * - Enfriamiento: cuando Banxico pide captcha no se insiste; nadie le pide nada durante 2 min (5 si lo vuelve
 *   a pedir en la media hora siguiente, luego 10). Quien no puede esperar tanto (una búsqueda con tiempo
 *   máximo) lo consulta con `enfriamiento()` y deja el comprobante para más tarde.
 * - Medición: cada captcha queda en la consola con cuántas peticiones hubo en los 10 min anteriores, para
 *   conocer el límite real de Banxico.
 */
import { BANXICO, REGLAS } from "../config.js";

const DIEZ_MIN_MS = 10 * 60_000;

export class Ritmo {
  private ultima = 0;
  private cola: Promise<void> = Promise.resolve();
  private enfriarHasta = 0;
  private ultimoCaptcha = 0;
  private nivel = 0;
  /** Inicio (epoch ms) de las peticiones de los últimos 10 min. */
  private recientes: number[] = [];
  private avisar: (mensaje: string) => void = (m) => console.log(m);

  constructor(
    private readonly reloj: () => number = Date.now,
    private readonly dormir: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  /** A dónde van los avisos de captcha (el bot los manda a su consola con la hora). */
  alAvisar(avisar: (mensaje: string) => void): void {
    this.avisar = avisar;
  }

  /** Pausa vigente entre peticiones: más larga durante un rato después de un captcha. */
  pausa(ahora = this.reloj()): number {
    const trasCaptcha = this.ultimoCaptcha > 0 && ahora - this.ultimoCaptcha < BANXICO.duracionPausaTrasCaptchaMs;
    return trasCaptcha ? BANXICO.pausaTrasCaptchaMs : REGLAS.pausaEntreConsultasMs;
  }

  /** Milisegundos que faltan para que termine el enfriamiento por captcha (0 si no hay). */
  enfriamiento(ahora = this.reloj()): number {
    return Math.max(0, this.enfriarHasta - ahora);
  }

  /** Peticiones que empezaron en los últimos 10 min. */
  peticionesRecientes(ahora = this.reloj()): number {
    this.recientes = this.recientes.filter((t) => ahora - t < DIEZ_MIN_MS);
    return this.recientes.length;
  }

  /** Espera el turno de la siguiente petición (y el fin del enfriamiento, si lo hay). */
  turno(): Promise<void> {
    const turno = this.cola.then(async () => {
      // Se vuelve a calcular después de dormir: mientras tanto pudo llegar un captcha.
      for (;;) {
        const ahora = this.reloj();
        const espera = Math.max(this.ultima + this.pausa(ahora) - ahora, this.enfriarHasta - ahora);
        if (espera <= 0) break;
        await this.dormir(espera);
      }
      this.ultima = this.reloj();
      this.peticionesRecientes(this.ultima);
      this.recientes.push(this.ultima);
    });
    this.cola = turno.catch(() => undefined);
    return turno;
  }

  /**
   * Banxico pidió captcha: empieza el enfriamiento (más largo si lo vuelve a pedir dentro de la media hora
   * siguiente) y se anota en la consola cuántas peticiones hubo antes.
   */
  registrarCaptcha(origen: string): void {
    const ahora = this.reloj();
    if (ahora < this.enfriarHasta) return; // ya se está enfriando (otra respuesta de la misma racha)
    const seguido = this.ultimoCaptcha > 0 && ahora - this.ultimoCaptcha < BANXICO.duracionPausaTrasCaptchaMs;
    const niveles = BANXICO.enfriamientoCaptchaMin;
    this.nivel = seguido ? Math.min(this.nivel + 1, niveles.length - 1) : 0;
    const minutos = niveles[this.nivel]!;
    const pausaAntes = this.pausa(ahora);
    this.enfriarHasta = ahora + minutos * 60_000;
    this.ultimoCaptcha = ahora;
    this.avisar(
      `Banxico pidió captcha (${origen}) tras ${this.peticionesRecientes(ahora)} peticiones en los últimos 10 min ` +
        `(pausa de ${pausaAntes / 1000} s). No se le consulta nada durante ${minutos} min; ` +
        `después, la pausa entre peticiones es de ${BANXICO.pausaTrasCaptchaMs / 1000} s por ${BANXICO.duracionPausaTrasCaptchaMs / 60_000} min.`,
    );
  }
}

/** El ritmo de todo el proceso. */
export const RITMO = new Ritmo();

/** Espera el turno global de Banxico. */
export function turnoBanxico(): Promise<void> {
  return RITMO.turno();
}

/** Ejecuta una petición a Banxico respetando el turno global. */
export async function conTurno<T>(peticion: () => Promise<T>): Promise<T> {
  await turnoBanxico();
  return peticion();
}
