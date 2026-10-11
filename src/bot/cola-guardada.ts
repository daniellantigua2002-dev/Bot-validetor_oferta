/**
 * Comprobantes en la cola guardados en data/cola.json. Si el bot se reinicia (se cae, se cierra la
 * ventana o se apaga la PC), al arrancar los retoma y nadie se queda sin respuesta.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { escribirJsonAtomico } from "../storage/archivo.js";

export const RUTA_COLA = resolve("data/cola.json");

export class ColaGuardada<T extends { id: string }> {
  private trabajos = new Map<string, T>();
  /** Las escrituras van una detrás de otra para que no se pisen. */
  private escritura: Promise<void> = Promise.resolve();

  constructor(readonly ruta: string = RUTA_COLA) {}

  /**
   * Lee los trabajos que quedaron pendientes, en orden de llegada. Hay que llamarlo antes de
   * guardar trabajos nuevos, para no sobrescribir el archivo sin ellos.
   */
  async cargar(): Promise<T[]> {
    let lista: T[] = [];
    try {
      const contenido: unknown = JSON.parse(await readFile(this.ruta, "utf8"));
      if (Array.isArray(contenido)) lista = contenido as T[];
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`No se pudo leer ${this.ruta}: ${(e as Error).message}`);
    }
    for (const t of lista) this.trabajos.set(t.id, t);
    return lista;
  }

  /** Agrega o actualiza un trabajo. */
  guardar(trabajo: T): Promise<void> {
    this.trabajos.set(trabajo.id, trabajo);
    return this.escribir();
  }

  /** Quita un trabajo ya respondido. */
  quitar(id: string): Promise<void> {
    if (!this.trabajos.delete(id)) return this.escritura;
    return this.escribir();
  }

  private escribir(): Promise<void> {
    const contenido = [...this.trabajos.values()];
    const tarea = this.escritura.then(() => escribirJsonAtomico(this.ruta, contenido));
    this.escritura = tarea.catch(() => undefined);
    return tarea;
  }
}
