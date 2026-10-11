/**
 * Validadores de números de cuenta.
 */

const PESOS_CLABE = [3, 7, 1] as const;

/** Dígito de control de una CLABE (18 dígitos) según el estándar de la ABM. */
export function clabeValida(clabe: string): boolean {
  if (!/^\d{18}$/.test(clabe)) return false;
  let suma = 0;
  for (let i = 0; i < 17; i++) suma += (Number(clabe[i]) * PESOS_CLABE[i % 3]!) % 10;
  return (10 - (suma % 10)) % 10 === Number(clabe[17]);
}

/** Algoritmo de Luhn para tarjetas de débito o crédito. */
export function tarjetaValida(tarjeta: string): boolean {
  if (!/^\d{13,19}$/.test(tarjeta)) return false;
  let suma = 0;
  for (let i = 0; i < tarjeta.length; i++) {
    let d = Number(tarjeta[tarjeta.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    suma += d;
  }
  return suma % 10 === 0;
}
