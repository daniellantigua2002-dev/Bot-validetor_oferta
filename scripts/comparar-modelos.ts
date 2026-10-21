/**
 * Compara modelos de visión de NVIDIA con comprobantes sintéticos (Spin, Klar en modo oscuro, Azteca).
 * Útil si NVIDIA retira el modelo configurado. Ver modelos disponibles: GET /v1/models.
 *
 * Uso: npm run comparar-modelos -- google/gemma-4-31b-it nvidia/nemotron-3.5-super-vl-120b-a12b
 */
import { extraerConNvidia, crearClienteNvidia } from "../src/extraction/nvidia.js";
import { imagenConTexto } from "../tests/helpers/imagen-sintetica.js";
import { TEXTO_SPIN, TEXTO_KLAR, TEXTO_AZTECA } from "../tests/extraction/textos-ocr.js";

const MODELOS = process.argv.slice(2);
const casos = [
  { nombre: "spin", img: await imagenConTexto(TEXTO_SPIN.split("\n")), esperado: { banco: /spin/i, cuentaDestino: "072000000000000012", claveRastreo: "SPIN-20261008200443959PNEB9", referencia: "7454748", fecha: "2026-10-08", hora: "14:04:43", monto: 400 } },
  { nombre: "klar", img: await imagenConTexto(TEXTO_KLAR.split("\n"), { oscuro: true }), esperado: { cuentaDestino: "012180001234567890", claveRastreo: "27SsrAVomLDdm0HAqpDehA", referencia: "5214022", fecha: "2026-09-22", hora: "16:52", monto: 1352 } },
  { nombre: "azteca", img: await imagenConTexto(TEXTO_AZTECA.split("\n")), esperado: { banco: /azteca/i, cuentaDestino: "574", claveRastreo: "261008011287636711I", referencia: "4936574", fecha: "2026-10-08", hora: "17:09:36", monto: 890 } },
];
const cliente = crearClienteNvidia();
for (const modelo of MODELOS) {
  let aciertos = 0, total = 0; const fallos: string[] = []; let ms = 0;
  for (const c of casos) {
    const t0 = Date.now();
    try {
      const d = await extraerConNvidia(c.img, { cliente, modelo });
      ms += Date.now() - t0;
      for (const [k, v] of Object.entries(c.esperado)) {
        total++;
        const real = k === "banco" ? d.bancoEmisor.nombre : (d as Record<string, unknown>)[k];
        const ok = v instanceof RegExp ? v.test(String(real)) : real === v;
        if (ok) aciertos++; else fallos.push(`${c.nombre}.${k}=${JSON.stringify(real)}`);
      }
    } catch (e) {
      ms += Date.now() - t0;
      total += Object.keys(c.esperado).length;
      fallos.push(`${c.nombre}: ERROR ${(e as Error).message.slice(0, 160)}`);
    }
  }
  console.log(`\n### ${modelo}: ${aciertos}/${total} aciertos, ${Math.round(ms / casos.length)} ms/img`);
  for (const f of fallos) console.log("   - " + f);
}
