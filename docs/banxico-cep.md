# CEP de Banxico: endpoints y comportamiento

Investigación hecha el 08/09-oct-2026 sobre https://www.banxico.org.mx/cep/ (versión del sitio **v.3.8.6**) con
Playwright (`scripts/explorar-cep.ts`), lectura del JavaScript del sitio (`js/cep-min.js` y `js/validations/*.js`) y
peticiones directas con `curl`. Se usaron 3 pagos reales: Spin → Banorte, Azteca → Inbursa y Klar → Banamex.

Leyenda: ✅ verificado con peticiones reales · 🟡 deducido del JavaScript del sitio, sin confirmar.

## Resumen

| Uso | Método y ruta | Sesión | Estado |
|---|---|---|---|
| Catálogo de instituciones | `GET /cep/instituciones.do?fecha=dd-MM-yyyy` | No | ✅ |
| Consultar Pago: tabla con el estado | `POST /cep/valida.do` con `tipoConsulta=0` | No | ✅ |
| Descargar CEP: genera el CEP | `POST /cep/valida.do` con `tipoConsulta=1` | No (crea una) | ✅ |
| Archivo del CEP | `GET /cep/descarga.do?formato=PDF\|XML\|ZIP` | **Sí**, la de `valida.do` con `tipoConsulta=1` | ✅ |
| PDF "Reporte de estado de pago" (la tabla) | `POST /cep/descargaComprobanteSPEI.do` (`htmlCEPImprimir`) | Sí | ✅ (vía navegador) |
| Confirmación de cuenta ordenante | `POST /cep/depura.do` (`cuenta`) | Sí | 🟡 no se usará |
| Texto de obligaciones de los bancos | `GET /cep/obligaciones.do` | No | 🟡 no se usará |
| Imagen del captcha | `GET /cep/stickyImg?b_capt=<n>` | Sí | 🟡 |

Base: `https://www.banxico.org.mx/cep/`

---

## 1. Catálogo de instituciones ✅

```
GET https://www.banxico.org.mx/cep/instituciones.do?fecha=08-10-2026
```

- **Parámetro:** `fecha` con formato `dd-MM-yyyy`. Con otro formato (por ejemplo `2026-10-08`) responde **HTTP 500**.
- **No requiere cookies ni sesión.**
- **Respuesta** (`application/json`):

```json
{
  "instituciones":       [["40133", "ACTINVER"], ["40062", "AFIRME"], ...],
  "institucionesMISPEI": [["40133", "ACTINVER"], ...],
  "overrideCaptcha": true
}
```

- Cada institución es un par `[código, nombre]`. Los nombres se escriben tal cual: algunos en mayúsculas
  (`BBVA MEXICO`) y otros no (`Mercado Pago W`, `albo`, `Cuenca`).
- `instituciones` llena el combo **receptor**. Para el combo **emisor**, el sitio toma los primeros
  `institucionesMISPEI.length` elementos de `instituciones`. Hoy las dos listas son iguales (97 elementos).
- **Fecha futura** (por ejemplo `20-10-2026`): responde solo `{"overrideCaptcha":true}`, sin listas.

### El catálogo cambia con la fecha, incluidos los códigos

Comparación entre `15-06-2024` (85 instituciones) y `08-10-2026` (97 instituciones):

| Cambio | 2024 | 2026 |
|---|---|---|
| Nu cambió de código | `90638` NU MEXICO | `40638` NUBANK |
| Renombrado, mismo código | `40138` ABC CAPITAL | `40138` UALA |
| Renombrado, mismo código | `40128` AUTOFIN | `40128` KAPITAL |
| Renombrado, mismo código | `90631` CI BOLSA | `90631` TRF |
| Nuevos en 2026 | — | HEY BANCO `40167`, SPIN BY OXXO `90728`, CITI MEXICO `40124`, REVOLUT BANK `40170`, albo, Clip, etc. |

**Consecuencia:** los códigos no se pueden fijar en el código. El bot debe pedir el catálogo **de la fecha que va a
consultar** y resolver cada banco por nombre o alias contra ese catálogo.

### Bancos de interés en el catálogo actual (08-10-2026)

| Banco | Nombre exacto en el catálogo | Código |
|---|---|---|
| BBVA | `BBVA MEXICO` | 40012 |
| Banco Azteca | `AZTECA` | 40127 |
| Spin by OXXO | `SPIN BY OXXO` | 90728 |
| Nu México | `NUBANK` (antes `NU MEXICO` 90638) | 40638 |
| Mercado Pago | `Mercado Pago W` | 90722 |
| Banorte | `BANORTE` | 40072 |
| Inbursa | `INBURSA` | 40036 |
| Citibanamex | `BANAMEX` (no confundir con `CITI MEXICO` 40124) | 40002 |
| BanCoppel | `BANCOPPEL` | 40137 |
| Santander | `SANTANDER` | 40014 |
| HSBC | `HSBC` | 40021 |
| Scotiabank | `SCOTIABANK` | 40044 |
| Hey Banco | `HEY BANCO` (no existe en el catálogo de 2024) | 40167 |
| Klar | `KLAR` | 90661 |
| Stori | **No aparece con ese nombre.** Pendiente de confirmar con un comprobante real. | ? |
| Openbank | **No aparece con ese nombre.** Pendiente de confirmar con un comprobante real. | ? |

---

## 2. Consulta: `valida.do` ✅

```
POST https://www.banxico.org.mx/cep/valida.do
Content-Type: application/x-www-form-urlencoded; charset=UTF-8
```

Petición real capturada desde el navegador:

```
tipoCriterio=T&fecha=08-10-2026&criterio=SPIN-20261008200443959PNEB9&emisor=90728&receptor=40072
&cuenta=072000000000000012&receptorParticipante=0&monto=400.00&captcha=c&tipoConsulta=0
```

### Campos

| Campo | Valores | Notas |
|---|---|---|
| `tipoCriterio` | `T` = clave de rastreo · `R` = número de referencia | Sin este campo: "No existe un tipo de criterio". |
| `fecha` | `dd-MM-yyyy` | Año entre 2012 y el actual. |
| `criterio` | Clave de rastreo: hasta 30 caracteres ASCII. Referencia: hasta 7 dígitos. | ⚠️ **La clave distingue mayúsculas de minúsculas** (ver 2.3). |
| `emisor` | Código del catálogo, por ejemplo `40012` | Debe ser distinto de `receptor`. |
| `receptor` | Código del catálogo | Si es igual al emisor, Banxico responde con un error. |
| `cuenta` | Solo dígitos. CLABE = 18, tarjeta de débito = 16, celular = 10. También el **número de cuenta** del banco (7, 10 u 11 dígitos): el 12-oct Banxico tuvo un pago BBVA → Banorte con la cuenta `1000000001`, y el 13-oct, con cuentas de 7 (Banamex), 10 (Banorte) y 11 dígitos (BanCoppel, Inbursa), respondió "Operación no encontrada" normal (no rechaza el largo). | Se compara **exacta**: un dígito distinto da "no encontrado". |
| `receptorParticipante` | `0` = "Pago a banco" **desmarcado** · `1` = marcado (la cuenta pasa a ser la cuenta ordenante) | Siempre enviar `0`. |
| `monto` | `^\d*\.?\d{0,2}$`: sin `$` ni comas, por ejemplo `1032.00` | Se compara **exacto**: $401 en lugar de $400 da "no encontrado". |
| `captcha` | `c` | **Siempre** enviarlo con `c` (ver la sección 5). |
| `tipoConsulta` | `0` = **Consultar Pago** (tabla con el estado) · `1` = **Descargar CEP** | Ver 2.2. |

### 2.1 Las respuestas posibles

Siempre **HTTP 200**, `text/html; charset=UTF-8`. Es un **fragmento HTML** que el sitio inserta en un modal
(`#divValidacionPertenencia .msg-banxico .contenido`).

| Respuesta | Cómo se reconoce | Fixture |
|---|---|---|
| **Error** | `<div id="#error_div">` (con el `#` literal) y el mensaje en un `<p>` | `valida-error-*.html` |
| **Captcha requerido** | Error con el mensaje "La imagen de seguridad no fue ingresada correctamente. Favor de validar." y `varHideCaptcha` igual a `false` | `valida-error-captcha-requerido.html` |
| **No encontrado** | `<strong>` con "Operación no encontrada" **fuera de comentarios HTML** | `valida-no-encontrado-*.html` |
| **Un pago** (`tipoConsulta=0`) | `table#xxx.styled-table.vertical`: filas `<tr><td>Etiqueta</td><td>Valor</td></tr>` | `valida-consulta-encontrado-*.html` |
| **Varios pagos** (`tipoConsulta=0`) | `table#xxx.operacionesLiquidados.styled-table` con `<thead>` y una fila por pago | `valida-consulta-varios-pagos-referencia.html` |
| **CEP disponible** (`tipoConsulta=1`) | Título "Descargar CEP" y enlaces `descarga.do?formato=PDF\|XML\|ZIP` | `valida-descarga-disponible.html` |

⚠️ Los mensajes de "no encontrado" y "se identificó el siguiente pago" vienen **duplicados dentro de comentarios
HTML**. El parser debe quitar los `<!-- … -->` antes de analizar.

Mensajes de error observados:

| Caso | Mensaje |
|---|---|
| Fecha con formato incorrecto | "La fecha ingresada es inválida. Favor de verificar." |
| Emisor igual a receptor | "Las instituciones financieras emisora y receptora seleccionadas son iguales y deben ser diferentes. Favor de verificar." |
| Sin el campo `captcha` | "El código de seguridad es inválido. Favor de verificar." |
| Captcha activado (demasiadas consultas o tras descargar) | "La imagen de seguridad no fue ingresada correctamente. Favor de validar." |
| Petición vacía | "No existe un tipo de criterio" |

### 2.2 "Consultar Pago" (`tipoConsulta=0`), la tabla de las capturas

Con un solo pago encontrado:

```html
<strong>Con la información proporcionada se identificó el siguiente pago:</strong>
<table id="xxx" class="styled-table vertical" style="margin: auto;"><tbody>
  <tr><td>Número de Referencia</td><td>7454748</td></tr>
  <tr><td>Clave de Rastreo</td><td>SPIN-20261008200443959PNEB9</td></tr>
  <tr><td>Instituci&oacute;n emisora del pago</td><td>SPIN BY OXXO</td></tr>
  <tr><td>Instituci&oacute;n receptora del pago</td><td>BANORTE</td></tr>
  <tr><td>Estado del pago en Banxico</td><td>Liquidado</td></tr>
  <tr><td>Fecha y hora de recepción</td><td>08/10/2026 14:04:47</td></tr>
  <tr><td>Fecha y hora de procesamiento</td><td>08/10/2026 14:04:48</td></tr>
  <tr class="columna-cuenta"><td>Cuenta Beneficiaria</td><td>072000000000000012</td></tr>
  <tr class="columna-monto"><td>Monto</td><td>400.00</td></tr>
</tbody></table>
```

- Las filas **Cuenta Beneficiaria** y **Monto** aparecen **solo si se enviaron `cuenta` y `monto`**. Sin ellos, la tabla
  trae las primeras 7 filas.
- Las fechas vienen como `dd/MM/yyyy HH:mm:ss` y el monto como `400.00`.
- **Si se envían `cuenta` y `monto`, Banxico también los verifica**: si alguno no coincide, responde "no
  encontrado". Así que una tabla con cuenta y monto ya es una validación completa.
- **Filtra por cada uno por separado** ✅: con la clave y solo el monto (cuenta vacía), o solo la cuenta (monto vacío),
  responde la tabla si ese dato coincide y "no encontrado" si no. El bot lo usa para la detección temprana: si la clave
  existe pero no con nuestra cuenta y el monto, una consulta con solo el monto dice cuál de los dos está alterado.
- La respuesta incluye un formulario `POST descargaComprobanteSPEI.do` (`htmlCEPImprimir` = HTML de la tabla) que
  genera el PDF "Reporte_Estado_De_Pago.pdf". Ese reporte **no es un CEP**.

**Varios pagos:** al buscar **por referencia** el pago de Azteca, Banxico devolvió **2 pagos distintos** con la misma
referencia (`4936574`), la misma cuenta, el mismo monto ($890.00) y la misma fecha, pero con claves diferentes (15:46
y 17:11). En Banco Azteca la referencia son los **últimos 7 dígitos de la cuenta destino**, así que se repite en cada
pago a esa cuenta. La tabla horizontal tiene estas columnas: Número de Referencia, Clave de Rastreo, Institución
emisora, Estado, Fecha y hora de Recepción, Fecha y hora de Procesamiento, Institución receptora, Cuenta Beneficiaria
y Monto.

### 2.3 La clave de rastreo distingue mayúsculas ✅

| Prueba | Resultado |
|---|---|
| `SPIN-20261008200443959PNEB9` (original) | Encontrado |
| `spin-20261008200443959pneb9` | **No encontrado** |
| `27SsrAVomLDdm0HAqpDehA` (Klar, original) | Encontrado |
| `27SSRAVOMLDDM0HAQPDEHA` | **No encontrado** |

**No se puede convertir la clave a mayúsculas**: hay que copiarla tal cual. Klar usa claves con mayúsculas y minúsculas.

### 2.4 Estados posibles del pago

Tomados de las descripciones que trae la propia respuesta (`#desc_*`):

| Texto en la tabla | Id | Significado |
|---|---|---|
| En proceso | `desc_EnProceso` | El SPEI recibió la orden pero no la ha liquidado. |
| **Liquidado** | `desc_Liquidado` | Pago liquidado y notificado al banco del beneficiario. **Es el único estado válido.** |
| Cancelado | `desc_Cancelado` | Cancelado por el banco emisor antes de liquidarse. |
| Rechazado | `desc_Rechazado` | Rechazado por el SPEI. |
| En proceso de devolución | `desc_EnProcesoDeDevolucion` | Liquidado y luego devuelto; la devolución está pendiente. |
| Devuelto | `desc_Devuelto` | Devuelto por el banco del beneficiario. |
| No liquidado | `desc_CanceladoAlCierre` | No se liquidó en la jornada y se eliminó al cierre. |
| Retornado | `desc_Retornado` | Retornado por el banco del beneficiario. |
| No encontrado | `desc_No_encontrado` | — |

Solo se vio **Liquidado**. Los textos de los demás estados en la tabla se suponen iguales al `<h4>` de su descripción.

---

## 3. "Descargar CEP" (`tipoConsulta=1`) ✅

Exige `cuenta` y `monto`. Si el pago existe **y está liquidado** con esa cuenta y ese monto, responde:

```html
<div class="bg-banxico title-bar">... Descargar CEP</div>
<h2>Gracias por utilizar el servicio de descarga de CEP</h2>
<a href="descarga.do?formato=PDF">PDF</a> <a href="descarga.do?formato=XML">XML</a> <a href="descarga.do?formato=ZIP">ZIP</a>
```

Esta respuesta **no trae la tabla**. Los datos están en el CEP descargado.

## 4. Descarga del CEP ✅

```
GET https://www.banxico.org.mx/cep/descarga.do?formato=PDF   → CEP-20261008-<clave>.pdf
GET https://www.banxico.org.mx/cep/descarga.do?formato=XML   → CEP-20261008-<clave>.xml
GET https://www.banxico.org.mx/cep/descarga.do?formato=ZIP   → Paquete-CEP-20261008.zip (PDF + XML)
```

- Requiere la **cookie de sesión** (`JSESSIONID`) de la consulta `valida.do` con `tipoConsulta=1`. Sin un CEP en la
  sesión responde **HTTP 500**.
- XML del CEP (anonimizado en `fixtures/cep-*.xml`):

```xml
<SPEI_Tercero FechaOperacion="2026-10-08" Hora="14:04:48" ClaveSPEI="40072" claveRastreo="SPIN-20261008200443959PNEB9"
              sello="…" numeroCertificado="00001000000710905384" cadenaCDA="||1|08102026|…">
  <Beneficiario BancoReceptor="BANORTE" Nombre="CARLOS ALBERTO RAMIREZ SOTO" TipoCuenta="40"
                Cuenta="072000000000000012" RFC="…" Concepto="…" IVA="0.00" MontoPago="400.00"/>
  <Ordenante BancoEmisor="SPIN BY OXXO" Nombre="…" TipoCuenta="40" Cuenta="…" RFC="…"/>
</SPEI_Tercero>
```

- `TipoCuenta`: `40` = CLABE, `3` = tarjeta de débito (y, según la norma SPEI, `10` = celular).
- `BancoReceptor` y `BancoEmisor` pueden traer **espacios de relleno** (`"INBURSA        "`): hay que quitarlos.
- El XML **trae el nombre del titular beneficiario**, que la tabla no muestra.

---

## 5. Sesión, cookies, captcha y límites

### Cookies

| Cookie | Origen probable | ¿Se necesita? |
|---|---|---|
| `JSESSIONID` | Servidor de aplicaciones (Oracle WebLogic) | Solo para `descarga.do` y `descargaComprobanteSPEI.do`. |
| `Hex49615001`, `SRVCOOKIE` | Balanceador | No |
| `TS012f422b` | Firewall de aplicaciones F5 BIG-IP ASM | No |

`valida.do` funciona sin visitar antes la página: el servidor crea la sesión en la misma respuesta.

### Captcha: está desactivado, pero se activa ⚠️

- Normalmente está oculto: el catálogo responde `overrideCaptcha: true` y el servidor acepta `captcha=c`.
- **Se activó en dos situaciones:**
  1. **Consultas muy seguidas desde la misma IP**, incluso con sesiones nuevas: con pausas de ~2 s, unas 7 consultas
     seguidas bastaron para que empezara a responder "La imagen de seguridad no fue ingresada correctamente". Con
     pausas de 8 s, no volvió a pasar.
  2. **Después de descargar archivos del CEP**, la siguiente consulta en la **misma sesión** del navegador lo pidió.
- Sin el campo `captcha` → "El código de seguridad es inválido".
- **Estrategia para el bot:**
  - una consulta a la vez;
  - pausa de ~5 a 8 s entre consultas;
  - una **sesión nueva por consulta**;
  - si aparece el error de captcha, **no insistir**: nadie le consulta nada durante 2 min (5 si lo vuelve a pedir
    dentro de la media hora siguiente, luego 10) y después la pausa sube a 10 s durante 30 min (`src/banxico/ritmo.ts`,
    desde el 11-oct; antes se esperaba 30 s y se reintentaba);
  - reportar "Banxico está limitando las consultas, intenta en unos minutos" en vez de "no encontrado", y revisar
    el comprobante solo más tarde.

### Horario y fechas

- El aviso "El horario de consulta es de 09:30-23:00 hrs" solo aplica a fechas anteriores al **02-06-2021**
  (histórico). Para fechas recientes se consultó a la 01:58 hora de Cuba (23:58 en CDMX) sin problema.
- El calendario del sitio usa la **fecha local del navegador**, así que Playwright debe usar
  `timezoneId: "America/Mexico_City"` (esta máquina está en UTC-4).
- A las 23:39 del 08-10-2026 (hora de CDMX), `instituciones.do?fecha=09-10-2026` ya devolvía el catálogo. Puede que la
  **fecha de operación** del SPEI avance antes de medianoche. Pendiente de confirmar con un pago nocturno.
- La hora del comprobante y la de Banxico pueden diferir unos minutos. Azteca mostró 17:09:36 y Banxico registró
  17:11:34. Klar mostró 4:52 p.m. y Banxico registró 17:22:31.

---

## 6. Lo que se aprendió de los comprobantes reales

| Comprobante | Clave de rastreo | Referencia | Cuenta destino visible | Notas |
|---|---|---|---|---|
| Spin → Banorte | `SPIN-20261008200443959PNEB9` (partida en 2 líneas en la imagen) | 7454748 | CLABE completa `072000000000000012` | La clave lleva la fecha y la hora UTC. |
| Azteca → Inbursa | `261008011287636711I` (termina en letra) | 4936574 | Solo `Inbursa ***574` (**3 dígitos**) | La referencia son los últimos 7 dígitos de la tarjeta destino. |
| Klar → Banamex | `27SsrAVomLDdm0HAqpDehA`: la parte del **Folio** antes de `:` | 5214022 | CLABE completa con espacios (`0021 80701 …`) | Clave con mayúsculas y minúsculas. |

---

## 7. Implicaciones para el diseño

1. **Consultas por HTTP directo** (`fetch`) a `instituciones.do` y `valida.do` con `tipoConsulta=0`, cuenta y monto. Una
   tabla "Liquidado" con cuenta y monto ya es una validación completa, porque Banxico verifica ambos.
2. **Captura:** se reproduce la consulta que funcionó en Playwright y se fotografía `#consultaMISPEI table#xxx`
   (verificado: queda igual a las capturas de ejemplo). Opcionalmente, en una sesión aparte, se hace
   `tipoConsulta=1` y se descarga el PDF o XML del CEP.
3. **Resolver los bancos por nombre contra el catálogo de la fecha consultada**, con caché por fecha. Los alias
   deben incluir nombres históricos (`NU MEXICO` y `NUBANK`).
4. **No pasar la clave a mayúsculas.** Solo quitar espacios y saltos de línea y corregir `MBANO` → `MBAN0`.
5. **La referencia es ambigua:** puede devolver varios pagos. Si se busca por referencia, hay que elegir la fila
   cuya clave coincida con la del comprobante o, si no hay clave, una fila que no esté ya en `usados.json`. Si quedan
   varias candidatas, se pide confirmación.
6. **Duplicados por clave de rastreo:** dos pagos idénticos (mismo monto, cuenta y día) solo se distinguen por la
   clave.
7. **Parser:** quitar los comentarios HTML; distinguir error, captcha, no encontrado, tabla vertical, tabla
   horizontal y CEP disponible.
8. **Mismo banco:** Banxico rechaza emisor igual a receptor, lo que coincide con la regla `MISMO_BANCO`.

## 8. Cómo repetir la exploración

```bash
# Con datos ficticios (resultado: no encontrado)
npx tsx scripts/explorar-cep.ts --fecha 08-10-2026

# Con un pago real
npx tsx scripts/explorar-cep.ts --fecha dd-MM-yyyy --tipo T --criterio <CLAVE> \
  --emisor <código> --receptor <código> --cuenta <cuenta completa> --monto 1234.56 --ver
```

Las salidas quedan en `tests/fixtures/banxico/exploracion/` (capturas, HTML, PDF, XML y `red.json`). Esa carpeta está
en `.gitignore` porque contiene datos reales sin anonimizar.
