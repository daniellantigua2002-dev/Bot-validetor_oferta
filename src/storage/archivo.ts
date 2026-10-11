/**
 * Escritura atómica de archivos JSON: se escribe un archivo temporal y luego se renombra, así un
 * corte de luz o un cierre a la mitad nunca deja el archivo a medias.
 */
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

export async function escribirJsonAtomico(ruta: string, contenido: unknown): Promise<void> {
  await mkdir(dirname(ruta), { recursive: true });
  const temporal = `${ruta}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temporal, JSON.stringify(contenido, null, 2) + "\n", "utf8");
  try {
    await renombrarConReintentos(temporal, ruta);
  } catch (e) {
    await rm(temporal, { force: true });
    throw e;
  }
}

/** En Windows el renombrado puede fallar un instante si otro proceso (antivirus, editor) tiene el archivo abierto. */
async function renombrarConReintentos(origen: string, destino: string, intentos = 5): Promise<void> {
  for (let i = 1; ; i++) {
    try {
      return await rename(origen, destino);
    } catch (e) {
      const codigo = (e as NodeJS.ErrnoException).code;
      if (i >= intentos || (codigo !== "EPERM" && codigo !== "EBUSY" && codigo !== "EACCES")) throw e;
      await new Promise((r) => setTimeout(r, 50 * i));
    }
  }
}
