# Imagen para el servidor (Render). Trae Chromium y sus librerías, que hacen falta para la foto de la tabla de
# Banxico. Su versión tiene que ser la del paquete playwright de package-lock.json (cada versión usa su Chromium):
# si se actualiza playwright, cambiar también esta línea.
FROM mcr.microsoft.com/playwright:v1.64.0-noble

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
