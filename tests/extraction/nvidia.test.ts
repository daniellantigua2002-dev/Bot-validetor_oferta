import { describe, expect, it } from "vitest";
import sharp from "sharp";
import type { ChatCompletion, ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";
import {
  ErrorExtraccion,
  extraerConModelos,
  extraerConNvidia,
  extraerJson,
  preprocesarImagen,
  validarRespuesta,
  modelosConfigurados,
  type ClienteChat,
  type ConfigModelos,
} from "../../src/extraction/nvidia.js";
import { PROMPT_SISTEMA } from "../../src/extraction/prompt.js";
import { datosEjemplo } from "./datos.js";

/** Cliente que devuelve las respuestas indicadas en orden (un Error se lanza). */
function clienteFalso(respuestas: (string | Error)[]) {
  const llamadas: ChatCompletionCreateParamsNonStreaming[] = [];
  const cliente: ClienteChat = {
    chat: {
      completions: {
        create: async (params) => {
          llamadas.push(structuredClone(params));
          const r = respuestas.shift();
          if (r === undefined) throw new Error("sin respuestas preparadas");
          if (r instanceof Error) throw r;
          return { choices: [{ message: { content: r } }] } as unknown as ChatCompletion;
        },
      },
    },
  };
  return { cliente, llamadas };
}

const imagenBlanca = (ancho: number, alto: number) =>
  sharp({ create: { width: ancho, height: alto, channels: 3, background: "#ffffff" } }).png().toBuffer();

const JSON_OK = JSON.stringify(datosEjemplo());

describe("preprocesarImagen", () => {
  it("reduce a 1600 px por lado y convierte a JPEG", async () => {
    const salida = await preprocesarImagen(await imagenBlanca(3000, 2000));
    const meta = await sharp(salida).metadata();
    expect(meta.format).toBe("jpeg");
    expect(Math.max(meta.width!, meta.height!)).toBe(1600);
  });

  it("no agranda imágenes pequeñas", async () => {
    const meta = await sharp(await preprocesarImagen(await imagenBlanca(600, 1200))).metadata();
    expect([meta.width, meta.height]).toEqual([600, 1200]);
  });
});

describe("extraerJson / validarRespuesta", () => {
  it("tolera bloques de código y texto alrededor", () => {
    expect(extraerJson('Claro:\n```json\n{"a": 1}\n```')).toEqual({ a: 1 });
  });

  it("convierte montos y confianzas que llegan como texto", () => {
    const crudo = { ...datosEjemplo(), monto: "-$1,352.00", bancoEmisor: { nombre: "Klar", fuente: "logo", confianza: "0.9" } };
    const r = validarRespuesta(JSON.stringify(crudo));
    expect(r.ok && r.datos.monto).toBe(1352);
    expect(r.ok && r.datos.bancoEmisor.confianza).toBe(0.9);
  });

  it("explica por qué no cumple el schema", () => {
    const r = validarRespuesta(JSON.stringify({ ...datosEjemplo(), esComprobante: "si" }));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("esComprobante");
  });
});

describe("extraerConNvidia", () => {
  it("envía modelo, temperature 0, prompt e imagen JPEG en base64", async () => {
    const { cliente, llamadas } = clienteFalso([JSON_OK]);
    const datos = await extraerConNvidia(await imagenBlanca(800, 1600), { cliente, modelo: "modelo/prueba" });

    expect(datos).toEqual(datosEjemplo());
    expect(llamadas).toHaveLength(1);
    const p = llamadas[0]!;
    expect(p.model).toBe("modelo/prueba");
    expect(p.temperature).toBe(0);
    expect(p.messages[0]).toEqual({ role: "system", content: PROMPT_SISTEMA });
    const partes = p.messages[1]!.content as { type: string; image_url?: { url: string } }[];
    expect(partes.find((x) => x.type === "image_url")?.image_url?.url).toMatch(/^data:image\/jpeg;base64,/);
  });

  it("reintenta una vez si el JSON es inválido, mostrando el error al modelo", async () => {
    const { cliente, llamadas } = clienteFalso(["esto no es JSON", JSON_OK]);
    const datos = await extraerConNvidia(await imagenBlanca(100, 100), { cliente, modelo: "m" });

    expect(datos.claveRastreo).toBe("SPIN-20261008200443959PNEB9");
    expect(llamadas).toHaveLength(2);
    const ultimo = llamadas[1]!.messages.at(-1)!;
    expect(ultimo.role).toBe("user");
    expect(String(ultimo.content)).toContain("JSON inválido");
  });

  it("lanza ErrorExtraccion si falla dos veces", async () => {
    const { cliente, llamadas } = clienteFalso(['{"esComprobante": true}', "{}"]);
    await expect(extraerConNvidia(await imagenBlanca(100, 100), { cliente, modelo: "m" })).rejects.toBeInstanceOf(
      ErrorExtraccion,
    );
    expect(llamadas).toHaveLength(2);
  });

  it("lanza ErrorExtraccion con el código HTTP si la API falla (429)", async () => {
    const error = Object.assign(new Error("Too Many Requests"), { status: 429 });
    const { cliente } = clienteFalso([error]);
    await expect(extraerConNvidia(await imagenBlanca(100, 100), { cliente, modelo: "m" })).rejects.toThrow(/HTTP 429/);
  });
});

describe("extraerConModelos: carrera escalonada (NVIDIA, Gemini, respaldo)", () => {
  const imagen = Buffer.from("x");
  const tarda = (ms: number, resultado: "ok" | Error, registro: string[], nombre: string) => ({
    nombre,
    extraer: () =>
      new Promise<ReturnType<typeof datosEjemplo>>((ok, mal) => {
        registro.push(nombre);
        setTimeout(() => (resultado === "ok" ? ok(datosEjemplo({ referencia: nombre })) : mal(resultado)), ms);
      }),
  });

  it("el principal responde a tiempo: no se llama a los demás", async () => {
    const llamados: string[] = [];
    const r = await extraerConModelos(imagen, [tarda(5, "ok", llamados, "kimi"), tarda(5, "ok", llamados, "gemini")], 50);
    expect(r.modelo).toBe("kimi");
    expect(llamados).toEqual(["kimi"]);
  });

  it("el principal falla: el siguiente arranca de inmediato, sin esperar", async () => {
    const llamados: string[] = [];
    const inicio = Date.now();
    const r = await extraerConModelos(imagen, [tarda(5, new Error("HTTP 429"), llamados, "kimi"), tarda(5, "ok", llamados, "gemini")], 5000);
    expect(r.modelo).toBe("gemini");
    expect(Date.now() - inicio).toBeLessThan(1000);
  });

  it("el principal tarda: después de la espera arranca el siguiente y gana el primero que responda", async () => {
    const llamados: string[] = [];
    const r = await extraerConModelos(imagen, [tarda(400, "ok", llamados, "kimi"), tarda(5, "ok", llamados, "gemini")], 30);
    expect(r.modelo).toBe("gemini");
    expect(llamados).toEqual(["kimi", "gemini"]);
  });

  it("todos fallan: el error trae los motivos de cada uno", async () => {
    const llamados: string[] = [];
    const modelos = [tarda(5, new Error("HTTP 429"), llamados, "kimi"), tarda(5, new Error("sin clave"), llamados, "gemini")];
    await expect(extraerConModelos(imagen, modelos, 30)).rejects.toThrow(/kimi: HTTP 429 \| gemini: sin clave/);
  });

  it("sin modelos configurados: error claro", async () => {
    await expect(extraerConModelos(imagen, [], 30)).rejects.toThrow(/no hay modelos configurados/);
  });
});

describe("modelosConfigurados + extraerConModelos: Flash, Flash-Lite de respaldo y NVIDIA", () => {
  const FLASH = "gemini-3.5-flash";
  const LITE = "gemini-3.5-flash-lite";
  const NVIDIA = "google/gemma-4-31b-it";
  const config = (cambios: Partial<ConfigModelos> = {}): ConfigModelos => ({
    geminiApiKeys: ["k1", "k2", "k3", "k4", "k5", "k6"],
    geminiModelos: [FLASH],
    geminiModeloRespaldo: LITE,
    nvidiaApiKey: "nv",
    nvidiaModel: NVIDIA,
    ...cambios,
  });

  /** Clientes sin red: `respuesta(modelo, clave)` dice si ese modelo con esa clave responde ("ok") o con qué HTTP falla. */
  function simular(respuesta: (modelo: string, clave: string) => "ok" | number) {
    const llamadas: string[] = [];
    const cliente = (clave: string): ClienteChat => ({
      chat: {
        completions: {
          create: async (params) => {
            llamadas.push(`${params.model}@${clave}`);
            const r = respuesta(params.model, clave);
            if (r !== "ok") throw Object.assign(new Error(`error ${r}`), { status: r });
            return { choices: [{ message: { content: JSON_OK } }] } as unknown as ChatCompletion;
          },
        },
      },
    });
    return { llamadas, clientes: { gemini: cliente, nvidia: cliente } };
  }
  const correr = async (cfg: ConfigModelos, respuesta: (modelo: string, clave: string) => "ok" | number) => {
    const { llamadas, clientes } = simular(respuesta);
    const imagen = await imagenBlanca(100, 100);
    const resultado = await extraerConModelos(imagen, modelosConfigurados(cfg, clientes), 5000).then(
      (r) => r.modelo,
      (e: Error) => e,
    );
    return { resultado, llamadas };
  };
  const seis = (modelo: string) => ["k1", "k2", "k3", "k4", "k5", "k6"].map((k) => `${modelo}@${k}`);

  it("el orden de la carrera es Flash #1..#6, Flash-Lite #1..#6 y NVIDIA", () => {
    const nombres = modelosConfigurados(config(), simular(() => "ok").clientes).map((m) => m.nombre);
    expect(nombres).toEqual([
      ...[1, 2, 3, 4, 5, 6].map((n) => `${FLASH}#${n}`),
      ...[1, 2, 3, 4, 5, 6].map((n) => `${LITE}#${n}`),
      NVIDIA,
    ]);
  });

  it("normal: responde flash#1 y Flash-Lite nunca se llama", async () => {
    const { resultado, llamadas } = await correr(config(), () => "ok");
    expect(resultado).toBe(`${FLASH}#1`);
    expect(llamadas).toEqual([`${FLASH}@k1`]);
  });

  it("429 en una clave de Flash: pasa a la siguiente clave de Flash", async () => {
    const { resultado, llamadas } = await correr(config(), (m, k) => (m === FLASH && k === "k1" ? 429 : "ok"));
    expect(resultado).toBe(`${FLASH}#2`);
    expect(llamadas).toEqual([`${FLASH}@k1`, `${FLASH}@k2`]);
  });

  it("429 en las 6 claves de Flash: responde flash-lite#1", async () => {
    const { resultado, llamadas } = await correr(config(), (m) => (m === FLASH ? 429 : "ok"));
    expect(resultado).toBe(`${LITE}#1`);
    expect(llamadas).toEqual([...seis(FLASH), `${LITE}@k1`]);
  });

  it("503 en flash#1: salta a flash-lite#1 sin llamar a flash#2..#6", async () => {
    const { resultado, llamadas } = await correr(config(), (m) => (m === FLASH ? 503 : "ok"));
    expect(resultado).toBe(`${LITE}#1`);
    expect(llamadas).toEqual([`${FLASH}@k1`, `${LITE}@k1`]);
  });

  it("429 en Flash-Lite: pasa a la siguiente clave de Flash-Lite", async () => {
    const { resultado, llamadas } = await correr(config(), (m, k) => (m === FLASH ? 429 : k === "k1" ? 429 : "ok"));
    expect(resultado).toBe(`${LITE}#2`);
    expect(llamadas).toEqual([...seis(FLASH), `${LITE}@k1`, `${LITE}@k2`]);
  });

  it("503 en Flash-Lite: pasa a NVIDIA sin probar las demás claves de Flash-Lite", async () => {
    const { resultado, llamadas } = await correr(config(), (m) => (m === LITE ? 503 : m === FLASH ? 429 : "ok"));
    expect(resultado).toBe(NVIDIA);
    expect(llamadas).toEqual([...seis(FLASH), `${LITE}@k1`, `${NVIDIA}@nv`]);
  });

  it("503 en Flash y en Flash-Lite: va directo a NVIDIA", async () => {
    const { resultado, llamadas } = await correr(config(), (m) => (m === NVIDIA ? "ok" : 503));
    expect(resultado).toBe(NVIDIA);
    expect(llamadas).toEqual([`${FLASH}@k1`, `${LITE}@k1`, `${NVIDIA}@nv`]);
  });

  it("GEMINI_MODEL_RESPALDO vacío: no hay respaldo (Flash agotado pasa directo a NVIDIA)", async () => {
    const cfg = config({ geminiModeloRespaldo: "" });
    expect(modelosConfigurados(cfg, simular(() => "ok").clientes).map((m) => m.nombre)).toEqual([
      ...[1, 2, 3, 4, 5, 6].map((n) => `${FLASH}#${n}`),
      NVIDIA,
    ]);
    const { resultado, llamadas } = await correr(cfg, (m) => (m === FLASH ? 429 : "ok"));
    expect(resultado).toBe(NVIDIA);
    expect(llamadas).toEqual([...seis(FLASH), `${NVIDIA}@nv`]);
    expect(llamadas.some((l) => l.startsWith(LITE))).toBe(false);
  });

  it("todo agotado: el error trae el motivo de cada modelo", async () => {
    const { resultado } = await correr(config({ geminiApiKeys: ["k1", "k2"], nvidiaApiKey: "" }), () => 429);
    expect(resultado).toBeInstanceOf(ErrorExtraccion);
    expect((resultado as Error).message).toMatch(new RegExp(`${FLASH}#1: .*HTTP 429.*${LITE}#2: .*HTTP 429`));
  });
});
