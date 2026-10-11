/**
 * Confianza del banco emisor: cruza cuatro señales independientes.
 *   1. modelo: el banco que dio el modelo de visión (logo o texto).
 *   2. texto: el nombre del banco en el texto reconocido por OCR (fuera del lado destino).
 *   3. clave: el prefijo o la forma de la clave de rastreo.
 *   4. firma: frases propias del diseño del comprobante de ese banco (BANCOS[…].firmas).
 *
 * - 2 o más señales coinciden → suficiente.
 * - Señales que se contradicen sin mayoría → REQUIERE_CONFIRMACION_BANCO.
 * - Una sola señal → suficiente si es la clave o la firma, o el modelo con confianza ≥ REGLAS.confianzaMinimaBanco.
 */
import { BANCOS, REGLAS, type ClaveBanco } from "../config.js";
import { bancoPorFirma, bancoPorReferencia, detectarBancoPorClave, resolverBanco } from "../normalize/banco.js";
import { bancoEmisorPorTexto } from "./campos-texto.js";
import type { DatosExtraidos } from "./schema.js";

export interface SenalesBanco {
  modelo: ClaveBanco | null;
  texto: ClaveBanco | null;
  clave: ClaveBanco | null;
  firma: ClaveBanco | null;
}

export interface EvaluacionBanco {
  /** Banco decidido (o la mejor sugerencia si no es suficiente). */
  banco: ClaveBanco | null;
  /** Nombre que dio el modelo cuando no corresponde a ningún banco de BANCOS. */
  nombreLibre: string | null;
  suficiente: boolean;
  senales: SenalesBanco;
  /** Bancos posibles para preguntarle al usuario cuando no es suficiente. */
  candidatos: ClaveBanco[];
  motivo: string;
}

const nombre = (b: ClaveBanco) => BANCOS[b].nombre;

export function evaluarBancoEmisor(
  datos: DatosExtraidos,
  textoOcr: string | null,
  origen: "nvidia" | "ocr",
): EvaluacionBanco {
  // En el respaldo OCR el "banco del modelo" salió del mismo texto: no se cuenta dos veces.
  const delModelo = origen === "nvidia" ? resolverBanco(datos.bancoEmisor.nombre) : null;
  const senales: SenalesBanco = {
    modelo: delModelo ?? (origen === "nvidia" && datos.esMercadoPago ? "MERCADO_PAGO" : null),
    texto: textoOcr ? bancoEmisorPorTexto(textoOcr) : null,
    clave: detectarBancoPorClave(datos.claveRastreo),
    firma: bancoPorFirma(textoOcr),
  };
  // El banco del texto puede ser el destino mal ubicado (Santander pone "Banco: BANORTE" bajo la cuenta
  // de origen): si la IA dice que ese es el banco destino y ve otro emisor, el texto no cuenta.
  const destinoIa = origen === "nvidia" ? resolverBanco(datos.bancoDestino) : null;
  if (senales.texto && senales.texto === destinoIa && senales.modelo && senales.modelo !== senales.texto) senales.texto = null;

  const votos = new Map<ClaveBanco, number>();
  for (const b of Object.values(senales)) if (b) votos.set(b, (votos.get(b) ?? 0) + 1);
  const candidatos = [...votos.keys()];
  const [ganador, maxVotos] = [...votos.entries()].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];

  const base = { senales, candidatos, nombreLibre: null };

  if (ganador && maxVotos >= 2) {
    return { ...base, banco: ganador, suficiente: true, motivo: `${maxVotos} señales coinciden en ${nombre(ganador)}` };
  }

  if (candidatos.length >= 2) {
    const detalle = Object.entries(senales)
      .filter(([, b]) => b)
      .map(([s, b]) => `${s}=${nombre(b!)}`)
      .join(", ");
    return { ...base, banco: senales.modelo ?? candidatos[0]!, suficiente: false, motivo: `señales contradictorias (${detalle})` };
  }

  const confianza = datos.bancoEmisor.confianza;
  if (ganador) {
    if (senales.clave) {
      return { ...base, banco: ganador, suficiente: true, motivo: `la clave de rastreo indica ${nombre(ganador)}` };
    }
    if (senales.firma) {
      return { ...base, banco: ganador, suficiente: true, motivo: `el diseño del comprobante es de ${nombre(ganador)}` };
    }
    if (senales.modelo && confianza >= REGLAS.confianzaMinimaBanco) {
      return { ...base, banco: ganador, suficiente: true, motivo: `el modelo identificó ${nombre(ganador)} (confianza ${confianza})` };
    }
    return { ...base, banco: ganador, suficiente: false, motivo: `solo una señal débil indica ${nombre(ganador)}` };
  }

  // Ninguna señal corresponde a BANCOS: un nombre libre del modelo se resolverá contra el catálogo de Banxico.
  const libre = origen === "nvidia" ? datos.bancoEmisor.nombre?.trim() || null : null;
  if (libre && confianza >= REGLAS.confianzaMinimaBanco) {
    return { ...base, banco: null, nombreLibre: libre, suficiente: true, motivo: `banco fuera del mapa: "${libre}"` };
  }
  // Último recurso, sin ninguna otra pista: la referencia son los últimos 7 dígitos de nuestra cuenta
  // (diseño de Banco Azteca). Si no fuera Azteca, Banxico no encontrará el pago.
  const porReferencia = bancoPorReferencia(datos.referencia);
  if (porReferencia) {
    const motivo = `la referencia son los últimos 7 dígitos de nuestra cuenta, como en ${nombre(porReferencia)}`;
    return { ...base, banco: porReferencia, candidatos: [porReferencia], suficiente: true, motivo };
  }
  return { ...base, banco: null, nombreLibre: libre, suficiente: false, motivo: "no se pudo identificar el banco emisor" };
}
