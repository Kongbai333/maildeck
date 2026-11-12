# syntax=docker/dockerfile:1

# ───────────────────────── 构建阶段 ─────────────────────────
FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false

# 先装依赖（--ignore-scripts 避免拉取 Electron 二进制）
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# 复制源码并构建：前端静态资源 + 服务端 JS
COPY . .
RUN npm run build:webapp && npm run build:server

# ───────────────────────── 运行阶段 ─────────────────────────
FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false

# 仅生产依赖
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# 构建产物 + 环境变量样例
COPY --from=build /app/dist-server ./dist-server
COPY --from=build /app/webapp/dist ./webapp/dist
COPY --from=build /app/server/.env.example ./server/.env.example

# 数据目录（SQLite 与缓存），以非 root 运行
RUN mkdir -p /data \
  && useradd -r -u 10001 maildeck \
  && chown -R maildeck:maildeck /app /data

ENV MAILDECK_HOST=0.0.0.0 \
    MAILDECK_PORT=8787 \
    MAILDECK_DATA_DIR=/data

USER maildeck
VOLUME ["/data"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.MAILDECK_PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist-server/server/src/index.js"]
