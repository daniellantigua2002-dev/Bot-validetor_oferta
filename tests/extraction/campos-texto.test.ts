import { describe, expect, it } from "vitest";
import { bancoEmisorPorTexto, extraerDeTexto } from "../../src/extraction/campos-texto.js";
import { DatosExtraidosSchema } from "../../src/extraction/schema.js";
import {
  TEXTO_AZTECA,
  TEXTO_BANCOPPEL,
  TEXTO_BANORTE_A_INBURSA,
  TEXTO_BANORTE_INTERNA,
  TEXTO_BBVA,
  TEXTO_BBVA_DETALLE,
  TEXTO_BBVA_EXITOSA,
  TEXTO_BBVA_OPERACION,
  TEXTO_KLAR,
  TEXTO_MERCADO_PAGO,
  TEXTO_MERCADO_PAGO_TRANSFERENCIA,
  TEXTO_NO_COMPROBANTE,
  TEXTO_SANTANDER,
  TEXTO_SANTANDER_DOS_REFERENCIAS,
  TEXTO_SPIN,
  TEXTO_SPIN_INBURSA,
} from "./textos-ocr.js";

describe("extraerDeTexto", () => {
  it("Spin → Banorte: clave partida en dos líneas, CLABE completa y beneficiario", () => {
    const d = extraerDeTexto(TEXTO_SPIN);
    expect(d).toMatchObject({
      esComprobante: true,
      bancoEmisor: { nombre: "Spin by OXXO", fuente: "texto" },
      esMercadoPago: false,
      cuentaDestino: "072000000000000012",
      claveRastreo: "SPIN-20261008200443959PNEB9",
      referencia: "7454748",
      numeroOperacion: null,
      fecha: "2026-10-08",
      hora: "14:04:43",
      monto: 400,
      beneficiario: "Carlos Alberto Ramírez Soto",
    });
    expect(DatosExtraidosSchema.safeParse(d).success).toBe(true);
  });

  it("Azteca → Inbursa: ignora la cuenta de origen y toma la terminación de 3 dígitos", () => {
    const d = extraerDeTexto(TEXTO_AZTECA);
    expect(d).toMatchObject({
      esComprobante: true,
      bancoEmisor: { nombre: "Banco Azteca", fuente: "texto" },
      cuentaDestino: "574",
      claveRastreo: "261008011287636711I",
      referencia: "4936574",
      fecha: "2026-10-08",
      hora: "17:09:36",
      monto: 890,
    });
  });

  it("Klar: clave desde el Folio, modo 12 h, CLABE con espacios y sin la hora del celular", () => {
    const d = extraerDeTexto(TEXTO_KLAR);
    expect(d).toMatchObject({
      esComprobante: true,
      cuentaDestino: "012180001234567890",
      claveRastreo: "27SsrAVomLDdm0HAqpDehA",
      referencia: "5214022",
      fecha: "2026-09-22",
      hora: "16:52",
      monto: 1352,
      beneficiario: "Beneficiario De Prueba",
    });
    // "Banco BANAMEX" es el destino, no el emisor.
    expect(d.bancoEmisor.nombre).toBeNull();
  });

  it("BBVA: conserva la clave tal cual (la corrección MBANO → MBAN0 es de la normalización)", () => {
    const d = extraerDeTexto(TEXTO_BBVA);
    expect(d).toMatchObject({
      bancoEmisor: { nombre: "BBVA" },
      cuentaDestino: "5884",
      claveRastreo: "MBANO1002610080012345678",
      referencia: "1234567",
      fecha: "2026-10-08",
      hora: "10:15:20",
      monto: 1032,
    });
  });

  it("BBVA 'Comprobante de la operación': la terminación sin punto es la cuenta destino, no el folio de 10 dígitos", () => {
    const d = extraerDeTexto(TEXTO_BBVA_OPERACION);
    expect(d).toMatchObject({
      bancoEmisor: { nombre: "BBVA" },
      cuentaDestino: "1871",
      claveRastreo: "MBANO1002610090090453121",
      fecha: "2026-10-09",
      monto: 400,
      beneficiario: "pago de champu",
    });
  });

  it("terminación con un solo punto en el mismo renglón ('Cuenta de destino •1871')", () => {
    expect(extraerDeTexto("Transferencia\nImporte $400.00\nCuenta de destino •1871").cuentaDestino).toBe("1871");
  });

  it("el valor de 'Folio' en el renglón siguiente nunca es la cuenta, aunque tenga 10 dígitos", () => {
    expect(extraerDeTexto("Transferencia\nImporte $400.00\nFolio de la operación\n0555577886").cuentaDestino).toBeNull();
  });

  it("Mercado Pago 'Comprobante de transferencia': la cuenta destino es la segunda bajo 'Origen y destino', y el '#' leído como '4' se corrige", () => {
    const d = extraerDeTexto(TEXTO_MERCADO_PAGO_TRANSFERENCIA);
    expect(d).toMatchObject({
      bancoEmisor: { nombre: "Mercado Pago" },
      esMercadoPago: true,
      cuentaDestino: "1871",
      numeroOperacion: "#182949974794",
      claveRastreo: "CPO182949974794",
      fecha: "2026-10-07",
      hora: "14:41",
      monto: null,
    });
    // Sin monto sigue siendo comprobante: la respuesta será "falta el monto", no "no es comprobante".
    expect(d.esComprobante).toBe(true);
  });

  it("Mercado Pago con el renglón del monto que agrega la segunda lectura del OCR", () => {
    expect(extraerDeTexto(`${TEXTO_MERCADO_PAGO_TRANSFERENCIA}\n$ 690 MXN`).monto).toBe(690);
  });

  it("Mercado Pago: el banco por texto es Mercado Pago (no se descarta por 'Seguridad de Mercado Pago' al final)", () => {
    expect(bancoEmisorPorTexto(TEXTO_MERCADO_PAGO_TRANSFERENCIA)).toBe("MERCADO_PAGO");
  });

  it("Mercado Pago: el número de comprobante con '#' se toma tal cual", () => {
    expect(extraerDeTexto("Mercado Pago\nComprobante\n#182949974794").numeroOperacion).toBe("#182949974794");
  });

  it("Mercado Pago: número de operación y fecha en texto", () => {
    const d = extraerDeTexto(TEXTO_MERCADO_PAGO);
    expect(d).toMatchObject({
      esComprobante: true,
      esMercadoPago: true,
      bancoEmisor: { nombre: "Mercado Pago" },
      cuentaDestino: "8798",
      numeroOperacion: "#182949974794",
      fecha: "2026-10-09",
      hora: "11:05",
      monto: 250.5,
    });
  });

  it("Santander: 'Ref. SuperMóvil', fecha con '0ct' y el renglón 'Banco BANORTE' es el destino", () => {
    const d = extraerDeTexto(TEXTO_SANTANDER);
    expect(d).toMatchObject({
      esComprobante: true,
      bancoEmisor: { nombre: "Santander", fuente: "texto" },
      cuentaDestino: "1871",
      claveRastreo: null,
      referencia: "3315988",
      fecha: "2026-10-06",
      hora: "22:06",
      monto: 990,
    });
  });

  it("Banorte en dos columnas (Desde | Para): no toma la cuenta de origen como destino", () => {
    const d = extraerDeTexto(TEXTO_BANORTE_INTERNA);
    expect(d).toMatchObject({ bancoEmisor: { nombre: "Banorte" }, claveRastreo: null, referencia: null, monto: 400, fecha: "2026-10-06" });
    expect(d.cuentaDestino).not.toBe("6962");
  });

  it("la referencia admite una palabra antes de los dígitos, no una frase", () => {
    expect(extraerDeTexto("Comprobante\nMonto $10.00\nReferencia SuperMóvil 1234567").referencia).toBe("1234567");
    expect(extraerDeTexto("Comprobante\nMonto $10.00\nReferencia Pago de renta 2").referencia).toBeNull();
  });

  it("un texto cualquiera no es comprobante", () => {
    const d = extraerDeTexto(TEXTO_NO_COMPROBANTE);
    expect(d.esComprobante).toBe(false);
    expect(d.monto).toBeNull();
  });
});

describe("bancoEmisorPorTexto", () => {
  it("ignora el banco de la sección destino", () => {
    expect(bancoEmisorPorTexto(TEXTO_AZTECA)).toBe("AZTECA");
    expect(bancoEmisorPorTexto(TEXTO_SPIN)).toBe("SPIN");
    expect(bancoEmisorPorTexto(TEXTO_KLAR)).toBeNull();
  });
});

describe("extraerDeTexto: formatos de los comprobantes reales", () => {
  it("BBVA 'Transferencia exitosa': cuenta '•8798' leída como ':8798', ignora la comisión de $0.00 y el banco sale del diseño", () => {
    const d = extraerDeTexto(TEXTO_BBVA_EXITOSA);
    expect(d).toMatchObject({
      bancoEmisor: { nombre: "BBVA" },
      cuentaDestino: "8798",
      bancoDestino: "Citibanamex",
      monto: 490,
      fecha: null,
      claveRastreo: null,
      referencia: null,
    });
  });

  it("BBVA 'Detalle de movimiento': une la clave y la fecha partidas en dos renglones; sin cuenta, con el banco destino", () => {
    const d = extraerDeTexto(TEXTO_BBVA_DETALLE);
    expect(d).toMatchObject({
      bancoEmisor: { nombre: "BBVA" },
      claveRastreo: "MBANO1002610080083280746",
      referencia: "2309260",
      fecha: "2026-10-08",
      hora: "15:02:31",
      cuentaDestino: null,
      bancoDestino: "Banorte",
      monto: null,
    });
  });

  it("Banorte → Inbursa en columnas: la cuenta de la derecha y el banco de la derecha son el destino", () => {
    const d = extraerDeTexto(TEXTO_BANORTE_A_INBURSA);
    expect(d).toMatchObject({ bancoEmisor: { nombre: "Banorte" }, cuentaDestino: "1946", bancoDestino: "Inbursa", monto: 300 });
    expect(bancoEmisorPorTexto(TEXTO_BANORTE_A_INBURSA)).not.toBe("INBURSA");
  });

  it("BanCoppel: 'Tu clave de rastreo es:' con la clave abajo; referencia ddMMaa0", () => {
    const d = extraerDeTexto(TEXTO_BANCOPPEL);
    expect(d).toMatchObject({
      bancoEmisor: { nombre: "BanCoppel" },
      claveRastreo: "50110910TRANSBP119499334",
      referencia: "0310260",
      fecha: "2026-10-03",
      hora: "18:29:46",
      cuentaDestino: "1871",
      bancoDestino: "Banorte",
      monto: 400,
    });
  });

  it("Spin: 'Número de / referencia' partido en dos renglones; el número de cuenta Spin no es el destino", () => {
    const d = extraerDeTexto(TEXTO_SPIN_INBURSA);
    expect(d).toMatchObject({
      bancoEmisor: { nombre: "Spin by OXXO" },
      referencia: "7358003",
      cuentaDestino: "036000000000000029",
      claveRastreo: "SPIN-20261006164228VIOOHYLN",
      fecha: "2026-10-06",
      monto: 590,
    });
  });

  it("Santander con dos referencias: gana el 'Número de referencia'; fecha con año de 2 dígitos", () => {
    const d = extraerDeTexto(TEXTO_SANTANDER_DOS_REFERENCIAS);
    expect(d).toMatchObject({ referencia: "194620", fecha: "2026-10-03", hora: "18:22", cuentaDestino: "5884", monto: 1490 });
  });

  it("máscaras que el OCR deforma: '*+**41871' es …1871 y ':4191' en el origen no es el destino", () => {
    expect(extraerDeTexto("Transferencia\nImporte $10.00\nBANORTE - *+**41871").cuentaDestino).toBe("1871");
    expect(extraerDeTexto("Transferencia\nImporte $10.00\nOrigen Cuenta de Ahorro :4191\nDestino Carlos -:1871").cuentaDestino).toBe("1871");
  });

  it("monto sin signo de pesos (Santander: '-1,300.00 MXN')", () => {
    expect(extraerDeTexto("-1,300.00 mu\n03 Octubre, 2026\n1224769\nTRANSFERENCIA ACEPTADA").monto).toBe(1300);
    expect(extraerDeTexto("Transferencia\nReferencia 1234567\nFolio 0083280746").monto).toBeNull();
  });

  it("un renglón con la forma de clave de un banco, sin etiqueta (Santander sin rótulos)", () => {
    expect(extraerDeTexto("-1,300.00\n03 Octubre, 2026\n2026100340014BMOVP020431647380\nTRANSFERENCIA ACEPTADA").claveRastreo).toBe(
      "2026100340014BMOVP020431647380",
    );
  });
});
