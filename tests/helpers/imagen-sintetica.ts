import sharp from "sharp";

const escapar = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Genera una imagen PNG con las líneas de texto dadas (simula un comprobante). */
export async function imagenConTexto(
  lineas: string[],
  opciones: { oscuro?: boolean; ancho?: number; tamano?: number } = {},
): Promise<Buffer> {
  const { oscuro = false, ancho = 720, tamano = 26 } = opciones;
  const alto = 60 + lineas.length * tamano * 1.6;
  const [fondo, tinta] = oscuro ? ["#1c1c1e", "#f2f2f2"] : ["#ffffff", "#222222"];
  const textos = lineas
    .map((l, i) => `<text x="30" y="${50 + i * tamano * 1.6}" font-family="Arial, Helvetica, sans-serif" font-size="${tamano}" fill="${tinta}">${escapar(l)}</text>`)
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${ancho}" height="${alto}"><rect width="100%" height="100%" fill="${fondo}"/>${textos}</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}
