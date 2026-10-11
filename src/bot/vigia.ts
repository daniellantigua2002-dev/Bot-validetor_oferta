/**
 * Vigía de Banxico: mientras haya comprobantes esperando a que Banxico vuelva, lo revisa con UNA petición
 * liviana cada 3 minutos (revisarBanxico), en lugar de que cada comprobante lo consulte por su cuenta. Si
 * Banxico responde, los comprobantes salen a la cola, que los atiende de uno en uno.
 */
import type { SaludBanxico } from "../banxico/reintentos.js";
import { ESPERA_BANXICO_MS } from "./espera.js";

export class VigiaBanxico {
  private reloj: ReturnType<typeof setTimeout> | null = null;
  private siguiente: number | null = null;
  private revisando = false;
  /** Llegó otro comprobante mientras se revisaba: hay que volver a programar. */
  private pendiente = false;

  constructor(
    /** La revisión: una petición a Banxico. */
    private readonly revisar: () => Promise<SaludBanxico>,
    /** Qué hacer con el resultado. Devuelve true si quedan comprobantes esperando (se sigue vigilando). */
    private readonly alRevisar: (salud: SaludBanxico) => Promise<boolean>,
    private readonly intervaloMs = ESPERA_BANXICO_MS,
    private readonly ahora: () => number = Date.now,
  ) {}

  /** Cuándo será la próxima revisión (null si no hay ninguna programada). */
  get proxima(): number | null {
    return this.siguiente;
  }

  /**
   * Programa una revisión para `cuando` (como pronto, ya), salvo que ya haya una programada: entonces
   * vale esa. Devuelve cuándo será.
   */
  programar(cuando = this.ahora() + this.intervaloMs): number {
    if (this.siguiente !== null) return this.siguiente;
    if (this.revisando) {
      this.pendiente = true;
      return this.ahora() + this.intervaloMs;
    }
    const momento = Math.max(cuando, this.ahora());
    this.siguiente = momento;
    this.reloj = setTimeout(() => void this.ejecutar(), momento - this.ahora());
    return momento;
  }

  detener(): void {
    if (this.reloj) clearTimeout(this.reloj);
    this.reloj = null;
    this.siguiente = null;
  }

  private async ejecutar(): Promise<void> {
    this.reloj = null;
    this.siguiente = null;
    this.revisando = true;
    this.pendiente = false;
    let seguir = true;
    try {
      const salud = await this.revisar().catch((e: unknown): SaludBanxico => ({ ok: false, motivo: (e as Error).message }));
      seguir = await this.alRevisar(salud);
    } catch {
      seguir = true; // un error al avisar no debe dejar a nadie esperando para siempre
    } finally {
      this.revisando = false;
    }
    if (seguir || this.pendiente) this.programar();
  }
}
