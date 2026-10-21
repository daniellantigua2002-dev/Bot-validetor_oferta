/**
 * Textos de OCR de ejemplo. Los de Spin, Azteca y Klar reproducen comprobantes reales
 * (con los datos de terceros anonimizados); los de BBVA y Mercado Pago son sintéticos.
 */

export const TEXTO_SPIN = `spin
by OXXO
08/10/2026 02:04:43 p.m.
Enviaste
$400.00
a Carlos Alberto Ramírez Soto
*Dato no verificado por esta institución
BANORTE - 072000000000000012
En proceso de verificación
Número de cuenta Spin 9500507116211835576
Número de referencia 7454748
ID de movimiento #6ac7f75b25b51c8ff3734
3c5
Clave de rastreo SPIN-20261008200443959
PNEB9
Monto Total: $400.00
Consulta tu Comprobante Electrónico de Pago (CEP) en
www.banxico.org.mx/cep/`;

export const TEXTO_AZTECA = `Enviaste a una cuenta
$890.00
08/Oct/2026 17:09:36 (CST)
40660 Cdad. Altamirano, Guerrero
Cuenta origen
Nomina Azteca Tradicional
***4516
Cuenta destino
Pagó
Inbursa ***574
Concepto
pago
Referencia
4936574
Consulta el estatus en:
https://www.banxico.org.mx
/cep
Clave de rastreo
261008011287636711I
Este vínculo se activará a más
tarde dentro de los primeros
5 minutos siguientes de la
aceptación de la operación.
Todos los envíos se hacen en el
horario zona centro de México
(CST).
Folio: 27202610817935456`;

export const TEXTO_KLAR = `9:33
Detalles de transacción
-$1,352 00
Transferencia enviada
22 sep 2026, 4:52 p.m.
Compartir recibo
Estado Completada
Destinatario Beneficiario De Prueba
CLABE 0121 80001 23456 7890
Banco BANAMEX
Mensaje Pago de prueba
Referencia 5214022
Folio 27SsrAVomLDdm0HAqpDehA:4
5ab9593-b6d8-11f1-94c7-
fd064d2e4c5c`;

export const TEXTO_BBVA = `BBVA
Comprobante de transferencia
Importe $1,032.00
Cuenta destino ****5884
Clave de rastreo MBANO1002610080012345678
Referencia 1234567
Fecha de operación 08/10/2026 10:15:20`;

export const TEXTO_MERCADO_PAGO = `mercado pago
Transferencia enviada
$ 250.50
Para Carlos Alberto Ramírez Soto
Banamex ****8798
Número de operación #182949974794
9 de octubre de 2026 a las 11:05 hs`;

/** Santander (SuperMóvil) → Banorte: OCR real (RFC del cliente anonimizado). Sin clave de rastreo. */
export const TEXTO_SANTANDER = `| d Comprobante
Enviaste $990.00 MXN
por el concepto “Transferencia a Carlos Alejandro
Fondac”.
GA
Carlos Alberto Ramírez Sotoros

BANORTE - TDD **1871
Fecha y hora de operación 06/0ct/2026 - 22:06
Cuenta origen CTA **1997
Banco BANORTE
Estatus de la operación Exitosa
Ref. SuperMóvil 3315988
Tipo de operación SPEI
RFC cliente Santander XAXX010101000`;

/** Banorte → Banorte (transferencia interna, sin clave ni referencia): OCR real, dos columnas "Desde | Para". */
export const TEXTO_BANORTE_INTERNA = `¡Tu transferencia fue exitosa!
Transferir a otros
Envié
$ 400.00 mMN
Desde Para
UD
Nómina Banorte sin Cheqg... CARLOS A**** p*=* R**=-
BANORTE
Cuenta ****6962 Cuenta ***3306
Concepto de transferencia: tomasa cerda suarez
06/10/2026 - 13:14:05`;

export const TEXTO_NO_COMPROBANTE = `Hola, ¿cómo estás?
Te mando la foto mañana
Saludos`;

/**
 * BBVA (formato "COMPROBANTE DE LA OPERACION", 09-oct) tal como lo lee el OCR: la cuenta destino
 * "•1871" queda sin el punto y el "Folio de la operación" (10 dígitos) va en la línea siguiente.
 */
export const TEXTO_BBVA_OPERACION = `COMPROBANTE DE LA OPERACION
Tipo de operación
Transferencia a otros bancos
Folio de la operación
0555577886
Fecha
09 octubre 2026
Hora
18:26h
Concepto
pago de natalia
Clave de rastreo
MBANO1002610090090453121
Importe transferido
$ 400.00
Cuenta de origen
5201
Nombre del beneficiario
pago de champu
Nombre del banco
Cuenta BANORTE
Cuenta de destino
1871
Verifica el estatus de tu operación en
https:/www.banxico.org.mx/cep/
Información sobre aclaración SPEI en
www.bbva.mx`;

/**
 * Mercado Pago "Comprobante de transferencia" (07-oct) tal como lo lee el OCR en modo bloque: no
 * aparece el monto en letra grande ("$ 690 MXN"), las dos cuentas van bajo "Origen y destino" y el
 * "#" del número de comprobante se lee como "4".
 */
export const TEXTO_MERCADO_PAGO_TRANSFERENCIA = `oO | WALLET
Comprobante de transferencia
7/octubre/2026 alas 14:41.
Origen y destino
«» Benito Ortiz
Mercado Pago Wallet
CLABE: ****3529
” Carlos Alejandro fondacaro rielo
BANORTE
Número de tarjeta: ****1871
Comprobante
4182949974794
Protegemos tu dinero en
cada paso
Seguridad de Mercado Pago`;

// --- Comprobantes reales de "Imagenes de prueba" tal como los lee el OCR (oct-2026) -------------

/** BBVA, pantalla "Transferencia exitosa": sin fecha ni clave; el punto de "•8798" se lee como ":". */
export const TEXTO_BBVA_EXITOSA = `Transferir x
Cerrar
Transferencia
exitosa
Monto transferido

Origen Cuenta de Ahorro
*2929
Destino alejandro :8798
Cuenta Banamex

(D El nombre del beneficiario de esta operación es
un dato no verificado por la institución.

Comisión $ 0.00
$490.00`;

/** BBVA, "Detalle de movimiento" en dos columnas: la clave y la fecha quedan partidas en dos renglones. */
export const TEXTO_BBVA_DETALLE = `< Detalle de movimiento
Volver
Nombre del Carlos Alejandro
beneficiario Ramírez Soto
Banco destino Banorte
Lugar o MBAN BANCA
canal MOV
Referencia numérica 2309260
Clave de MBANO10026100800
rastreo 83280746
Folio de 0083280746
operación 072
Fecha de 08 octubre
operación 2026
Hora de operación 15:02:31 h
Fecha de 08 octubre
aplicación 2026
Hora de aplicación 15:02:44 h
Verifica el estatus de tu operación`;

/** Banorte → Inbursa en dos columnas "Desde | Para"; el OCR lee las máscaras como comillas. */
export const TEXTO_BANORTE_A_INBURSA = `¡Tu transferencia fue exitosa!
Transferir a otros
Envié
$ 300.00 mn
Desde Para
CUENTA ENLACE PERSO... INBURSA
Cuenta "4008 CLABE *="1946`;

/** BanCoppel: "Tu clave de rastreo es:" con la clave en el renglón siguiente (la I leída como 1). */
export const TEXTO_BANCOPPEL = `Transferencia exitosa
$400.00
Monto transferido
03/10/2026 - 06:29:46 p.m.
Fecha y hora de la transacción
Cuenta destino
BANORTE/IXE *1871
Carlos alejandro fondacaro
Cuenta origen
CUENTA EFECTIVA DIGITAL *9091
BanCoppel
Datos de tu transferencia
Referencia 0310260
Comisión $0.00
Tu clave de rastreo es:
50110910TRANSBP119499334`;

/** Spin: "Número de referencia" partido en dos columnas y la CLABE completa del destino. */
export const TEXTO_SPIN_INBURSA = `spin
06/10/2026 10:42:39 a.m.
Enviaste Y
$590.00
a Comerciodemo
*Dato no verificado por esta institución
INBURSA - 036000000000000029
Aceptada
Número de cuenta  950050261654941
Spin 6390
Número de 7358003
referencia
ID de movimiento H6ac524f50df80df7
01f63b9b
Clave de rastreo SPIN-20261006164
228VIOOHYLN
Concento Envío de Luis
Monto Total: $590.00`;

/** Santander con "Ref. SuperMóvil" y además "Número de referencia" (Banxico usa este). */
export const TEXTO_SANTANDER_DOS_REFERENCIAS = `Comprobante
Enviaste $1,490.00 MXN por el concepto
Carlos Alberto Ramírez Soto
BANORTE - CLABE **5884
Fecha y hora de operación 03/Oct/26 - 18:22
Cuenta origen CTA **5970
Banco BANORTE
Estatus de la operación Exitosa
Ref. SuperMóvil 1109400
Tipo de operación SPEI
Número de referencia 194620
RFC cliente Santander MEGL820402MAA`;
