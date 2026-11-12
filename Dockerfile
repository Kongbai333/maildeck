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

# gosu 用于入口脚本修正数据卷属主后降权运行；非 root 账号 maildeck(10001)
RUN apt-get update \
  && apt-get install -y --no-install-recommends gosu \
  && rm -rf /var/lib/apt/lists/* \
  && useradd -r -u 10001 maildeck \
  && mkdir -p /data

# 仅生产依赖
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# 构建产物 + 环境变量样例 + 入口脚本
COPY --from=build /app/dist-server ./dist-server
COPY --from=build /app/webapp/dist ./webapp/dist
COPY --from=build /app/server/.env.example ./server/.env.example
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
  && chown -R maildeck:maildeck /app /data

ENV MAILDECK_HOST=0.0.0.0 \
    MAILDECK_PORT=8787 \
    MAILDECK_DATA_DIR=/data

VOLUME ["/data"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.MAILDECK_PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist-server/server/src/index.js"]
