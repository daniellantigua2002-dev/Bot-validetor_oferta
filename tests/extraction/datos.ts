import type { DatosExtraidos } from "../../src/extraction/schema.js";

/** Datos extraídos de ejemplo (comprobante Spin → Banorte), modificables por test. */
export function datosEjemplo(cambios: Partial<DatosExtraidos> = {}): DatosExtraidos {
  return {
    esComprobante: true,
    descripcionVisual: "Fondo blanco, logo morado 'spin by OXXO'.",
    bancoEmisor: { nombre: "Spin by OXXO", fuente: "logo", confianza: 0.95 },
    esMercadoPago: false,
    cuentaDestino: "072000000000000012",
    claveRastreo: "SPIN-20261008200443959PNEB9",
    referencia: "7454748",
    numeroOperacion: null,
    fecha: "2026-10-08",
    hora: "14:04:43",
    monto: 400,
    beneficiario: "Carlos Alberto Ramírez Soto",
    ...cambios,
  };
}
