import { describe, expect, it } from "vitest";
import { clasificarMensaje, formatoImagen, puedeUsar } from "../../src/bot/filtro.js";

const foto = (id: string) => ({ file_id: id, file_unique_id: id, width: 100, height: 100 });

describe("clasificarMensaje: solo se aceptan imágenes", () => {
  it("foto → la de mayor resolución", () => {
    expect(clasificarMensaje({ photo: [foto("chica"), foto("grande")] })).toEqual({ tipo: "imagen", fileId: "grande" });
  });

  it("imagen enviada como archivo (JPG/PNG)", () => {
    const document = { file_id: "doc", file_unique_id: "doc", mime_type: "image/png" };
    expect(clasificarMensaje({ document })).toEqual({ tipo: "imagen", fileId: "doc" });
  });

  it.each([
    ["texto", { text: "hola" }],
    ["números", { text: "072650010004755884" }],
    ["un monto", { text: "$400.00" }],
    ["un comando desconocido", { text: "/validar" }],
    ["un PDF", { document: { file_id: "p", file_unique_id: "p", mime_type: "application/pdf" } }],
    ["un archivo sin tipo", { document: { file_id: "x", file_unique_id: "x" } }],
    ["un sticker, audio o ubicación (sin foto, archivo ni texto)", {}],
  ])("rechaza %s", (_, mensaje) => {
    expect(clasificarMensaje(mensaje)).toEqual({ tipo: "rechazar" });
  });

  it.each([["/start"], ["/ayuda"], ["/help"], ["/start@validador_spei_mx_bot"], ["  /START  "]])("%s → ayuda", (text) => {
    expect(clasificarMensaje({ text })).toEqual({ tipo: "ayuda" });
  });
});

describe("clasificarMensaje: avisos de Telegram", () => {
  it.each([
    ["alguien entró al grupo", { new_chat_members: [] }],
    ["alguien salió del grupo", { left_chat_member: {} }],
    ["cambio de nombre del grupo", { new_chat_title: "Pagos" }],
    ["el grupo pasó a supergrupo", { migrate_to_chat_id: -1001234567890 }],
  ])("%s → servicio", (_, mensaje) => {
    expect(clasificarMensaje(mensaje)).toEqual({ tipo: "servicio" });
  });
});

describe("puedeUsar", () => {
  const permitidos = [111];
  const grupos = new Set([-1001234567890]);

  it("en privado, solo ALLOWED_USER_IDS", () => {
    expect(puedeUsar({ id: 111, type: "private" }, 111, permitidos, grupos)).toBe(true);
    expect(puedeUsar({ id: 222, type: "private" }, 222, permitidos, grupos)).toBe(false);
  });

  it("en un grupo autorizado, cualquier miembro", () => {
    expect(puedeUsar({ id: -1001234567890, type: "supergroup" }, 222, permitidos, grupos)).toBe(true);
  });

  it("en un grupo no autorizado, nadie (tampoco ALLOWED_USER_IDS)", () => {
    expect(puedeUsar({ id: -1009999999999, type: "supergroup" }, 111, permitidos, grupos)).toBe(false);
    expect(puedeUsar({ id: -555, type: "group" }, 111, permitidos, grupos)).toBe(false);
  });

  it("en un canal, nadie", () => {
    expect(puedeUsar({ id: -1001234567890, type: "channel" }, undefined, permitidos, grupos)).toBe(false);
  });
});

describe("clasificarMensaje: formatos y tamaño", () => {
  const archivo = (mime_type: string, file_size = 500_000) => ({ document: { file_id: "d", file_unique_id: "d", mime_type, file_size } });

  it.each([["image/jpeg"], ["image/png"], ["image/webp"]])("acepta %s", (tipo) => {
    expect(clasificarMensaje(archivo(tipo))).toEqual({ tipo: "imagen", fileId: "d" });
  });

  it.each([["image/gif"], ["image/svg+xml"], ["image/heic"], ["image/tiff"]])("rechaza %s", (tipo) => {
    expect(clasificarMensaje(archivo(tipo))).toEqual({ tipo: "rechazar" });
  });

  it("rechaza archivos de más de 10 MB", () => {
    expect(clasificarMensaje(archivo("image/png", 10 * 1024 * 1024 + 1))).toEqual({ tipo: "rechazar" });
    expect(clasificarMensaje({ photo: [{ ...foto("g"), file_size: 11 * 1024 * 1024 }] })).toEqual({ tipo: "rechazar" });
  });

  it("acepta la foto con pie de foto (texto)", () => {
    const conPie = { photo: [foto("a")], caption: "pago de Juan" };
    expect(clasificarMensaje(conPie)).toEqual({ tipo: "imagen", fileId: "a" });
  });
});

describe("formatoImagen (por los primeros bytes)", () => {
  it("reconoce JPG, PNG y WEBP", () => {
    expect(formatoImagen(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe("jpeg");
    expect(formatoImagen(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe("png");
    expect(formatoImagen(Buffer.from("RIFF\x10\x00\x00\x00WEBPVP8 ", "latin1"))).toBe("webp");
  });

  it("rechaza lo demás aunque diga ser imagen", () => {
    expect(formatoImagen(Buffer.from("%PDF-1.7"))).toBeNull();
    expect(formatoImagen(Buffer.from("GIF89a"))).toBeNull();
    expect(formatoImagen(Buffer.from("<svg"))).toBeNull();
    expect(formatoImagen(Buffer.alloc(0))).toBeNull();
  });
});
