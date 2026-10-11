/**
 * Reconocimiento de bancos por nombre, alias o forma de la clave de rastreo.
 */
import { BANCOS, CUENTAS_DESTINO, type ClaveBanco, type DefinicionBanco } from "../config.js";

const LISTA = Object.entries(BANCOS) as [ClaveBanco, DefinicionBanco][];

/** Minúsculas, sin acentos, sin signos y con espacios simples. */
export function normalizarTexto(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Alias y nombres de catálogo normalizados de cada banco, del más largo al más corto.
 * Al estar normalizados solo contienen [a-z0-9 ], así que se pueden usar directo en la regex.
 */
const TERMINOS: { banco: ClaveBanco; termino: string; regex: RegExp }[] = LISTA.flatMap(([banco, def]) =>
  [...new Set([...def.alias, ...def.catalogo].map(normalizarTexto).filter(Boolean))].map((termino) => ({
    banco,
    termino,
    regex: new RegExp(`(?<![a-z0-9])${termino}(?![a-z0-9])`),
  })),
).sort((a, b) => b.termino.length - a.termino.length);

/**
 * Convierte un nombre libre ("Banco Azteca", "CITIBANAMEX", "Nu México") en la clave de BANCOS.
 * Gana el alias más largo contenido como palabra completa. Devuelve null si no hay coincidencia
 * o si dos bancos empatan.
 */
export function resolverBanco(nombre: string | null | undefined): ClaveBanco | null {
  if (!nombre) return null;
  const texto = normalizarTexto(nombre);
  if (!texto) return null;
  const exacto = TERMINOS.find((t) => t.termino === texto);
  if (exacto) return exacto.banco;
  const coincidencias = TERMINOS.filter((t) => t.regex.test(texto));
  if (coincidencias.length === 0) return null;
  const largo = coincidencias[0]!.termino.length;
  const mejores = new Set(coincidencias.filter((t) => t.termino.length === largo).map((t) => t.banco));
  return mejores.size === 1 ? coincidencias[0]!.banco : null;
}

const LARGO_MINIMO_EN_LINEA = 3;

/** Bancos mencionados en una línea de texto (cada banco una sola vez). */
export function bancosEnLinea(linea: string): ClaveBanco[] {
  const texto = normalizarTexto(linea);
  const encontrados: ClaveBanco[] = [];
  let resto = texto;
  for (const t of TERMINOS) {
    // Los términos muy cortos ("nu") solo valen como nombre completo: dentro de un renglón el OCR
    // produce "NU" al leer logos de otros bancos.
    if (t.termino.length < LARGO_MINIMO_EN_LINEA) continue;
    if (t.regex.test(resto)) {
      if (!encontrados.includes(t.banco)) encontrados.push(t.banco);
      // Se quita el término para que "spin by oxxo" no cuente también como "spin".
      resto = resto.replace(t.regex, " ");
    }
  }
  return encontrados;
}

/**
 * Banco cuyo diseño de comprobante reconoce el texto (BANCOS[…].firmas: frases propias de su app,
 * como "Ref. SuperMóvil" o "Cuenta efectiva digital"). Solo si es uno.
 */
export function bancoPorFirma(texto: string | null | undefined): ClaveBanco | null {
  if (!texto) return null;
  const norm = normalizarTexto(texto);
  const encontrados = LISTA.filter(([, def]) => def.firmas?.some((f) => f.test(norm))).map(([clave]) => clave);
  return encontrados.length === 1 ? encontrados[0]! : null;
}

/**
 * Banco cuya app usa como referencia los últimos 7 dígitos de la cuenta destino (Banco Azteca),
 * si la referencia del comprobante son los últimos 7 dígitos de una de nuestras cuentas.
 */
export function bancoPorReferencia(referencia: string | null | undefined): ClaveBanco | null {
  const digitos = referencia?.replace(/\D/g, "") ?? "";
  if (digitos.length !== 7) return null;
  const numeros = CUENTAS_DESTINO.flatMap((c) => Object.values(c as Record<string, string>));
  if (!numeros.some((n) => /^\d+$/.test(n) && n.length > 7 && n.endsWith(digitos))) return null;
  const bancos = LISTA.filter(([, def]) => def.referenciaHabitual?.tipo === "cuentaDestino").map(([clave]) => clave);
  return bancos.length === 1 ? bancos[0]! : null;
}

/** Banco según el prefijo o la forma de la clave de rastreo. Se respetan mayúsculas. */
export function detectarBancoPorClave(clave: string | null | undefined): ClaveBanco | null {
  if (!clave) return null;
  const limpia = clave.replace(/\s+/g, "");
  const candidatos = LISTA.filter(
    ([, def]) => def.prefijosClave.some((p) => limpia.startsWith(p)) || (def.patronClave?.test(limpia) ?? false),
  ).map(([clave]) => clave);
  return candidatos.length === 1 ? candidatos[0]! : null;
}
