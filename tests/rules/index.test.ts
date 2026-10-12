import { describe, expect, it } from "vitest";
import { CUENTAS_DESTINO, REGLAS } from "../../src/config.js";
import type { EvaluacionBanco } from "../../src/extraction/banco-emisor.js";
import type { DatosExtraidos } from "../../src/extraction/schema.js";
import { normalizarDatos } from "../../src/normalize/index.js";
import {
  buscarCuentasDestino,
  buscarCuentasParecidas,
  cuentasDelBancoDestino,
  cuentasDelBeneficiario,
  evaluarReglas,
  MENSAJES,
  type EntradaReglas,
  type ResultadoReglas,
} from "../../src/rules/index.js";
import type { RegistroUsado } from "../../src/storage/usados.js";
import type { ClaveBanco } from "../../src/types.js";
import { datosEjemplo } from "../extraction/datos.js";
import { registro } from "../helpers/registros.js";

/** 08-oct-2026 23:39 en CDMX = 09-oct-2026 05:39 UTC. */
const AHORA = new Date("2026-10-09T05:39:00Z");

const bancoSeguro = (banco: ClaveBanco = "SPIN"): EvaluacionBanco => ({
  banco,
  nombreLibre: null,
  suficiente: true,
  senales: { modelo: banco, texto: banco, clave: null, firma: null },
  candidatos: [banco],
  motivo: "prueba",
});

function evaluar(
  cambios: Partial<DatosExtraidos> = {},
  extra: Partial<Omit<EntradaReglas, "datos" | "normalizados">> = {},
): ResultadoReglas {
  const datos = datosEjemplo(cambios);
  return evaluarReglas({
    datos,
    normalizados: normalizarDatos(datos),
    banco: bancoSeguro(),
    usados: [] as RegistroUsado[],
    ahora: AHORA,
    ...extra,
  });
}

const codigo = (r: ResultadoReglas) => (r.aprobado ? "APROBADO" : r.codigo);

describe("Paso A: condiciones del comprobante", () => {
  it("1. no es comprobante", () => {
    const r = evaluar({ esComprobante: false });
    expect(r).toMatchObject({ aprobado: false, codigo: "NO_ES_COMPROBANTE", mensaje: MENSAJES.NO_ES_COMPROBANTE });
  });

  it("2. faltan datos: indica cuáles (la fecha ya no es obligatoria)", () => {
    const r = evaluar({ monto: null, fecha: null, claveRastreo: null, referencia: null });
    expect(r).toMatchObject({
      codigo: "DATOS_INSUFICIENTES",
      faltantes: ["el monto", "la clave de rastreo o el número de referencia"],
      mensaje: "Datos insuficientes: no se pudo leer el monto y la clave de rastreo o el número de referencia.",
    });
  });

  it("2. sin fecha: se aprueba y se buscará de hoy hacia atrás", () => {
    const r = evaluar({ fecha: null });
    expect(r.aprobado).toBe(true);
    expect(r.reglas.find((x) => x.regla === "Datos mínimos")?.detalle).toMatch(/sin fecha/);
  });

  it("2. sin clave ni referencia, pero el banco pone una referencia habitual (BanCoppel, Banorte…): se aprueba", () => {
    const r = evaluar({ claveRastreo: null, referencia: null }, { banco: bancoSeguro("BANCOPPEL") });
    expect(r.aprobado).toBe(true);
    expect(r.reglas.find((x) => x.regla === "Datos mínimos")?.detalle).toMatch(/referencia habitual/);
  });

  it("2. BBVA sin clave ni referencia: datos insuficientes (su referencia cambia según la semana, no se adivina)", () => {
    const r = evaluar({ claveRastreo: null, referencia: null }, { banco: bancoSeguro("BBVA") });
    expect(r).toMatchObject({ codigo: "DATOS_INSUFICIENTES", faltantes: ["la clave de rastreo o el número de referencia"] });
  });

  it("2. basta la referencia si no hay clave (y viceversa)", () => {
    expect(codigo(evaluar({ claveRastreo: null }))).toBe("APROBADO");
    expect(codigo(evaluar({ referencia: null }))).toBe("APROBADO");
  });

  it("2. sin clave ni referencia pero Banorte → Banorte: MISMO_BANCO (no 'datos insuficientes')", () => {
    const r = evaluar({ claveRastreo: null, referencia: null, cuentaDestino: "3306" }, { banco: bancoSeguro("BANORTE") });
    expect(r).toMatchObject({ codigo: "MISMO_BANCO", mensaje: MENSAJES.MISMO_BANCO });
  });

  it("2. sin clave ni referencia y la cuenta no es nuestra: CUENTA_INCORRECTA", () => {
    expect(codigo(evaluar({ claveRastreo: null, referencia: null, cuentaDestino: "574" }))).toBe("CUENTA_INCORRECTA");
  });

  it("2. sin clave ni referencia, de un banco sin referencia habitual: DATOS_INSUFICIENTES, sin preguntas", () => {
    expect(codigo(evaluar({ claveRastreo: null, referencia: null }))).toBe("DATOS_INSUFICIENTES");
    // Aunque no se vea la cuenta, no se pregunta: sin clave no se puede consultar Banxico.
    expect(codigo(evaluar({ claveRastreo: null, referencia: null, cuentaDestino: null }))).toBe("DATOS_INSUFICIENTES");
    const dudoso: EvaluacionBanco = { ...bancoSeguro("SPIN"), suficiente: false };
    expect(codigo(evaluar({ claveRastreo: null, referencia: null, cuentaDestino: "3306" }, { banco: dudoso }))).toBe("DATOS_INSUFICIENTES");
  });

  it("2. sin clave ni referencia y el banco es dudoso pero podría tener referencia habitual: se pregunta el banco", () => {
    const dudoso: EvaluacionBanco = { ...bancoSeguro("BANCOPPEL"), suficiente: false, candidatos: ["BANCOPPEL", "SPIN"] };
    expect(codigo(evaluar({ claveRastreo: null, referencia: null }, { banco: dudoso }))).toBe("REQUIERE_CONFIRMACION_BANCO");
  });

  it("2. una fecha inválida cuenta como sin fecha", () => {
    expect(evaluar({ fecha: "2026-02-30" }).aprobado).toBe(true);
  });
});

describe("Paso B: regla 3, cuenta destino", () => {
  it.each([
    ["072650010004755884", "BANORTE", "clabe"],
    ["884", "BANORTE", "clabe"],
    ["1871", "BANORTE", "tarjeta"],
    ["3306", "BANORTE", "cuenta"],
    ["946", "INBURSA", "clabe"],
    ["57194", "INBURSA", "cuenta"],
    ["6185", "BANAMEX", "clabe"],
    ["8798", "BANAMEX", "tarjeta"],
    ["1618", "BANAMEX", "cuenta"],
    ["9426", "BANCOPPEL", "clabe"],
    ["4988", "BANCOPPEL", "tarjeta"],
    ["4942", "BANCOPPEL", "cuenta"],
  ])("%s → %s (%s) y guarda el número completo", (cuentaDestino, banco, tipo) => {
    const r = evaluar({ cuentaDestino });
    expect(r.aprobado).toBe(true);
    if (r.aprobado) {
      expect(r.coincidencia.cuenta.banco).toBe(banco);
      expect(r.coincidencia.tipo).toBe(tipo);
      expect(r.coincidencia.numero.endsWith(cuentaDestino)).toBe(true);
    }
  });

  it("sin coincidencia → CUENTA_INCORRECTA con el mensaje exacto", () => {
    for (const cuentaDestino of ["574", "012180001234567890", "4658280004936574"]) {
      expect(evaluar({ cuentaDestino })).toMatchObject({ codigo: "CUENTA_INCORRECTA", mensaje: MENSAJES.CUENTA_INCORRECTA });
    }
  });

  it("una CLABE completa debe coincidir entera, no solo la terminación", () => {
    expect(codigo(evaluar({ cuentaDestino: "999650010004755884" }))).toBe("CUENTA_INCORRECTA");
  });

  it("sin dígitos, pero con el banco destino: nuestra cuenta de ese banco, y se prueban todos sus números", () => {
    const r = evaluar({ cuentaDestino: null, bancoDestino: "Banorte" });
    expect(r).toMatchObject({ aprobado: true, cuentaDeducida: true, coincidencia: { cuenta: { banco: "BANORTE" }, tipo: "tarjeta" } });
  });

  it("sin dígitos, pero la referencia son los últimos 7 de una cuenta nuestra (Azteca): esa cuenta", () => {
    const r = evaluar({ cuentaDestino: null, referencia: "7841871" });
    expect(r).toMatchObject({
      aprobado: true,
      cuentaDeducida: true,
      coincidencia: { tipo: "tarjeta", numero: "4189143097841871" },
    });
  });

  it("terminación de varias cuentas, pero con el banco destino: la de ese banco", () => {
    const minimo = REGLAS.minDigitosTerminacion;
    REGLAS.minDigitosTerminacion = 1;
    try {
      const r = evaluar({ cuentaDestino: "4", bancoDestino: "INBURSA" });
      expect(r).toMatchObject({ aprobado: true, cuentaDeducida: true, coincidencia: { cuenta: { banco: "INBURSA" } } });
    } finally {
      REGLAS.minDigitosTerminacion = minimo;
    }
  });

  it("con la cuenta visible no se deduce nada", () => {
    expect(evaluar({ cuentaDestino: "1871", bancoDestino: "Inbursa" })).toMatchObject({ aprobado: true, cuentaDeducida: false });
  });

  it("sin dígitos y el banco destino es uno donde no tenemos cuenta (BBVA) → cuentas incorrectas, sin preguntar", () => {
    const r = evaluar({ cuentaDestino: null, bancoDestino: "BBVA" });
    expect(r).toMatchObject({ codigo: "CUENTA_INCORRECTA" });
    expect(r.reglas.at(-1)).toMatchObject({ regla: "Cuenta destino", paso: false, detalle: "el banco destino es BBVA, donde no tenemos cuenta" });
  });

  it("sin dígitos y un banco destino que no se reconoce: se pregunta, como antes", () => {
    expect(evaluar({ cuentaDestino: null, bancoDestino: "Cuenta de ahorro" })).toMatchObject({ codigo: "REQUIERE_CONFIRMACION_CUENTA" });
  });

  it("sin dígitos o con menos del mínimo → se pregunta a cuál cuenta", () => {
    for (const cuentaDestino of [null, "84"]) {
      const r = evaluar({ cuentaDestino });
      expect(r).toMatchObject({ codigo: "REQUIERE_CONFIRMACION_CUENTA" });
      expect(!r.aprobado && r.candidatosCuenta).toHaveLength(CUENTAS_DESTINO.length);
    }
  });

  it("coincidencia ambigua → REQUIERE_CONFIRMACION_CUENTA con las candidatas", () => {
    expect(buscarCuentasDestino("4").map((c) => c.cuenta.banco)).toEqual(["BANORTE", "INBURSA"]);
    const minimo = REGLAS.minDigitosTerminacion;
    REGLAS.minDigitosTerminacion = 1;
    try {
      const r = evaluar({ cuentaDestino: "4" });
      expect(r).toMatchObject({ codigo: "REQUIERE_CONFIRMACION_CUENTA" });
      expect(!r.aprobado && r.candidatosCuenta?.map((c) => c.banco)).toEqual(["BANORTE", "INBURSA"]);
    } finally {
      REGLAS.minDigitosTerminacion = minimo;
    }
  });

  it("con la cuenta confirmada por el usuario se prueban todos sus números", () => {
    const r = evaluar({ cuentaDestino: null }, { confirmaciones: { cuentaClabe: "036650500740571946" } });
    expect(r.aprobado && r.coincidencia).toMatchObject({ tipo: "clabe", numero: "036650500740571946", cuenta: { banco: "INBURSA" } });
    expect(r.aprobado && r.cuentaDeducida).toBe(true);
    const banorte = evaluar({ cuentaDestino: null }, { confirmaciones: { cuentaClabe: "072650010004755884" } });
    expect(banorte.aprobado && banorte.coincidencia).toMatchObject({ tipo: "tarjeta", numero: "4189143097841871" });
  });
});

describe("buscarCuentasParecidas: números nuestros que se parecen a una cuenta leída que no coincide (pedido del usuario, 11-oct)", () => {
  /** "BANCO tipo errores" de cada parecida. */
  const parecidas = (leido: string) => buscarCuentasParecidas(leido).map((p) => `${p.cuenta.banco} ${p.tipo} ${p.errores}`);

  it.each([
    ["1874", "BANORTE tarjeta 1", "un dígito mal leído de la tarjeta …1871"],
    ["5883", "BANORTE clabe 1", "un dígito mal leído de la CLABE …5884"],
    ["1617", "BANAMEX cuenta 1", "un dígito mal leído del número de cuenta Banamex 2461618"],
    ["18711", "BANORTE tarjeta 1", "un dígito de más"],
    ["41891871", "BANORTE tarjeta 0", "tarjeta enmascarada en medio (4189 •••• •••• 1871)"],
    ["418914309784", "BANORTE tarjeta 0", "tarjeta recortada por la imagen al final"],
    ["07265001000475588", "BANORTE clabe 0", "CLABE recortada al final (17 dígitos)"],
    ["07265001000475584", "BANORTE clabe 1", "CLABE con un dígito de menos en medio"],
    ["072650010094755834", "BANORTE clabe 2", "CLABE completa con 2 dígitos mal leídos"],
  ])("%s → %s (%s)", (leido, esperada) => {
    expect(parecidas(leido)).toEqual([esperada]);
  });

  it("se parece a dos números (…4948: tarjeta …4988 y cuenta …4942 de BanCoppel): los dos", () => {
    expect(parecidas("4948")).toEqual(["BANCOPPEL tarjeta 1", "BANCOPPEL cuenta 1"]);
  });

  it.each([
    ["8852", "BanCoppel de otra persona (carpeta 8)"],
    ["9151", "Banamex de otra persona (Varios)"],
    ["002180701849395151", "CLABE Banamex completa de otra persona"],
    ["187", "solo 3 dígitos: no basta para decir que se parece"],
    ["1871", "coincide exacto: no es 'parecida'"],
    ["", "nada leído"],
  ])("%s → ninguna (%s)", (leido) => {
    expect(buscarCuentasParecidas(leido)).toEqual([]);
  });

  it("de la más parecida a la menos", () => {
    const errores = buscarCuentasParecidas("072650010094755834").map((p) => p.errores);
    expect(errores).toEqual([...errores].sort((a, b) => a - b));
  });
});

describe("cuentasDelBeneficiario: el nombre como pista para buscar más (nunca para rechazar)", () => {
  const bancos = (...nombres: (string | null)[]) => cuentasDelBeneficiario(...nombres).map((c) => c.banco);
  const DE_GABRIEL = ["BANORTE", "BANAMEX", "BANCOPPEL"];

  it.each([
    ["Gabriel Alejandro Fondacaro Rielo", "completo"],
    ["GABRIEL ALEJANDRO FONDACARO RIELO", "en mayúsculas"],
    ["Gabriel Alejandro Fondacaro", "sin el segundo apellido"],
    ["Gabriel Fondacaro R", "con la inicial del segundo apellido"],
    ["GABRIEL F**", "enmascarado: nombre e inicial"],
    ["Gábriel Aléjandro", "con acentos"],
  ])("%s → sus 3 cuentas (%s)", (nombre) => {
    expect(bancos(nombre)).toEqual(DE_GABRIEL);
  });

  it("una empresa: MEXIOFERTAS → Inbursa", () => {
    expect(bancos("MEXIOFERTAS")).toEqual(["INBURSA"]);
    expect(bancos("Mexiofertas SA de CV")).toEqual(["INBURSA"]);
  });

  it.each([
    ["Gabriel", "solo el nombre de pila: hay muchos Gabriel"],
    ["Nicolas A Josid", "otra persona"],
    ["Fernando Gabriel", "otra persona con un nombre en común"],
    [null, "sin nombre"],
  ] as [string | null, string][])("%s → ninguna (%s)", (nombre) => {
    expect(bancos(nombre)).toEqual([]);
  });

  it("basta con que coincida una de las lecturas (la IA o el OCR)", () => {
    expect(bancos("pago de champu", "Gabriel Alejandro Fondacaro")).toEqual(DE_GABRIEL);
  });
});

describe("cuentasDelBancoDestino: dónde buscar en Banxico un pago cuya cuenta visible no es nuestra", () => {
  it("la nuestra del banco destino, si es uno de los nuestros", () => {
    expect(cuentasDelBancoDestino("Banorte").map((c) => c.banco)).toEqual(["BANORTE"]);
    expect(cuentasDelBancoDestino("Cuenta BANORTE").map((c) => c.banco)).toEqual(["BANORTE"]);
    expect(cuentasDelBancoDestino("Citibanamex").map((c) => c.banco)).toEqual(["BANAMEX"]);
  });

  it("ninguna si el comprobante no dice el banco destino o si es otro banco (regla del usuario, 11-oct)", () => {
    expect(cuentasDelBancoDestino(null)).toEqual([]);
    expect(cuentasDelBancoDestino("  ")).toEqual([]);
    expect(cuentasDelBancoDestino("Santander")).toEqual([]);
  });
});

describe("Paso B: regla 4, mismo banco", () => {
  it("emisor igual al destino → MISMO_BANCO", () => {
    const r = evaluar({}, { banco: bancoSeguro("BANORTE") });
    expect(r).toMatchObject({ codigo: "MISMO_BANCO", mensaje: MENSAJES.MISMO_BANCO });
  });

  it("emisor dudoso → REQUIERE_CONFIRMACION_BANCO con candidatos", () => {
    const dudoso: EvaluacionBanco = { ...bancoSeguro(), banco: "SPIN", suficiente: false, candidatos: ["SPIN", "NU"], motivo: "contradicción" };
    const r = evaluar({}, { banco: dudoso });
    expect(r).toMatchObject({ codigo: "REQUIERE_CONFIRMACION_BANCO", candidatosBanco: ["SPIN", "NU"] });
  });

  it("con el banco confirmado por el usuario continúa (y vuelve a revisar mismo banco)", () => {
    const dudoso: EvaluacionBanco = { ...bancoSeguro(), suficiente: false };
    expect(codigo(evaluar({}, { banco: dudoso, confirmaciones: { banco: { clave: "NU", nombreLibre: null } } }))).toBe("APROBADO");
    expect(codigo(evaluar({}, { banco: dudoso, confirmaciones: { banco: { clave: "BANORTE", nombreLibre: null } } }))).toBe(
      "MISMO_BANCO",
    );
  });

  it("un banco fuera del mapa (nombre libre) no es el mismo banco", () => {
    const libre: EvaluacionBanco = { ...bancoSeguro(), banco: null, nombreLibre: "Banco Multiva" };
    const r = evaluar({}, { banco: libre });
    expect(r.aprobado && r.bancoEmisor).toEqual({ clave: null, nombreLibre: "Banco Multiva" });
  });
});

describe("Paso B: regla 5, fecha posterior a hoy (hoy en CDMX)", () => {
  // Ya no se rechaza sin consultar: la búsqueda prueba los días anteriores que ya pasaron y, si no
  // aparece, responde FECHA_FUTURA (pedido del usuario, 11-oct).
  const detalleFecha = (r: ResultadoReglas) => r.reglas.find((x) => x.regla === "Fecha")?.detalle ?? "";

  it("una fecha posterior a hoy se aprueba y se anota que se busca en los días anteriores", () => {
    const r = evaluar({ fecha: "2026-10-12" });
    expect(codigo(r)).toBe("APROBADO");
    expect(detalleFecha(r)).toBe("2026-10-12 es posterior a hoy (2026-10-08): se busca en los días anteriores");
  });

  it("BBVA de noche imprime la fecha del día siguiente: 'mañana' no cuenta como posterior (los demás bancos sí)", () => {
    const bbva = { banco: bancoSeguro("BBVA") };
    expect(detalleFecha(evaluar({ fecha: "2026-10-09", hora: "23:15" }, bbva))).not.toMatch(/posterior/);
    expect(detalleFecha(evaluar({ fecha: "2026-10-09", hora: "12:00" }, bbva))).toMatch(/posterior/);
    expect(detalleFecha(evaluar({ fecha: "2026-10-10", hora: "23:15" }, bbva))).toMatch(/posterior/);
    expect(detalleFecha(evaluar({ fecha: "2026-10-09", hora: "23:15" }))).toMatch(/posterior/);
  });

  it("a las 23:39 de CDMX del 08-oct, el 09-oct es posterior aunque en UTC ya sea 09-oct", () => {
    expect(detalleFecha(evaluar({ fecha: "2026-10-09" }))).toMatch(/posterior/);
    expect(detalleFecha(evaluar({ fecha: "2026-10-08" }))).not.toMatch(/posterior/);
    expect(detalleFecha(evaluar({ fecha: "2026-10-01" }))).not.toMatch(/posterior/);
  });
});

describe("Paso B: regla 6, duplicado", () => {
  it("clave ya validada → DUPLICADO con la fecha de uso en hora de CDMX", () => {
    const r = evaluar({}, { usados: [registro({ validadoEn: "2026-10-08T20:10:00.000Z" })], bloquearDuplicados: true });
    expect(r).toMatchObject({
      codigo: "DUPLICADO",
      mensaje: "Este comprobante ya fue validado el 08/10/2026 a las 14:10 (hora de CDMX).",
    });
  });

  it("misma referencia con otra clave no es duplicado", () => {
    const r = evaluar({}, { usados: [registro({ claveRastreo: "OTRA-CLAVE" })] });
    expect(codigo(r)).toBe("APROBADO");
  });

  it("desactivado (REGLAS.bloquearDuplicados = false, decisión del usuario): un comprobante repetido se aprueba otra vez", () => {
    expect(REGLAS.bloquearDuplicados).toBe(false);
    expect(codigo(evaluar({}, { usados: [registro()] }))).toBe("APROBADO");
  });
});

describe("orden y resultado final", () => {
  it("respeta el orden: la cuenta se revisa antes que el duplicado; la fecha ya no rechaza", () => {
    const r = evaluar({ cuentaDestino: "574", fecha: "2030-01-01" }, { usados: [registro()], bloquearDuplicados: true });
    expect(codigo(r)).toBe("CUENTA_INCORRECTA");
    expect(codigo(evaluar({ fecha: "2030-01-01" }, { usados: [registro()], bloquearDuplicados: true }))).toBe("DUPLICADO");
  });

  it("todo en orden → aprobado, con las 5 reglas (6 si se revisan los duplicados)", () => {
    const cinco = ["Es un comprobante", "Datos mínimos", "Cuenta destino", "Bancos distintos", "Fecha"];
    expect(evaluar({}, { bloquearDuplicados: true }).reglas.map((x) => x.regla)).toEqual([...cinco, "No usado antes"]);
    const r = evaluar();
    expect(r.aprobado).toBe(true);
    if (r.aprobado) {
      expect(r.reglas.map((x) => x.regla)).toEqual(cinco);
      expect(r.reglas.every((x) => x.paso)).toBe(true);
      expect(r.coincidencia.numero).toBe("072650010004755884");
      expect(r.bancoEmisor).toEqual({ clave: "SPIN", nombreLibre: null });
    }
  });
});

describe("referencia semanal aprendida (BBVA)", () => {
  it("BBVA sin clave ni referencia, pero con la de esta semana aprendida: se aprueba", () => {
    const r = evaluar(
      { claveRastreo: null, referencia: null },
      { banco: bancoSeguro("BBVA"), referenciasAprendidas: (banco) => (banco === "BBVA" ? "2309260" : null) },
    );
    expect(r.aprobado).toBe(true);
  });
});
