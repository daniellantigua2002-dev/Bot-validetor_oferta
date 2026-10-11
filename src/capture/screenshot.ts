/**
 * Foto del resultado de Banxico (la tabla con referencia, clave, instituciones, estado, fechas,
 * cuenta beneficiaria y monto) que se devuelve al usuario.
 *
 * - renderizarTabla: dibuja la tabla que ya devolvió Banxico con los estilos del sitio, más un
 *   marco blanco y celdas holgadas (rápido y sin otra consulta).
 * - capturarEnSitio: abre el CEP con Playwright, llena el formulario con la consulta que funcionó,
 *   pulsa "Consultar Pago" y dibuja la tabla de esa respuesta con la misma presentación.
 * El modo principal se elige en CAPTURA.modo; si falla se usa el otro.
 */
import { chromium, type Browser, type BrowserContext } from "playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { peticion, type ConsultaBanxico } from "../banxico/cliente.js";
import { parsearRespuesta } from "../banxico/parser.js";
import { RITMO, turnoBanxico } from "../banxico/ritmo.js";
import { BANXICO, CAPTURA, ZONA_HORARIA } from "../config.js";

export const CARPETA_CAPTURAS = resolve("data/capturas");
const SELECTOR_TABLA = "#consultaMISPEI table#xxx";

let navegador: Promise<Browser> | null = null;
/** Contexto reutilizado para dibujar tablas: conserva en caché los estilos y fuentes de Banxico. */
let contextoLocal: Promise<BrowserContext> | null = null;

/** Un solo navegador para todo el proceso (abrirlo tarda 1–2 s). */
function obtenerNavegador(): Promise<Browser> {
  if (!navegador) {
    navegador = chromium.launch({ headless: true }).catch((e) => {
      navegador = null;
      throw e;
    });
  }
  return navegador;
}

export async function cerrarNavegador(): Promise<void> {
  const n = navegador;
  navegador = null;
  contextoLocal = null;
  await (await n?.catch(() => null))?.close();
}

/** Nombre de archivo seguro: "2026-10-08_SPIN-20261008200443959PNEB9". */
export function nombreBase(fechaIso: string, clave: string): string {
  return `${fechaIso}_${clave.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

const contextoNuevo = (b: Browser) =>
  b.newContext({ locale: "es-MX", timezoneId: ZONA_HORARIA, viewport: { width: 1100, height: 900 }, deviceScaleFactor: 2 });

/** Repite la consulta en el sitio del CEP y guarda la captura de la tabla en `destino`. */
export async function capturarEnSitio(consulta: ConsultaBanxico, destino: string): Promise<void> {
  const contexto = await contextoNuevo(await obtenerNavegador());
  try {
    const page = await contexto.newPage();
    // Abrir el sitio también son peticiones a Banxico (la página y su catálogo): respetan el turno.
    await turnoBanxico();
    await Promise.all([
      page.waitForResponse((r) => r.url().includes("instituciones.do"), { timeout: BANXICO.timeoutMs }),
      page.goto(BANXICO.urlBase, { waitUntil: "domcontentloaded", timeout: BANXICO.timeoutMs }),
    ]);

    // Fecha → el sitio pide el catálogo de esa fecha y llena los combos.
    await Promise.all([
      page.waitForResponse((r) => r.url().includes(`instituciones.do?fecha=${consulta.fecha}`), { timeout: BANXICO.timeoutMs }),
      page.evaluate((fecha) => {
        const $ = (window as unknown as { $: (s: string) => { datepicker: (...a: unknown[]) => void; trigger: (e: string) => void } }).$;
        $("#input_fecha").datepicker("setDate", fecha);
        $("[name='fecha']").trigger("change");
      }, consulta.fecha),
    ]);
    // El sitio vuelve a poner el receptor por defecto 500 ms después de recibir el catálogo.
    await page.waitForTimeout(800);

    await page.selectOption("#input_tipoCriterio", consulta.tipoCriterio); // limpia el criterio: va primero
    await page.fill("#input_criterio", consulta.criterio);
    await page.selectOption("#input_emisor", consulta.emisor.codigo);
    await page.selectOption("#input_receptor", consulta.receptor.codigo);
    await page.fill("#input_cuenta", consulta.cuenta);
    await page.fill("#input_monto", consulta.monto);
    await page.evaluate(() => {
      (document.querySelector("#input_captcha") as HTMLInputElement).value = "c";
    });
    await page.dispatchEvent("#fConsulta", "input");

    await turnoBanxico();
    const [respuesta] = await Promise.all([
      page.waitForResponse((r) => r.url().includes("valida.do") && r.request().method() === "POST", { timeout: BANXICO.timeoutMs }),
      page.click("#btn_Consultar"),
    ]);
    const html = await respuesta.text();
    const r = parsearRespuesta(html);
    if (r.tipo === "CAPTCHA") RITMO.registrarCaptcha("foto en el sitio");
    if (r.tipo !== "PAGOS") throw new Error(`al repetir la consulta en el navegador Banxico respondió ${r.tipo}`);
    await page.locator(SELECTOR_TABLA).first().waitFor({ state: "visible", timeout: 15_000 });
    // Misma presentación que el modo local: la tabla que devolvió Banxico con el marco holgado.
    await renderizarTabla(html, destino);
  } finally {
    await contexto.close();
  }
}

/**
 * Ajustes sobre los estilos de Banxico para una imagen más holgada y legible: marco blanco
 * alrededor, celdas con más espacio y etiquetas sin negrita (como se ve el sitio en el celular).
 */
const ESTILO_CAPTURA = `
  html, body { margin: 0; background: #fff; }
  #marco { display: inline-block; padding: 28px 34px; background: #fff; }
  #marco table.styled-table { width: auto; margin: 0; border: 1px solid #a7a7a7; border-collapse: separate; }
  #marco table.styled-table td {
    padding: 9px 16px !important;
    font-family: Roboto, "Segoe UI", Arial, sans-serif;
    font-size: 15px;
    color: #4a4a4a;
    border-right: 0;
  }
  #marco table.styled-table.vertical tr > td:first-child {
    font-weight: 400;
    text-align: right;
    color: #555;
    border-right: 1px solid #a7a7a7;
  }
  #marco table.styled-table.vertical tr > td:last-child { text-align: center; min-width: 230px; }
`;

/** Hoja de estilos de Banxico para la foto, guardada en disco: se descarga una sola vez (respetando el turno). */
const ARCHIVO_ESTILOS = resolve(BANXICO.carpetaDisco, "cep-min.css");
let estilos: Promise<string | null> | null = null;

/** Los estilos de Banxico del disco o, la primera vez, del sitio. null si no se pudieron obtener (se enlazan como antes). */
function estilosBanxico(): Promise<string | null> {
  estilos ??= (async () => {
    const guardados = await readFile(ARCHIVO_ESTILOS, "utf8").catch(() => null);
    if (guardados) return guardados;
    if (RITMO.enfriamiento() > 0) return null; // la foto no espera a que termine el enfriamiento por captcha
    const r = await peticion(new URL("css/cep-min.css", BANXICO.urlBase).href, { method: "GET" }, { turno: turnoBanxico, reintentos: 1 });
    const css = r.ok && /css/i.test(r.headers.get("content-type") ?? "") ? await r.text() : "";
    if (!css.trim()) return null;
    await mkdir(dirname(ARCHIVO_ESTILOS), { recursive: true });
    await writeFile(ARCHIVO_ESTILOS, css, "utf8").catch(() => undefined);
    return css;
  })().catch(() => null);
  return estilos.then((css) => {
    if (!css) estilos = null; // se reintenta en la próxima foto
    return css;
  });
}

/** Dibuja la tabla a partir del HTML que ya devolvió Banxico (sin volver a consultar). */
export async function renderizarTabla(html: string, destino: string): Promise<void> {
  const tabla = html.replace(/<!--[\s\S]*?-->/g, "").match(/<table\b[^>]*\bid="xxx"[\s\S]*?<\/table>/i)?.[0];
  if (!tabla) throw new Error("la respuesta de Banxico no trae la tabla del resultado");
  if (!contextoLocal) {
    contextoLocal = obtenerNavegador().then(contextoNuevo);
    contextoLocal.catch(() => (contextoLocal = null));
  }
  const css = await estilosBanxico();
  // Con los estilos del disco, la base es su carpeta en Banxico: sus rutas internas se resuelven igual que antes.
  const base = css ? new URL("css/", BANXICO.urlBase).href : BANXICO.urlBase;
  const hojaBanxico = css ? `<style>${css}</style>` : `<link rel="stylesheet" href="css/cep-min.css">`;
  const page = await (await contextoLocal).newPage();
  try {
    await page.setContent(
      `<!doctype html><html><head><meta charset="utf-8"><base href="${base}">
${hojaBanxico}
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500&display=swap">
<style>${ESTILO_CAPTURA}</style></head>
<body><div id="marco">${tabla}</div></body></html>`,
      { waitUntil: "load", timeout: BANXICO.timeoutMs },
    );
    await page.evaluate(() => document.fonts.ready);
    await page.locator("#marco").screenshot({ path: destino });
  } finally {
    await page.close();
  }
}

export interface Captura {
  ruta: string;
  metodo: "sitio" | "local";
  /** Motivo por el que no se pudo capturar en el sitio, si aplica. */
  aviso?: string;
}

/** Foto de la tabla en data/capturas/<base>.png, con el modo de CAPTURA.modo y el otro como respaldo. */
export async function capturarResultado(
  consulta: ConsultaBanxico,
  base: string,
  html?: string,
  carpeta = CARPETA_CAPTURAS,
): Promise<Captura> {
  await mkdir(carpeta, { recursive: true });
  const ruta = join(carpeta, `${base}.png`);
  const local = async () => {
    if (!html) throw new Error("no hay HTML de Banxico para dibujar la tabla");
    await renderizarTabla(html, ruta);
  };
  const [primero, respaldo] =
    CAPTURA.modo === "local"
      ? ([[local, "local"], [() => capturarEnSitio(consulta, ruta), "sitio"]] as const)
      : ([[() => capturarEnSitio(consulta, ruta), "sitio"], [local, "local"]] as const);
  try {
    await primero[0]();
    return { ruta, metodo: primero[1] };
  } catch (e) {
    await respaldo[0]();
    return { ruta, metodo: respaldo[1], aviso: (e as Error).message };
  }
}

