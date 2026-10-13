import { describe, expect, it } from "vitest";
import type { ConsultaBanxico } from "../src/banxico/cliente.js";
import { cuentasAIntentar, type EntradaBusqueda, type ResultadoBusqueda } from "../src/banxico/reintentos.js";
import type { EvaluacionBanco } from "../src/extraction/banco-emisor.js";
import type { ResultadoExtraccion } from "../src/extraction/index.js";
import type { DatosExtraidos } from "../src/extraction/schema.js";
import {
  completarConOcr,
  fechasAlternativas,
  montosAlternativos,
  otrosEmisores,
  validarComprobante,
  type DependenciasPipeline,
  type Progreso,
} from "../src/pipeline.js";
import { MENSAJES } from "../src/rules/index.js";
import type { RegistroUsado } from "../src/storage/usados.js";
import type { IntentoBanxico } from "../src/types.js";
import { datosEjemplo } from "./extraction/datos.js";
import { TEXTO_KLAR, TEXTO_SPIN } from "./extraction/textos-ocr.js";

const AHORA = new Date("2026-10-09T18:00:00Z");
const CLAVE_REAL = "SPIN-20261008200443959PNEB9";

const CONSULTA: ConsultaBanxico = {
  tipoCriterio: "R",
  fecha: "08-10-2026",
  criterio: "7454748",
  emisor: { codigo: "90728", nombre: "SPIN BY OXXO" },
  receptor: { codigo: "40072", nombre: "BANORTE" },
  cuenta: "072650010004755884",
  monto: "400.00",
  tipoConsulta: 0,
};

const VALIDADO: ResultadoBusqueda = {
  estado: "VALIDADO",
  mensaje: "Pago validado en Banxico: Liquidado.",
  intentos: [],
  consulta: CONSULTA,
  html: "<table id='xxx'></table>",
  pago: {
    estado: "LIQUIDADO",
    referencia: "7454748",
    claveRastreo: CLAVE_REAL,
    emisor: "SPIN BY OXXO",
    receptor: "BANORTE",
    cuentaBeneficiaria: "072650010004755884",
    monto: "400.00",
    fechaRecepcion: "08/10/2026 14:04:47",
    fechaProcesamiento: "08/10/2026 14:04:48",
  },
};

const NO_ENCONTRADO: ResultadoBusqueda = { estado: "NO_ENCONTRADO", mensaje: "No se encontró", intentos: [], consultadas: ["k-ocr"] };

const bancoSpin: EvaluacionBanco = {
  banco: "SPIN",
  nombreLibre: null,
  suficiente: true,
  senales: { modelo: "SPIN", texto: "SPIN", clave: "SPIN", firma: null },
  candidatos: ["SPIN"],
  motivo: "prueba",
};

const extraccion = (cambios: Partial<DatosExtraidos> = {}): ResultadoExtraccion => ({
  datos: datosEjemplo(cambios),
  origen: "nvidia",
  textoOcr: null,
  banco: bancoSpin,
});

const NUNCA = new Promise<never>(() => undefined);

interface OpcionesFalsas {
  /** Respuestas de buscar, en orden (la última se repite). */
  busquedas?: ResultadoBusqueda[];
  lecturas?: RegistroUsado[][];
  capturaFalla?: boolean;
  datos?: Partial<DatosExtraidos>;
  /** Texto del OCR (null = el OCR falla). Por defecto falla, para probar la ruta normal. */
  ocr?: string | null;
  /** La IA nunca termina (para comprobar que la ruta rápida no la espera). */
  iaNuncaTermina?: boolean;
}

/** Dependencias simuladas que registran lo que se les pidió. */
function falsas(opciones: OpcionesFalsas = {}) {
  const llamadas = { completa: 0, busquedas: [] as EntradaBusqueda[], capturas: [] as string[], registros: [] as RegistroUsado[] };
  const lecturas = [...(opciones.lecturas ?? [])];
  const busquedas = [...(opciones.busquedas ?? [VALIDADO])];
  const deps: DependenciasPipeline = {
    iniciarExtraccion: () => ({
      ocr: opciones.ocr ? Promise.resolve(opciones.ocr) : Promise.reject(new Error("sin OCR")),
      get completa() {
        llamadas.completa++;
        return opciones.iaNuncaTermina ? NUNCA : Promise.resolve(extraccion(opciones.datos));
      },
    }),
    buscar: async (entrada) => {
      llamadas.busquedas.push(entrada);
      return busquedas.length > 1 ? busquedas.shift()! : busquedas[0]!;
    },
    capturar: async (_consulta, base) => {
      if (opciones.capturaFalla) throw new Error("sin navegador");
      llamadas.capturas.push(base);
      return { ruta: `data/capturas/${base}.png`, metodo: "local" };
    },
    almacen: {
      leer: async () => lecturas.shift() ?? [...llamadas.registros],
      registrar: async (r) => {
        llamadas.registros.push(r);
      },
    },
  };
  return { deps, llamadas };
}

const imagen = Buffer.from("imagen");

describe("validarComprobante: ruta normal", () => {
  it("validado: registra la clave REAL de Banxico y genera la foto", async () => {
    const { deps, llamadas } = falsas({ datos: { claveRastreo: "SPIN-2026100820O443959PNEB9" } });
    const progreso: Progreso[] = [];
    const r = await validarComprobante(imagen, { usuario: "123", ahora: AHORA, alProgreso: (p) => progreso.push(p) }, deps);

    expect(r).toMatchObject({ codigo: "VALIDADO", ruta: "normal", captura: { ruta: `data/capturas/2026-10-08_${CLAVE_REAL}.png` } });
    expect(llamadas.registros).toEqual([
      expect.objectContaining({
        claveRastreo: CLAVE_REAL,
        referencia: "7454748",
        monto: "400.00",
        fecha: "2026-10-08",
        cuenta: "072650010004755884",
        emisor: "SPIN BY OXXO",
        usuario: "123",
      }),
    ]);
    expect(progreso.map((p) => p.etapa)).toEqual(["LEYENDO", "REGLAS", "BANXICO", "CAPTURA"]);
    expect(r.tiempos.total).toBeGreaterThanOrEqual(0);
  });

  it("rechazo por reglas (cuenta ajena y sin clave de rastreo): no consulta Banxico ni registra", async () => {
    const { deps, llamadas } = falsas({ datos: { cuentaDestino: "574", claveRastreo: null } });
    const r = await validarComprobante(imagen, { usuario: "123", ahora: AHORA }, deps);
    expect(r.codigo).toBe("CUENTA_INCORRECTA");
    expect(llamadas.busquedas).toHaveLength(0);
    expect(llamadas.registros).toEqual([]);
  });

  it("no encontrado: devuelve los intentos y no registra", async () => {
    const intentos = [{ fecha: "08-10-2026", criterio: "CLAVE_RASTREO" as const, valorCriterio: "X", cuenta: "1", emisor: "A", receptor: "B", resultado: "NO_ENCONTRADO" as const }];
    const { deps, llamadas } = falsas({ busquedas: [{ estado: "NO_ENCONTRADO", mensaje: "No se encontró", intentos }] });
    const r = await validarComprobante(imagen, { usuario: "123", ahora: AHORA }, deps);
    expect(r).toMatchObject({ codigo: "NO_ENCONTRADO", intentos });
    expect(llamadas.registros).toEqual([]);
  });

  const DEVUELTO: ResultadoBusqueda = {
    ...VALIDADO,
    estado: "NO_LIQUIDADO",
    mensaje: 'El pago existe en Banxico pero su estado es "Devuelto".',
    pago: { ...VALIDADO.pago!, estado: "DEVUELTO" },
  };

  it("devuelto: NO_LIQUIDADO con la foto de la tabla de Banxico (para ver la devolución) y sin registrar", async () => {
    const { deps, llamadas } = falsas({ busquedas: [DEVUELTO] });
    const progreso: Progreso[] = [];
    const r = await validarComprobante(imagen, { usuario: "123", ahora: AHORA, alProgreso: (p) => progreso.push(p) }, deps);
    expect(r).toMatchObject({ codigo: "NO_LIQUIDADO", mensaje: DEVUELTO.mensaje, captura: { ruta: `data/capturas/2026-10-08_${CLAVE_REAL}_devuelto.png` } });
    expect(llamadas.registros).toEqual([]);
    // Sin clave en el progreso: no es un pago registrado.
    expect(progreso.at(-1)).toEqual({ etapa: "CAPTURA" });
  });

  it("devuelto y la foto falla: queda el aviso de siempre", async () => {
    const { deps } = falsas({ busquedas: [DEVUELTO], capturaFalla: true });
    const r = await validarComprobante(imagen, { usuario: "123", ahora: AHORA }, deps);
    expect(r).toMatchObject({ codigo: "NO_LIQUIDADO", errorCaptura: "sin navegador" });
    expect(r.captura).toBeUndefined();
  });

  it("otro estado que no es una devolución (en proceso): solo el aviso, sin foto", async () => {
    const enProceso: ResultadoBusqueda = { ...DEVUELTO, pago: { ...VALIDADO.pago!, estado: "EN_PROCESO" } };
    const { deps, llamadas } = falsas({ busquedas: [enProceso] });
    const r = await validarComprobante(imagen, { usuario: "123", ahora: AHORA }, deps);
    expect(r.codigo).toBe("NO_LIQUIDADO");
    expect(llamadas.capturas).toEqual([]);
  });

  it("una fecha posterior a hoy ya no se rechaza sin consultar: se busca en Banxico", async () => {
    const { deps, llamadas } = falsas({ datos: { fecha: "2026-10-11" } });
    const r = await validarComprobante(imagen, { usuario: "123", ahora: AHORA }, deps);
    expect(llamadas.busquedas).toHaveLength(1);
    expect(r.codigo).toBe("VALIDADO");
  });

  it("pasa a la búsqueda las otras fechas posibles y el tiempo máximo", async () => {
    const { deps, llamadas } = falsas();
    await validarComprobante(imagen, { usuario: "123", ahora: AHORA, nota: { fecha: "2026-10-05" }, limite: 123_456 }, deps);
    // La nota manda; la fecha de la imagen (08-oct) queda como otra fecha posible.
    expect(llamadas.busquedas[0]).toMatchObject({ fechasAlternativas: ["2026-10-08"], limite: 123_456 });
    expect(llamadas.busquedas[0]!.normalizados.fecha).toBe("2026-10-05");
  });

  it("--sin-registro: valida pero no guarda en usados", async () => {
    const { deps, llamadas } = falsas();
    const r = await validarComprobante(imagen, { usuario: "cli", ahora: AHORA, registrar: false }, deps);
    expect(r.codigo).toBe("VALIDADO");
    expect(llamadas.registros).toEqual([]);
  });

  it("si la foto falla el pago sigue validado (y registrado)", async () => {
    const { deps, llamadas } = falsas({ capturaFalla: true });
    const r = await validarComprobante(imagen, { usuario: "123", ahora: AHORA }, deps);
    expect(r).toMatchObject({ codigo: "VALIDADO", errorCaptura: "sin navegador" });
    expect(r.captura).toBeUndefined();
    expect(llamadas.registros).toHaveLength(1);
  });

  it("si otra validación registró la misma clave mientras tanto → DUPLICADO", async () => {
    const previo = { claveRastreo: CLAVE_REAL, referencia: null, monto: "400.00", fecha: "2026-10-08", cuenta: null, emisor: null, usuario: "otro", validadoEn: "2026-10-09T17:59:00.000Z" };
    const { deps, llamadas } = falsas({ lecturas: [[], [previo]] });
    const r = await validarComprobante(imagen, { usuario: "123", ahora: AHORA }, deps);
    expect(r.codigo).toBe("DUPLICADO");
    expect(llamadas.registros).toEqual([]);
  });

  it("al responder una confirmación reutiliza la lectura (no vuelve a leer la imagen)", async () => {
    const { deps, llamadas } = falsas();
    const r = await validarComprobante(
      null,
      { usuario: "123", ahora: AHORA, extraccion: extraccion({ cuentaDestino: null }), confirmaciones: { cuentaClabe: "072650010004755884" } },
      deps,
    );
    expect(r.codigo).toBe("VALIDADO");
    expect(llamadas.completa).toBe(0);
  });
});

describe("fechasAlternativas", () => {
  it("la del OCR si no coincide con la de la IA (una de las dos se leyó mal)", () => {
    const e = { ...extraccion({ fecha: "2026-10-07" }), textoOcr: TEXTO_SPIN }; // el OCR lee 08-oct
    expect(fechasAlternativas(e, "2026-10-07")).toEqual(["2026-10-08"]);
    expect(fechasAlternativas(e, "2026-10-08")).toEqual([]);
    // Si la IA falló y solo leyó el OCR, no hay segunda lectura.
    expect(fechasAlternativas({ ...e, origen: "ocr" }, "2026-10-07")).toEqual([]);
  });

  it("la de la imagen si la nota trae otra", () => {
    const e = { ...extraccion(), notaAplicada: { diferencias: [], fechaImagen: "2026-10-08" } };
    expect(fechasAlternativas(e, "2026-10-05")).toEqual(["2026-10-08"]);
  });
});

describe("validarComprobante: ruta rápida con el OCR", () => {
  it("OCR completo y Banxico lo valida: responde sin esperar a la IA", async () => {
    const { deps, llamadas } = falsas({ ocr: TEXTO_SPIN, iaNuncaTermina: true });
    const r = await validarComprobante(imagen, { usuario: "123", ahora: AHORA }, deps);
    expect(r).toMatchObject({ codigo: "VALIDADO", ruta: "rapida", extraccion: { origen: "ocr" } });
    expect(llamadas.busquedas).toHaveLength(1);
    expect(llamadas.busquedas[0]).toMatchObject({ soloPrimerIntento: true, bancoEmisor: { clave: "SPIN" } });
    expect(llamadas.registros).toHaveLength(1);
    expect(llamadas.completa).toBe(0);
  });

  it("si la consulta rápida no lo encuentra, sigue con la IA sin repetir esa consulta", async () => {
    const { deps, llamadas } = falsas({ ocr: TEXTO_SPIN, busquedas: [NO_ENCONTRADO, VALIDADO] });
    const r = await validarComprobante(imagen, { usuario: "123", ahora: AHORA }, deps);
    expect(r).toMatchObject({ codigo: "VALIDADO", ruta: "normal" });
    expect(llamadas.busquedas).toHaveLength(2);
    expect(llamadas.busquedas[1]!.soloPrimerIntento).toBeUndefined();
    expect([...(llamadas.busquedas[1]!.yaConsultadas ?? [])]).toEqual(["k-ocr"]);
  });

  it("un resultado definitivo de Banxico (ya usado) también responde de inmediato", async () => {
    const duplicado: ResultadoBusqueda = { estado: "DUPLICADO", mensaje: "Este comprobante ya fue validado…", intentos: [] };
    const { deps } = falsas({ ocr: TEXTO_SPIN, busquedas: [duplicado], iaNuncaTermina: true });
    const r = await validarComprobante(imagen, { usuario: "123", ahora: AHORA }, deps);
    expect(r).toMatchObject({ codigo: "DUPLICADO", ruta: "rapida" });
  });

  it("si el OCR no identifica el banco no intenta la ruta rápida (Klar)", async () => {
    const { deps, llamadas } = falsas({ ocr: TEXTO_KLAR });
    await validarComprobante(imagen, { usuario: "123", ahora: AHORA }, deps);
    expect(llamadas.busquedas).toHaveLength(1);
    expect(llamadas.busquedas[0]!.soloPrimerIntento).toBeUndefined();
  });

  it("se puede desactivar", async () => {
    const { deps, llamadas } = falsas({ ocr: TEXTO_SPIN });
    const r = await validarComprobante(imagen, { usuario: "123", ahora: AHORA, rutaRapida: false }, deps);
    expect(r.ruta).toBe("normal");
    expect(llamadas.busquedas).toHaveLength(1);
  });
});

describe("validarComprobante: cancelación y reinicios del bot", () => {
  it("cancelado antes de registrar: no registra el pago ni genera la foto", async () => {
    const { deps, llamadas } = falsas();
    const controlador = new AbortController();
    deps.buscar = async () => {
      controlador.abort(new Error("tiempo agotado"));
      return VALIDADO;
    };
    await expect(validarComprobante(imagen, { usuario: "123", ahora: AHORA, signal: controlador.signal }, deps)).rejects.toThrow(
      "tiempo agotado",
    );
    expect(llamadas.registros).toEqual([]);
    expect(llamadas.capturas).toEqual([]);
  });

  it("pasa la cancelación a la búsqueda en Banxico", async () => {
    const { deps, llamadas } = falsas();
    const controlador = new AbortController();
    await validarComprobante(imagen, { usuario: "123", ahora: AHORA, signal: controlador.signal }, deps);
    expect(llamadas.busquedas[0]!.signal).toBe(controlador.signal);
  });

  it("avisa en el progreso la clave con la que quedó registrado el pago", async () => {
    const { deps } = falsas();
    const progreso: Progreso[] = [];
    await validarComprobante(imagen, { usuario: "123", ahora: AHORA, alProgreso: (p) => progreso.push(p) }, deps);
    expect(progreso.at(-1)).toEqual({ etapa: "CAPTURA", clave: CLAVE_REAL });
  });

  it("retomado tras un reinicio: su propio registro no es duplicado y no se registra dos veces", async () => {
    const propio: RegistroUsado = {
      claveRastreo: CLAVE_REAL,
      referencia: "7454748",
      monto: "400.00",
      fecha: "2026-10-08",
      cuenta: "072650010004755884",
      emisor: "SPIN BY OXXO",
      usuario: "123",
      validadoEn: "2026-10-09T17:59:00Z",
    };
    const { deps, llamadas } = falsas({ lecturas: [[propio], [propio]], datos: { claveRastreo: CLAVE_REAL } });
    const r = await validarComprobante(imagen, { usuario: "123", ahora: AHORA, claveYaRegistrada: CLAVE_REAL }, deps);
    expect(r.codigo).toBe("VALIDADO");
    expect(r.captura).toBeDefined();
    expect(llamadas.registros).toEqual([]);
    expect(llamadas.busquedas[0]!.usados).toEqual([]);
  });
});

describe("validarComprobante: segunda opinión del OCR sobre la cuenta destino", () => {
  const TEXTO_OCR_1871 = "COMPROBANTE DE LA OPERACION\nImporte transferido\n$ 400.00\nCuenta de destino\n1871";

  it("la IA leyó una cuenta que no es nuestra pero el OCR leyó la nuestra: se usa la del OCR", async () => {
    const { deps, llamadas } = falsas({ datos: { cuentaDestino: "5201" } });
    const iniciar = deps.iniciarExtraccion;
    deps.iniciarExtraccion = (img) => {
      const proceso = iniciar(img);
      return { ocr: proceso.ocr, completa: proceso.completa.then((e) => ({ ...e, textoOcr: TEXTO_OCR_1871 })) };
    };
    const r = await validarComprobante(imagen, { usuario: "123", ahora: AHORA }, deps);
    expect(r.codigo).toBe("VALIDADO");
    expect(r.extraccion?.cuentaCorregida).toEqual({ ia: "5201", ocr: "1871" });
    expect(llamadas.busquedas[0]!.coincidencia.cuenta.banco).toBe("BANORTE");
  });

  it("si el OCR tampoco lee una cuenta nuestra y el banco destino es otro, es cuenta incorrecta sin consultar", async () => {
    const { deps, llamadas } = falsas({ datos: { cuentaDestino: "5201", bancoDestino: "Santander" } });
    const r = await validarComprobante(imagen, { usuario: "123", ahora: AHORA }, deps);
    expect(r.codigo).toBe("CUENTA_INCORRECTA");
    expect(llamadas.busquedas).toHaveLength(0);
  });
});

describe("validarComprobante: nota de la foto", () => {
  it("la imagen no trae fecha pero la nota sí: no es 'datos insuficientes', se usa la de la nota", async () => {
    const { deps, llamadas } = falsas({ datos: { fecha: null } });
    const r = await validarComprobante(imagen, { usuario: "123", ahora: AHORA, nota: { fecha: "2026-10-08" } }, deps);
    expect(r.codigo).toBe("VALIDADO");
    expect(llamadas.busquedas[0]!.normalizados.fecha).toBe("2026-10-08");
  });

  it("sin la nota ni fecha en la imagen, se busca de hoy hacia atrás", async () => {
    const { deps, llamadas } = falsas({ datos: { fecha: null } });
    const r = await validarComprobante(imagen, { usuario: "123", ahora: AHORA }, deps);
    expect(r.codigo).toBe("VALIDADO");
    expect(llamadas.busquedas[0]!.normalizados.fecha).toBeNull();
  });

  it("sin la nota ni el monto en la imagen: datos insuficientes", async () => {
    const { deps } = falsas({ datos: { monto: null } });
    const r = await validarComprobante(imagen, { usuario: "123", ahora: AHORA }, deps);
    expect(r).toMatchObject({ codigo: "DATOS_INSUFICIENTES", faltantes: ["el monto"] });
  });

  it("si la imagen no es un comprobante, la nota no la salva", async () => {
    const { deps, llamadas } = falsas({ datos: { esComprobante: false } });
    const nota = { fecha: "2026-10-08", monto: 400, referencia: "7454748", banco: "SPIN" as const, cuentaDestino: "1871" };
    const r = await validarComprobante(imagen, { usuario: "123", ahora: AHORA, nota }, deps);
    expect(r.codigo).toBe("NO_ES_COMPROBANTE");
    expect(llamadas.busquedas).toHaveLength(0);
  });

  it("la nota contradice la imagen: se consulta con la nota y queda la diferencia para avisar", async () => {
    const { deps, llamadas } = falsas();
    const r = await validarComprobante(imagen, { usuario: "123", ahora: AHORA, nota: { monto: 500 } }, deps);
    expect(llamadas.busquedas[0]!.normalizados.monto).toBe("500.00");
    expect(r.extraccion?.notaAplicada?.diferencias).toEqual([{ campo: "monto", nota: "$500.00", imagen: "$400.00" }]);
  });

  it("la cuenta escrita en la nota no se cambia por la que lee el OCR", async () => {
    const { deps } = falsas();
    const iniciar = deps.iniciarExtraccion;
    deps.iniciarExtraccion = (img) => {
      const proceso = iniciar(img);
      return { ocr: proceso.ocr, completa: proceso.completa.then((e) => ({ ...e, textoOcr: "Cuenta de destino\n1871" })) };
    };
    const r = await validarComprobante(imagen, { usuario: "123", ahora: AHORA, nota: { cuentaDestino: "9999" } }, deps);
    expect(r.codigo).toBe("CUENTA_INCORRECTA");
    expect(r.extraccion?.cuentaCorregida).toBeUndefined();
  });
});

describe("validarComprobante: 'cuenta [banco]' en la nota (se sabe la cuenta, no el número)", () => {
  /** Números de nuestra cuenta que se consultan en Banxico, en orden. */
  const numeros = (entrada: EntradaBusqueda) => cuentasAIntentar(entrada.coincidencia, entrada.cuentaDeducida).map(([, tipo]) => tipo);

  it("sin número en la imagen: se prueban los números de esa cuenta, empezando por la tarjeta (antes, solo la CLABE)", async () => {
    const { deps, llamadas } = falsas({ datos: { cuentaDestino: null } });
    const r = await validarComprobante(imagen, { usuario: "123", ahora: AHORA, nota: { cuentaBanco: "BANORTE" } }, deps);
    expect(r.codigo).toBe("VALIDADO");
    expect(llamadas.busquedas[0]!.coincidencia.cuenta.banco).toBe("BANORTE");
    expect(numeros(llamadas.busquedas[0]!).slice(0, 2)).toEqual(["tarjeta", "clabe"]);
  });

  it("vale para cualquiera de nuestros bancos: 'cuenta Banamex' también prueba su tarjeta", async () => {
    const { deps, llamadas } = falsas({ datos: { cuentaDestino: null } });
    await validarComprobante(imagen, { usuario: "123", ahora: AHORA, nota: { cuentaBanco: "BANAMEX" } }, deps);
    expect(llamadas.busquedas[0]!.coincidencia.cuenta.banco).toBe("BANAMEX");
    expect(numeros(llamadas.busquedas[0]!).slice(0, 2)).toEqual(["tarjeta", "clabe"]);
  });

  it("la imagen muestra la tarjeta …1871 y la nota dice 'cuenta Banorte': se consulta con la tarjeta, no se cambia por la CLABE", async () => {
    const { deps, llamadas } = falsas({ datos: { cuentaDestino: "1871" } });
    await validarComprobante(imagen, { usuario: "123", ahora: AHORA, nota: { cuentaBanco: "BANORTE" } }, deps);
    expect(llamadas.busquedas[0]!.coincidencia).toMatchObject({ tipo: "tarjeta", numero: "4189143097841871" });
  });

  it("sin clave ni referencia y la nota da el mismo banco que el emisor: 'mismo banco', como antes", async () => {
    // Inbursa no tiene referencia habitual: sin clave ni referencia no hay con qué buscar (rechazoSinCriterio).
    const { deps, llamadas } = falsas({ datos: { cuentaDestino: null, claveRastreo: null, referencia: null } });
    const r = await validarComprobante(imagen, { usuario: "123", ahora: AHORA, nota: { cuentaBanco: "INBURSA", banco: "INBURSA" } }, deps);
    expect(r.codigo).toBe("MISMO_BANCO");
    expect(llamadas.busquedas).toHaveLength(0);
  });
});

describe("validarComprobante: sin registro de pagos ya validados (REGLAS.bloquearDuplicados = false)", () => {
  it("en producción no hay registro: el pipeline no lee ni guarda nada", async () => {
    const { DEPENDENCIAS_PIPELINE } = await import("../src/pipeline.js");
    expect(DEPENDENCIAS_PIPELINE.almacen).toBeNull();
  });

  it("el mismo comprobante enviado dos veces se valida las dos veces", async () => {
    const { deps, llamadas } = falsas();
    deps.almacen = null;
    const primera = await validarComprobante(imagen, { usuario: "123", ahora: AHORA }, deps);
    const segunda = await validarComprobante(imagen, { usuario: "456", ahora: AHORA }, deps);
    expect([primera.codigo, segunda.codigo]).toEqual(["VALIDADO", "VALIDADO"]);
    expect(segunda.reglas.map((r) => r.regla)).not.toContain("No usado antes");
    expect(llamadas.registros).toEqual([]);
    expect(llamadas.busquedas[1]!.usados).toEqual([]);
  });
});

describe("completarConOcr: lo que la IA dejó vacío y el OCR sí leyó", () => {
  const conTexto = (cambios: Partial<DatosExtraidos>, texto: string): ResultadoExtraccion => ({
    ...extraccion({ bancoDestino: "Banorte", ...cambios }),
    textoOcr: texto,
  });

  it("la fecha y su hora del OCR, si la IA no las leyó", () => {
    const r = completarConOcr(conTexto({ fecha: null, hora: null }, TEXTO_SPIN));
    expect(r.datos).toMatchObject({ fecha: "2026-10-08", hora: "14:04:43" });
    expect(r.completadoConOcr).toEqual(["fecha", "hora"]);
  });

  it("lo que la IA sí leyó no se cambia", () => {
    const r = completarConOcr(conTexto({ fecha: "2026-10-07" }, TEXTO_SPIN));
    expect(r.datos.fecha).toBe("2026-10-07");
    expect(r.completadoConOcr).toBeUndefined();
  });

  it("la cuenta del OCR solo si es una de las nuestras", () => {
    expect(completarConOcr(conTexto({ cuentaDestino: null }, TEXTO_SPIN)).datos.cuentaDestino).toBe("072650010004755884");
    const ajena = "Transferencia\nImporte $10.00\nCuenta destino ****9999";
    expect(completarConOcr(conTexto({ cuentaDestino: null }, ajena)).datos.cuentaDestino).toBeNull();
  });

  it("en validarComprobante: la IA sin fecha + el OCR con fecha → se consulta con la del OCR", async () => {
    const { deps, llamadas } = falsas({ datos: { fecha: null } });
    const iniciar = deps.iniciarExtraccion;
    deps.iniciarExtraccion = (img) => {
      const proceso = iniciar(img);
      return { ...proceso, completa: proceso.completa.then((e) => ({ ...e, textoOcr: TEXTO_SPIN })) };
    };
    await validarComprobante(imagen, { usuario: "123", ahora: AHORA }, deps);
    expect(llamadas.busquedas[0]!.normalizados.fecha).toBe("2026-10-08");
  });
});

describe("banco emisor dudoso: se prueban los bancos posibles en Banxico antes de preguntar", () => {
  const dudoso: EvaluacionBanco = { ...bancoSpin, suficiente: false, candidatos: ["SPIN", "NU"], motivo: "contradicción" };
  const conBancoDudoso = (opciones: Parameters<typeof falsas>[0]) => {
    const f = falsas(opciones);
    const iniciar = f.deps.iniciarExtraccion;
    f.deps.iniciarExtraccion = (img) => {
      const proceso = iniciar(img);
      return { ...proceso, completa: proceso.completa.then((e) => ({ ...e, banco: dudoso })) };
    };
    return f;
  };

  it("el segundo banco posible lo encuentra: validado sin preguntar", async () => {
    const { deps, llamadas } = conBancoDudoso({ busquedas: [NO_ENCONTRADO, VALIDADO] });
    const r = await validarComprobante(imagen, { usuario: "123", ahora: AHORA }, deps);
    expect(r.codigo).toBe("VALIDADO");
    expect(llamadas.busquedas.map((b) => b.bancoEmisor.clave)).toEqual(["SPIN", "NU"]);
    expect(llamadas.busquedas.every((b) => b.maxFechas === 2)).toBe(true);
  });

  it("ninguno lo encuentra: se pregunta el banco, con las consultas hechas", async () => {
    const intento = { fecha: "08-10-2026", criterio: "CLAVE_RASTREO" as const, valorCriterio: "X", cuenta: "1", emisor: "A", receptor: "B", resultado: "NO_ENCONTRADO" as const };
    const { deps, llamadas } = conBancoDudoso({ busquedas: [{ ...NO_ENCONTRADO, intentos: [intento] }] });
    const r = await validarComprobante(imagen, { usuario: "123", ahora: AHORA }, deps);
    expect(r).toMatchObject({ codigo: "REQUIERE_CONFIRMACION_BANCO", candidatosBanco: ["SPIN", "NU"] });
    expect(r.intentos).toHaveLength(2);
    expect(llamadas.busquedas).toHaveLength(2);
  });

  it("si la persona ya eligió el banco, no se prueban otros", async () => {
    const { deps, llamadas } = conBancoDudoso({});
    const confirmaciones = { banco: { clave: "NU" as const, nombreLibre: null } };
    await validarComprobante(imagen, { usuario: "123", ahora: AHORA, confirmaciones }, deps);
    expect(llamadas.busquedas.map((b) => b.bancoEmisor.clave)).toEqual(["NU"]);
  });
});

describe("referencia semanal de BBVA aprendida de los pagos validados", () => {
  const bancoBbva: EvaluacionBanco = { ...bancoSpin, banco: "BBVA", senales: { modelo: "BBVA", texto: "BBVA", clave: "BBVA", firma: null }, candidatos: ["BBVA"] };
  const referenciasFalsas = (conocida: string | null) => {
    const aprendidas: [string, string, string][] = [];
    return {
      aprendidas,
      referencias: {
        cargar: async () => undefined,
        para: () => conocida,
        aprender: async (banco: string, referencia: string, fecha: string) => {
          aprendidas.push([banco, referencia, fecha]);
        },
      },
    };
  };
  const conBbva = (datos: Partial<DatosExtraidos>, conocida: string | null) => {
    const f = falsas({ datos });
    const { aprendidas, referencias } = referenciasFalsas(conocida);
    f.deps.referencias = referencias as unknown as DependenciasPipeline["referencias"];
    const iniciar = f.deps.iniciarExtraccion;
    f.deps.iniciarExtraccion = (img) => {
      const proceso = iniciar(img);
      return { ...proceso, completa: proceso.completa.then((e) => ({ ...e, banco: bancoBbva })) };
    };
    return { ...f, aprendidas };
  };

  it("al validar un pago BBVA se anota su referencia real con la fecha del pago", async () => {
    const { deps, aprendidas } = conBbva({}, null);
    const r = await validarComprobante(imagen, { usuario: "123", ahora: AHORA }, deps);
    expect(r.codigo).toBe("VALIDADO");
    expect(aprendidas).toEqual([["BBVA", "7454748", "2026-10-08"]]);
  });

  it("un BBVA sin clave ni referencia se busca con la aprendida", async () => {
    const { deps, llamadas } = conBbva({ claveRastreo: null, referencia: null }, "2309260");
    const r = await validarComprobante(imagen, { usuario: "123", ahora: AHORA }, deps);
    expect(r.codigo).toBe("VALIDADO");
    expect(llamadas.busquedas[0]!.referenciasAprendidas?.("BBVA", "2026-10-08")).toBe("2309260");
  });

  it("sin ninguna aprendida, un BBVA sin clave ni referencia pide la referencia", async () => {
    const { deps, llamadas } = conBbva({ claveRastreo: null, referencia: null }, null);
    const r = await validarComprobante(imagen, { usuario: "123", ahora: AHORA }, deps);
    expect(r.codigo).toBe("DATOS_INSUFICIENTES");
    expect(llamadas.busquedas).toHaveLength(0);
  });
});

// --- Antes de rechazar o de preguntar, Banxico decide (pedido del usuario, 11-oct) ------------------------

/** La lectura completa con estos cambios (texto del OCR, banco emisor…), sin activar la ruta rápida. */
function conLectura(f: ReturnType<typeof falsas>, cambios: Partial<ResultadoExtraccion>) {
  const iniciar = f.deps.iniciarExtraccion;
  f.deps.iniciarExtraccion = (img) => {
    const proceso = iniciar(img);
    return { ...proceso, completa: proceso.completa.then((e) => ({ ...e, ...cambios })) };
  };
  return f;
}

const intento = (resultado: IntentoBanxico["resultado"] = "NO_ENCONTRADO"): IntentoBanxico => ({
  fecha: "08-10-2026",
  criterio: "CLAVE_RASTREO",
  valorCriterio: "X",
  cuenta: "1",
  emisor: "A",
  receptor: "B",
  resultado,
});

/** Detección temprana: Banxico tiene la clave el 08-oct, pero no con el monto leído. */
const MONTO_DISTINTO: ResultadoBusqueda = {
  estado: "MONTO_NO_COINCIDE",
  mensaje: "El monto no coincide: en Banxico el pago con esa clave de rastreo no es por $450.00.",
  intentos: [intento()],
  consultadas: ["k-450"],
  fechaClave: "2026-10-08",
};

const A_OTRA_CUENTA: ResultadoBusqueda = {
  estado: "CUENTA_INCORRECTA",
  mensaje: `${MENSAJES.CUENTA_INCORRECTA} (Banxico registra ese pago a otra cuenta).`,
  intentos: [intento()],
  fechaClave: "2026-10-08",
};

const SIN_PAGO: ResultadoBusqueda = { ...NO_ENCONTRADO, intentos: [intento()] };

describe("segunda opinión del monto: antes de 'El monto no coincide' se prueban los otros montos leídos", () => {
  it("la IA leyó $450 y el OCR $400: con $400, en la fecha en que Banxico tiene la clave, se valida", async () => {
    const { deps, llamadas } = conLectura(falsas({ datos: { monto: 450 }, busquedas: [MONTO_DISTINTO, VALIDADO] }), { textoOcr: TEXTO_SPIN });
    const r = await validarComprobante(imagen, { usuario: "123", ahora: AHORA }, deps);
    expect(r).toMatchObject({ codigo: "VALIDADO", montoCorregido: { leido: "450.00", banxico: "400.00" } });
    expect(r.normalizados?.monto).toBe("400.00");
    const [primera, segunda] = llamadas.busquedas;
    expect(primera!.normalizados.monto).toBe("450.00");
    // Rápido: solo la fecha de la clave, solo con la clave y sin repetir lo ya consultado.
    expect(segunda).toMatchObject({ maxFechas: 1, soloClave: true, fechasAlternativas: [] });
    expect(segunda!.normalizados).toMatchObject({ monto: "400.00", fecha: "2026-10-08", hora: null });
    expect([...(segunda!.yaConsultadas ?? [])]).toContain("k-450");
    expect(r.intentos).toHaveLength(1);
  });

  it("sin otro monto leído: MONTO_NO_COINCIDE con una sola búsqueda", async () => {
    const { deps, llamadas } = falsas({ datos: { monto: 450 }, busquedas: [MONTO_DISTINTO] });
    const r = await validarComprobante(imagen, { usuario: "123", ahora: AHORA }, deps);
    expect(r).toMatchObject({ codigo: "MONTO_NO_COINCIDE", mensaje: MONTO_DISTINTO.mensaje });
    expect(llamadas.busquedas).toHaveLength(1);
  });

  it("con el otro monto tampoco coincide: queda el aviso del monto leído, con todas las consultas", async () => {
    const otraVez = { ...MONTO_DISTINTO, mensaje: "El monto no coincide: … $400.00." };
    const { deps } = conLectura(falsas({ datos: { monto: 450 }, busquedas: [MONTO_DISTINTO, otraVez] }), { textoOcr: TEXTO_SPIN });
    const r = await validarComprobante(imagen, { usuario: "123", ahora: AHORA }, deps);
    expect(r).toMatchObject({ codigo: "MONTO_NO_COINCIDE", mensaje: MONTO_DISTINTO.mensaje });
    expect(r.montoCorregido).toBeUndefined();
    expect(r.intentos).toHaveLength(2);
  });

  it("con el otro monto el pago existe pero fue a otra cuenta: CUENTA_INCORRECTA (es lo que de verdad pasó)", async () => {
    const { deps } = conLectura(falsas({ datos: { monto: 450 }, busquedas: [MONTO_DISTINTO, A_OTRA_CUENTA] }), { textoOcr: TEXTO_SPIN });
    const r = await validarComprobante(imagen, { usuario: "123", ahora: AHORA }, deps);
    expect(r).toMatchObject({ codigo: "CUENTA_INCORRECTA", mensaje: A_OTRA_CUENTA.mensaje });
    expect(r.montoCorregido).toBeUndefined();
  });

  it("el monto de la nota no coincide: se prueba el de la imagen", async () => {
    const { deps, llamadas } = falsas({ busquedas: [MONTO_DISTINTO, VALIDADO] });
    const r = await validarComprobante(imagen, { usuario: "123", ahora: AHORA, nota: { monto: 450 } }, deps);
    expect(r).toMatchObject({ codigo: "VALIDADO", montoCorregido: { leido: "450.00", banxico: "400.00" } });
    expect(llamadas.busquedas[1]!.normalizados.monto).toBe("400.00");
  });
});

describe("montosAlternativos", () => {
  it("el del OCR si no coincide con el de la IA (uno de los dos se leyó mal)", () => {
    const e = { ...extraccion({ monto: 450 }), textoOcr: TEXTO_SPIN }; // el OCR lee $400.00
    expect(montosAlternativos(e)).toEqual(["400.00"]);
    expect(montosAlternativos({ ...e, datos: datosEjemplo({ monto: 400 }) })).toEqual([]);
    // Si la IA falló y solo leyó el OCR, no hay segunda lectura.
    expect(montosAlternativos({ ...e, origen: "ocr" })).toEqual([]);
  });

  it("el de la imagen si la nota trae otro", () => {
    const e = { ...extraccion({ monto: 500 }), notaAplicada: { diferencias: [], montoImagen: 400 } };
    expect(montosAlternativos(e)).toEqual(["400.00"]);
  });
});

describe("cuenta visible que no es nuestra, con clave de rastreo: antes de rechazar se pregunta a Banxico", () => {
  // "1874" no es de ninguna de nuestras cuentas (la tarjeta Banorte termina en 1871: pudo leerse mal).
  it("banco destino nuestro (Banorte): se busca completa en esa cuenta, con todos sus números", async () => {
    const { deps, llamadas } = falsas({ datos: { cuentaDestino: "1874", bancoDestino: "Banorte" } });
    const r = await validarComprobante(imagen, { usuario: "123", ahora: AHORA }, deps);
    expect(r.codigo).toBe("VALIDADO");
    expect(llamadas.busquedas).toHaveLength(1);
    expect(llamadas.busquedas[0]).toMatchObject({ coincidencia: { cuenta: { banco: "BANORTE" } }, cuentaDeducida: true });
    expect(llamadas.busquedas[0]!.soloClave).toBeUndefined();
    expect(llamadas.busquedas[0]!.maxFechas).toBeUndefined();
  });

  it("no dice el banco destino, la cuenta no se parece a ninguna nuestra (…8852) y el beneficiario es otra persona: cuentas incorrectas, sin consultar", async () => {
    const { deps, llamadas } = falsas({ datos: { cuentaDestino: "8852", bancoDestino: null, beneficiario: "Nicolas A Josid" } });
    const r = await validarComprobante(imagen, { usuario: "123", ahora: AHORA }, deps);
    expect(r).toMatchObject({ codigo: "CUENTA_INCORRECTA", mensaje: MENSAJES.CUENTA_INCORRECTA });
    expect(r.cuentaParecida).toBeUndefined();
    expect(llamadas.busquedas).toHaveLength(0);
  });

  it("dice otro banco (Santander) y no se parece: cuentas incorrectas, sin consultar", async () => {
    const { deps, llamadas } = falsas({ datos: { cuentaDestino: "8852", bancoDestino: "Santander" } });
    const r = await validarComprobante(imagen, { usuario: "123", ahora: AHORA }, deps);
    expect(r.codigo).toBe("CUENTA_INCORRECTA");
    expect(llamadas.busquedas).toHaveLength(0);
  });

  it("nuestra cuenta de ese banco no lo tiene: cuentas incorrectas, con las consultas hechas", async () => {
    const { deps, llamadas } = falsas({ datos: { cuentaDestino: "1874", bancoDestino: "Banorte" }, busquedas: [SIN_PAGO] });
    const r = await validarComprobante(imagen, { usuario: "123", ahora: AHORA }, deps);
    expect(r).toMatchObject({ codigo: "CUENTA_INCORRECTA", mensaje: MENSAJES.CUENTA_INCORRECTA });
    expect(llamadas.busquedas).toHaveLength(1);
    expect(r.intentos).toHaveLength(1);
  });

  it("Banxico tiene la clave con otra cuenta: lo dice", async () => {
    const { deps, llamadas } = falsas({ datos: { cuentaDestino: "1874", bancoDestino: "Banorte" }, busquedas: [A_OTRA_CUENTA] });
    const r = await validarComprobante(imagen, { usuario: "123", ahora: AHORA }, deps);
    expect(r).toMatchObject({ codigo: "CUENTA_INCORRECTA", mensaje: A_OTRA_CUENTA.mensaje });
    expect(llamadas.busquedas).toHaveLength(1);
  });

  it("la cuenta escrita en la nota se respeta: sin consultar", async () => {
    const { deps, llamadas } = falsas();
    const r = await validarComprobante(imagen, { usuario: "123", ahora: AHORA, nota: { cuentaDestino: "9999" } }, deps);
    expect(r.codigo).toBe("CUENTA_INCORRECTA");
    expect(llamadas.busquedas).toHaveLength(0);
  });
});

describe("cuenta leída que no es nuestra pero SE PARECE a uno de nuestros números: se busca con ese número (pedido del usuario, 11-oct)", () => {
  const TARJETA_BANORTE = "4189143097841871";
  const CLABE_BANORTE = "072650010004755884";
  /** Tipos de número que se consultan en Banxico con esa búsqueda. */
  const tipos = (b: EntradaBusqueda) => cuentasAIntentar(b.coincidencia, b.cuentaDeducida).map(([, tipo]) => tipo);

  it("…1874 sin banco destino: busca solo con la tarjeta Banorte (…1871), lo valida y lo deja anotado", async () => {
    const { deps, llamadas } = falsas({ datos: { cuentaDestino: "1874", bancoDestino: null } });
    const r = await validarComprobante(imagen, { usuario: "123", ahora: AHORA }, deps);
    expect(r.codigo).toBe("VALIDADO");
    expect(llamadas.busquedas).toHaveLength(1);
    const b = llamadas.busquedas[0]!;
    expect(b.coincidencia).toMatchObject({ tipo: "tarjeta", numero: TARJETA_BANORTE });
    expect(tipos(b)).toEqual(["tarjeta"]);
    expect(b.normalizados.cuentaDestino).toBe(TARJETA_BANORTE);
    expect(b.soloClave).toBeUndefined(); // una sola opción: búsqueda completa
    expect(r.cuentaParecida).toEqual({ leida: "1874", usada: TARJETA_BANORTE });
    // Lo que se leyó queda como se leyó.
    expect(r.extraccion?.datos.cuentaDestino).toBe("1874");
  });

  it("se parece a la CLABE (…5883): busca con la CLABE, no con la tarjeta", async () => {
    const { deps, llamadas } = falsas({ datos: { cuentaDestino: "5883", bancoDestino: null } });
    await validarComprobante(imagen, { usuario: "123", ahora: AHORA }, deps);
    expect(llamadas.busquedas[0]!.coincidencia).toMatchObject({ tipo: "clabe", numero: CLABE_BANORTE });
    expect(tipos(llamadas.busquedas[0]!)).toEqual(["clabe"]);
  });

  it("se parece al número de cuenta de Banamex (…1617 ≈ 2461618): busca con esa cuenta y después con su CLABE (13-oct)", async () => {
    const { deps, llamadas } = falsas({ datos: { cuentaDestino: "1617", bancoDestino: null } });
    await validarComprobante(imagen, { usuario: "123", ahora: AHORA }, deps);
    const b = llamadas.busquedas[0]!;
    expect(b.coincidencia.cuenta.banco).toBe("BANAMEX");
    expect(cuentasAIntentar(b.coincidencia, b.cuentaDeducida)).toEqual([
      ["2461618", "cuenta"],
      ["002180702124616185", "clabe"],
    ]);
  });

  it.each([
    ["41891871", TARJETA_BANORTE, "tarjeta enmascarada en medio"],
    ["07265001000475588", CLABE_BANORTE, "CLABE recortada al final"],
    ["07265001000475584", CLABE_BANORTE, "CLABE con un dígito de menos"],
  ])("%s → busca con %s (%s)", async (leido, numero) => {
    const { deps, llamadas } = falsas({ datos: { cuentaDestino: leido, bancoDestino: null } });
    const r = await validarComprobante(imagen, { usuario: "123", ahora: AHORA }, deps);
    expect(r.codigo).toBe("VALIDADO");
    expect(llamadas.busquedas[0]!.coincidencia.numero).toBe(numero);
  });

  it("aunque el comprobante diga otro banco (Santander), si el número se parece se prueba", async () => {
    const { deps, llamadas } = falsas({ datos: { cuentaDestino: "1874", bancoDestino: "Santander" } });
    const r = await validarComprobante(imagen, { usuario: "123", ahora: AHORA }, deps);
    expect(r.codigo).toBe("VALIDADO");
    expect(llamadas.busquedas[0]!.coincidencia.numero).toBe(TARJETA_BANORTE);
  });

  it("sin clave de rastreo también se prueba (con la referencia, búsqueda completa)", async () => {
    const { deps, llamadas } = falsas({ datos: { cuentaDestino: "1874", bancoDestino: null, claveRastreo: null } });
    const r = await validarComprobante(imagen, { usuario: "123", ahora: AHORA }, deps);
    expect(r.codigo).toBe("VALIDADO");
    expect(llamadas.busquedas).toHaveLength(1);
    expect(llamadas.busquedas[0]!.soloClave).toBeUndefined();
  });

  it("se parece a dos números (…4948): prueba los dos, cada uno con su número, rápido", async () => {
    const { deps, llamadas } = falsas({ datos: { cuentaDestino: "4948", bancoDestino: null }, busquedas: [NO_ENCONTRADO, VALIDADO] });
    const r = await validarComprobante(imagen, { usuario: "123", ahora: AHORA }, deps);
    expect(r.codigo).toBe("VALIDADO");
    // La tarjeta …4988 y la cuenta …4942 (después su CLABE, en la misma búsqueda).
    expect(llamadas.busquedas.map((b) => tipos(b))).toEqual([["tarjeta"], ["cuenta", "clabe"]]);
    expect(llamadas.busquedas.every((b) => b.coincidencia.cuenta.banco === "BANCOPPEL" && b.soloClave === true && b.maxFechas === 2)).toBe(true);
  });

  it("banco destino nuestro (Banorte) y el número se parece a otra cuenta (…4987 ≈ BanCoppel …4988): las dos", async () => {
    const { deps, llamadas } = falsas({ datos: { cuentaDestino: "4987", bancoDestino: "Banorte" }, busquedas: [NO_ENCONTRADO, VALIDADO] });
    const r = await validarComprobante(imagen, { usuario: "123", ahora: AHORA }, deps);
    expect(r.codigo).toBe("VALIDADO");
    expect(llamadas.busquedas.map((b) => b.coincidencia.cuenta.banco)).toEqual(["BANORTE", "BANCOPPEL"]);
    expect(llamadas.busquedas[0]!.cuentaDeducida).toBe(true); // Banorte: todos sus números
    expect(llamadas.busquedas[1]!.coincidencia.numero).toBe("4169160608474988"); // BanCoppel: solo la tarjeta parecida
  });

  it("la lectura del OCR también cuenta: la IA leyó …8852 (no se parece) y el OCR …1874", async () => {
    const f = conLectura(falsas({ datos: { cuentaDestino: "8852", bancoDestino: null } }), { textoOcr: "Cuenta de destino\n1874" });
    const r = await validarComprobante(imagen, { usuario: "123", ahora: AHORA }, f.deps);
    expect(r.codigo).toBe("VALIDADO");
    expect(r.cuentaParecida).toEqual({ leida: "1874", usada: TARJETA_BANORTE });
  });

  it("Banxico no lo tiene con nuestro número: cuentas incorrectas, con la consulta hecha", async () => {
    const { deps, llamadas } = falsas({ datos: { cuentaDestino: "1874", bancoDestino: null, beneficiario: "Nicolas A Josid" }, busquedas: [SIN_PAGO] });
    const r = await validarComprobante(imagen, { usuario: "123", ahora: AHORA }, deps);
    expect(r).toMatchObject({ codigo: "CUENTA_INCORRECTA", mensaje: MENSAJES.CUENTA_INCORRECTA });
    expect(llamadas.busquedas).toHaveLength(1);
    expect(r.intentos).toHaveLength(1);
  });

  it("la cuenta escrita en la nota se respeta: no se buscan parecidas", async () => {
    const { deps, llamadas } = falsas({ datos: { bancoDestino: null } });
    const r = await validarComprobante(imagen, { usuario: "123", ahora: AHORA, nota: { cuentaDestino: "1874" } }, deps);
    expect(r.codigo).toBe("CUENTA_INCORRECTA");
    expect(llamadas.busquedas).toHaveLength(0);
  });
});

describe("cuenta muy mal leída sin banco destino: el beneficiario como pista (pedido del usuario, 11-oct)", () => {
  // "0555577886" (un folio leído como cuenta) no se parece a ninguno de nuestros números.
  const muyMalLeida = (cambios: Partial<DatosExtraidos> = {}) => ({ cuentaDestino: "0555577886", bancoDestino: null, ...cambios });

  it("el beneficiario es nuestro titular: se prueban sus cuentas, rápido, y se valida en la que lo tiene", async () => {
    const { deps, llamadas } = falsas({ datos: muyMalLeida(), busquedas: [NO_ENCONTRADO, VALIDADO] });
    const r = await validarComprobante(imagen, { usuario: "123", ahora: AHORA }, deps);
    expect(r.codigo).toBe("VALIDADO");
    expect(llamadas.busquedas.map((b) => b.coincidencia.cuenta.banco)).toEqual(["BANORTE", "BANAMEX"]);
    expect(llamadas.busquedas.every((b) => b.soloClave === true && b.maxFechas === 2 && b.cuentaDeducida)).toBe(true);
    expect(r.cuentaPorBeneficiario).toEqual({ beneficiario: "Gabriel Alejandro Fondacaro Rielo", banco: "BANAMEX" });
  });

  it("ninguna de sus cuentas lo tiene: cuentas incorrectas, con las consultas hechas", async () => {
    const { deps, llamadas } = falsas({ datos: muyMalLeida(), busquedas: [SIN_PAGO] });
    const r = await validarComprobante(imagen, { usuario: "123", ahora: AHORA }, deps);
    expect(r).toMatchObject({ codigo: "CUENTA_INCORRECTA", mensaje: MENSAJES.CUENTA_INCORRECTA });
    expect(llamadas.busquedas).toHaveLength(3); // Banorte, Banamex y BanCoppel
    expect(r.cuentaPorBeneficiario).toBeUndefined();
  });

  it("MEXIOFERTAS: solo Inbursa", async () => {
    const { deps, llamadas } = falsas({ datos: muyMalLeida({ beneficiario: "MEXIOFERTAS" }) });
    await validarComprobante(imagen, { usuario: "123", ahora: AHORA }, deps);
    expect(llamadas.busquedas.map((b) => b.coincidencia.cuenta.banco)).toEqual(["INBURSA"]);
  });

  it("el nombre de la IA es otro, pero el OCR lee el de nuestro titular: también cuenta", async () => {
    const texto = "Beneficiario: Gabriel Alejandro Fondacaro\nCuenta de destino\n0555577886";
    const f = conLectura(falsas({ datos: muyMalLeida({ beneficiario: "pago de champu" }) }), { textoOcr: texto });
    const r = await validarComprobante(imagen, { usuario: "123", ahora: AHORA }, f.deps);
    expect(r.codigo).toBe("VALIDADO");
    expect(f.llamadas.busquedas[0]!.coincidencia.cuenta.banco).toBe("BANORTE");
  });

  it.each([
    ["el beneficiario es otra persona", { beneficiario: "Nicolas A Josid" }],
    ["no se ve el beneficiario", { beneficiario: null }],
    ["sin clave de rastreo (por referencia serían ~30 consultas)", { claveRastreo: null }],
    ["el comprobante dice otro banco (Santander)", { bancoDestino: "Santander" }],
  ])("%s: cuentas incorrectas, sin consultar", async (_caso, cambios: Partial<DatosExtraidos>) => {
    const { deps, llamadas } = falsas({ datos: muyMalLeida(cambios) });
    const r = await validarComprobante(imagen, { usuario: "123", ahora: AHORA }, deps);
    expect(r.codigo).toBe("CUENTA_INCORRECTA");
    expect(llamadas.busquedas).toHaveLength(0);
  });

  it("número parecido y beneficiario nuestro: primero el parecido (búsqueda completa) y después sus cuentas (rápido)", async () => {
    const { deps, llamadas } = falsas({ datos: { cuentaDestino: "1874", bancoDestino: null }, busquedas: [NO_ENCONTRADO, NO_ENCONTRADO, VALIDADO] });
    const r = await validarComprobante(imagen, { usuario: "123", ahora: AHORA }, deps);
    expect(r.codigo).toBe("VALIDADO");
    const [parecida, ...porNombre] = llamadas.busquedas;
    expect(parecida!.coincidencia.numero).toBe("4189143097841871");
    expect(parecida!.soloClave).toBeUndefined();
    expect(porNombre.map((b) => b.coincidencia.cuenta.banco)).toEqual(["BANORTE", "BANAMEX"]);
    expect(porNombre.every((b) => b.soloClave === true && b.maxFechas === 2)).toBe(true);
  });
});

describe("cuenta que no se ve ni se puede deducir, con clave: se prueban nuestras cuentas antes de preguntar", () => {
  it("la tercera la tiene: validado sin preguntar", async () => {
    const { deps, llamadas } = falsas({ datos: { cuentaDestino: null }, busquedas: [NO_ENCONTRADO, NO_ENCONTRADO, VALIDADO] });
    const r = await validarComprobante(imagen, { usuario: "123", ahora: AHORA }, deps);
    expect(r.codigo).toBe("VALIDADO");
    expect(llamadas.busquedas.map((b) => b.coincidencia.cuenta.banco)).toEqual(["BANORTE", "INBURSA", "BANAMEX"]);
    expect(llamadas.busquedas.every((b) => b.soloClave === true && b.maxFechas === 2 && b.cuentaDeducida)).toBe(true);
  });

  it("ninguna la tiene: se pregunta la cuenta, con las consultas hechas", async () => {
    const { deps } = falsas({ datos: { cuentaDestino: null }, busquedas: [SIN_PAGO] });
    const r = await validarComprobante(imagen, { usuario: "123", ahora: AHORA }, deps);
    expect(r.codigo).toBe("REQUIERE_CONFIRMACION_CUENTA");
    expect(r.candidatosCuenta).toHaveLength(4);
    expect(r.intentos).toHaveLength(4);
  });

  it("sin clave de rastreo se pregunta directo, sin consultar", async () => {
    const { deps, llamadas } = falsas({ datos: { cuentaDestino: null, claveRastreo: null } });
    const r = await validarComprobante(imagen, { usuario: "123", ahora: AHORA }, deps);
    expect(r.codigo).toBe("REQUIERE_CONFIRMACION_CUENTA");
    expect(llamadas.busquedas).toHaveLength(0);
  });

  it("el comprobante dice que fue a BBVA (donde no tenemos cuenta): cuentas incorrectas, sin probar las 4 ni preguntar", async () => {
    const { deps, llamadas } = falsas({ datos: { cuentaDestino: null, bancoDestino: "BBVA" } });
    const r = await validarComprobante(imagen, { usuario: "123", ahora: AHORA }, deps);
    expect(r.codigo).toBe("CUENTA_INCORRECTA");
    expect(llamadas.busquedas).toHaveLength(0);
  });
});

describe("mismo banco con clave de rastreo: antes de decirlo se prueban en Banxico los otros bancos posibles", () => {
  // La IA y el texto dicen Banorte (el banco de la cuenta destino), pero la clave de rastreo es de Spin.
  const banorteConClaveSpin: EvaluacionBanco = {
    banco: "BANORTE",
    nombreLibre: null,
    suficiente: true,
    senales: { modelo: "BANORTE", texto: "BANORTE", clave: "SPIN", firma: null },
    candidatos: ["BANORTE", "SPIN"],
    motivo: "2 señales coinciden en Banorte",
  };
  const soloBanorte: EvaluacionBanco = {
    ...banorteConClaveSpin,
    senales: { modelo: "BANORTE", texto: "BANORTE", clave: "BANORTE", firma: "BANORTE" },
    candidatos: ["BANORTE"],
  };

  it("Spin (el banco de la clave) lo tiene: validado, no era del mismo banco", async () => {
    const { deps, llamadas } = conLectura(falsas(), { banco: banorteConClaveSpin });
    const r = await validarComprobante(imagen, { usuario: "123", ahora: AHORA }, deps);
    expect(r.codigo).toBe("VALIDADO");
    expect(llamadas.busquedas).toHaveLength(1);
    expect(llamadas.busquedas[0]).toMatchObject({ bancoEmisor: { clave: "SPIN" }, maxFechas: 2 });
  });

  it("ningún otro banco lo tiene: sí es del mismo banco (con su mensaje)", async () => {
    const { deps } = conLectura(falsas({ busquedas: [SIN_PAGO] }), { banco: banorteConClaveSpin });
    const r = await validarComprobante(imagen, { usuario: "123", ahora: AHORA }, deps);
    expect(r).toMatchObject({ codigo: "MISMO_BANCO", mensaje: MENSAJES.MISMO_BANCO });
    expect(r.intentos).toHaveLength(1);
  });

  it("todas las señales dicen el mismo banco: mismo banco sin consultar", async () => {
    const { deps, llamadas } = conLectura(falsas(), { banco: soloBanorte });
    const r = await validarComprobante(imagen, { usuario: "123", ahora: AHORA }, deps);
    expect(r.codigo).toBe("MISMO_BANCO");
    expect(llamadas.busquedas).toHaveLength(0);
  });

  it("sin clave de rastreo (transferencia interna, no pasa por SPEI): mismo banco sin consultar", async () => {
    const { deps, llamadas } = conLectura(falsas({ datos: { claveRastreo: null } }), { banco: banorteConClaveSpin });
    const r = await validarComprobante(imagen, { usuario: "123", ahora: AHORA }, deps);
    expect(r.codigo).toBe("MISMO_BANCO");
    expect(llamadas.busquedas).toHaveLength(0);
  });

  it("si la persona escribió el banco en la nota, se respeta", async () => {
    const { deps, llamadas } = conLectura(falsas(), { banco: banorteConClaveSpin });
    const r = await validarComprobante(imagen, { usuario: "123", ahora: AHORA, nota: { banco: "BANORTE" } }, deps);
    expect(r.codigo).toBe("MISMO_BANCO");
    expect(llamadas.busquedas).toHaveLength(0);
  });
});

describe("otrosEmisores", () => {
  it("los otros bancos de las señales, del indicio más fuerte al más débil: clave, diseño, IA y texto", () => {
    const banco: EvaluacionBanco = {
      banco: "BANORTE",
      nombreLibre: null,
      suficiente: true,
      senales: { modelo: "BBVA", texto: "BANORTE", clave: "SPIN", firma: "NU" },
      candidatos: ["BANORTE", "BBVA", "SPIN", "NU"],
      motivo: "prueba",
    };
    expect(otrosEmisores(banco)).toEqual(["SPIN", "NU", "BBVA"]);
  });
});

describe("al probar bancos o cuentas posibles, la detección temprana también es una respuesta", () => {
  it("banco dudoso: con el primero la clave existe pero con otro monto → lo dice, no pregunta el banco", async () => {
    const dudoso: EvaluacionBanco = { ...bancoSpin, suficiente: false, candidatos: ["SPIN", "NU"], motivo: "contradicción" };
    const { deps, llamadas } = conLectura(falsas({ busquedas: [MONTO_DISTINTO] }), { banco: dudoso });
    const r = await validarComprobante(imagen, { usuario: "123", ahora: AHORA }, deps);
    expect(r).toMatchObject({ codigo: "MONTO_NO_COINCIDE", mensaje: MONTO_DISTINTO.mensaje });
    expect(llamadas.busquedas).toHaveLength(1);
  });
});
