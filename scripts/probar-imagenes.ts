/**
 * Mide al bot contra los comprobantes reales de "Imagenes de prueba" (datos esperados en
 * tests/fixtures/imagenes-prueba.json).
 *
 * Uso:
 *   npm run probar-imagenes                 # solo OCR local (rápido, sin internet)
 *   npm run probar-imagenes -- --ia         # también la IA de NVIDIA
 *   npm run probar-imagenes -- --banxico    # validación completa contra Banxico (sin foto, lento)
 *   npm run probar-imagenes -- --filtro BBVA --texto   # solo los que contienen "BBVA"; imprime el texto del OCR
 *   npm run probar-imagenes -- --banxico --pausa 9000  # pausa entre consultas a Banxico (ms)
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { cerrarNavegador } from "../src/capture/screenshot.js";
import { REGLAS, type ClaveBanco } from "../src/config.js";
import { evaluarBancoEmisor, type EvaluacionBanco } from "../src/extraction/banco-emisor.js";
import { extraerDeTexto } from "../src/extraction/campos-texto.js";
import { extraerConModelos } from "../src/extraction/nvidia.js";
import { reconocerTexto, terminarOcr } from "../src/extraction/ocr-fallback.js";
import type { DatosExtraidos } from "../src/extraction/schema.js";
import { normalizarDatos, normalizarReferencia } from "../src/normalize/index.js";
import { validarComprobante } from "../src/pipeline.js";

interface Esperado {
  archivo: string;
  banco: ClaveBanco;
  monto: number | null;
  fecha: string | null;
  hora: string | null;
  clave: string | null;
  referencia: string | null;
  cuenta: string | null;
  esperado: string;
}

const CARPETA = "Imagenes de prueba";
const { values } = parseArgs({
  options: {
    ia: { type: "boolean", default: false },
    banxico: { type: "boolean", default: false },
    texto: { type: "boolean", default: false },
    filtro: { type: "string" },
    // Pausa entre consultas a Banxico (ms). Más larga que la del bot para no provocar el captcha en una corrida de 37.
    pausa: { type: "string", default: "9000" },
  },
});
REGLAS.pausaEntreConsultasMs = Number(values.pausa);

const todos = (JSON.parse(readFileSync("tests/fixtures/imagenes-prueba.json", "utf8")) as { comprobantes: Esperado[] }).comprobantes;
const casos = values.filtro ? todos.filter((c) => JSON.stringify(c).toLowerCase().includes(values.filtro!.toLowerCase())) : todos;

const sinCeros = (r: string | null) => r?.replace(/^0+/, "") ?? null;

/** Campos que no coinciden con lo esperado. */
function diferencias(e: Esperado, d: DatosExtraidos, banco: EvaluacionBanco): string[] {
  const n = normalizarDatos(d);
  const mal: string[] = [];
  const comparar = (campo: string, leido: unknown, esperado: unknown) => {
    if (leido !== esperado) mal.push(`${campo}: ${JSON.stringify(leido)} ≠ ${JSON.stringify(esperado)}`);
  };
  if (banco.banco !== e.banco) mal.push(`banco: ${banco.banco ?? "?"}${banco.suficiente ? "" : " (dudoso)"} ≠ ${e.banco}`);
  else if (!banco.suficiente) mal.push(`banco: ${banco.banco} sin certeza (${banco.motivo})`);
  comparar("monto", d.monto, e.monto);
  comparar("fecha", n.fecha, e.fecha);
  comparar("clave", n.claveRastreo, e.clave);
  comparar("ref", sinCeros(normalizarReferencia(d.referencia)), sinCeros(e.referencia));
  comparar("cuenta", n.cuentaDestino, e.cuenta);
  return mal;
}

const etiqueta = (e: Esperado) => `${e.archivo.split("/")[0]!.padEnd(6)} ${e.banco.padEnd(12)}`;

async function medirLectura(): Promise<void> {
  let ok = 0;
  for (const e of casos) {
    const imagen = readFileSync(`${CARPETA}/${e.archivo}`);
    const texto = await reconocerTexto(imagen);
    const datos = extraerDeTexto(texto);
    const mal = diferencias(e, datos, evaluarBancoEmisor(datos, texto, "ocr"));
    let linea = `${mal.length ? "✘" : "✔"} OCR ${etiqueta(e)} ${mal.join(" · ")}`;
    if (values.ia) {
      try {
        const { datos: ia } = await extraerConModelos(imagen);
        const malIa = diferencias(e, ia, evaluarBancoEmisor(ia, texto, "nvidia"));
        linea += `\n  ${malIa.length ? "✘" : "✔"} IA  ${malIa.join(" · ")}`;
      } catch (error) {
        linea += `\n  ✘ IA  error: ${(error as Error).message}`;
      }
    }
    if (!mal.length) ok++;
    console.log(linea);
    if (values.texto) console.log(texto.replace(/^/gm, "    │ "));
  }
  console.log(`\nOCR correcto en ${ok} de ${casos.length}.`);
}

async function medirValidacion(): Promise<void> {
  let ok = 0;
  for (const e of casos) {
    const r = await validarComprobante(readFileSync(`${CARPETA}/${e.archivo}`), { usuario: "prueba", capturar: false, registrar: false, busquedaCompleta: true });
    const bien = r.codigo === e.esperado;
    if (bien) ok++;
    const pago = r.pago ? ` · ${r.pago.claveRastreo} ${r.pago.fechaRecepcion}` : "";
    console.log(
      `${bien ? "✔" : "✘"} ${etiqueta(e)} ${r.codigo} (esperado ${e.esperado}) · ${r.intentos.length} consultas · ${((r.tiempos.total ?? 0) / 1000).toFixed(1)} s · ruta ${r.ruta ?? "-"}${pago}`,
    );
    if (!bien) console.log(`    ${r.mensaje}`);
  }
  console.log(`\nResultado correcto en ${ok} de ${casos.length}.`);
}

try {
  await (values.banxico ? medirValidacion() : medirLectura());
} finally {
  await terminarOcr();
  await cerrarNavegador();
}
process.exit(0);
