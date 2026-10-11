# Bot validador de comprobantes SPEI

Bot de Telegram que valida comprobantes de transferencia SPEI contra el
[CEP de Banxico](https://www.banxico.org.mx/cep/).

1. Le envías la **foto del comprobante**.
2. La IA lee los datos.
3. Se aplican las reglas: que el depósito haya ido a nuestras cuentas, que el banco emisor no sea el mismo que el de destino y que la fecha no sea futura. Un comprobante que se vuelve a enviar se valida otra vez: no se guarda cuáles ya se validaron.
4. Banxico confirma que el pago está **Liquidado**, a nuestra cuenta y por ese monto. Si al comprobante le falta la fecha, la referencia o la cuenta, el bot usa lo que sabe de cada banco (por ejemplo, Banorte usa la fecha como referencia y Banco Azteca los últimos 7 dígitos de la cuenta) y Banxico verifica el resto: ver [`docs/comprobantes.md`](docs/comprobantes.md).
5. Si todo coincide, el bot responde con la **captura de la tabla de Banxico**.

## Instalación

Necesitas Node.js 20 o superior.

```bash
npm install
npx playwright install chromium
```

## Configuración (`.env`)

Copia `.env.example` como `.env` y llena:

| Variable | Qué es |
|---|---|
| `NVIDIA_API_KEY` | Clave gratuita de https://build.nvidia.com (empieza con `nvapi-`) |
| `NVIDIA_MODEL` | Modelo de visión. Por defecto `moonshotai/kimi-k3` |
| `NVIDIA_MODEL_RESPALDO` | Modelo que se usa si el principal falla. Por defecto `meta/llama-3.2-90b-vision-instruct`; vacío = sin respaldo |
| `GEMINI_API_KEY` | Segunda IA de respaldo: clave gratuita de [Google AI Studio](https://aistudio.google.com/apikey). Se usa si NVIDIA falla o no responde en 30 s (gana la primera respuesta válida). Vacía = sin Gemini |
| `GEMINI_MODEL` | Modelos de Gemini separados por coma; si uno está saturado entra el siguiente. Por defecto `gemini-3.5-flash,gemini-3.8-flash` (el `gemini-2.5-flash` ya no está disponible para claves nuevas) |
| `TELEGRAM_BOT_TOKEN` | Token que da @BotFather al crear el bot |
| `ALLOWED_USER_IDS` | IDs de Telegram que pueden usar el bot **en privado**, separados por coma (se obtienen con @userinfobot) |
| `ALLOWED_CHAT_IDS` | IDs de los **grupos** donde cualquier miembro puede usar el bot (empiezan con `-100`). Al agregar el bot a un grupo, su ID aparece en la ventana del bot |

Nunca subas el `.env` a git ni lo compartas.

## Uso

### Bot de Telegram

Doble clic en **`iniciar-bot.bat`**, o desde la terminal:

```bash
npm run bot
```

El bot funciona mientras esa ventana esté abierta y la PC encendida. Usa long polling, así que no necesita servidor público.

En Telegram, envía la foto del comprobante al bot o en el grupo autorizado. Para una mejor lectura, envíala **como archivo** (📎 → Archivo), porque Telegram comprime las fotos.

| Respuesta | Significado |
|---|---|
| ✅ + captura | Pago validado en Banxico |
| ✅ sin captura | Mismo banco: transferencia entre cuentas del mismo banco (no pasa por SPEI) |
| ❌ | Cuenta incorrecta, monto alterado, no es comprobante o faltan datos |
| ⏳ | Fecha futura, o pago "En proceso" |
| ⚠️ | Banxico no está respondiendo |
| ❓ + botones | Hay que elegir el banco emisor o la cuenta destino |
| 🔍 | No se encontró en Banxico (con la lista de intentos realizados) |

### Usar el bot en un grupo

1. En @BotFather: `/mybots` → el bot → **Bot Settings**:
   - **Allow Groups?** → *Turn groups on*;
   - **Group Privacy** → *Turn off* (para que el bot vea las fotos y no solo los comandos).
2. En Telegram: crear el grupo y agregar al bot como miembro.
3. En el grupo: hacer al bot **administrador** con los permisos **Eliminar mensajes** y **Fijar mensajes** (lo demás puede ir apagado). Con "Fijar mensajes", el bot deja fijada la guía de cómo enviar el comprobante y las palabras de la nota.
4. Con el bot encendido, escribir `/id` en el grupo: el bot responde con el ID del grupo. También aparece en la ventana del bot como
   `Grupo no autorizado: "…" con ID -100…`.
5. Poner ese ID en el `.env` (`ALLOWED_CHAT_IDS=-100…`) y reiniciar el bot.

En el grupo, cualquier miembro puede enviar comprobantes. El bot siempre responde **como respuesta al mensaje del comprobante** y:

- borra todo lo que no sea imagen: solo acepta fotos o archivos JPG, PNG o WEBP de hasta 10 MB; las fotos con pie de foto sí se aceptan;
- acepta **una foto a la vez por persona**: si mandan dos juntas, o mandan otra antes de recibir la respuesta (o de contestar la pregunta del banco), la segunda se borra con un aviso;
- acepta una **nota** en la foto (el texto que va con ella) para dar los datos que no aparecen en la imagen. Van palabras clave separadas por coma, en cualquier orden: `fecha 09/10/2026, monto 400, clave MBAN0100…, ref 2309260, banco BBVA, cuenta 1871`. La nota manda sobre lo que se lee en la imagen; si la contradice, se valida igual y la respuesta lo avisa. Si la imagen no es un comprobante, se rechaza aunque traiga nota. Para probar: `npm run validar -- foto.jpg --nota "fecha 09/10/2026, ref 123"`;
- borra los mensajes **editados**, para que nadie cambie la foto después de recibir la respuesta;
- avisa en el grupo cuando **Banxico no está respondiendo**, y otra vez cuando vuelve;
- **revisa solo más tarde** en vez de responder "no encontrado":
  - si el pago es de hace menos de 15 minutos (los bancos tardan hasta 10 en enviarlo a Banxico), a los 5 y a los 10 minutos;
  - si Banxico no responde, cada 3 minutos durante 1 hora como máximo, o en cuanto Banxico vuelva.

  La persona ve a qué hora se revisará y no tiene que reenviarlo. Si el bot se reinicia, las esperas siguen.
- antes de preguntar o de rechazar, **deja que Banxico decida** (solo encuentra el pago con los datos correctos):
  - banco emisor dudoso: prueba los bancos posibles antes de preguntar con botones;
  - cuenta que no se ve, con clave de rastreo: prueba nuestras cuentas antes de preguntar;
  - cuenta que no es nuestra, con clave: busca en nuestra cuenta del banco destino (o en todas si no se ve el banco), por si se leyó mal;
  - mismo banco, pero con clave de rastreo (una transferencia interna no la trae): prueba los otros bancos que indica el comprobante; si ninguno aparece, responde "mismo banco";
  - "el monto no coincide": antes prueba el otro monto leído (el del OCR, o el de la imagen si la nota trae otro);
- cada comprobante tiene **5 minutos como máximo** (antes 3) para buscarse en Banxico;
- deja **fijada** en el grupo la guía con las palabras de la nota (si tiene el permiso "Fijar mensajes").
Si Telegram convierte el grupo en supergrupo, su ID cambia: el bot lo muestra en la ventana y hay que actualizar el `.env`.

### Línea de comandos

```bash
npm run validar -- ./comprobante.jpg                 # validación completa
npm run validar -- ./comprobante.jpg --sin-registro  # prueba sin marcarlo como usado
npm run validar -- ./comprobante.jpg --banco NU      # responde "¿desde qué banco?"
npm run validar -- ./comprobante.jpg --cuenta BANORTE
npm run extraer -- ./comprobante.jpg                 # solo la lectura de la imagen
```

## Dónde quedan los datos

- `data/usados.json`: ya no se usa. Con `REGLAS.bloquearDuplicados = false` (en `src/config.ts`) el bot no guarda ni revisa los pagos ya validados. Si un día se vuelve a poner en `true`, el archivo vuelve a impedir validar dos veces el mismo pago.
- `data/capturas/`: las capturas de Banxico de cada pago validado.
- `data/referencias-aprendidas.json`: la referencia que pone BBVA (cambia según la semana), aprendida de los pagos BBVA validados; se usa para los BBVA sin referencia de fechas cercanas (±7 días). Se puede borrar: el bot la vuelve a aprender.
- `data/cola.json`: comprobantes que están en la cola (y los que esperan para revisarse solos). Si el bot se reinicia, al arrancar los retoma y responde. No lo borres con el bot encendido.

## Agregar cuentas o bancos (`src/config.ts`)

- **Cuenta destino:** agrega un objeto a `CUENTAS_DESTINO` con `banco` (una clave de `BANCOS`), `titular`, `clabe` y, si aplica, `tarjeta` y `cuenta`.
- **Banco emisor:** agrega una entrada a `BANCOS` con:
  - `catalogo`: el nombre exacto en el catálogo de Banxico; ver `docs/banxico-cep.md`;
  - `alias`: el texto como aparece en los comprobantes, en minúsculas y sin acentos;
  - `prefijosClave` o `patronClave`: los prefijos o la forma de su clave de rastreo, si se conocen;
  - `firmas`: frases propias del diseño de su comprobante, para reconocerlo aunque no diga el nombre;
  - `referenciaHabitual`: la referencia que pone sola su app (fija, la fecha o los últimos 7 dígitos de la cuenta destino);
  - `fechaSiguienteDeNoche`: si de noche imprime la fecha del día siguiente (BBVA);
  - `fechaEnClave`: dónde lleva la fecha su clave de rastreo (BBVA, Azteca, Spin, Santander…), para buscar alrededor de ella;
  - `prefijoClabe`: los 3 primeros dígitos de sus CLABE.

  Si un banco no está en el mapa, el bot lo busca por nombre en el catálogo de Banxico.
- **Reglas** (`REGLAS`):
  - `minDigitosTerminacion`: dígitos de cuenta que se comparan;
  - `diasAlrededor`: días antes y después de la fecha del comprobante que se consultan (2: D, D−1, D+1, D−2, D+2);
  - `diasHaciaAtras`: sin fecha, días anteriores a hoy que se consultan; con una fecha posterior a hoy, días anteriores a ella;
  - `pausaEntreConsultasMs`: espera entre consultas a Banxico. No la bajes de unos 6 s, porque Banxico pide captcha.
- **Captura** (`CAPTURA.modo`):
  - `"local"` (rápido): dibuja la respuesta de Banxico;
  - `"sitio"`: repite la consulta en el navegador.

Después de cualquier cambio: `npm test`.

## Desarrollo

```bash
npm test               # pruebas (vitest)
npm run typecheck      # revisión de tipos
npm run probar-imagenes                # mide la lectura del OCR con los 37 comprobantes de "Imagenes de prueba"
npm run probar-imagenes -- --ia        # también la IA
npm run probar-imagenes -- --banxico   # validación completa contra Banxico (lento)
npm run comparar-modelos -- moonshotai/kimi-k3 <otro-modelo>   # si NVIDIA retira el modelo
```

Documentación técnica:
- [`docs/banxico-cep.md`](docs/banxico-cep.md): cómo funciona el CEP de Banxico.
- [`docs/comprobantes.md`](docs/comprobantes.md): cómo luce el comprobante de cada banco y los patrones que usa el bot.
- [`docs/PROGRESO.md`](docs/PROGRESO.md): estado del proyecto y decisiones tomadas.
