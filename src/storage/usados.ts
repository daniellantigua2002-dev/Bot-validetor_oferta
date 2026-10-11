/**
 * Registro de comprobantes ya validados en data/usados.json.
 * La escritura es atómica: se escribe un archivo temporal y luego se renombra.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { escribirJsonAtomico } from "./archivo.js";

export interface RegistroUsado {
  claveRastreo: string | null;
  referencia: string | null;
  /** "1032.00" */
  monto: string;
  /** Fecha del pago, ISO yyyy-MM-dd. */
  fecha: string;
  /** Cuenta destino completa con la que Banxico encontró el pago. */
  cuenta: string | null;
  emisor: string | null;
  /** Usuario que lo validó (id de Telegram o "cli"). */
  usuario: string;
  /** Momento de la validación, ISO con zona. */
  validadoEn: string;
}

interface ArchivoUsados {
  registros: RegistroUsado[];
}

export const RUTA_USADOS = resolve("data/usados.json");

export class AlmacenUsados {
  /** Cola para que dos escrituras no se pisen dentro del mismo proceso. */
  private cola: Promise<unknown> = Promise.resolve();

  constructor(readonly ruta: string = RUTA_USADOS) {}

  async leer(): Promise<RegistroUsado[]> {
    try {
      const contenido = JSON.parse(await readFile(this.ruta, "utf8")) as ArchivoUsados;
      return Array.isArray(contenido.registros) ? contenido.registros : [];
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new Error(`No se pudo leer ${this.ruta}: ${(e as Error).message}`);
    }
  }

  /** Agrega un registro (se encola detrás de cualquier escritura en curso). */
  registrar(registro: RegistroUsado): Promise<void> {
    const tarea = this.cola.then(async () => {
      const registros = await this.leer();
      registros.push(registro);
      await escribirJsonAtomico(this.ruta, { registros } satisfies ArchivoUsados);
    });
    this.cola = tarea.catch(() => undefined);
    return tarea;
  }
}

/**
 * Revisión rápida, antes de consultar Banxico: ¿la clave de rastreo del comprobante ya se validó?
 * La clave es única por pago. Sin clave no se decide aquí: la referencia se repite entre pagos
 * distintos (en Banco Azteca son los últimos 7 dígitos de la cuenta destino), así que se resuelve
 * después con la clave real que devuelve Banxico (ver banxico/reintentos.ts).
 */
export function buscarDuplicado(
  registros: readonly RegistroUsado[],
  datos: { claveRastreo: string | null },
): RegistroUsado | null {
  if (!datos.claveRastreo) return null;
  return registros.find((r) => r.claveRastreo === datos.claveRastreo) ?? null;
}
