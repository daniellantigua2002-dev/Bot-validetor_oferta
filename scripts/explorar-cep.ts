/**
 * Fase 1: exploración del CEP de Banxico con Playwright.
 *
 * Abre https://www.banxico.org.mx/cep/, intercepta las peticiones de red y
 * recorre el formulario igual que un usuario: cambia la fecha (catálogo),
 * llena los campos y pulsa "Descargar CEP" (tipoConsulta=1) y
 * "Consultar Pago" (tipoConsulta=0). Guarda el tráfico, las respuestas HTML
 * y capturas del resultado para documentar los endpoints.
 *
 * Uso:
 *   npx tsx scripts/explorar-cep.ts                       # datos ficticios (no encontrado)
 *   npx tsx scripts/explorar-cep.ts --fecha 08-10-2026 --tipo T --criterio MBAN01002610080012345678 \
 *     --emisor 40012 --receptor 40072 --cuenta 072000000000000012 --monto 1032.00 --ver
 *
 * Opciones:
 *   --fecha     dd-MM-yyyy (por defecto: ayer en hora de CDMX)
 *   --tipo      T = clave de rastreo, R = número de referencia
 *   --criterio  clave de rastreo o referencia
 *   --emisor    código de institución emisora (ver catálogo)
 *   --receptor  código de institución receptora
 *   --cuenta    cuenta beneficiaria (CLABE, tarjeta o celular)
 *   --monto     monto con punto decimal, sin comas
 *   --salida    carpeta de salida (por defecto: tests/fixtures/banxico/exploracion)
 *   --ver       abre el navegador visible
 */
import { chromium, type Page } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const URL_CEP = "https://www.banxico.org.mx/cep/";

interface EntradaRed {
  momento: string;
  tipo: string;
  metodo: string;
  url: string;
  cuerpo: string | null;
  estado?: number;
  contentType?: string;
}

type TipoRespuesta = "ERROR" | "NO_ENCONTRADO" | "ENCONTRADO";

/** Fecha de "ayer" en America/Mexico_City con formato dd-MM-yyyy. */
function ayerCdmx(): string {
  const partes = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Mexico_City",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date()); // yyyy-mm-dd
  const [a, m, d] = partes.split("-").map(Number) as [number, number, number];
  const ayer = new Date(Date.UTC(a, m - 1, d - 1));
  const dd = String(ayer.getUTCDate()).padStart(2, "0");
  const mm = String(ayer.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}-${mm}-${ayer.getUTCFullYear()}`;
}

/** Clasificación rápida de la respuesta de valida.do (el parser real va en src/banxico). */
function clasificar(html: string): { tipo: TipoRespuesta; mensaje: string } {
  const limpiar = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  if (html.includes('id="#error_div"') || html.includes("meta:stats=ERR")) {
    const m = html.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    return { tipo: "ERROR", mensaje: limpiar(m?.[1] ?? html) };
  }
  // El mensaje de "no encontrada" también aparece comentado en el HTML; se busca fuera de comentarios.
  const sinComentarios = html.replace(/<!--[\s\S]*?-->/g, "");
  if (/Operaci[oó]n no encontrada/i.test(sinComentarios)) {
    const m = sinComentarios.match(/<strong>([\s\S]*?)<\/strong>/);
    return { tipo: "NO_ENCONTRADO", mensaje: limpiar(m?.[1] ?? "") };
  }
  return { tipo: "ENCONTRADO", mensaje: "La respuesta no es error ni 'no encontrada': revisar HTML guardado." };
}

/** Lista formularios, botones y enlaces dentro del resultado (para descubrir la descarga del CEP). */
async function describirControlesResultado(page: Page) {
  return page.evaluate(() => {
    const raiz = document.querySelector("#divValidacionPertenencia .msg-banxico") ?? document.body;
    const formularios = [...raiz.querySelectorAll("form")].map((f) => ({
      action: f.getAttribute("action"),
      method: f.getAttribute("method"),
      onsubmit: f.getAttribute("onsubmit"),
      campos: [...f.querySelectorAll("input, select, button")].map((c) => ({
        etiqueta: c.tagName.toLowerCase(),
        tipo: c.getAttribute("type"),
        nombre: c.getAttribute("name"),
        id: c.id,
        valor: (c as HTMLInputElement).value?.slice(0, 80) ?? null,
      })),
    }));
    const enlaces = [...raiz.querySelectorAll("a")].map((a) => ({
      id: a.id,
      href: a.getAttribute("href"),
      texto: a.textContent?.trim().slice(0, 60),
      onclick: a.getAttribute("onclick"),
    }));
    const tablas = [...raiz.querySelectorAll("table")].map((t) => ({
      id: t.id,
      clase: t.className,
      encabezados: [...t.querySelectorAll("th, td.titulo, td strong")].map((x) => x.textContent?.trim()),
    }));
    return { formularios, enlaces, tablas };
  });
}

async function main() {
  const { values: op } = parseArgs({
    options: {
      fecha: { type: "string", default: ayerCdmx() },
      tipo: { type: "string", default: "T" },
      criterio: { type: "string", default: "EXPLORACION0000000001" },
      emisor: { type: "string", default: "40012" }, // BBVA MEXICO
      receptor: { type: "string", default: "40072" }, // BANORTE
      cuenta: { type: "string", default: "012180000000000001" },
      monto: { type: "string", default: "100.00" },
      salida: { type: "string", default: "tests/fixtures/banxico/exploracion" },
      ver: { type: "boolean", default: false },
    },
  });
  const salida = op.salida!;
  mkdirSync(salida, { recursive: true });

  const red: EntradaRed[] = [];
  const browser = await chromium.launch({ headless: !op.ver });
  const contexto = await browser.newContext({
    locale: "es-MX",
    timezoneId: "America/Mexico_City", // el calendario del sitio usa la fecha local del navegador
    acceptDownloads: true,
  });
  const page = await contexto.newPage();

  // Intercepción de red: solo documentos y XHR (se ignoran imágenes, estilos y fuentes).
  const relevante = (t: string) => ["document", "xhr", "fetch"].includes(t);
  page.on("request", (r) => {
    if (!relevante(r.resourceType())) return;
    red.push({
      momento: new Date().toISOString(),
      tipo: r.resourceType(),
      metodo: r.method(),
      url: r.url(),
      cuerpo: r.postData(),
    });
  });
  page.on("response", (r) => {
    if (!relevante(r.request().resourceType())) return;
    const entrada = [...red].reverse().find((e) => e.url === r.url() && e.estado === undefined);
    if (entrada) {
      entrada.estado = r.status();
      entrada.contentType = r.headers()["content-type"];
    }
  });

  console.log(`→ Abriendo ${URL_CEP}`);
  await Promise.all([
    page.waitForResponse((r) => r.url().includes("instituciones.do")),
    page.goto(URL_CEP, { waitUntil: "domcontentloaded", timeout: 60_000 }),
  ]);

  // 1) Catálogo de instituciones de la fecha elegida (lo dispara el evento change de la fecha).
  console.log(`→ Cambiando fecha a ${op.fecha} (dispara instituciones.do)`);
  const [respCatalogo] = await Promise.all([
    page.waitForResponse((r) => r.url().includes(`instituciones.do?fecha=${op.fecha}`)),
    page.evaluate((fecha) => {
      const $ = (window as unknown as { $: (s: string) => any }).$;
      $("#input_fecha").datepicker("setDate", fecha);
      $("[name='fecha']").trigger("change");
    }, op.fecha!),
  ]);
  const catalogo = (await respCatalogo.json()) as {
    instituciones?: [string, string][];
    institucionesMISPEI?: [string, string][];
    overrideCaptcha?: boolean;
  };
  writeFileSync(join(salida, `catalogo-${op.fecha}.json`), JSON.stringify(catalogo, null, 2));
  console.log(
    `  instituciones=${catalogo.instituciones?.length ?? 0} emisores(MISPEI)=${catalogo.institucionesMISPEI?.length ?? 0} overrideCaptcha=${catalogo.overrideCaptcha}`,
  );
  await page.waitForTimeout(800); // el sitio llena los <select> con un setTimeout de 500 ms

  // 2) Llenado del formulario.
  await page.selectOption("#input_tipoCriterio", op.tipo!); // el cambio limpia el criterio, por eso va primero
  await page.fill("#input_criterio", op.criterio!);
  await page.selectOption("#input_emisor", op.emisor!);
  await page.selectOption("#input_receptor", op.receptor!);
  await page.fill("#input_cuenta", op.cuenta!);
  await page.fill("#input_monto", op.monto!);
  // "Pago a banco" se deja desmarcado (receptorParticipante=0).

  const resultados: Record<string, unknown> = {};

  // "Consultar Pago" va primero: tras descargar archivos del CEP, Banxico exige captcha
  // en la siguiente consulta de la misma sesión.
  for (const [boton, tipoConsulta, nombre] of [
    ["#btn_Consultar", "0", "consultar-pago"],
    ["#btn_Descargar", "1", "descargar-cep"],
  ] as const) {
    // El sitio vacía el captcha tras cada consulta y Banxico rechaza la siguiente
    // ("La imagen de seguridad no fue ingresada correctamente"): se repone el valor fijo "c".
    await page.evaluate(() => {
      (document.querySelector("#input_captcha") as HTMLInputElement).value = "c";
    });
    // Reactivar botones (el sitio los deshabilita tras cada consulta).
    await page.dispatchEvent("#fConsulta", "input");
    console.log(`→ Pulsando ${boton} (tipoConsulta=${tipoConsulta})`);
    const [resp] = await Promise.all([
      page.waitForResponse((r) => r.url().includes("valida.do") && r.request().method() === "POST", {
        timeout: 90_000,
      }),
      page.click(boton),
    ]);
    const html = await resp.text();
    writeFileSync(join(salida, `valida-${nombre}.html`), html);
    const clase = clasificar(html);
    console.log(`  POST ${resp.request().postData()}`);
    console.log(`  → ${resp.status()} ${clase.tipo}: ${clase.mensaje}`);

    const modal = page.locator("#divValidacionPertenencia .msg-banxico");
    await modal.waitFor({ state: "visible", timeout: 30_000 });
    await page.waitForTimeout(700); // animación de centrado
    await modal.screenshot({ path: join(salida, `captura-${nombre}.png`) });
    // Captura solo de la tabla del resultado (lo que mostrará el bot).
    const tabla = page.locator("#consultaMISPEI table#xxx");
    if (await tabla.count()) await tabla.screenshot({ path: join(salida, `tabla-${nombre}.png`) });

    const controles = await describirControlesResultado(page);
    resultados[nombre] = { postData: resp.request().postData(), estado: resp.status(), ...clase, controles };

    // Si se encontró el pago, intentar las descargas que ofrezca el resultado.
    if (clase.tipo === "ENCONTRADO") {
      for (const f of controles.formularios) console.log(`  formulario: ${JSON.stringify(f)}`);
      for (const a of controles.enlaces) console.log(`  enlace: ${JSON.stringify(a)}`);
      const botonesDescarga = modal.locator("form button, form input[type=submit], a[href*='descarga']");
      const total = await botonesDescarga.count();
      for (let i = 0; i < total; i++) {
        try {
          const [descarga] = await Promise.all([
            page.waitForEvent("download", { timeout: 30_000 }),
            botonesDescarga.nth(i).click(),
          ]);
          const destino = join(salida, `cep-${nombre}-${i}-${descarga.suggestedFilename()}`);
          await descarga.saveAs(destino);
          console.log(`  descarga guardada: ${destino} (${descarga.url()})`);
        } catch (e) {
          console.log(`  el control #${i} no produjo descarga: ${(e as Error).message.split("\n")[0]}`);
        }
      }
    }

    await page.click("#btnCerrar");
    await modal.waitFor({ state: "hidden", timeout: 10_000 }).catch(() => undefined);
    // Pausa entre consultas: con ~2 s Banxico empezó a pedir captcha tras ~7 consultas; con 8 s no.
    await page.waitForTimeout(8000);
  }

  const cookies = (await contexto.cookies()).map((c) => ({ nombre: c.name, dominio: c.domain, httpOnly: c.httpOnly }));
  writeFileSync(join(salida, "red.json"), JSON.stringify(red, null, 2));
  writeFileSync(join(salida, "resumen.json"), JSON.stringify({ opciones: op, cookies, resultados }, null, 2));

  console.log("\nPeticiones relevantes:");
  for (const e of red) console.log(`  ${e.metodo} ${e.estado ?? "-"} ${e.url}${e.cuerpo ? `  ← ${e.cuerpo}` : ""}`);
  console.log(`\nCookies: ${cookies.map((c) => c.nombre).join(", ")}`);
  console.log(`Archivos en ${salida}`);

  await browser.close();
}

main().catch((e) => {
  console.error("Error en la exploración:", e);
  process.exit(1);
});
