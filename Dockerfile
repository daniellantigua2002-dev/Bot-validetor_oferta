# Imagen para el servidor (Render). Trae Chromium y sus librerías, que hacen falta para la foto de la tabla de
# Banxico. Su versión tiene que ser la del paquete playwright de package-lock.json (cada versión usa su Chromium):
# si se actualiza playwright, cambiar también esta línea.
FROM mcr.microsoft.com/playwright:v1.64.0-noble

# Tesseract para el OCR local. Sin el paquete tesseract-ocr-spa de apt: es otro modelo y lee distinto. El de
# español es el mismo de Tesseract.js, que npm run preparar-tessdata deja en /app/tessdata.
RUN apt-get update \
  && apt-get install -y --no-install-recommends tesseract-ocr \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm run preparar-tessdata && npm prune --omit=dev

ENV NODE_ENV=production
ENV TESSDATA_DIR=/app/tessdata
CMD ["node", "dist/index.js"]
