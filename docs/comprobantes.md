# Comprobantes por banco: cómo lucen y qué patrones esconden

Aprendido de los 56 archivos de `Imagenes de prueba/` (37 comprobantes y sus capturas de Banxico, del
28-sep al 09-oct-2026). Cada patrón marcado con ✅ se confirmó con una consulta real a Banxico.
Los datos esperados de cada imagen están en `tests/fixtures/imagenes-prueba.json`, y
`npm run probar-imagenes` mide al bot contra ellos (`--ia` también la IA, `--banxico` la validación completa).

## Patrones útiles (los que el bot ya usa)

| Patrón | Dónde se usa | Evidencia |
|---|---|---|
| **BBVA: la referencia cambia según la semana** (del 05 al 09-oct fue 2309260 en todos) | No se fija: se **aprende** de los pagos BBVA validados y se usa para BBVA sin referencia de fechas cercanas (±7 días). Sin ninguna aprendida, va en la nota | 10 de 10 comprobantes BBVA de esa semana; Banxico responde "demasiadas coincidencias" si se busca sin cuenta |
| ✅ **BBVA de noche imprime la fecha del día siguiente** | Se busca primero el día anterior; "mañana" no cuenta como fecha futura | "09 octubre 21:08" → Banxico 08/10 21:09; "08 octubre 20:45" → Banxico 07/10. Con la fecha impresa Banxico **no** lo encuentra |
| ✅ **Banorte: la referencia es la fecha aaMMdd** | Si el comprobante no la muestra (no la muestra nunca) | 07-oct-2026 → `261007` |
| ✅ **Banco Azteca: la referencia son los últimos 7 dígitos de la cuenta destino** | Para deducir la cuenta destino y el banco cuando no se ven | `0000013` = tarjeta Banorte …0000013; `0000037` = CLABE Banamex …0000037 |
| **BanCoppel: la referencia es la fecha ddMMaa + 0** | Si no se lee | 03-oct → `0310260`, 05-oct → `0510260` (`510260` sin el cero) |
| **Citibanamex, Scotiabank, Compartamos: la referencia es la fecha ddMMaa** | Si no se lee | 05-oct → `51026`, 07-oct → `071026` |
| ✅ **Mercado Pago: clave = "CPO" + número de comprobante; referencia = sus últimos 7 dígitos** | Siempre | `#182949974794` → `CPO182949974794`, ref `9974794` |
| ✅ **Santander con dos referencias**: Banxico usa el "Número de referencia", no la "Ref. SuperMóvil" | Lectura (OCR e IA) | `194620` sí, `1109400` no |
| ✅ **Banxico acepta la referencia con cero inicial** | — | `071026` encuentra el pago guardado como `71026` |
| ✅ **Sin cuenta destino, Banxico sí busca por clave y monto** | — | La respuesta no trae la cuenta: el bot prueba nuestros números para confirmar que es nuestra |
| ✅ **Sin monto, Banxico confirma el pago pero no dice el monto** | El monto sigue siendo obligatorio (se pide en la nota) | Carpeta 10 |
| **La hora del comprobante puede ir 1 h adelante** (celular en otra zona horaria) | Para elegir entre pagos idénticos se tolera ±1 h | BBVA 18:26 → Banxico 17:27 |
| **Los comprobantes sin fecha suelen ser de hoy o de días recientes** | Se busca de hoy a 3 días atrás; si la clave lleva la fecha (BBVA, Azteca, Spin, Santander, Scotiabank, Banorte, Compartamos), primero alrededor de esa fecha (`fechaEnClave`) | Carpetas 2, 6 y 17 |

## Formas de la clave de rastreo

| Banco | Forma | Ejemplo |
|---|---|---|
| BBVA | `MBAN01002` + aaMMdd (fecha impresa) + 10 dígitos | `MBAN01002610090085509456` |
| Santander | aaaaMMdd + `40014` + letras y dígitos | `2026100340014BMOVP020431647380` |
| Banco Azteca | aaMMdd + 12 o 13 dígitos + una letra | `261008011288078433I`, `2610070111717922482H` |
| Spin by OXXO | `SPIN-` + fecha y hora **UTC** (14 dígitos) + 8 caracteres | `SPIN-20261006164228VIO0HYLN` |
| BanCoppel | 8 dígitos + `TRANSBPI` + 8 dígitos | `50110910TRANSBPI19499334` |
| Citibanamex | `08590` + número de autorización (6) + 7 dígitos | `085905400064327868` (autorización 540006) |
| Banorte | `38432P04` + aaaaMMdd + 10 dígitos (1 muestra) | `38432P04202610075861381568` |
| Compartamos | 12 dígitos + aaaaMMdd + hhmmss (1 muestra) | `9095381180120261007212220` |
| Scotiabank | aaaaMMdd + `40044` + … (no aparece en el comprobante) | `2026100740044B36L0000501290024` |
| Mercado Pago | `CPO` + número de comprobante (no aparece en el comprobante) | `CPO182949974794` |
| HSBC | `HSBC` + dígitos (1 muestra, cortada) | `HSBC729857…` |
| albo | aaaaMMdd + 5 dígitos + `ALBO` + 13 dígitos | `2026101590721ALBO1920322744767` |
| Inbursa | `036NAPP` + ddMMyyyy + dígitos | `036NAPP29092026301309216` |
| BanBajío | `BB` + dígitos (1 muestra, 15 caracteres) | `BB2473115020808` |
| Consubanco / Uber Pro Card | `CSB0` + aaaaMMdd + dígitos | `CSB020261018080851208892077` |

En BBVA "Detalle de movimiento", el **folio de operación** (`0083280746 072`) son los últimos 10 dígitos
de la clave más el código del banco destino (072 = Banorte).

## Cómo luce cada comprobante

- **BBVA** (azul marino):
  - "COMPROBANTE DE LA OPERACION": todo (folio, fecha, hora, concepto, clave, importe, `•` + 4 dígitos de origen y destino, "Cuenta BANORTE" = banco destino). Sin referencia.
  - "Transferencia exitosa" (círculo verde, "Monto transferido", "Origen Cuenta de Ahorro •2929", "Destino nombre •8798 Cuenta Banamex"): **sin fecha, clave ni referencia** → el bot pide la referencia en la nota (`ref …`); con ella busca de hoy hacia atrás.
  - "Detalle de movimiento" (dos columnas, "Lugar o canal: MBAN BANCA MOV"): referencia, clave, fechas; **sin monto ni cuenta** (solo "Banco destino").
- **Banorte** (rojo): "¡Tu transferencia fue exitosa! · Transferir a otros · Envié $… MN" con columnas "Desde | Para" (izquierda origen, derecha destino); sin clave ni referencia, y la fecha va al pie (a veces recortada). También correo "Te informamos los detalles de tu operación realizada desde: Banorte Móvil".
- **Banco Azteca** (verde, logo circular verde con centro rojo): "Enviaste a una cuenta", fecha "08/Oct/2026 17:54:22 (CST)", origen "Guardadito", "Banamex ***185", referencia y clave. Su "Detalle de movimiento" (verde, "Transferencia Bancaria", "No. de referencia") no tiene logo ni nombre.
- **Santander** (llama roja): "¡Enviaste una transferencia! / Comprobante", "BANORTE - TDD **1871" (destino), fecha "08/oct/26 - 10:25", "Ref. SuperMóvil", a veces "Número de referencia", "RFC cliente Santander", estatus "En proceso". Otro diseño: "TRANSFERENCIA ACEPTADA Y CONFIRMADA" con clave, referencia y banco destino, sin cuenta.
- **BanCoppel**: "Transferencia exitosa", "$400⁰⁰ Monto transferido" (centavos en superíndice: el OCR lee 40000), "CUENTA EFECTIVA DIGITAL" de origen, "BANORTE/IXE *1871", "Tu clave de rastreo es:".
- **Citibanamex**: "Transferencia exitosa · Esta transferencia ha sido aceptada…", "MiCuenta Banamex **459", "CARLOS R**871" (3 dígitos), "Número de autorización", clave de 18 dígitos, "Referencia numérica". A veces sin fecha.
- **Spin by OXXO** (morado): fecha arriba, "Enviaste $…", "BANORTE - ****1871" o la CLABE completa, "Número de cuenta Spin" (**origen**), referencia, "ID de movimiento", clave `SPIN-…`.
- **Mercado Pago**: "Comprobante de transferencia", "$ 690 MXN" (letra grande), "Origen y destino" (primero origen, luego destino), "Comprobante #…".
- **Compartamos** (magenta): "¡Transferencia exitosa!", todo en dos columnas, referencia ddMMaa.
- **Scotiabank** (rojo): "Transferencia exitosa · Enviaste $790.00 a …", cuenta de origen "Scotia Nomina Clasica *8198", referencia ddMMaa (071026), folio, sin clave.
- **HSBC** (rojo): dos formatos. (1) "Resumen de operación" en tabla: "Cuenta Flexible Simple HSBC ****9561", "Banco receptor: 002-BANAMEX", "Referencia numérica: 02", "Clave de rastreo: HSBC729857…"; (2) "Confirmación" con "Transferencia exitosa", "Institución bancaria: HSBC", "Nómina Flexible HSBC *****5986", "Cuenta destino: Transferencia Express Tarjeta de débito ****871", "Banco receptor: BANORTE", "Referencia numérica: 0171026". La clave empieza con "HSBC".
- **albo** (azul): comprobante minimalista en tarjeta blanca: monto, "Nombre: Nicolas", fecha y hora, tarjeta parcial (4169 16** **** 8852 = destino), concepto, clave de rastreo "2026101590721ALBO1920322744767". Sin referencia visible.
- **Inbursa** (azul): logo "INBURSA", "Traspaso SPEI" (otro banco) o "Traspaso a tercero" (mismo banco), folio, monto, fecha, cuenta de origen con tipo ("TIPO CUENTA SANBORNS ****0700" o "NOMINA INBURSA ****1603"), destinatario con banco y tarjeta/CLABE. Clave de rastreo: "036NAPP29092026301309216" (036 = prefijo CLABE Inbursa, fecha ddMMyyyy).
- **BanBajío** (morado/verde): logo "BanBajío" con "BB", "Operación exitosa", "Transferencia SPEI", cuenta de origen (********2101, Nómina 1), ordenante (JORGE ISAAC CORTES ESPINOZA), beneficiario, cuenta destino completa (4169161484898852 = BanCoppel), referencia (2473115), "No. Autorización" (138235041), clave de rastreo "BB2473115020808".
- **Consubanco / Uber Pro Card** (negro/blanco): "Uber Pro Card · Powered by" (logo Consubanco), "Envío exitoso", monto grande ($500), fecha, "Para: nicolas alejandro josid", "Cuenta destino: 0708178789", mensaje del remitente, clave rastreo "CSB020261018080851208892077".
- **Klar** (morado): dos formatos. (1) App oscura: "Detalles de transacción", "Transferencia enviada", monto, fecha, estado "Completada", destinatario, CLABE, banco, mensaje, referencia (5214022), folio largo con ":" (la clave es lo que va antes de ":"). (2) PDF/correo: "Klar · Transferencia realizada", monto, destinatario, tarjeta destino (****6574), cuenta origen (****9198), referencia (0875218), concepto, fecha.

## Casos de la carpeta que no se pueden validar (y es correcto)

- **Carpeta 8** (Banorte → BanCoppel tarjeta …8852, de Nicolas A Josid) y **Varios** (Spin → Banamex `002180701849395151`, de Fernando): son cuentas que no están en `CUENTAS_DESTINO` → "Cuentas incorrectas". La cuenta BanCoppel de la empresa (agregada el 10-oct) es otra: tarjeta …4988, CLABE …9426.
- **BBVA "Transferencia exitosa"** (carpetas 2 y 6) y la de la **clave cortada** (carpeta 3): sin referencia hace falta escribirla en la nota.
- **Varios, Banorte → Banorte** (correo de Banorte Móvil): mismo banco, no pasa por SPEI.
- **Carpeta 10**: no muestra el monto → el bot lo pide en la nota (`monto 400`).
- **Varios, Citibanamex sin fecha**: si es de hace más de 3 días, hace falta la fecha en la nota.
- **Carpeta 20**: la captura de Banxico de esa carpeta es de **otro pago** (BBVA del 06-10, $990); el comprobante es un Azteca del 07-10 que el bot sí valida.
