/**
 * Mensaje de progreso animado mientras se valida un comprobante: lista de pasos, reloj que gira
 * en el paso actual, barra de avance, segundos transcurridos y el aviso nativo de Telegram
 * ("escribiendo…" / "enviando foto…").
 */
import { GrammyError, type Api } from "grammy";
import type { Progreso } from "../pipeline.js";
import { renderizarProgreso, type EstadoProgreso } from "./mensajes.js";

/** Cada cuánto se redibuja (Telegram limita las ediciones; ~1 por segundo por chat es seguro). */
const INTERVALO_MS = 1500;
/** En grupos Telegram permite ~20 mensajes por minuto y las ediciones cuentan: se redibuja más lento. */
export const INTERVALO_GRUPO_MS = 4000;
/** El aviso "escribiendo…" dura ~5 s: se renueva antes. */
const INTERVALO_ACCION_MS = 4500;

/** Rango de la barra en cada etapa: [inicio, tope, avance por cuadro]. */
const RANGOS: Record<Progreso["etapa"], [number, number, number]> = {
  LEYENDO: [10, 45, 3],
  REGLAS: [48, 52, 1],
  BANXICO: [55, 88, 2],
  CAPTURA: [90, 98, 2],
};

/** Calcula el porcentaje: empieza en el inicio de la etapa y avanza poco a poco sin pasar el tope ni retroceder. */
export function siguientePorcentaje(anterior: number, etapa: Progreso["etapa"], cuadrosEnEtapa: number): number {
  const [inicio, tope, paso] = RANGOS[etapa];
  return Math.max(anterior, Math.min(tope, inicio + cuadrosEnEtapa * paso));
}

export class IndicadorProgreso {
  private estado: EstadoProgreso = { etapa: "LEYENDO", cuadro: 0, porcentaje: 0, segundos: 0 };
  private cuadrosEnEtapa = 0;
  private inicio = Date.now();
  private ultimoTexto = "";
  private pausaHasta = 0;
  private detenido = false;
  private editando: Promise<void> | null = null;
  private temporizador?: NodeJS.Timeout;
  private temporizadorAccion?: NodeJS.Timeout;

  constructor(
    private readonly api: Api,
    private readonly chatId: number,
    private readonly mensajeId: number,
    private readonly intervaloMs = INTERVALO_MS,
  ) {}

  /** Empieza la animación. */
  iniciar(etapa: Progreso["etapa"] = "LEYENDO"): void {
    this.inicio = Date.now();
    this.actualizar({ etapa });
    this.temporizador = setInterval(() => {
      this.estado.cuadro++;
      this.cuadrosEnEtapa++;
      void this.dibujar();
    }, this.intervaloMs);
    this.accionDeChat();
    this.temporizadorAccion = setInterval(() => this.accionDeChat(), INTERVALO_ACCION_MS);
  }

  /** Cambio de etapa informado por el pipeline. */
  actualizar(p: Progreso): void {
    if (p.etapa !== this.estado.etapa) this.cuadrosEnEtapa = 0;
    this.estado.etapa = p.etapa;
    this.estado.consulta = p.consulta;
    void this.dibujar();
  }

  /** Detiene la animación antes de mostrar el resultado final. Después ya no edita nada más. */
  async detener(): Promise<void> {
    this.detenido = true;
    clearInterval(this.temporizador);
    clearInterval(this.temporizadorAccion);
    await this.editando;
  }

  private accionDeChat(): void {
    const accion = this.estado.etapa === "CAPTURA" ? "upload_photo" : "typing";
    void this.api.sendChatAction(this.chatId, accion).catch(() => undefined);
  }

  private async dibujar(): Promise<void> {
    if (this.detenido || this.editando || Date.now() < this.pausaHasta) return;
    this.estado.porcentaje = siguientePorcentaje(this.estado.porcentaje, this.estado.etapa, this.cuadrosEnEtapa);
    this.estado.segundos = Math.round((Date.now() - this.inicio) / 1000);
    const texto = renderizarProgreso(this.estado);
    if (texto === this.ultimoTexto) return;

    this.editando = this.api
      .editMessageText(this.chatId, this.mensajeId, texto, { parse_mode: "HTML" })
      .then(() => {
        this.ultimoTexto = texto;
      })
      .catch((e) => {
        // Telegram pide bajar el ritmo: se espera lo que indique.
        if (e instanceof GrammyError && e.error_code === 429) {
          this.pausaHasta = Date.now() + (e.parameters.retry_after ?? 5) * 1000;
        }
      })
      .finally(() => {
        this.editando = null;
      });
    await this.editando;
  }
}
