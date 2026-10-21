import type { RegistroUsado } from "../../src/storage/usados.js";

/** Registro de usados de ejemplo (comprobante Spin → Banorte), modificable por test. */
export const registro = (cambios: Partial<RegistroUsado> = {}): RegistroUsado => ({
  claveRastreo: "SPIN-20261008200443959PNEB9",
  referencia: "7454748",
  monto: "400.00",
  fecha: "2026-10-08",
  cuenta: "072000000000000012",
  emisor: "SPIN BY OXXO",
  usuario: "cli",
  validadoEn: "2026-10-08T20:10:00.000Z",
  ...cambios,
});
