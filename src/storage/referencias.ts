/**
 * Referencias que la app de un banco pone sola y que cambian con el tiempo (BBVA: cambia según la
 * semana; del 05 al 09-oct-2026 fue 2309260). Se aprenden de los pagos validados en Banxico, que
 * devuelve la referencia real, y solo se usan cerca de la fecha en que se vieron.
 *
 * Se guardan en data/referencias-aprendidas.json (unas pocas líneas por banco) para no perderlas
 * si el bot se reinicia.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ClaveBanco } from "../config.js";
import { escribirJsonAtomico } from "./archivo.js";

export interface ReferenciaVista {
  banco: ClaveBanco;
  referencia: string;
  /** yyyy-MM-dd del pago más reciente con esta referencia. */
  fecha: string;
  /** Pagos validados con esta referencia. */
  veces: number;
}

/** Una referencia aprendida sirve para pagos de hasta estos días antes o después. */
export const VIGENCIA_REFERENCIA_DIAS = 7;
/** Las referencias que no se ven en este tiempo se olvidan. */
const OLVIDAR_DESPUES_DE_DIAS = 30;

const diasEntre = (a: string, b: string) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;

export class ReferenciasAprendidas {
  private vistas: ReferenciaVista[] = [];
  private carga: Promise<void> | null = null;
  private escritura: Promise<void> = Promise.resolve();

  constructor(private readonly ruta = resolve("data/referencias-aprendidas.json")) {}

  /** Lee el archivo una sola vez (si no existe o está dañado, empieza vacío). */
  cargar(): Promise<void> {
    this.carga ??= readFile(this.ruta, "utf8")
      .then((texto) => {
        const datos = JSON.parse(texto) as unknown;
        this.vistas = Array.isArray(datos) ? (datos as ReferenciaVista[]) : [];
      })
      .catch(() => {
        this.vistas = [];
      });
    return this.carga;
  }

  /**
   * La referencia del banco para un pago de esa fecha: entre las vistas a ±VIGENCIA_REFERENCIA_DIAS,
   * la de más pagos (si empatan, la más cercana en fecha). Llamar después de cargar().
   */
  para(banco: ClaveBanco, fechaIso: string): string | null {
    const cercanas = this.vistas
      .filter((v) => v.banco === banco && diasEntre(v.fecha, fechaIso) <= VIGENCIA_REFERENCIA_DIAS)
      .sort((a, b) => b.veces - a.veces || diasEntre(a.fecha, fechaIso) - diasEntre(b.fecha, fechaIso));
    return cercanas[0]?.referencia ?? null;
  }

  /** Anota la referencia de un pago validado y olvida las que llevan mucho sin verse. */
  async aprender(banco: ClaveBanco, referencia: string, fechaIso: string): Promise<void> {
    await this.cargar();
    const previa = this.vistas.find((v) => v.banco === banco && v.referencia === referencia);
    if (previa) {
      previa.veces++;
      if (fechaIso > previa.fecha) previa.fecha = fechaIso;
    } else {
      this.vistas.push({ banco, referencia, fecha: fechaIso, veces: 1 });
    }
    const masReciente = this.vistas.reduce((max, v) => (v.fecha > max ? v.fecha : max), fechaIso);
    this.vistas = this.vistas.filter((v) => diasEntre(v.fecha, masReciente) <= OLVIDAR_DESPUES_DE_DIAS);
    const contenido = [...this.vistas];
    this.escritura = this.escritura.then(() => escribirJsonAtomico(this.ruta, contenido)).catch(() => undefined);
    await this.escritura;
  }
}
