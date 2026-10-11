/**
 * Catálogo de instituciones de Banxico por fecha, con caché en memoria y, para los días pasados, en disco.
 * El catálogo cambia con la fecha (incluso los códigos), así que siempre se usa el de la fecha consultada.
 * El de un día que ya pasó no cambia: se guarda en disco y no se vuelve a pedir aunque el bot se reinicie.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { formatInTimeZone } from "date-fns-tz";
import { BANXICO, ZONA_HORARIA } from "../config.js";
import { escribirJsonAtomico } from "../storage/archivo.js";
import {
  institucionDeBanco,
  institucionPorNombre,
  type CatalogoInstituciones,
  type Institucion,
} from "../normalize/index.js";
import type { BancoEmisor, ClaveBanco } from "../types.js";
import { peticion, type OpcionesHttp } from "./cliente.js";

export interface CatalogoBanxico {
  /** dd-MM-yyyy */
  fecha: string;
  instituciones: CatalogoInstituciones;
  /** false = Banxico reactivó el captcha. */
  overrideCaptcha: boolean;
}

/** Dónde guardar los catálogos de días pasados. */
export interface DiscoCatalogos {
  carpeta: string;
  /** Hoy en CDMX (yyyy-MM-dd): el de hoy y los de fechas futuras no se guardan. */
  hoy?: () => string;
}

/** dd-MM-yyyy → yyyy-MM-dd */
const isoDesdeBanxico = (fecha: string) => fecha.split("-").reverse().join("-");

export class Catalogos {
  private readonly cache = new Map<string, Promise<CatalogoBanxico>>();

  constructor(
    private readonly opciones: OpcionesHttp = {},
    private readonly disco: DiscoCatalogos | null = null,
  ) {}

  /**
   * Catálogo de la fecha (dd-MM-yyyy): de la memoria, del disco (días pasados) o de Banxico. Si falla, o si
   * llegó con el captcha activado, no se guarda: la próxima vez se vuelve a pedir.
   */
  obtener(fecha: string): Promise<CatalogoBanxico> {
    let promesa = this.cache.get(fecha);
    if (!promesa) {
      const nueva = this.delDisco(fecha).then((guardado) => guardado ?? this.descargarYGuardar(fecha));
      this.cache.set(fecha, nueva);
      const olvidar = () => {
        if (this.cache.get(fecha) === nueva) this.cache.delete(fecha);
      };
      nueva.then((c) => c.overrideCaptcha || olvidar(), olvidar);
      promesa = nueva;
    }
    return promesa;
  }

  /**
   * Catálogo pedido a Banxico en ese momento, sin cachés: para revisar si Banxico responde (y si activó el
   * captcha en el sitio, que solo se sabe así).
   */
  async vivo(fecha: string): Promise<CatalogoBanxico> {
    const catalogo = await this.descargar(fecha);
    if (catalogo.instituciones.length) this.cache.set(fecha, Promise.resolve(catalogo));
    return catalogo;
  }

  private archivo(fecha: string): string | null {
    if (!this.disco) return null;
    const iso = isoDesdeBanxico(fecha);
    const hoy = this.disco.hoy?.() ?? formatInTimeZone(new Date(), ZONA_HORARIA, "yyyy-MM-dd");
    return iso < hoy ? join(this.disco.carpeta, `${iso}.json`) : null;
  }

  private async delDisco(fecha: string): Promise<CatalogoBanxico | null> {
    const ruta = this.archivo(fecha);
    if (!ruta) return null;
    try {
      const { instituciones } = JSON.parse(await readFile(ruta, "utf8")) as { instituciones?: [string, string][] };
      return instituciones?.length ? { fecha, instituciones, overrideCaptcha: true } : null;
    } catch {
      return null; // no está guardado (o el archivo está dañado): se pide a Banxico
    }
  }

  private async descargarYGuardar(fecha: string): Promise<CatalogoBanxico> {
    const catalogo = await this.descargar(fecha);
    const ruta = this.archivo(fecha);
    if (ruta && catalogo.instituciones.length) {
      await escribirJsonAtomico(ruta, { fecha, instituciones: catalogo.instituciones }).catch(() => undefined);
    }
    return catalogo;
  }

  private async descargar(fecha: string): Promise<CatalogoBanxico> {
    const url = new URL("instituciones.do", BANXICO.urlBase);
    url.searchParams.set("fecha", fecha);
    const r = await peticion(url.href, { method: "GET", headers: { "X-Requested-With": "XMLHttpRequest" } }, this.opciones);
    if (!r.ok) throw new Error(`instituciones.do respondió HTTP ${r.status} para ${fecha}`);
    const json = (await r.json()) as { instituciones?: [string, string][]; overrideCaptcha?: boolean };
    // Para fechas futuras Banxico responde solo {"overrideCaptcha": true}.
    return { fecha, instituciones: json.instituciones ?? [], overrideCaptcha: json.overrideCaptcha !== false };
  }
}

/** Código y nombre del banco emisor en el catálogo (por el mapa BANCOS o por nombre libre). */
export function institucionEmisora(banco: BancoEmisor, catalogo: CatalogoBanxico): Institucion | null {
  if (banco.clave) return institucionDeBanco(banco.clave, catalogo.instituciones);
  return banco.nombreLibre ? institucionPorNombre(banco.nombreLibre, catalogo.instituciones) : null;
}

export function institucionReceptora(banco: ClaveBanco, catalogo: CatalogoBanxico): Institucion | null {
  return institucionDeBanco(banco, catalogo.instituciones);
}
