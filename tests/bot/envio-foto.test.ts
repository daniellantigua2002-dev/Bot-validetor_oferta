/**
 * De punta a punta en el bot, sin red: llega la foto de un comprobante en privado, se valida y la foto de
 * Banxico (en memoria, sin archivo en el disco) se envía a Telegram como respuesta a ese mensaje.
 * La API de Telegram se intercepta y la validación se simula.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InputFile } from "grammy";
import sharp from "sharp";
import { afterAll, describe, expect, it, vi } from "vitest";
import { ColaGuardada } from "../../src/bot/cola-guardada.js";
import { crearBot } from "../../src/bot/index.js";
import type { ResultadoValidacion } from "../../src/pipeline.js";

const validarComprobante = vi.hoisted(() => vi.fn());
vi.mock("../../src/pipeline.js", () => ({ validarComprobante }));

const USUARIO = 42;
const carpeta = mkdtempSync(join(tmpdir(), "envio-foto-"));
afterAll(() => {
  vi.unstubAllGlobals();
  rmSync(carpeta, { recursive: true, force: true });
});

describe("envío de la foto de Banxico a Telegram", () => {
  it("validado: sendPhoto con la imagen en memoria, como respuesta al comprobante", async () => {
    const foto = await sharp({ create: { width: 40, height: 20, channels: 3, background: "#ffffff" } }).png().toBuffer();
    const comprobante = await sharp({ create: { width: 10, height: 10, channels: 3, background: "#000000" } }).jpeg().toBuffer();
    // Descarga de la imagen del comprobante desde los servidores de archivos de Telegram.
    vi.stubGlobal("fetch", vi.fn(async () => new Response(comprobante)));
    const resultado: ResultadoValidacion = {
      codigo: "VALIDADO",
      mensaje: "",
      reglas: [],
      intentos: [],
      tiempos: {},
      captura: { imagen: foto, metodo: "local" },
    };
    validarComprobante.mockResolvedValue(resultado);

    const { bot } = crearBot("123:prueba", [USUARIO], [], new ColaGuardada(join(carpeta, "cola.json")));
    bot.botInfo = { id: 1, is_bot: true, first_name: "Bot", username: "bot_prueba" } as typeof bot.botInfo;
    const llamadas: { metodo: string; datos: Record<string, unknown> }[] = [];
    bot.api.config.use(async (_prev, metodo, datos) => {
      llamadas.push({ metodo, datos: datos as Record<string, unknown> });
      const result = metodo === "getFile" ? { file_id: "f", file_unique_id: "f", file_path: "photos/f.jpg" } : { message_id: 900 };
      return { ok: true, result } as never;
    });

    await bot.handleUpdate({
      update_id: 1,
      message: {
        message_id: 7,
        date: 0,
        chat: { id: USUARIO, type: "private", first_name: "Ana" },
        from: { id: USUARIO, is_bot: false, first_name: "Ana" },
        photo: [{ file_id: "f", file_unique_id: "f", width: 10, height: 10 }],
      },
    });

    await vi.waitFor(() => expect(llamadas.some((l) => l.metodo === "sendPhoto")).toBe(true), { timeout: 5000 });
    const envio = llamadas.find((l) => l.metodo === "sendPhoto")!.datos;
    expect(envio).toMatchObject({ chat_id: USUARIO, reply_parameters: { message_id: 7 } });
    expect(envio.photo).toBeInstanceOf(InputFile);
    expect(Buffer.from((await (envio.photo as InputFile).toRaw()) as Uint8Array)).toEqual(foto);
    expect(String(envio.caption)).toContain("Ana, su comprobante fue validado");
  });
});
