/**
 * ¿Banxico está respondiendo? Se deduce del resultado de cada validación para avisar en el grupo
 * una sola vez cuando deja de responder y otra cuando vuelve.
 */
import type { ResultadoValidacion } from "../pipeline.js";

/** Respuestas de Banxico que no cuentan como "respondió". */
const FALLAS = new Set(["ERROR_RED", "CAPTCHA", "OMITIDO"]);

/** true si Banxico respondió, false si no respondió y null si la validación no llegó a consultarlo. */
export function banxicoRespondio(r: Pick<ResultadoValidacion, "codigo" | "intentos">): boolean | null {
  if (r.codigo === "BANXICO_NO_DISPONIBLE") return false;
  if (r.intentos.some((i) => !FALLAS.has(i.resultado))) return true;
  return null;
}

export class EstadoBanxico {
  private caido = false;

  get estaCaido(): boolean {
    return this.caido;
  }

  /** Registra lo que pasó con Banxico y dice si hay que avisar algo en el grupo. */
  registrar(respondio: boolean | null): "CAYO" | "VOLVIO" | null {
    if (respondio === false && !this.caido) {
      this.caido = true;
      return "CAYO";
    }
    if (respondio === true && this.caido) {
      this.caido = false;
      return "VOLVIO";
    }
    return null;
  }
}
