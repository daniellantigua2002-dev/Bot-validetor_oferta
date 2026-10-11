import { describe, expect, it } from "vitest";
import {
  AYUDA,
  avisoPreguntaPendiente,
  avisoUnaFotoALaVez,
  botonesBanco,
  escapar,
  GUIA_GRUPO,
  textoEsperaBanxico,
  textoEsperaPagoReciente,
  textoPlano,
  reaccionPara,
  renderizarProgreso,
  respuestaFinal,
  resumenIntentos,
  textoEnCola,
  textoValidado,
} from "../../src/bot/mensajes.js";
import { CUENTAS_DESTINO } from "../../src/config.js";
import { MENSAJES } from "../../src/rules/index.js";
import type { ResultadoValidacion } from "../../src/pipeline.js";

const base = (cambios: Partial<ResultadoValidacion>): ResultadoValidacion => ({
  codigo: "NO_ENCONTRADO",
  mensaje: "",
  reglas: [],
  intentos: [],
  tiempos: {},
  normalizados: {
    claveRastreo: "SPIN-20261008200443959PNEB9",
    origenClave: "comprobante",
    origenReferencia: "comprobante",
    referencia: "7454748",
    monto: "1352.00",
    fecha: "2026-10-08",
    fechaBanxico: "08-10-2026",
    hora: "14:04:43",
    cuentaDestino: "884",
  },
  ...cambios,
});

const PAGO = {
  estado: "LIQUIDADO" as const,
  referencia: "7454748",
  claveRastreo: "SPIN-20261008200443959PNEB9",
  emisor: "SPIN BY OXXO",
  receptor: "BANORTE",
  cuentaBeneficiaria: "072650010004755884",
  monto: "1352.00",
  fechaRecepcion: "08/10/2026 14:04:47",
  fechaProcesamiento: "08/10/2026 14:04:48",
};

describe("respuestaFinal", () => {
  it("validado: solo la foto de Banxico y el aviso con el nombre de quien lo envió", () => {
    const r = respuestaFinal(base({ codigo: "VALIDADO", pago: PAGO, captura: { ruta: "data/capturas/x.png", metodo: "local" } }), "", "Daniel");
    expect(r).toEqual({ foto: "data/capturas/x.png", texto: "✅ Daniel, su comprobante fue validado." });
  });

  it("validado sin nombre de Telegram (y el nombre se escapa)", () => {
    expect(textoValidado()).toBe("✅ Su comprobante fue validado.");
    expect(textoValidado("  ")).toBe("✅ Su comprobante fue validado.");
    expect(textoValidado("<Dani>")).toBe("✅ &lt;Dani&gt;, su comprobante fue validado.");
  });

  it("validado sin foto: avisa por qué", () => {
    const r = respuestaFinal(base({ codigo: "VALIDADO", pago: PAGO, errorCaptura: "sin navegador" }), "", "Daniel");
    expect(r.foto).toBeUndefined();
    expect(r.texto).toContain("✅ Daniel, su comprobante fue validado.");
    expect(r.texto).toContain("No se pudo generar la captura: sin navegador");
  });

  it.each([
    ["CUENTA_INCORRECTA", MENSAJES.CUENTA_INCORRECTA, "❌"],
    ["MISMO_BANCO", MENSAJES.MISMO_BANCO, "✅"],
    ["NO_ES_COMPROBANTE", MENSAJES.NO_ES_COMPROBANTE, "❌"],
    ["DATOS_INSUFICIENTES", "Datos insuficientes: no se pudo leer el monto.", "❌"],
    ["MONTO_NO_COINCIDE", "El monto no coincide", "❌"],
    ["FECHA_FUTURA", MENSAJES.FECHA_FUTURA, "⏳"],
    ["DUPLICADO", "Este comprobante ya fue validado el 08/10/2026 a las 14:10 (hora de CDMX).", "⚠️"],
    ["BANXICO_NO_DISPONIBLE", "Banxico está limitando las consultas", "⚠️"],
  ] as const)("%s → %s %s", (codigo, mensaje, icono) => {
    const r = respuestaFinal(base({ codigo, mensaje }));
    expect(r.texto.startsWith(`${icono} ${escapar(mensaje)}`)).toBe(true);
    expect(r.botones).toBeUndefined();
  });

  it("no encontrado: el resumen de fechas y consultas, sin la lista de intentos (esa queda en la consola)", () => {
    const intentos: ResultadoValidacion["intentos"] = [
      { fecha: "08-10-2026", criterio: "CLAVE_RASTREO", valorCriterio: "X", cuenta: "072650010004755884", emisor: "A", receptor: "B", resultado: "NO_ENCONTRADO" },
      { fecha: "08-10-2026", criterio: "CLAVE_RASTREO", valorCriterio: "X", cuenta: "", emisor: "A", receptor: "B", resultado: "NO_ENCONTRADO", sondeo: "SIN_CUENTA_NI_MONTO" },
      { fecha: "08-10-2026", criterio: "REFERENCIA", valorCriterio: "1", cuenta: "072650010004755884", emisor: "A", receptor: "B", resultado: "NO_ENCONTRADO" },
    ];
    const mensaje = "No se encontró el pago en Banxico: busqué el 08/10/2026 (3 consultas).";
    const r = respuestaFinal(base({ codigo: "NO_ENCONTRADO", mensaje, intentos }));
    expect(r.texto.startsWith(`🔍 ${mensaje}`)).toBe(true);
    expect(r.texto).not.toContain("Intentos realizados");
    expect(resumenIntentos({ intentos })).toBe(
      "• 08-10-2026 · clave · …5884 → no encontrado\n• 08-10-2026 · clave (solo clave) → no encontrado\n• 08-10-2026 · referencia · …5884 → no encontrado",
    );
  });

  it("no encontrado sin fecha ni clave/referencia en el comprobante: sugiere escribirlas en la nota", () => {
    const sinDatos = base({ codigo: "NO_ENCONTRADO", mensaje: "No se encontró el pago." });
    sinDatos.normalizados = { ...sinDatos.normalizados!, fecha: null, fechaBanxico: null, claveRastreo: null, referencia: null };
    const r = respuestaFinal(sinDatos);
    expect(r.texto).toContain("💡 El comprobante no muestra la fecha ni la clave de rastreo ni la referencia.");
    expect(r.texto).toContain("<code>fecha 09/10/2026, ref 1234567</code>");
  });

  it("no encontrado con todos los datos: sugiere revisar la fecha (y la clave si Banxico no la tiene), salvo que la nota ya traiga una", () => {
    const ejemplo = "<code>fecha 09/10/2026</code>";
    expect(respuestaFinal(base({ codigo: "NO_ENCONTRADO", mensaje: "x" })).texto).toContain(
      `💡 Si la fecha del pago es otra, reenvía la foto escribiéndola en la nota, por ejemplo: ${ejemplo}`,
    );
    expect(respuestaFinal(base({ codigo: "NO_ENCONTRADO", mensaje: "x", claveInexistente: true })).texto).toContain(
      `💡 Revisa la fecha y la clave de rastreo del comprobante. Si la fecha del pago es otra, reenvía la foto escribiéndola en la nota, por ejemplo: ${ejemplo}`,
    );
    const nota = { datos: { fecha: "2026-10-03" }, entendidos: ["fecha 03/10/2026"], noEntendidos: [] };
    expect(respuestaFinal(base({ codigo: "NO_ENCONTRADO", mensaje: "x" }), "", undefined, nota).texto).not.toContain("💡");
  });

  it("devuelto: el aviso de siempre y además la foto de la tabla de Banxico", () => {
    const pago = { ...PAGO, estado: "DEVUELTO" as const };
    const mensaje = 'El pago existe en Banxico pero su estado es "Devuelto".';
    const r = respuestaFinal(base({ codigo: "NO_LIQUIDADO", mensaje, pago, captura: { ruta: "data/capturas/d.png", metodo: "local" } }));
    expect(r).toEqual({ texto: `❌ ${mensaje}`, foto: "data/capturas/d.png" });
    // Si no se pudo dibujar la captura, solo el aviso.
    expect(respuestaFinal(base({ codigo: "NO_LIQUIDADO", mensaje, pago }))).toEqual({ texto: `❌ ${mensaje}` });
  });

  it("pregunta de banco: los candidatos primero, sin bancos pendientes y con Cancelar", () => {
    const r = respuestaFinal(base({ codigo: "REQUIERE_CONFIRMACION_BANCO", mensaje: MENSAJES.REQUIERE_CONFIRMACION_BANCO, candidatosBanco: ["NU", "SPIN"] }), "abc123");
    const botones = r.botones!.flat();
    expect(botones[0]).toEqual({ texto: "⭐ Nu México", datos: "b:abc123:NU" });
    expect(botones[1]).toEqual({ texto: "⭐ Spin by OXXO", datos: "b:abc123:SPIN" });
    expect(botones.some((b) => b.datos.endsWith(":STORI") || b.datos.endsWith(":OPENBANK"))).toBe(false);
    expect(botones.at(-1)).toEqual({ texto: "✖️ Cancelar", datos: "x:abc123" });
    expect(botones.every((b) => Buffer.byteLength(b.datos) <= 64)).toBe(true);
    expect(r.texto).toContain("$1,352.00");
  });

  it("pregunta de cuenta: un botón por cuenta candidata", () => {
    const r = respuestaFinal(
      base({ codigo: "REQUIERE_CONFIRMACION_CUENTA", mensaje: MENSAJES.REQUIERE_CONFIRMACION_CUENTA, candidatosCuenta: [CUENTAS_DESTINO[0], CUENTAS_DESTINO[1]] }),
      "id1",
    );
    expect(r.botones!.flat()).toEqual([
      { texto: "Banorte …5884", datos: "k:id1:0" },
      { texto: "Inbursa …1946", datos: "k:id1:1" },
      { texto: "✖️ Cancelar", datos: "x:id1" },
    ]);
  });

  it("escapa el HTML de los mensajes", () => {
    expect(escapar("<b>&</b>")).toBe("&lt;b&gt;&amp;&lt;/b&gt;");
    expect(respuestaFinal(base({ codigo: "CUENTA_INCORRECTA", mensaje: "a<b" })).texto).toBe("❌ a&lt;b");
  });
});

describe("reacción sobre el comprobante", () => {
  it("👍 si se validó o si es del mismo banco (comprobante legítimo que no pasa por SPEI)", () => {
    expect(reaccionPara("VALIDADO")).toBe("👍");
    expect(reaccionPara("MISMO_BANCO")).toBe("👍");
  });

  it.each([
    "CUENTA_INCORRECTA", "NO_ES_COMPROBANTE", "DATOS_INSUFICIENTES", "MONTO_NO_COINCIDE",
    "NO_ENCONTRADO", "DUPLICADO", "NO_LIQUIDADO", "FECHA_FUTURA", "COMPROBANTE_NOCTURNO", "BANXICO_NO_DISPONIBLE",
  ] as const)("👎 si no se validó: %s", (codigo) => {
    expect(reaccionPara(codigo)).toBe("👎");
  });

  it("sin reacción mientras espera que elijan banco o cuenta", () => {
    expect(reaccionPara("REQUIERE_CONFIRMACION_BANCO")).toBeNull();
    expect(reaccionPara("REQUIERE_CONFIRMACION_CUENTA")).toBeNull();
  });
});

describe("mensaje de progreso animado", () => {
  it("pasos hechos ✅, paso actual con el reloj, pendientes ▫️, barra y tiempo", () => {
    const texto = renderizarProgreso({ etapa: "BANXICO", consulta: 1, cuadro: 2, porcentaje: 60, segundos: 9 });
    expect(texto).toBe(
      [
        "🔎 <b>Validando tu comprobante</b>",
        "",
        "✅ Imagen recibida",
        "✅ Leyendo los datos de la imagen",
        "✅ Revisando cuenta, banco y fecha",
        "🕒 <b>Consultando Banxico…</b>",
        "▫️ Generando la captura",
        "",
        "▰▰▰▰▰▰▱▱▱▱ 60%  ·  ⏱ 9 s",
      ].join("\n"),
    );
  });

  it("el reloj gira con cada cuadro y muestra el número de consulta", () => {
    const a = renderizarProgreso({ etapa: "LEYENDO", cuadro: 0, porcentaje: 10, segundos: 1 });
    const b = renderizarProgreso({ etapa: "LEYENDO", cuadro: 1, porcentaje: 10, segundos: 1 });
    expect(a).toContain("🕐 <b>Leyendo los datos de la imagen…</b>");
    expect(b).toContain("🕑 <b>Leyendo los datos de la imagen…</b>");
    expect(renderizarProgreso({ etapa: "BANXICO", consulta: 3, cuadro: 0, porcentaje: 70, segundos: 20 })).toContain(
      "Consultando Banxico (consulta 3)…",
    );
  });

  it("aviso de cola", () => {
    expect(textoEnCola(1)).toContain("Hay 1 comprobante antes que este");
    expect(textoEnCola(3)).toContain("Hay 3 comprobantes antes que este");
  });
});

describe("botones", () => {

  it("botonesBanco sin candidatos ofrece todos los bancos consultables", () => {
    const datos = botonesBanco("z").flat().map((b) => b.datos);
    expect(datos).toContain("b:z:BBVA");
    expect(datos).toContain("b:z:MERCADO_PAGO");
    expect(datos.at(-1)).toBe("x:z");
  });
});

describe("avisos de una foto a la vez", () => {
  it("dice que se acepta una foto a la vez, con el nombre escapado", () => {
    expect(avisoUnaFotoALaVez("Ana <b>")).toContain("Ana &lt;b&gt;, se acepta <b>una foto a la vez</b>");
    expect(avisoUnaFotoALaVez()).toMatch(/^⏳ Se acepta <b>una foto a la vez<\/b>/);
  });

  it("pide responder o cancelar la pregunta pendiente", () => {
    expect(avisoPreguntaPendiente("Ana")).toContain("Ana, primero responde la pregunta de tu comprobante anterior");
    expect(avisoPreguntaPendiente()).toContain("<b>Cancelar</b>");
  });
});

describe("respuesta con la nota de la foto", () => {
  const base = { reglas: [], intentos: [], tiempos: {} };
  const nota = { datos: { fecha: "2026-10-09" }, entendidos: ["fecha 09/10/2026"], noEntendidos: ["mont 400"] };
  const captura = { ruta: "data/capturas/x.png", metodo: "local" as const };

  it("validado: solo agrega el aviso si la nota contradice la imagen", () => {
    const sinDiferencias = respuestaFinal({ ...base, codigo: "VALIDADO", mensaje: "", captura }, "", "Ana", nota);
    expect(sinDiferencias.texto).toBe("✅ Ana, su comprobante fue validado.");

    const extraccion = {
      datos: {} as never,
      origen: "nvidia" as const,
      textoOcr: null,
      banco: {} as never,
      notaAplicada: { diferencias: [{ campo: "monto" as const, nota: "$500.00", imagen: "$400.00" }] },
    };
    const conDiferencia = respuestaFinal({ ...base, codigo: "VALIDADO", mensaje: "", captura, extraccion }, "", "Ana", nota);
    expect(conDiferencia.texto).toBe(
      "✅ Ana, su comprobante fue validado.\n\n⚠️ El monto de tu nota ($500.00) no coincide con la imagen ($400.00).",
    );
  });

  it("no validado: dice qué usó de la nota y qué no entendió", () => {
    const r = respuestaFinal({ ...base, codigo: "NO_ENCONTRADO", mensaje: "No se encontró" }, "", "Ana", nota);
    expect(r.texto).toContain("📝 De tu nota usé: fecha 09/10/2026.");
    expect(r.texto).toContain("❔ No entendí de tu nota: «mont 400».");
  });

  it("datos insuficientes: sugiere la nota con lo que falta", () => {
    const r = respuestaFinal({ ...base, codigo: "DATOS_INSUFICIENTES", mensaje: "Datos insuficientes", faltantes: ["la fecha", "el monto"] });
    expect(r.texto).toContain("💡 Reenvía la foto escribiendo en la nota lo que falta, por ejemplo: <code>fecha 09/10/2026, monto 400</code>");
  });

  it("la ayuda explica la nota y sus palabras clave", () => {
    expect(AYUDA).toContain("<code>fecha 09/10/2026, ref 2309260, banco BBVA</code>");
    expect(AYUDA).toContain("fecha, monto, clave, ref, banco, cuenta");
  });
});

describe("guía fijada en el grupo y avisos de espera", () => {
  it("la guía trae las seis palabras de la nota y un ejemplo", () => {
    for (const palabra of ["fecha", "monto", "clave", "ref", "banco", "cuenta"]) expect(GUIA_GRUPO).toContain(`<code>${palabra} `);
    expect(GUIA_GRUPO).toContain("Ejemplo: <code>fecha 09/10/2026, ref 1234567, banco BBVA</code>");
  });

  it("textoPlano: lo que muestra Telegram del mensaje (para saber si la guía ya está fijada)", () => {
    expect(textoPlano("<b>Hola</b> &lt;1&gt; <code>ref 1</code>")).toBe("Hola <1> ref 1");
    expect(textoPlano(GUIA_GRUPO)).not.toMatch(/<\/?(b|code)>/);
  });

  it("avisos de espera con la hora del siguiente intento", () => {
    expect(textoEsperaPagoReciente("17:45", 1, 2)).toContain("a las <b>17:45</b> (revisión 1 de 2)");
    expect(textoEsperaBanxico("17:45")).toContain("o antes si Banxico vuelve");
  });
});
