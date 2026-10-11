/**
 * CLI: valida un comprobante de punta a punta e imprime cada paso.
 *
 * Uso:
 *   npm run validar -- ./tests/fixtures/comprobantes/x.jpg
 *   npm run validar -- x.jpg --banco NU            (responde REQUIERE_CONFIRMACION_BANCO)
 *   npm run validar -- x.jpg --cuenta BANORTE      (responde REQUIERE_CONFIRMACION_CUENTA; también acepta la CLABE)
 *   npm run validar -- x.jpg --sin-registro        (no guarda en data/usados.json; sin efecto si REGLAS.bloquearDuplicados es false)
 *   npm run validar -- x.jpg --sin-captura
 *   npm run validar -- x.jpg --nota "fecha 09/10/2026, ref 2309260"   (la nota de la foto en Telegram)
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { cerrarNavegador } from "./capture/screenshot.js";
import { BANCOS, CUENTAS_DESTINO } from "./config.js";
import { leerNota } from "./extraction/nota.js";
import { terminarOcr } from "./extraction/ocr-fallback.js";
import { resolverBanco } from "./normalize/index.js";
import { validarComprobante, type ResultadoValidacion } from "./pipeline.js";
import type { BancoEmisor, ClaveBanco } from "./types.js";

const ICONOS: Partial<Record<ResultadoValidacion["codigo"], string>> = {
  VALIDADO: "✅",
  MISMO_BANCO: "✅",
  FECHA_FUTURA: "⏳",
  COMPROBANTE_NOCTURNO: "⏳",
  DUPLICADO: "⚠️",
  REQUIERE_CONFIRMACION_BANCO: "❓",
  REQUIERE_CONFIRMACION_CUENTA: "❓",
  NO_ENCONTRADO: "🔍",
  BANXICO_NO_DISPONIBLE: "⚠️",
};

const seg = (ms?: number) => (ms === undefined ? "-" : `${(ms / 1000).toFixed(1)} s`);
const titulo = (t: string) => console.log(`\n== ${t} ==`);

function bancoDesdeArgumento(valor: string): BancoEmisor {
  const clave = (valor.toUpperCase() in BANCOS ? valor.toUpperCase() : resolverBanco(valor)) as ClaveBanco | null;
  return clave ? { clave, nombreLibre: null } : { clave: null, nombreLibre: valor };
}

function cuentaDesdeArgumento(valor: string): string {
  const cuenta = CUENTAS_DESTINO.find((c) => c.clabe === valor || c.banco === valor.toUpperCase());
  if (!cuenta) throw new Error(`--cuenta debe ser una CLABE o un banco de CUENTAS_DESTINO (${CUENTAS_DESTINO.map((c) => c.banco).join(", ")})`);
  return cuenta.clabe;
}

function imprimir(r: ResultadoValidacion): void {
  const ex = r.extraccion;
  if (ex) {
    titulo(`Datos extraídos (origen: ${ex.origen}${ex.errorNvidia ? `; NVIDIA no disponible: ${ex.errorNvidia}` : ""})`);
    if (ex.completadoConOcr) console.log(`(la IA no leyó y se tomó del OCR: ${ex.completadoConOcr.join(", ")})`);
    console.log(JSON.stringify(ex.datos, null, 2));
    titulo("Banco emisor");
    const s = ex.banco.senales;
    console.log(`${ex.banco.suficiente ? "✔" : "✘"} ${ex.banco.motivo}  [modelo=${s.modelo ?? "-"} texto=${s.texto ?? "-"} clave=${s.clave ?? "-"} firma=${s.firma ?? "-"}]`);
  }
  if (r.normalizados) {
    titulo("Datos normalizados");
    console.log(JSON.stringify(r.normalizados, null, 2));
  }

  for (const d of r.extraccion?.notaAplicada?.diferencias ?? []) {
    console.log(`\n⚠️ ${d.campo}: la nota dice ${d.nota} y la imagen ${d.imagen} (se usa la nota)`);
  }

  titulo("Reglas aplicadas");
  for (const regla of r.reglas) console.log(`${regla.paso ? "✔" : "✘"} ${regla.regla}${regla.detalle ? ` — ${regla.detalle}` : ""}`);

  if (r.intentos.length) {
    titulo("Intentos a Banxico");
    r.intentos.forEach((i, n) => {
      const criterio = i.criterio === "CLAVE_RASTREO" ? "clave" : "referencia";
      const sondeo = i.sondeo ? ` [sondeo ${i.sondeo === "SIN_CUENTA" ? "sin cuenta" : "sin cuenta ni monto"}]` : "";
      console.log(
        `${String(n + 1).padStart(2)}. ${i.fecha} · ${criterio} ${i.valorCriterio} · cuenta ${i.cuenta || "-"} · ${i.emisor} → ${i.receptor}${sondeo} → ${i.resultado}${i.detalle ? ` (${i.detalle})` : ""}`,
      );
    });
  }

  if (r.candidatosBanco?.length) console.log(`\nBancos posibles: ${r.candidatosBanco.join(", ")}  → usa --banco <BANCO>`);
  if (r.candidatosCuenta?.length) console.log(`\nCuentas posibles: ${r.candidatosCuenta.map((c) => c.banco).join(", ")}  → usa --cuenta <BANCO>`);

  titulo("Resultado");
  console.log(`${ICONOS[r.codigo] ?? "❌"} ${r.codigo}: ${r.mensaje}`);
  if (r.ruta) console.log(`   Ruta: ${r.ruta === "rapida" ? "rápida (datos del OCR, sin esperar a la IA)" : "normal"}`);
  if (r.pago) console.log(`   Pago: ${JSON.stringify(r.pago)}`);
  if (r.captura) console.log(`   Captura: ${r.captura.ruta} (${r.captura.metodo}${r.captura.aviso ? `; respaldo porque: ${r.captura.aviso}` : ""})`);
  if (r.errorCaptura) console.log(`   No se pudo generar la captura: ${r.errorCaptura}`);
  const t = r.tiempos;
  console.log(`   Tiempos: lectura ${seg(t.lectura)} · Banxico ${seg(t.banxico)} · captura ${seg(t.captura)} · total ${seg(t.total)}`);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      banco: { type: "string" },
      cuenta: { type: "string" },
      nota: { type: "string" },
      usuario: { type: "string", default: "cli" },
      "sin-registro": { type: "boolean", default: false },
      "sin-captura": { type: "boolean", default: false },
    },
  });
  const ruta = positionals[0];
  if (!ruta) {
    console.error("Uso: npm run validar -- <imagen> [--banco BANCO] [--cuenta BANCO|CLABE] [--nota 'fecha 09/10/2026, ref 123'] [--sin-registro] [--sin-captura]");
    process.exitCode = 1;
    return;
  }

  const nota = leerNota(values.nota);
  if (nota) {
    titulo("Nota");
    console.log(`Entendido: ${nota.entendidos.join(", ") || "-"}`);
    if (nota.noEntendidos.length) console.log(`No entendido: ${nota.noEntendidos.map((p) => `«${p}»`).join(", ")}`);
  }

  const resultado = await validarComprobante(readFileSync(ruta), {
    usuario: values.usuario!,
    nota: nota?.datos,
    registrar: !values["sin-registro"],
    capturar: !values["sin-captura"],
    // La línea de comandos no vuelve a revisar sola un pago de hace minutos: busca de una vez en todas las fechas.
    busquedaCompleta: true,
    confirmaciones: {
      banco: values.banco ? bancoDesdeArgumento(values.banco) : undefined,
      cuentaClabe: values.cuenta ? cuentaDesdeArgumento(values.cuenta) : undefined,
    },
    alProgreso: (p) => process.stderr.write(`… ${p.etapa}${p.consulta ? ` (consulta ${p.consulta})` : ""}\n`),
  });
  imprimir(resultado);
}

main()
  .catch((e) => {
    console.error("Error:", (e as Error).message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await terminarOcr();
    await cerrarNavegador();
    // La IA puede seguir corriendo de fondo si se usó la ruta rápida: no hace falta esperarla.
    process.exit(process.exitCode ?? 0);
  });
