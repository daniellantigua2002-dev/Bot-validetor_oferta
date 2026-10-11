# Progreso del bot validador SPEI

> Documento para retomar el trabajo. Última actualización: **11-oct-2026 por la tarde (hora de CDMX)**.
> El proyecto está en **git** desde el 11-oct (`git log` muestra los cambios).
> Para seguir, dile a Claude: *"Lee docs/PROGRESO.md y continúa"*.

## Estado: el bot está terminado y funcionando

| Fase | Estado | Resumen |
|---|---|---|
| 1. Investigar el CEP de Banxico | ✅ | Endpoints, campos y respuestas reales en [banxico-cep.md](banxico-cep.md) |
| 2. Estructura y configuración | ✅ | Proyecto TypeScript; [config.ts](../src/config.ts) con 3 cuentas y 28 bancos |
| 3. Extracción de la imagen | ✅ | NVIDIA (Kimi K3 y Llama 90B de respaldo) con OCR Tesseract en paralelo y cruce de 3 señales para el banco |
| 4. Normalización y reglas | ✅ | Las 6 reglas en orden; `data/usados.json` con escritura atómica |
| 5. Consulta a Banxico | ✅ | HTTP directo, reintentos y detección temprana de monto o cuenta alterados |
| 6. Captura, pipeline y CLI | ✅ | Foto de la tabla de Banxico, registro con la clave real y `npm run validar` |
| 7. Bot de Telegram | ✅ | **@validador_spei_mx_bot**, long polling, `ALLOWED_USER_IDS` en privado y `ALLOWED_CHAT_IDS` en grupos, cola y botones |
| 6.5 Optimizaciones | ✅ | Ruta rápida OCR → Banxico, modelo de respaldo y comprobante nocturno |

**Pruebas:** 596 pasan (`npm test`) y la comprobación de tipos está limpia (`npm run typecheck`).

**Verificado de punta a punta contra Banxico real** con el pago Spin → Banorte de $400 del 08-oct
(clave `SPIN-20261008200443959PNEB9`):
- ruta rápida: **6.9 s** (OCR 1.7 s, Banxico 1.8 s, foto 3.4 s);
- ruta normal con la IA: **18.3 s**.

## Cómo usarlo

- **Arrancar el bot:** doble clic en `iniciar-bot.bat`, o `npm run bot`. Funciona mientras esa ventana esté abierta.
- **En Telegram:** enviar la foto del comprobante en el grupo autorizado (o al bot en privado, solo `ALLOWED_USER_IDS`). Para mejor lectura, **como archivo**. Responde con la **foto de la tabla de Banxico** y un resumen. No envía PDF, por decisión del usuario.
- **Línea de comandos:** `npm run validar -- <imagen> [--sin-registro] [--banco X] [--cuenta BANORTE]`.
- Las capturas quedan en `data/capturas/`. Los pagos validados **ya no se guardan** (ver "Duplicados" en las decisiones).

## Cómo funciona una validación

1. **Lectura:** la IA (Kimi K3; si falla, Llama 90B; si falla, OCR) y el OCR local arrancan en paralelo.
2. **Ruta rápida:** en cuanto el OCR termina (1–2 s), si leyó el monto y el banco (por nombre, forma de la clave o diseño del comprobante) y las reglas pasan, se hace **una consulta** a Banxico. Si Banxico da una respuesta definitiva (validado, ya usado o no liquidado), se responde sin esperar a la IA. Si no, se espera a la IA y esa consulta no se repite.
   - Lo que la IA deja vacío y el OCR sí leyó (por ejemplo la fecha "02/oct/26") se toma del OCR (`completarConOcr`).
3. **Reglas:** es comprobante, datos mínimos (**monto**, y clave o referencia o una referencia habitual del banco; la fecha ya no es obligatoria), cuenta destino (3 dígitos; si no se ve, se **deduce** del banco destino o de la referencia de Azteca), mismo banco, fecha futura (BBVA de noche imprime "mañana" y no cuenta) y duplicado (solo si `REGLAS.bloquearDuplicados` es `true`).
   - **Antes de preguntar o de rechazar, Banxico decide** (`verificacionPrevia` en `pipeline.ts`): banco dudoso → los bancos posibles; cuenta que no se ve (con clave) → nuestras cuentas; cuenta que no es nuestra (con clave) → nuestra cuenta del banco destino, o todas si no se ve el banco; mismo banco con clave de rastreo → los otros bancos de las señales. Varias cuentas se prueban rápido (solo la clave, 2 fechas); una sola, completa. Si la clave aparece con otro monto o a otra cuenta, esa es la respuesta.
4. **Banxico:**
   - fechas: la del comprobante **±2 días** (D, D−1, D+1, D−2, D+2), más las otras fechas posibles (la de la imagen si la nota trae otra, la del OCR si no coincide con la de la IA, la que lleva la clave de rastreo); **sin fecha**, alrededor de la fecha de la clave y de hoy hacia atrás; **fecha posterior a hoy**, los 3 días anteriores a ella que ya pasaron; **BBVA de noche**, también el día anterior (primero, desde las 19:00);
   - orden: la fecha más probable completa. En las demás, **con clave**, primero la clave sola (¿existe ese día?): si no existe, ese día no se consulta más; si existe, se busca con nuestras cuentas y, si no aparece, es la detección temprana. **Sin clave**, la consulta más probable y luego las demás cuentas. La **referencia** en las fechas vecinas solo va si la fecha o la clave son dudosas (sin fecha, fecha posterior a hoy, clave de Mercado Pago o con un largo que no es el de su banco); siempre va en la fecha principal, en las otras fechas leídas (nota, OCR) y, de noche, en los dos días posibles. Se corta ordenadamente antes de los 5 min de la cola;
   - criterio: la clave, luego la referencia; si el comprobante no trae referencia, la **referencia habitual** del banco (Banorte aaMMdd, BanCoppel ddMMaa0, Banamex ddMMaa, Azteca últimos 7 de la cuenta…; BBVA no tiene: la suya cambia según la semana);
   - cuenta: la que coincidió y luego la CLABE; si la cuenta **no se vio**, todos sus números (tarjeta, CLABE, cuenta);
   - una clave cortada por la imagen vale si es el inicio de la de Banxico;
   - detección temprana de monto o cuenta alterados;
   - **segunda opinión del monto**: si la clave existe con otro monto, antes de responder "El monto no coincide" se prueba el otro monto leído (el del OCR si la IA leyó otro, o el de la imagen si la nota trae otro), solo en la fecha de la clave (`buscarConSegundaOpinion`);
   - comprobante nocturno.
5. **Registro** en `usados.json`: **desactivado** desde el 10-oct (`REGLAS.bloquearDuplicados = false`). Con `true`, se registra la clave real de Banxico antes de la foto.
6. **Foto:** se dibuja la tabla que devolvió Banxico con los estilos de su sitio (`CAPTURA.modo = "local"`, ~1–4 s). Si falla, se repite la consulta en el sitio con Playwright (~15 s).

**Cola** (`src/bot/cola.ts`): un comprobante a la vez, con **5 min como máximo** hasta registrar el pago (`LIMITE_POR_COMPROBANTE_MS`; eran 3 hasta el 11-oct). Al vencer, se cancela sin registrar nada y sigue el siguiente. Cada comprobante en espera ve su lugar en la fila. Se guarda en `data/cola.json`, así que, si el bot se reinicia, al arrancar retoma lo pendiente. Si ya se había registrado el pago, no lo toma como duplicado de sí mismo.

Todas las peticiones a Banxico (consultas, catálogos, los estilos de la foto y el navegador) pasan por un **turno global** (`src/banxico/ritmo.ts`) con 6 s de separación, también entre comprobantes distintos de la cola.

**Captcha** (desde el 11-oct): si Banxico lo pide, no se insiste. Nadie le consulta nada durante 2 min (5 si lo vuelve a pedir dentro de la media hora siguiente, luego 10) y después la pausa sube a 10 s durante 30 min. La búsqueda termina como "Banxico no disponible" y el comprobante queda esperando. La consola anota cuántas peticiones hubo en los 10 min anteriores, para conocer el límite real.

**Vigía** (`src/bot/vigia.ts`, desde el 11-oct): los comprobantes que esperan a Banxico no lo consultan cada uno por su cuenta. El vigía hace **una** petición liviana cada 3 min (el catálogo de hoy, `revisarBanxico`); cuando Banxico responde, todos salen a la cola, que los atiende de uno en uno. Al cumplir 1 h esperando se le responde a la persona.

**En disco** (`data/banxico/`): los catálogos de días pasados (no cambian) y la hoja de estilos de la foto se guardan y no se vuelven a pedir aunque el bot se reinicie. El de hoy, uno vacío o uno con el captcha activado no se guardan.

## Decisiones tomadas (cambios respecto al prompt original)

| Tema | Decisión | Motivo |
|---|---|---|
| Modelo de visión | `moonshotai/kimi-k3`, con respaldo `meta/llama-3.2-90b-vision-instruct` | `llama-4-maverick` ya no existe. En la comparación, Kimi acertó 20/20 campos y Llama 90B 14/20. Cada llamada tiene 75 s como máximo y sin reintento automático |
| Clave de rastreo | **No** se pasa a mayúsculas; solo se quitan espacios y se corrige `MBANO` → `MBAN0` | Banxico distingue mayúsculas |
| Dígitos de cuenta | `minDigitosTerminacion: 3` | Azteca solo muestra "***574" |
| Pausa entre consultas | 6 s, con turno global | Con ~2 s Banxico pidió captcha |
| Fechas | `diasAlrededor: 2` alrededor de la fecha del comprobante (antes, hoy−1 … hoy−3); `diasHaciaAtras: 3` sin fecha o con fecha posterior a hoy; máximo 8 fechas | Lo pidió el usuario (11-oct: ±2 días, no desde hoy) |
| Duplicados | Por **clave de rastreo**; sin clave, se decide con la clave real de Banxico | La referencia se repite (Azteca) |
| Varios pagos con la misma referencia | Si el comprobante trae clave, solo vale esa clave (hasta 2 errores de lectura); si no, un pago no usado | La clave es única |
| Sin dígitos de cuenta visibles | Se pregunta la cuenta con botones | Banxico verifica la cuenta completa |
| Detección temprana | Sondeo solo con la clave y otro con solo el monto → `MONTO_NO_COINCIDE` o `CUENTA_INCORRECTA` | Monto alterado detectado en ~16 s en lugar de ~52 |
| Comprobante nocturno | Desde `REGLAS.horaInicioNocturno = "18:00"`. Si es de hoy y no aparece: *"Valídalo mañana"*. Si es de antes, también se prueba D+1 | Banxico puede registrarlo con la fecha del día siguiente. **Las 18:00 son una suposición por confirmar** |
| Respuesta del bot | Solo la **foto** de la tabla de Banxico con el texto *"✅ Daniel, su comprobante fue validado."* (nombre de Telegram de quien lo envía). Sin resumen, sin PDF y sin revisar el titular | Decisión del usuario |
| Foto | Modo `local` (dibuja la respuesta real de Banxico) y como respaldo `sitio`. Las dos usan la misma presentación: solo la tabla, con marco blanco, celdas holgadas, fuente Roboto y etiquetas sin negrita (`ESTILO_CAPTURA`) | Imagen idéntica; ~4 s contra ~20 s. El estilo lo pidió el usuario con un ejemplo |
| Reacción | 👍 sobre el comprobante si se validó **o si es del mismo banco**; 👎 en los demás casos (incluye cancelar). Sin reacción mientras espera una respuesta de banco o cuenta | Pedido del usuario |
| Orden de reglas sin clave ni referencia | Antes de "datos insuficientes" se revisa si la cuenta no es nuestra (`CUENTA_INCORRECTA`) o si es el mismo banco (`MISMO_BANCO`), sin preguntar nada | Las transferencias entre cuentas del mismo banco (p. ej. Banorte → Banorte) no pasan por SPEI y no traen clave; el usuario quiere que se diga "mismo banco" |
| Solo imágenes | Todo lo que no sea una imagen (texto, números, stickers, audios, PDFs…) **se borra**, con un aviso que se borra solo a los 5 s (como mucho uno cada 8 s). `/start` y `/ayuda` muestran la ayuda | Pedido del usuario (`src/bot/filtro.ts`) |
| Progreso | Mensaje animado: pasos ✅ / reloj 🕐 que gira / ▫️ pendientes, barra ▰▱ con %, segundos y "escribiendo…" de Telegram. Se redibuja cada 1.5 s y respeta los límites de Telegram (429) | Pedido del usuario (`src/bot/progreso.ts`) |
| Cuenta Banorte | Se mantiene `cuenta: "1000473306"` | Decisión del usuario |
| Grupo de Telegram | En los grupos de `ALLOWED_CHAT_IDS` puede validar **cualquier miembro**; en privado, solo `ALLOWED_USER_IDS`. En el grupo se borra **todo** lo que no sea imagen (también lo de los administradores) y los avisos de Telegram (alguien entró o salió). Los botones de banco o cuenta solo los puede pulsar quien envió el comprobante. En grupos el progreso se redibuja cada 4 s y los envíos se reintentan si Telegram responde 429 (~20 mensajes por minuto por grupo). Si el grupo pasa a supergrupo, el bot acepta el ID nuevo y pide actualizar el `.env` | Pedido del usuario (09-oct) |
| Reglas del grupo (fases 3 y 4, 10-oct) | Solo JPG, PNG o WEBP de hasta 10 MB; además se revisan los primeros bytes del archivo. Las fotos con pie de foto **sí se aceptan** (decisión del usuario). **Una foto a la vez por persona**: si mandan dos juntas (álbum) o mandan otra mientras la anterior está en la cola o esperando la respuesta a una pregunta, la segunda se borra con un aviso. No basta con contar el álbum: los mensajes se atienden de uno en uno, así que la segunda foto llega cuando la primera ya está en la cola. En privado (solo `ALLOWED_USER_IDS`) no hay límite. Los mensajes **editados** se borran. Si Banxico no responde (o una validación supera el tiempo máximo mientras lo consulta), se publica *"Banxico no está respondiendo"* en el grupo; cuando vuelve, ese aviso se borra y se publica *"Banxico ya está respondiendo"* (se borra solo a los 10 min) | Pedido del usuario |
| Segunda opinión de la cuenta (10-oct) | Si la cuenta que leyó la IA no es nuestra pero la del OCR sí, se usa la del OCR (`cuentaSegunOcr` en `pipeline.ts`): Banxico verifica la cuenta completa. Además, el OCR ya reconoce terminaciones con un solo punto o sin él (BBVA `•1871`) y nunca toma como cuenta el valor de "Folio", "Referencia" u "Operación" del renglón siguiente. La bitácora muestra la cuenta leída y por qué falló la IA | Un BBVA → Banorte de $400 salió como "Cuentas incorrectas": el OCR tomó el folio `0555577886` como cuenta |
| Nota de la foto (10-oct) | Palabras clave `fecha, monto, clave, ref, banco, cuenta` separadas por coma, en cualquier orden (`src/extraction/nota.ts`). Sirve sobre todo para los datos que no aparecen en la imagen. **La nota manda**: si contradice a la imagen se valida con la nota y la respuesta avisa la diferencia. Si la imagen no es un comprobante, error aunque traiga nota. Lo que no se entiende se le dice a la persona; con "datos insuficientes" se sugiere la nota con lo que falta. `cuenta Banorte` usa nuestra CLABE de ese banco; una fecha sin año usa el año actual (o el anterior si quedaría en el futuro). La cuenta de la nota no se cambia por la del OCR | Pedido del usuario |
| Mercado Pago (10-oct) | **Primero la clave `CPO` + número de comprobante** (`#182949974794` → `CPO182949974794`) y, si no aparece, en la misma fecha la **referencia** = últimos 7 dígitos (`9974794`), salvo que el comprobante traiga su propia referencia. Una `clave` escrita en la nota manda sobre la CPO. `prefijosClave: ["CPO"]` | Indicación del usuario, confirmada en Banxico (validado a la primera con la clave CPO) |
| OCR sin monto (10-oct) | Si el OCR no ve el monto pero hay clave, referencia o número de comprobante, sigue siendo comprobante: la respuesta es "falta el monto" (y se puede escribir en la nota), no "no es un comprobante" | Mejor respuesta cuando falla la IA |
| BBVA sin referencia fija (10-oct) | La referencia que pone BBVA **cambia según la semana**: no se fija. Se **aprende** de los pagos BBVA validados (Banxico la devuelve) y se usa solo para BBVA sin referencia de fechas cercanas (±7 días; gana la más vista). Sin ninguna aprendida, se pide en la nota (`data/referencias-aprendidas.json`) | Indicación del usuario (del 05 al 09-oct fue 2309260, pero varía); el aprendizaje automático lo aceptó después |
| Reintentos solos (10-oct) | Pago de hace menos de 15 min no encontrado → se revisa a los 5 y a los 10 min. Banxico caído (o tan lento que se agota el tiempo) → cada 3 min hasta 1 h, o en cuanto vuelva. La lectura ya hecha se reutiliza y las esperas sobreviven a un reinicio (`src/bot/espera.ts`) | Recomendación aceptada por el usuario |
| Gemini de respaldo (10-oct) | Carrera escalonada: NVIDIA (Kimi) primero; si falla o no responde en 30 s arranca Gemini (`GEMINI_API_KEY`), y al final Llama. Gana la primera respuesta válida | NVIDIA falló en 6 de 37 imágenes y a veces tarda más de 2 min |
| Banco dudoso (10-oct) | Antes de preguntar con botones se prueban en Banxico hasta 3 bancos posibles (2 fechas cada uno) | Banxico solo encuentra el pago con el banco correcto |
| Guía fijada (10-oct) | Al arrancar (y cuando le dan el permiso "Fijar mensajes") el bot fija en el grupo la guía con las palabras de la nota. Reemplaza la recomendación de un mensaje fijado con instrucciones por banco | Pedido del usuario |
| Comprobantes reales (10-oct) | Se analizaron los 37 comprobantes de `Imagenes de prueba/` y se confirmaron en Banxico: referencias habituales por banco, BBVA nocturno con la fecha del día siguiente, Santander con dos referencias (gana "Número de referencia"), cuenta deducida, firmas de diseño por banco (cuarta señal del banco emisor), formas de clave de BanCoppel, Citibanamex y Azteca. Todo en `docs/comprobantes.md` | Pedido del usuario: validar cualquier comprobante, primero que valide y luego la velocidad |
| Segunda opinión del monto (11-oct) | Si Banxico tiene la clave con otro monto, se prueba el otro monto leído (OCR, o el de la imagen si la nota trae otro) en la fecha de la clave. Si aparece, se valida (la consola dice "monto corregido"); si aparece a otra cuenta, "Cuentas incorrectas"; si no, "El monto no coincide" | Pedido del usuario: un monto mal leído rechazaba para siempre un comprobante bueno |
| Cuenta ajena con clave (11-oct) | Antes de "Cuentas incorrectas", si hay clave de rastreo, se busca en nuestra cuenta del banco destino con todos sus números; si el comprobante no dice el banco destino, en las 4 (rápido); si dice otro banco, no se consulta. Sin clave, o con la cuenta escrita en la nota, se rechaza como antes | Pedido del usuario: una cuenta mal leída se rechazaba sin consultar |
| Cuenta no visible con clave (11-oct) | Antes de preguntar la cuenta con botones se prueban nuestras cuentas posibles (rápido: solo la clave, 2 fechas). Sin clave se pregunta directo | Pedido del usuario: si la persona no contesta los botones, se pierde la validación |
| Mismo banco con clave (11-oct) | Una transferencia entre cuentas del mismo banco no pasa por SPEI y no trae clave. Si el comprobante trae clave, se prueban los otros bancos que indican las señales (clave, diseño, IA, texto; hasta 3). Si alguno aparece se valida; si no, "mismo banco" con su mensaje. Si todas las señales dicen el mismo banco, si no hay clave o si la persona escribió el banco en la nota, "mismo banco" sin consultar | Pedido del usuario: "que analice bien si son del mismo banco" |
| Opciones concluyentes (11-oct) | Al probar bancos o cuentas posibles, la detección temprana (la clave existe con otro monto o a otra cuenta) también termina la prueba y es la respuesta | Antes, con un banco dudoso, se seguía probando y al final se preguntaba el banco |
| Tiempo máximo 5 min (11-oct) | `LIMITE_POR_COMPROBANTE_MS = 5 min` (antes 3). Más tiempo para buscar, a costa de que la fila espere más | Pedido del usuario |
| Menos peticiones a Banxico (11-oct, madrugada) | Captcha sin reintentos (enfriamiento de 2, 5 y 10 min), vigía único para los que esperan a Banxico, catálogos y estilos en disco, y en las fechas vecinas primero la clave sola (la referencia solo si la fecha o la clave son dudosas). Un pago que no existe pasa de 12 a 6 consultas (Spin) y de 20 a 8 (Mercado Pago del 02-oct); uno encontrado en una fecha vecina gasta una consulta más (la clave sola) | Que Banxico no pida captcha. **Costo:** si la clave se leyó mal sin cambiar de largo y además el pago está en otra fecha, ya no se busca por referencia en esa fecha |
| Duplicados (10-oct) | **Desactivado** (`REGLAS.bloquearDuplicados = false`): no se lee, no se revisa ni se guarda `data/usados.json`; un comprobante que se vuelve a enviar se valida otra vez. Con `true` vuelve todo (revisión antes y después de Banxico y registro) | Decisión del usuario: cada quien sabe qué comprobante validar |

## Pendientes

- [ ] **⭐ SIGUIENTE: reconocer los comprobantes de papel y avisar que no se validan** (pedido del usuario el 10-oct; ampliado el 11-oct de los tickets de OXXO a **todos los comprobantes de papel**). **No programar todavía:** el usuario enviará varios comprobantes de papel para analizarlos y después dirá cómo hacerlo.
  - **Qué debe hacer el bot:** si la foto es de un comprobante **impreso en papel** (ticket de tienda, depósito en ventanilla o en cajero, etc.), **no consulta Banxico** y responde con un aviso de que ese comprobante no se valida en el CEP. Son pagos en efectivo o en ventanilla, no transferencias SPEI: no traen clave de rastreo ni se pueden buscar en el CEP.
  - **Texto propuesto** (el usuario pidió algo como *"este comprobante no se valida en el CEP"*, más profesional; falta que lo apruebe):
    > ⚠️ **Comprobante no válido para verificación.** Los comprobantes impresos (tickets de tienda, depósitos en ventanilla o en cajero) no corresponden a una transferencia SPEI, por lo que no pueden validarse en el CEP de Banxico.
  - **Al analizar las muestras:** solo aprender las señales de cada tipo de papel; **no consultar Banxico** (ver "Cómo trabaja el usuario").
  - **Lo que ya se sabe del ticket de OXXO** (OXXO Pay en efectivo; ejemplo del 09/10/2026 17:22, $890.00, "COBRO DE OXXO PAY", referencia de 14 dígitos, "Ecart Pay SAPI de CV"). Señales: "Cadena Comercial Oxxo", "COBRO DE OXXO PAY", "PAGADO EL DIA … EN EL TICKET #", "FOLIO DE CONTROL", "VALOR PAG.", "Folio de autorización proveedor", "Folio de WM", "FEMSA DIGITAL", "CONSERVE ESTE COMPROBANTE"; además, papel térmico fotografiado.
  - **Cuidado:** el ticket de OXXO menciona "SPIN PAGOS, SAPI DE CV", pero **no** es lo mismo que el comprobante digital de la app **Spin by OXXO**, que sí es una transferencia SPEI y sí se valida (por ejemplo, el Spin → Banorte de $400 del 08-oct). Tampoco hay que confundir una **foto de la pantalla** del celular o de la computadora con un papel. La detección no debe rechazar comprobantes digitales buenos.
  - **Por decidir al implementarlo:** el texto final, la reacción (👎 como en los demás rechazos) y qué hacer si el papel trae una nota con clave de rastreo.
- [ ] **⭐ SIGUIENTE: ajustes de las cuentas que se prueban en Banxico** (análisis del 11-oct; el usuario pidió guardarlos para implementarlos, **no programar hasta que lo pida**). Regla del usuario: **si se tiene la cuenta, solo esa; si solo se sabe el banco (por ejemplo Banorte), todos los números de ese banco**. Las fechas (±2 días) y la referencia **no cambian**.
  - **Por qué importa:** Banxico no dice a qué cuenta fue un pago (las filas Cuenta Beneficiaria y Monto solo salen si se le envían): responde sí o no a la cuenta que se le da. Cada consulta cuesta ~6 s y suma riesgo de captcha.
  - **Dato real:** en los 16 comprobantes de `Imagenes de prueba/` con dato de Banxico, la cuenta visible **siempre** fue la que registró Banxico (tarjeta → tarjeta, CLABE → CLABE). Los 3 sin cuenta visible fueron a la tarjeta Banorte.
  - Cifras de una simulación con un Banxico falso (sin red); el número de caso es el del análisis:

  | # | Ajuste | Hoy | Qué resuelve |
  |---|---|---|---|
  | 3 | **⚠️ El más importante.** La nota "cuenta Banorte" debe probar **la tarjeta y la CLABE** de ese banco y **no reemplazar** el número de la imagen si es de la misma cuenta (…1871 + "cuenta Banorte" → se queda la tarjeta) | La nota se guarda como la CLABE (`nota.ts`, `cuenta`) y borra el número de la imagen sin avisar. Pago real a la tarjeta Banorte: con clave responde **"Cuentas incorrectas"** (3 consultas); solo con referencia, **"No encontrado"** (5) | **Pagos buenos rechazados.** La guía fijada enseña a escribir "cuenta Banorte" |
  | 1 | Cuenta visible → **solo ese número**: quitar el respaldo de la CLABE (`cuentasAIntentar`, `[c.tipo, "clabe"]`) | …1871 → tarjeta y luego la CLABE. Solo referencia y el pago no existe: **10 consultas** (5 días × 2) | Pasa a 5 (~30 s menos). Riesgo: una app que muestre la tarjeta y Banxico tenga la CLABE (0 de 16 casos reales); se corrige con la nota |
  | 2 | **Número de cuenta suelto** visible (…3306) → consultar directo la **CLABE** de esa cuenta | Primero el número suelto (nunca funciona: SPEI solo acepta CLABE, tarjeta o celular, ver banxico-cep.md) y luego la CLABE: validado en 2 consultas | Pasa a 1. Preventivo: no hubo casos reales |
  | 4 | Cuenta **no visible** y banco destino **ajeno** (por ejemplo BBVA) → **"Cuentas incorrectas" sin consultar** | `verificacionPrevia`, `REQUIERE_CONFIRMACION_CUENTA`: prueba tus 4 cuentas (**12 consultas**, más de 1 min) y luego pregunta con botones | Tiempo, captchas y una pregunta que confunde. Corrige una incoherencia: con la cuenta visible ajena ya no se prueba si el banco es otro (`cuentasDelBancoDestino`). Riesgo: que la IA confunda origen con destino; se corrige reenviando con la nota |
  | 5 | Cuenta visible **ajena** (con clave): **mantener** la prueba de tu cuenta del banco destino si es uno de los tuyos; **quitar** la prueba de las 4 cuando no se ve el banco → "Cuentas incorrectas" | Sin banco visible prueba las 4 (**12 consultas**) | No gastar más de 1 min en cuentas de otras personas (carpeta 8: BanCoppel …8852). Se queda la segunda opinión del OCR (`cuentaSegunOcr`) |
  | 7 | Cuenta **deducida** (no visible, banco Banorte) → probar **tarjeta y CLABE**, sin el número suelto (`ORDEN_CUENTA_DEDUCIDA`) | Prueba tarjeta, CLABE y número suelto: solo referencia y no existe, **15 consultas**; con clave, 9 | Pasa a 10 y 8 |
  | 6 | **Sin cambios:** sin cuenta ni banco visibles se siguen probando rápido las 4 cuentas antes de los botones | — | Sin datos para elegir; si la persona no responde los botones, se pierde la validación (decisión del 11-oct, punto 6) |
  - Si un día hay **más de una cuenta en el mismo banco**, "solo se sabe el banco" debe probar todas las de ese banco (hoy hay una por banco: `deducirCuenta` solo deduce si hay una).
- [x] **Comprobantes reales** (10-oct): 37 de `Imagenes de prueba/` con sus datos esperados en `tests/fixtures/imagenes-prueba.json`. `npm run probar-imagenes` mide el OCR (`--ia` la IA, `--banxico` la validación completa). OCR: de 8 a 23 de 37 lecturas exactas.
- [ ] Probar en el grupo con comprobantes nuevos para medir la tasa de éxito real.
- [ ] **Volver a poner la carpeta `Imagenes de prueba/`** en el proyecto: el 11-oct ya no estaba y `npm run probar-imagenes` falla sin ella. No se guarda en git (son comprobantes reales).
- [ ] Antes de desplegar: que el bot no se apague (pm2 o arranque con Windows, sin suspensión), darle al bot el permiso **"Fijar mensajes"** en el grupo y correrlo en **un solo lugar** (si corre en la PC y en el servidor a la vez, Telegram responde 409 y ninguno funciona bien).
- [x] **git** (11-oct): repositorio local con el proyecto guardado. Fuera de git: `.env`, `node_modules/`, `data/`, `.cache/` e `Imagenes de prueba/`.
- [x] **Fechas alrededor de la fecha del comprobante, ±2 días** (pedido del usuario; hecho el 11-oct). Antes, con fecha se probaba esa fecha y luego hoy−1 … hoy−3: un Mercado Pago del **02-oct** ($990, `CPO181053611151`) enviado el **10-oct** se probó el 02, 09, 08 y 07-oct (12 de 16 consultas inútiles). Ahora `fechasAIntentar` prueba D, D−1, D+1, D−2, D+2 (`REGLAS.diasAlrededor = 2`), nunca futuras y como máximo 8 fechas: ese comprobante se busca del 30-sep al 04-oct. Sin fecha, sigue de hoy hacia atrás.
  - **Orden de las consultas** (para caber en el tiempo máximo de la cola, hoy 5 min): la fecha más probable completa; en las demás fechas, primero la consulta más probable (clave o referencia con la cuenta vista), luego la clave sola (¿existe ese día?; si existe con otra cuenta o monto, detección temprana en cualquier fecha) y al final lo que falta.
  - **Corte ordenado:** el bot pasa a la búsqueda el límite de la cola (`limite`); no se empieza una consulta si no alcanza (6 s de pausa + 15 s de margen). Termina con "no encontrado" y lo dice ("Se acabó el tiempo…") en lugar de que la cola lo corte y lo tome como Banxico caído.
- [x] **Recomendaciones para comprobantes viejos** (hechas el 11-oct):
  1. **Mensaje claro.** En el grupo ya no va la lista de intentos (queda en la consola del bot): *"Banxico no tiene ningún pago con la clave de rastreo CPO181053611151: busqué del 30/09 al 04/10/2026 (20 consultas)."* cuando la clave sola no existe en ninguna fecha; si no, *"No se encontró el pago en Banxico: busqué del … al … (N consultas)."* Más la sugerencia de escribir la fecha en la nota (si la nota no trae una).
  2. **La fecha de la nota con ±2 días** (sale con lo anterior). Si la nota trae otra fecha que la imagen, la de la imagen se prueba después (`notaAplicada.fechaImagen`).
  3. **IA y OCR con fechas distintas:** la del OCR se prueba después de la de la IA (`fechasAlternativas` en `pipeline.ts`).
  4. **Fecha dentro de la clave** (`BANCOS[…].fechaEnClave`): BBVA, Azteca, Spin (UTC → CDMX), Santander, Scotiabank, Banorte y Compartamos. Va como otra fecha posible; un comprobante **sin fecha** se busca primero alrededor de la fecha de su clave.
- [x] **Fecha adelantada** (hecho el 11-oct). La regla 5 ya no rechaza sin consultar: con hoy 10 y el comprobante del 12 se busca del 9 al 12 (los que ya pasaron: 10 y 9, de hoy hacia atrás). Si aparece, se valida; si no, *"Valida este comprobante en 1 o 2 días: la fecha del comprobante (12/10/2026) es posterior a hoy y el pago todavía no aparece en Banxico; busqué del 09/10 al 10/10/2026 (…)"*. Si es de más de 3 días adelante (ninguno de esos días ya pasó), se toma como mal leída: de hoy hacia atrás y el aviso *"puede estar mal leída"*. BBVA de noche con la fecha de mañana sigue igual.
- [x] **Pago devuelto con foto** (pedido del usuario el 11-oct). Si Banxico dice Devuelto (también "En proceso de devolución" o "Retornado"), la respuesta es la de siempre (*"El pago existe en Banxico pero su estado es "Devuelto"."*) y además la foto de la tabla de Banxico (`data/capturas/…_devuelto.png`). No se registra como validado.
- [x] **Para que no se rechace un comprobante bueno** (pedido del usuario el 11-oct, puntos 2, 3, 4, 6 y 7 del análisis): segunda opinión del monto, cuenta ajena con clave, cuenta no visible con clave, mismo banco con clave y tiempo máximo de 5 min. Detalle en "Decisiones tomadas".
- [ ] **Dejados pendientes por el usuario el 11-oct** (no programar hasta que lo pida): el punto 9 del análisis (más muestras de comprobantes: prefijos de clave de Banorte, Compartamos, Nu y Klar; referencias de una sola muestra, ver más abajo). El reconocimiento de los comprobantes de papel está al principio de esta lista.
- [x] Comprobante **nocturno** (10-oct): Banxico registra el pago con la fecha del día en que se hizo; BBVA imprime la del día siguiente ("09 octubre 21:08" → Banxico 08/10; con 09-10 no lo encuentra). Compartamos (21:22) y Santander (22:06) imprimen el mismo día. El corte de BBVA está entre las 17:27 y las 20:45: `REGLAS.horaDiaAnteriorPrimero = "19:00"`.
  - **Dato real (09-oct):** un pago Santander → Banorte de las **22:06 del 06-oct** también se encontró con la fecha 06-10 a la primera.
  - **Dato real (09-oct):** un pago BBVA → Banorte de las **20:45 del 07-oct** se encontró consultando con la fecha **07-10** (la de calendario), aunque su clave `MBAN0100261008…` lleva 261008. Indica que la consulta del CEP usa la fecha de calendario. La regla nocturna no estorba (primero siempre se prueba la fecha del comprobante), pero su mensaje *"valídalo mañana"* quizá casi nunca haga falta.
- [x] OCR con el formato "Comprobante de transferencia" de **Mercado Pago** (10-oct): si en modo bloque no aparece el monto, segunda lectura en modo automático (`PSM.AUTO`) que sí ve `$ 690 MXN`; bajo "Origen y destino" la primera cuenta es la de origen; el `#` leído como `4` se corrige; la clave `CPO` se deduce del número de comprobante (segunda señal del banco). Ese comprobante ahora valida por la ruta rápida en ~10 s (antes ~19 s) y funciona aunque falle la IA.
- [ ] Comprobantes de **Stori** y **Openbank**: su `catalogo` está vacío en `config.ts`.
- [ ] Ir llenando los **prefijos de clave de rastreo** de cada banco (hoy: BBVA, Spin, Mercado Pago, Azteca, Santander, BanCoppel y Citibanamex; faltan muestras de Banorte, Compartamos, Nu, Klar…).
- [ ] Confirmar con más comprobantes las referencias habituales de una sola muestra (Scotiabank y Compartamos ddMMaa).
- [x] Cuenta **BanCoppel** de la empresa agregada a `CUENTAS_DESTINO` (10-oct): tarjeta 4169160608474988, CLABE 137650105302649426, cuenta 10530264942. La tarjeta BanCoppel …8852 de la carpeta 8 es de otra persona y sigue dando "Cuentas incorrectas".
- [x] Regla de **Mercado Pago** confirmada el 10-oct con un pago real ($690 del 07-oct, comprobante `#182949974794`): los últimos 7 dígitos del número de comprobante son la **referencia** (`9974794`), no la clave de rastreo. Antes se usaban como clave y Banxico no lo encontraba. Banxico devolvió como clave real `CPO182949974794` y el usuario confirmó que en Mercado Pago la clave siempre es **"CPO" + el número de comprobante**: es lo primero que se prueba.
- [x] **Grupo de Telegram** "Validator SPEI" (`-1004435287266`) conectado el 10-oct: bot administrador con permiso de borrar y privacidad apagada. `/id` da el ID de un grupo nuevo (y lo anota en `data/grupos-detectados.txt`); en el grupo autorizado se borra como cualquier texto. La ayuda se borra sola a los 30 s. Falta probar con un comprobante real en el grupo.

## Ideas propuestas y no decididas todavía

- Del análisis del 11-oct, sin decidir: que el bot no se apague (Fase 2: pm2, arranque con Windows, sin suspensión; el 11-oct estaba apagado con 3 comprobantes en `data/cola.json`), leer la imagen mientras el comprobante espera en la cola (hoy la lectura con IA también va en fila), y comprobantes de Stori y Openbank.
- Bitácora de resultados en un archivo (Fase 5) para medir la tasa de éxito real por banco: propuesta y descartada por ahora (10-oct).
- Huella de la imagen para rechazar al instante reenvíos de la misma foto.
- Usar la fecha que traen algunas claves (Spin, Azteca) para elegir la fecha correcta.
- Volver a consultar sola un pago "En proceso" a los 5 minutos.
- Profesionalizar:
  - subir el repositorio de git a uno privado en internet (el local ya existe desde el 11-oct);
  - pm2 para reinicio automático;
  - bitácora de auditoría;
  - alertas.

## Mapa del código

```
src/
  index.ts               arranca el bot
  config.ts              CUENTAS_DESTINO, REGLAS, CAPTURA, BANXICO y BANCOS
  entorno.ts             .env (NVIDIA_API_KEY, NVIDIA_MODEL, NVIDIA_MODEL_RESPALDO, TELEGRAM_BOT_TOKEN, ALLOWED_USER_IDS, ALLOWED_CHAT_IDS)
  pipeline.ts            orquestador (ruta rápida y ruta normal)
  cli.ts                 npm run validar
  extraction/            prompt, nvidia (modelo principal y respaldo), OCR, campos-texto, banco-emisor, index
  normalize/             clave, monto, fecha, hora, banco → catálogo, validadores
  rules/index.ts         las 6 reglas, MENSAJES y confirmaciones
  storage/usados.ts      data/usados.json
  banxico/               parser, cliente, catálogo (memoria y disco), reintentos (búsqueda, detección temprana, nocturno,
                         revisarBanxico), ritmo (turno global y enfriamiento por captcha)
  capture/screenshot.ts  foto de la tabla (local o en el sitio)
  bot/                   index (grammY), mensajes (textos y botones), filtro (qué se acepta), cola (fila con tiempo máximo),
                         cola-guardada (data/cola.json), espera (reintentos solos), vigia (una revisión de Banxico para
                         todos los que lo esperan), estado-banxico (avisos de caída), progreso (animación)
  storage/archivo.ts     escritura atómica de JSON (usados.json y cola.json)
docs/banxico-cep.md      todo lo descubierto del CEP
iniciar-bot.bat          arranque con doble clic
```

## Cómo trabaja el usuario

- Avanzar por fases, mostrar un resumen y esperar su confirmación.
- Pedirle las cosas poco a poco.
- Todo en español.
- Cuando manda comprobantes para **analizarlos** (aprender), no se consulta Banxico sin su permiso: aprender no es validar.
