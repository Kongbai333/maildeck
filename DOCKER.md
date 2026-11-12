# 云部署（Docker）说明

本项目提供多阶段 `Dockerfile` 与 GitHub Actions，实现「推代码 → 自动构建镜像 → 云服务器拉取部署」。

## 1. 自动构建镜像（GitHub Actions → GHCR）

- 工作流：`.github/workflows/docker.yml`
- 触发：推送到 `main` / `cloud-deploy` 分支、打 `v*` 标签，或手动 `workflow_dispatch`。
- 产物：推送到 GitHub Container Registry：
  `ghcr.io/<owner>/<repo>:latest`、`:cloud-deploy`、`:sha-xxxx` 等。
- 权限：使用仓库自带的 `secrets.GITHUB_TOKEN`（已在 workflow 里 `packages: write`），无需额外配置。
- 首次构建完成后，去仓库右侧 **Packages** 里把该镜像的可见性按需设为 public，或在服务器上 `docker login ghcr.io` 用带 `read:packages` 的 token 拉取。

## 2. 服务器部署（docker compose）

```bash
# 1) 取部署文件（本仓库里的 docker-compose.yml / .env.docker.example）
mkdir -p /opt/maildeck && cd /opt/maildeck
# 把 docker-compose.yml 放进来（或 git clone 后进入该目录）

# 2) 准备环境变量（敏感信息只放本机 .env，不要提交）
cp .env.docker.example .env
# 生成主密钥并填入 .env 的 MAILDECK_MASTER_KEY
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
# 同时设置 MAILDECK_ADMIN_PASSWORD

# 3) 拉取镜像并启动
docker compose pull
docker compose up -d
```

访问 `http://<服务器IP>:8787`，用 `.env` 里的管理员账号登录。

> 生产建议放在 Nginx/Caddy 之后做 HTTPS 反代到 `127.0.0.1:8787`，并配置 `X-Forwarded-Proto`。

## 3. 本地手动构建（可选）

```bash
docker build -t maildeck:local .
docker run -d --name maildeck -p 8787:8787 \
  -e MAILDECK_MASTER_KEY="<32字节base64>" \
  -e MAILDECK_ADMIN_PASSWORD="<强密码>" \
  -v maildeck-data:/data \
  maildeck:local
```

## 4. 关键环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `MAILDECK_MASTER_KEY` | ✅ | 32 字节 base64，加密账号凭据/服务商 Key。**一旦用于加密就不能随意更换**，否则旧密文无法解密。 |
| `MAILDECK_ADMIN_PASSWORD` | ✅ | 首次启动自动创建管理员用的初始密码。 |
| `MAILDECK_ADMIN_USERNAME` | 可选（默认 admin） | |
| `MAILDECK_HOST` / `MAILDECK_PORT` | 可选（默认 0.0.0.0:8787） | 容器内已设好。 |
| `MAILDECK_DATA_DIR` | 可选（默认 /data） | SQLite 与缓存目录，挂载到持久卷。 |
| `MAILDECK_CORS_ORIGINS` | 可选 | 前后端分离跨域时才需要。 |

## 5. 安全要点

- **不要提交** `.env`、`data/`、`*.db`（`.gitignore` 已排除）。
- 生产必须显式设置 `MAILDECK_MASTER_KEY`；留空会退回内置开发用固定 key，等于明文。
- 数据持久化在 `maildeck-data` 卷（容器内 `/data`），升级镜像前先备份该卷。
- 镜像以非 root 用户运行；如需绑定挂载宿主目录做数据卷，请把目录属主改为 UID 10001。
