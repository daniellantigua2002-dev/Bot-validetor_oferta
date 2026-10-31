/**
 * Compara lo que lee el OCR antes y después de un cambio, con todas las imágenes que haya en la carpeta
 * (no hace falta que estén en tests/fixtures/imagenes-prueba.json).
 *
 * Uso:
 *   npm run comparar-ocr -- --salida antes                  # lee todo y guarda scripts/salidas/antes.json
 *   npm run comparar-ocr -- --salida despues
 *   npm run comparar-ocr -- --comparar antes despues        # tabla ✓/✗ por campo
 *   npm run comparar-ocr -- --memoria 30                    # RSS de Node al leer 30 comprobantes seguidos
 *   npm run comparar-ocr -- --carpeta otra --salida antes   # otra carpeta (por defecto "Imagenes de prueba")
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { extraerDeTexto } from "../src/extraction/campos-texto.js";
import { reconocerTexto, terminarOcr } from "../src/extraction/ocr-fallback.js";
import { normalizarDatos } from "../src/normalize/index.js";

const SALIDAS = "scripts/salidas";
const CAMPOS = ["banco", "cuenta", "clave", "referencia", "fecha", "monto"] as const;

type Lectura = Record<(typeof CAMPOS)[number], string | number | null> & { archivo: string; texto: string };

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    carpeta: { type: "string", default: "Imagenes de prueba" },
    salida: { type: "string" },
    comparar: { type: "boolean", default: false },
    memoria: { type: "string" },
  },
});

const imagenes = () =>
  readdirSync(values.carpeta)
    .filter((a) => /\.(jpe?g|png|webp)$/i.test(a))
    .sort();

async function leer(archivo: string): Promise<Lectura> {
  const texto = await reconocerTexto(readFileSync(join(values.carpeta, archivo)));
  const datos = extraerDeTexto(texto);
  const n = normalizarDatos(datos);
  return {
    archivo,
    banco: datos.bancoEmisor.nombre,
    cuenta: n.cuentaDestino,
    clave: n.claveRastreo,
    referencia: n.referencia,
    fecha: n.fecha,
    monto: n.monto,
    texto,
  };
}

async function guardar(nombre: string): Promise<void> {
  const lecturas: Lectura[] = [];
  for (const archivo of imagenes()) {
    const inicio = Date.now();
    lecturas.push(await leer(archivo));
    console.log(`${archivo}  ${Date.now() - inicio} ms`);
  }
  mkdirSync(SALIDAS, { recursive: true });
  writeFileSync(join(SALIDAS, `${nombre}.json`), JSON.stringify(lecturas, null, 2));
  console.log(`\n${lecturas.length} imágenes → ${SALIDAS}/${nombre}.json`);
}

function comparar(a: string, b: string): void {
  const cargar = (n: string) => JSON.parse(readFileSync(join(SALIDAS, `${n}.json`), "utf8")) as Lectura[];
  const despues = new Map(cargar(b).map((l) => [l.archivo, l]));
  let iguales = 0;
  const antes = cargar(a);
  console.log(`${"imagen".padEnd(34)} ${CAMPOS.map((c) => c.padEnd(10)).join(" ")} texto`);
  for (const x of antes) {
    const y = despues.get(x.archivo);
    if (!y) {
      console.log(`${x.archivo.padEnd(34)} falta en ${b}.json`);
      continue;
    }
    const distintos = CAMPOS.filter((c) => x[c] !== y[c]);
    if (!distintos.length) iguales++;
    const marcas = CAMPOS.map((c) => (distintos.includes(c) ? "✗" : "✓").padEnd(10)).join(" ");
    console.log(`${x.archivo.padEnd(34)} ${marcas} ${x.texto === y.texto ? "=" : "≠"}`);
    for (const c of distintos) console.log(`    ${c}: ${JSON.stringify(x[c])} → ${JSON.stringify(y[c])}`);
  }
  console.log(`\nMismos datos en ${iguales} de ${antes.length} imágenes.`);
}

async function medirMemoria(lecturas: number): Promise<void> {
  const archivos = imagenes();
  const mb = () => `${(process.memoryUsage().rss / 2 ** 20).toFixed(0)} MB`;
  console.log(`RSS al inicio: ${mb()}`);
  for (let i = 0; i < lecturas; i++) {
    await leer(archivos[i % archivos.length]!);
    if (i === 0 || (i + 1) % 10 === 0 || i === lecturas - 1) console.log(`RSS tras ${i + 1} lecturas: ${mb()}`);
  }
}

try {
  if (values.comparar) comparar(positionals[0] ?? "antes", positionals[1] ?? "despues");
  else if (values.memoria) await medirMemoria(Number(values.memoria));
  else if (values.salida) await guardar(values.salida);
  else console.error("Uso: --salida <nombre> | --comparar [a] [b] | --memoria <n>");
} finally {
  await terminarOcr();
}
