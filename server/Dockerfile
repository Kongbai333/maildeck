FROM node:24-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json tsconfig.app.json vite.config.ts index.html ./
COPY electron ./electron
COPY server ./server
COPY webapp ./webapp
COPY src ./src

RUN npm run build:server
RUN npm run build:webapp
RUN npm prune --omit=dev

FROM node:24-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production
ENV MAILDECK_HOST=0.0.0.0
ENV MAILDECK_PORT=8787
ENV MAILDECK_DATA_DIR=/data

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist-server ./dist-server
COPY --from=build /app/webapp/dist ./webapp/dist

VOLUME ["/data"]
EXPOSE 8787

CMD ["node", "dist-server/server/src/index.js"]
