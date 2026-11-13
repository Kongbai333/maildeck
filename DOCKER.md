# Docker 部署

MailDeck 使用一个容器提供网页和 HTTP API。镜像基于 Node.js 24，在构建阶段生成网页与服务端产物，运行阶段托管网页并连接持久化数据目录。

## 镜像构建与发布

[Docker 工作流](.github/workflows/docker.yml)在推送到 `main` / `cloud-deploy`、创建 `v*` 标签或手动触发时构建镜像，并发布到 GHCR：

```text
ghcr.io/kongbai333/maildeck:latest
ghcr.io/kongbai333/maildeck:main
ghcr.io/kongbai333/maildeck:sha-<提交号>
```

工作流使用仓库的 `GITHUB_TOKEN` 与 `packages: write` 权限。拉取私有镜像时，部署环境需先登录对应仓库。

[Dockerfile](Dockerfile)负责安装依赖、构建 `webapp/dist` 与 `dist-server`，并将两者放入运行镜像。构建容器前无需在宿主机预先运行网页构建。

## 使用 Compose 部署

在仓库根目录执行，或将[Compose 配置](docker-compose.yml)和[环境变量模板](.env.docker.example)放入同一部署目录后执行：

```bash
cp .env.docker.example .env
```

PowerShell 对应命令为 `Copy-Item .env.docker.example .env`。编辑 `.env`，设置 `MAILDECK_MASTER_KEY`、`MAILDECK_ADMIN_PASSWORD`，按需设置管理员用户名。主密钥可用以下命令生成：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

完成配置后：

```bash
docker compose pull
docker compose up -d
```

浏览器访问 `http://<服务器IP>:8787`，使用初始化的管理员账号登录。主配置将命名卷 `maildeck-data` 挂载到容器 `/data`。

## 本地构建镜像

在仓库根目录执行：

```bash
docker build -t maildeck:local .
docker run -d --name maildeck -p 8787:8787 \
  --env-file .env \
  -v maildeck-data:/data \
  maildeck:local
```

也可按[Compose 配置](docker-compose.yml)中的注释启用本地 `build`。构建完成后，容器运行 `node dist-server/server/src/index.js`；服务端只托管 `webapp/dist`。

## HTTPS 与反向代理

可使用[Caddy 配置](deploy/Caddyfile)或[Nginx 配置](deploy/nginx/maildeck.conf)转发到 MailDeck 服务端，并传递 `X-Forwarded-Proto`，使服务端按 HTTPS 场景设置会话 Cookie。

仓库另提供[HTTPS Compose 配置](docker-compose.https.yml)。使用前调整 Caddy 域名及其中的宿主机数据目录，再执行：

```bash
docker compose -f docker-compose.https.yml up -d
```

容器部署与反向代理只改变访问和托管方式，不改变现有 API、账号权限或在线播放服务端行为。

## 环境变量与数据

| 变量 | 说明 |
| --- | --- |
| `MAILDECK_MASTER_KEY` | 32 字节 base64 主密钥，用于加密账号凭据与服务商密钥；恢复原数据库时使用原密钥 |
| `MAILDECK_ADMIN_PASSWORD` | 首次初始化管理员的密码 |
| `MAILDECK_ADMIN_USERNAME` | 首次初始化管理员用户名，默认 `admin` |
| `MAILDECK_HOST` / `MAILDECK_PORT` | 镜像默认 `0.0.0.0` / `8787` |
| `MAILDECK_DATA_DIR` | 镜像默认 `/data`，用于 SQLite 和缓存 |
| `MAILDECK_CORS_ORIGINS` | 前后端分离部署时配置允许的网页来源 |

首次初始化后的账号密码由数据库管理。备份应包含持久化数据、原主密钥与部署配置；升级或迁移前安排一致性备份。`.env`、数据库和真实业务截图不应进入代码仓库或镜像构建上下文。

## 容器运行身份

当前镜像没有设置 `USER`，由 **root** 执行[入口脚本](docker-entrypoint.sh)。脚本创建数据目录，尝试执行 `chmod 777` 和 `chown -R 10001:10001`，然后通过 `exec` 启动服务端；它没有切换到 UID 10001。因此目录属主为 10001 不代表服务进程以该用户运行。此处描述现有部署行为，未调整容器运行策略。

服务端环境变量、账号初始化和兼容 HTTP 管理接口见[服务端说明](server/README.md)。
