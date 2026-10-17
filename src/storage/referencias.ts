/**
 * Referencias que la app de un banco pone sola y que cambian con el tiempo (BBVA: cambia según la
 * semana; del 05 al 09-oct-2026 fue 2309260). Se aprenden de los pagos validados en Banxico, que
 * devuelve la referencia real, y solo se usan cerca de la fecha en que se vieron.
 *
 * De cada referencia se guarda cuántos pagos se validaron con ella CADA DÍA (no un solo contador
 * acumulado): así se elige la que más se repitió en los últimos 7 días —la de la semana en curso— y no
 * la más repetida de todo el historial, que durante el cambio de semana todavía sería la de la semana
 * pasada. El ranking también da la 2ª más repetida, para una consulta extra (ver reintentos.ts).
 *
 * Se guardan en data/referencias-aprendidas.json (unas pocas líneas por banco) para no perderlas
 * si el bot se reinicia. Se acepta el formato viejo ({ fecha, veces }) para no perder lo ya aprendido.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ClaveBanco } from "../config.js";
import { escribirJsonAtomico } from "./archivo.js";

export interface ReferenciaVista {
  banco: ClaveBanco;
  referencia: string;
  /** Pagos validados con esta referencia, por día (yyyy-MM-dd → veces). */
  dias: Record<string, number>;
}

/** Una referencia aprendida sirve para pagos de hasta estos días antes o después. */
export const VIGENCIA_REFERENCIA_DIAS = 7;
/** Las referencias que no se ven en este tiempo se olvidan. */
const OLVIDAR_DESPUES_DE_DIAS = 30;

const diasEntre = (a: string, b: string) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;

/** Acepta el formato nuevo (dias) y el viejo ({ fecha, veces }); descarta lo que no se entiende. */
function normalizarVista(x: unknown): ReferenciaVista | null {
  if (!x || typeof x !== "object") return null;
  const v = x as Record<string, unknown>;
  if (typeof v.banco !== "string" || typeof v.referencia !== "string") return null;
  const base = { banco: v.banco as ClaveBanco, referencia: v.referencia };
  if (v.dias && typeof v.dias === "object") {
    const dias: Record<string, number> = {};
    for (const [dia, n] of Object.entries(v.dias as Record<string, unknown>)) {
      if (typeof n === "number" && n > 0) dias[dia] = n;
    }
    return Object.keys(dias).length ? { ...base, dias } : null;
  }
  if (typeof v.fecha === "string" && typeof v.veces === "number" && v.veces > 0) {
    return { ...base, dias: { [v.fecha]: v.veces } };
  }
  return null;
}

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
        this.vistas = Array.isArray(datos) ? datos.map(normalizarVista).filter((v): v is ReferenciaVista => v !== null) : [];
      })
      .catch(() => {
        this.vistas = [];
      });
    return this.carga;
  }

  /**
   * Referencias del banco ordenadas por cuántos pagos se validaron con ellas en los ±VIGENCIA_REFERENCIA_DIAS
   * días de la fecha dada (la más repetida primero; si empatan, la de día más reciente). Llamar tras cargar().
   */
  rankeadas(banco: ClaveBanco, fechaIso: string): string[] {
    return this.vistas
      .flatMap((v) => {
        if (v.banco !== banco) return [];
        let veces = 0;
        let reciente = "";
        for (const [dia, n] of Object.entries(v.dias)) {
          if (diasEntre(dia, fechaIso) <= VIGENCIA_REFERENCIA_DIAS) {
            veces += n;
            if (dia > reciente) reciente = dia;
          }
        }
        return veces > 0 ? [{ referencia: v.referencia, veces, reciente }] : [];
      })
      .sort((a, b) => b.veces - a.veces || (a.reciente < b.reciente ? 1 : a.reciente > b.reciente ? -1 : 0))
      .map((c) => c.referencia);
  }

  /**
   * La referencia del banco para un pago de esa fecha, por orden de repetición en la última semana
   * (rango 0 = la que más se repite, 1 = la segunda…). null si no hay. Llamar después de cargar().
   */
  para(banco: ClaveBanco, fechaIso: string, rango = 0): string | null {
    return this.rankeadas(banco, fechaIso)[rango] ?? null;
  }

  /** Anota la referencia de un pago validado y olvida las que llevan mucho sin verse. */
  async aprender(banco: ClaveBanco, referencia: string, fechaIso: string): Promise<void> {
    await this.cargar();
    const previa = this.vistas.find((v) => v.banco === banco && v.referencia === referencia);
    if (previa) previa.dias[fechaIso] = (previa.dias[fechaIso] ?? 0) + 1;
    else this.vistas.push({ banco, referencia, dias: { [fechaIso]: 1 } });

    const masReciente = this.vistas.flatMap((v) => Object.keys(v.dias)).reduce((max, d) => (d > max ? d : max), fechaIso);
    for (const v of this.vistas) {
      for (const dia of Object.keys(v.dias)) {
        if (diasEntre(dia, masReciente) > OLVIDAR_DESPUES_DE_DIAS) delete v.dias[dia];
      }
    }
    this.vistas = this.vistas.filter((v) => Object.keys(v.dias).length > 0);

    const contenido = this.vistas.map((v) => ({ ...v, dias: { ...v.dias } }));
    this.escritura = this.escritura.then(() => escribirJsonAtomico(this.ruta, contenido)).catch(() => undefined);
    await this.escritura;
  }
}
