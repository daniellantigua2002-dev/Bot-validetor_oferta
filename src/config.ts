/**
 * Configuración de negocio: cuentas destino, bancos y reglas.
 *
 * - Para agregar una cuenta propia: añade un objeto a CUENTAS_DESTINO (el campo `banco`
 *   debe ser una clave de BANCOS).
 * - Para agregar un banco emisor: añade una entrada a BANCOS. Si un banco no está en el
 *   mapa, el bot intenta encontrarlo directamente por su nombre en el catálogo de Banxico.
 *
 * Los nombres de catálogo salen de https://www.banxico.org.mx/cep/instituciones.do
 * (ver docs/banxico-cep.md). El catálogo cambia con la fecha, por eso cada banco lista
 * su nombre vigente y sus nombres históricos.
 */

export const ZONA_HORARIA = "America/Mexico_City";

// ---------------------------------------------------------------------------
// Cuentas destino (las únicas cuentas a las que un comprobante puede ser válido)
// ---------------------------------------------------------------------------

export const CUENTAS_DESTINO = [
  {
    banco: "BANORTE",
    titular: "Gabriel Alejandro Fondacaro Rielo",
    clabe: "072650010004755884",
    tarjeta: "4189143097841871",
    cuenta: "1000473306",
  },
  {
    banco: "INBURSA",
    titular: "MEXIOFERTAS",
    clabe: "036650500740571946",
    cuenta: "50074057194",
  },
  {
    banco: "BANAMEX", // Citibanamex
    titular: "Gabriel Alejandro Fondacaro Rielo",
    clabe: "002180702124616185",
    tarjeta: "5204166178808798",
    cuenta: "2461618",
  },
  {
    banco: "BANCOPPEL",
    titular: "Gabriel Alejandro Fondacaro Rielo",
    clabe: "137650105302649426",
    tarjeta: "4169160608474988",
    cuenta: "10530264942",
  },
] as const satisfies readonly DefinicionCuenta[];

// ---------------------------------------------------------------------------
// Reglas de negocio
// ---------------------------------------------------------------------------

export const REGLAS = {
  rechazarMismoBanco: true,
  // Fechas a consultar con fecha en el comprobante: esa fecha y estos días antes y después (D, D−1, D+1,
  // D−2, D+2), nunca futuras. Pedido del usuario (11-oct): ±2 alrededor de la fecha, no desde hoy.
  diasAlrededor: 2,
  // Sin fecha en el comprobante: hoy y estos días hacia atrás. Con una fecha posterior a hoy: los días
  // anteriores a ella que ya pasaron (12-oct con hoy 10 → 10 y 9); si es de más días adelante, de hoy hacia atrás.
  diasHaciaAtras: 3,
  // Banco Azteca solo muestra 3 dígitos de la cuenta destino ("Inbursa ***574").
  minDigitosTerminacion: 3,
  // Pagos ya validados (data/usados.json): con false no se guardan ni se revisan, y un comprobante
  // que se vuelve a enviar se valida otra vez. Decisión del usuario (10-oct): cada quien sabe qué validar.
  bloquearDuplicados: false,
  // Con pausas de ~2 s Banxico activó el captcha tras ~7 consultas; con 8 s no (docs/banxico-cep.md §5).
  pausaEntreConsultasMs: 6000,
  // Ruta rápida: con los datos del OCR (1–2 s) se hace una consulta a Banxico sin esperar a la IA.
  rutaRapida: true,
  // Comprobante "nocturno": desde esta hora, si es de días anteriores, también se prueba el día siguiente. En todos
  // los casos reales Banxico lo registró con la fecha del día del pago: BBVA imprime la del día siguiente ("09 octubre
  // 21:08" → Banxico 08/10); Compartamos (21:22), BanCoppel (18:11) y STP (18:07, 12-oct) aparecieron con la del mismo
  // día. Por eso, desde el 13-oct, uno de hoy que no aparece ya no recibe "valídalo mañana" sino "vuelve a enviarlo".
  horaInicioNocturno: "18:00",
  // BBVA de noche: desde esta hora (impresa) se busca primero el día anterior a la fecha impresa; entre
  // horaInicioNocturno y esta, primero la impresa. El celular puede ir 1 h adelante: "18:26" fue un pago de
  // las 17:27 con la fecha del mismo día; "20:45" y "21:08" ya traían la del día siguiente.
  horaDiaAnteriorPrimero: "19:00",
  // Si solo el modelo identifica el banco emisor (sin otra señal que lo confirme), confianza mínima para aceptarlo.
  confianzaMinimaBanco: 0.8,
};

/** Cómo se genera la foto del resultado que se devuelve al usuario. */
export const CAPTURA = {
  // "local": dibuja la respuesta que ya dio Banxico con los estilos del sitio (≈1–4 s, sin otra consulta).
  // "sitio": repite la consulta en el sitio con el navegador (≈15 s y una consulta más a Banxico).
  // Las dos dan la misma imagen; si una falla se usa la otra.
  modo: "local" as "local" | "sitio",
};

/** Parámetros técnicos de la consulta al CEP. */
export const BANXICO = {
  urlBase: "https://www.banxico.org.mx/cep/",
  timeoutMs: 60_000,
  reintentosRed: 3,
  // Si Banxico pide captcha ("La imagen de seguridad no fue ingresada correctamente") no se insiste: nadie le
  // pide nada durante 2 min (5 si lo vuelve a pedir dentro de la media hora siguiente, luego 10)…
  enfriamientoCaptchaMin: [2, 5, 10] as readonly number[],
  // …y durante 30 min después de cada captcha la pausa entre peticiones sube a 10 s.
  pausaTrasCaptchaMs: 10_000,
  duracionPausaTrasCaptchaMs: 30 * 60_000,
  // Lo que se guarda en disco para no volver a pedirlo: los catálogos de días pasados (no cambian) y los estilos de la foto.
  carpetaDisco: "data/banxico",
};

// ---------------------------------------------------------------------------
// Bancos
// ---------------------------------------------------------------------------

export interface DefinicionBanco {
  /** Nombre para mostrar al usuario. */
  nombre: string;
  /**
   * Nombres exactos en el catálogo de Banxico. El primero es el vigente; los demás son
   * históricos (por ejemplo, Nu se llamaba "NU MEXICO" con otro código). Vacío = pendiente.
   */
  catalogo: readonly string[];
  /** Textos con los que aparece en comprobantes. Se comparan sin acentos, en minúsculas y como palabra completa. */
  alias: readonly string[];
  /** Prefijos conocidos de la clave de rastreo. Se comparan respetando mayúsculas. */
  prefijosClave: readonly string[];
  /** Forma conocida de la clave de rastreo cuando no tiene un prefijo fijo. */
  patronClave?: RegExp;
  /**
   * Largos conocidos de su clave de rastreo completa (de comprobantes reales). Una clave de otro largo
   * pudo cortarse o leerse mal: entonces también se busca por referencia en las fechas vecinas.
   */
  largosClave?: readonly number[];
  /**
   * Frases propias del diseño de su comprobante (sobre el texto normalizado: minúsculas, sin acentos
   * ni signos). Sirven para reconocer el banco cuando el comprobante no escribe su nombre.
   */
  firmas?: readonly RegExp[];
  /** Referencia que la app pone sola: se prueba en Banxico si el comprobante no muestra ninguna. */
  referenciaHabitual?: ReferenciaHabitual;
  /** Fecha que lleva la clave de rastreo: otra fecha posible del pago (o la única, si el comprobante no la muestra). */
  fechaEnClave?: FechaEnClave;
  /**
   * De noche imprime la fecha de operación (la del día siguiente), pero Banxico registra el pago con
   * la fecha del día en que se hizo: se prueba primero el día anterior al del comprobante.
   */
  fechaSiguienteDeNoche?: boolean;
  /** Primeros 3 dígitos de sus CLABE (coinciden con los 3 últimos del código de Banxico). */
  prefijoClabe: string | null;
}

/**
 * Referencia que pone la app cuando la persona no escribe una:
 * - fija: siempre la misma.
 * - fecha: la fecha del pago (aaMMdd = 261007, ddMMaa = 071026, ddMMaa0 = 0710260).
 * - cuentaDestino: los últimos 7 dígitos de la cuenta destino.
 * - semanal: cambia con el tiempo; se aprende de los pagos validados (ver storage/referencias.ts).
 */
export type ReferenciaHabitual =
  | { tipo: "fija"; valor: string }
  | { tipo: "fecha"; formato: "aaMMdd" | "ddMMaa" | "ddMMaa0" }
  | { tipo: "cuentaDestino" }
  | { tipo: "semanal" };

/**
 * Dónde va la fecha dentro de la clave de rastreo: `patron` la captura en el grupo 1.
 * - aaMMdd / aaaaMMdd: la fecha del pago (BBVA de noche lleva la del día siguiente, como su comprobante).
 * - aaaaMMddHHmmss-utc: fecha y hora en UTC (Spin); se pasa a la fecha de CDMX.
 */
export interface FechaEnClave {
  patron: RegExp;
  formato: "aaMMdd" | "aaaaMMdd" | "aaaaMMddHHmmss-utc";
}

// Las referencias habituales, las firmas y las formas de clave salen de los comprobantes reales de
// "Imagenes de prueba" (oct-2026), confirmadas contra Banxico. Ver docs/comprobantes.md.
export const BANCOS = {
  // --- Bancos pedidos explícitamente ---
  BBVA: {
    nombre: "BBVA",
    catalogo: ["BBVA MEXICO"],
    alias: ["bbva", "bbva mexico", "bbva bancomer", "bancomer"],
    prefijosClave: ["MBAN"], // después de MBAN siempre va un cero (MBAN0…)
    // La referencia que pone BBVA cambia según la semana (del 05 al 09-oct fue 2309260): no se fija, se
    // aprende de los pagos BBVA validados y se usa solo para pagos de fechas cercanas.
    referenciaHabitual: { tipo: "semanal" },
    fechaSiguienteDeNoche: true,
    // "MBAN01002610090085509456" = MBAN0100 + aaMMdd (la fecha impresa) + 10 dígitos.
    fechaEnClave: { patron: /^MBAN0100(\d{6})/, formato: "aaMMdd" },
    largosClave: [24],
    firmas: [
      /\bcomprobante de la operacion\b.*\bimporte transferido\b/,
      /\bnombre del beneficiario de esta operacion es un dato no verificado\b/,
      /\bmonto transferido\b.*\bcuenta de ahorro\b/,
      /\bmban banca\b/, // "Lugar o canal: MBAN BANCA MOV" del detalle de movimiento
    ],
    prefijoClabe: "012",
  },
  AZTECA: {
    nombre: "Banco Azteca",
    catalogo: ["AZTECA"],
    alias: ["banco azteca", "azteca"],
    prefijosClave: [],
    // "261008011287636711I" o "2610070111717922482H": yyMMdd + 12 o 13 dígitos + letra.
    patronClave: /^\d{18,19}[A-Z]$/,
    fechaEnClave: { patron: /^(\d{6})\d{12,13}[A-Z]$/, formato: "aaMMdd" },
    largosClave: [19, 20],
    // La referencia son los últimos 7 dígitos de la cuenta destino ("Banamex ***185" → 4616185).
    referenciaHabitual: { tipo: "cuentaDestino" },
    firmas: [/\bguardadito\b/, /\benviaste a una cuenta\b/, /\btodos los envios se hacen en el horario zona centro\b/],
    prefijoClabe: "127",
  },
  SPIN: {
    nombre: "Spin by OXXO",
    catalogo: ["SPIN BY OXXO"],
    alias: ["spin by oxxo", "spin"],
    prefijosClave: ["SPIN-"], // "SPIN-" + fecha y hora UTC (14 dígitos) + 8 letras o dígitos
    fechaEnClave: { patron: /^SPIN-(\d{14})/, formato: "aaaaMMddHHmmss-utc" },
    largosClave: [27],
    firmas: [/^(?=.*\bdato no verificado por esta institucion\b)(?=.*\bid de movimiento\b)/],
    prefijoClabe: "728",
  },
  NU: {
    nombre: "Nu México",
    catalogo: ["NUBANK", "NU MEXICO"],
    alias: ["nu mexico", "nubank", "nu"], // "nu" solo cuenta si es todo el texto (ver bancosEnLinea)
    prefijosClave: [],
    prefijoClabe: "638",
  },
  MERCADO_PAGO: {
    nombre: "Mercado Pago",
    catalogo: ["Mercado Pago W"],
    alias: ["mercado pago", "mercadopago", "mercado pago w"],
    // La clave es "CPO" + el número de comprobante; si no aparece, la referencia son sus últimos 7 dígitos.
    prefijosClave: ["CPO"],
    prefijoClabe: "722",
  },
  BANORTE: {
    nombre: "Banorte",
    catalogo: ["BANORTE"],
    alias: ["banorte"],
    prefijosClave: [],
    // La referencia es la fecha del pago: 07-oct-2026 → 261007.
    referenciaHabitual: { tipo: "fecha", formato: "aaMMdd" },
    // 1 comprobante: "38432P04202610075861381568" = 5 dígitos + P04 + aaaaMMdd + 10 dígitos.
    fechaEnClave: { patron: /^\d{5}P04(\d{8})\d{10}$/, formato: "aaaaMMdd" },
    largosClave: [26],
    firmas: [
      /^(?=.*\btu transferencia fue exitosa\b)(?=.*\b(transferir a otros|envie)\b)/,
      /\brealizada desde banorte movil\b/,
    ],
    prefijoClabe: "072",
  },
  INBURSA: {
    nombre: "Inbursa",
    catalogo: ["INBURSA"],
    alias: ["inbursa", "banco inbursa"],
    prefijosClave: [],
    prefijoClabe: "036",
  },
  BANAMEX: {
    nombre: "Citibanamex",
    // Ojo: "CITI MEXICO" (40124) es otra institución.
    catalogo: ["BANAMEX"],
    alias: ["banamex", "citibanamex", "citi banamex", "banco nacional de mexico"],
    prefijosClave: [],
    // "085908810424327763" = 08590 + número de autorización (6 dígitos) + 7 dígitos.
    patronClave: /^08590\d{13}$/,
    largosClave: [18],
    // La referencia es la fecha del pago: 05-oct-2026 → 051026 (Banxico la guarda sin el cero: 51026).
    referenciaHabitual: { tipo: "fecha", formato: "ddMMaa" },
    firmas: [/\bmicuenta banamex\b/, /\bpara validarla consulta tu comprobante electronico de pago\b/],
    prefijoClabe: "002",
  },
  BANCOPPEL: {
    nombre: "BanCoppel",
    catalogo: ["BANCOPPEL"],
    alias: ["bancoppel", "coppel"],
    prefijosClave: [],
    // "50110910TRANSBPI19499334" (el OCR suele leer la I de TRANSBPI como 1).
    patronClave: /^\d{8}TRANSBP[I1l]\d{8}$/,
    largosClave: [24],
    // La referencia es la fecha del pago y un cero: 03-oct-2026 → 0310260.
    referenciaHabitual: { tipo: "fecha", formato: "ddMMaa0" },
    firmas: [/\bcuenta efectiva digital\b/, /\btu clave de rastreo es\b/],
    prefijoClabe: "137",
  },
  SANTANDER: {
    nombre: "Santander",
    catalogo: ["SANTANDER"],
    alias: ["santander", "supermovil"], // SuperMóvil es la app de Santander ("Ref. SuperMóvil")
    prefijosClave: [],
    // "2026100640014TRAPP020406130600" o "2026100340014BMOVP020431647380" = yyyyMMdd + 40014 (código de Santander) + …
    patronClave: /^\d{8}40014[A-Z]/,
    fechaEnClave: { patron: /^(\d{8})40014/, formato: "aaaaMMdd" },
    largosClave: [30],
    firmas: [/\bref supermovil\b/, /\brfc cliente santander\b/, /\btransferencia aceptada y confirmada\b/, /\bguardaste este contacto\b/],
    prefijoClabe: "014",
  },
  HSBC: {
    nombre: "HSBC",
    catalogo: ["HSBC"],
    alias: ["hsbc"],
    prefijosClave: [],
    prefijoClabe: "021",
  },
  SCOTIABANK: {
    nombre: "Scotiabank",
    catalogo: ["SCOTIABANK"],
    alias: ["scotiabank", "scotia"],
    prefijosClave: [],
    // 1 comprobante: 07-oct-2026 → 071026.
    referenciaHabitual: { tipo: "fecha", formato: "ddMMaa" },
    // "2026100740044B36L0000501290024" = aaaaMMdd + 40044 (código de Scotiabank) + …
    fechaEnClave: { patron: /^(\d{8})40044/, formato: "aaaaMMdd" },
    largosClave: [30],
    firmas: [/\bdel banco de mexico estara disponible en 10 minutos\b/],
    prefijoClabe: "044",
  },
  HEY_BANCO: {
    nombre: "Hey Banco",
    catalogo: ["HEY BANCO"], // no existe en el catálogo de 2024
    alias: ["hey banco", "hey"],
    prefijosClave: [],
    prefijoClabe: "167",
  },
  STORI: {
    nombre: "Stori",
    catalogo: [], // PENDIENTE: no aparece con ese nombre en el catálogo; confirmar con un comprobante real
    alias: ["stori"],
    prefijosClave: [],
    prefijoClabe: null,
  },
  KLAR: {
    nombre: "Klar",
    catalogo: ["KLAR"],
    alias: ["klar"],
    prefijosClave: [], // la clave es la parte del "Folio" antes de ":" (mayúsculas y minúsculas)
    prefijoClabe: "661",
  },
  OPENBANK: {
    nombre: "Openbank",
    catalogo: [], // PENDIENTE: no aparece con ese nombre en el catálogo; confirmar con un comprobante real
    alias: ["openbank"],
    prefijosClave: [],
    prefijoClabe: null,
  },

  // --- Otros emisores frecuentes ---
  BANREGIO: {
    nombre: "Banregio",
    catalogo: ["BANREGIO"],
    alias: ["banregio"],
    prefijosClave: [],
    prefijoClabe: "058",
  },
  BAJIO: {
    nombre: "BanBajío",
    catalogo: ["BAJIO"],
    alias: ["banbajio", "banco del bajio", "bajio"],
    prefijosClave: [],
    prefijoClabe: "030",
  },
  AFIRME: {
    nombre: "Afirme",
    catalogo: ["AFIRME"],
    alias: ["afirme"],
    prefijosClave: [],
    prefijoClabe: "062",
  },
  BIENESTAR: {
    nombre: "Banco del Bienestar",
    catalogo: ["BaBien"],
    alias: ["banco del bienestar", "bienestar", "babien"],
    prefijosClave: [],
    prefijoClabe: "166",
  },
  COMPARTAMOS: {
    nombre: "Compartamos",
    catalogo: ["COMPARTAMOS"],
    alias: ["compartamos"],
    prefijosClave: [],
    // 1 comprobante: 07-oct-2026 → 071026.
    referenciaHabitual: { tipo: "fecha", formato: "ddMMaa" },
    // 1 comprobante: "9095381180120261007212220" = 11 dígitos + aaaaMMdd + hhmmss.
    fechaEnClave: { patron: /^\d{10,12}(20\d{6})\d{6}$/, formato: "aaaaMMdd" },
    largosClave: [25],
    prefijoClabe: "130",
  },
  UALA: {
    nombre: "Ualá",
    catalogo: ["UALA", "ABC CAPITAL"],
    alias: ["uala"],
    prefijosClave: [],
    prefijoClabe: "138",
  },
  REVOLUT: {
    nombre: "Revolut",
    catalogo: ["REVOLUT BANK"],
    alias: ["revolut"],
    prefijosClave: [],
    prefijoClabe: "170",
  },
  ALBO: {
    nombre: "albo",
    catalogo: ["albo"],
    alias: ["albo"],
    prefijosClave: [],
    prefijoClabe: "721",
  },
  FONDEADORA: {
    nombre: "Fondeadora",
    catalogo: ["FONDEADORA"],
    alias: ["fondeadora"],
    prefijosClave: [],
    prefijoClabe: "699",
  },
  CUENCA: {
    nombre: "Cuenca",
    catalogo: ["Cuenca"],
    alias: ["cuenca"],
    prefijosClave: [],
    prefijoClabe: "723",
  },
  STP: {
    nombre: "STP",
    catalogo: ["STP"],
    alias: ["stp", "sistema de transferencias y pagos"],
    prefijosClave: [],
    prefijoClabe: "646",
  },
} as const satisfies Record<string, DefinicionBanco>;

export type ClaveBanco = keyof typeof BANCOS;

export interface DefinicionCuenta {
  banco: ClaveBanco;
  titular: string;
  clabe: string;
  tarjeta?: string;
  cuenta?: string;
}
