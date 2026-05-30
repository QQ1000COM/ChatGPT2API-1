# ChatGPT2API 部署与升级指南

本文档覆盖 Linux 服务器上的首次安装、升级、验证、备份、日志排查和反向代理配置。推荐使用 Docker 部署，应用、前端静态文件和 API 都由同一个容器提供。

## 服务器信息

当前目标服务器：

- IP：`192.168.88.186`
- SSH 用户：`admin`
- 默认访问地址：`http://192.168.88.186:3000`

不要把服务器密码、管理员密钥、OAuth token、数据库密码写进 Git 仓库。安装时通过命令参数或服务器本地 `.env` 写入。

## 一键安装或升级

登录服务器：

```bash
ssh admin@192.168.88.186
```

执行一键命令。首次安装必须传 `--auth-key`；后续升级如果服务器 `/opt/chatgpt2api/.env` 已存在，可以省略。

```bash
curl -fsSL https://raw.githubusercontent.com/QQ1000COM/ChatGPT2API-1/main/scripts/install.sh | bash -s -- \
  --repo https://github.com/QQ1000COM/ChatGPT2API-1.git \
  --branch main \
  --auth-key 'chatgpt2api' \
  --base-url 'http://192.168.88.186:3000' \
  --port 3000
```

如果服务器不能访问 GitHub raw，可以先克隆仓库再本地运行：

```bash
git clone https://github.com/QQ1000COM/ChatGPT2API-1.git /opt/chatgpt2api
cd /opt/chatgpt2api
bash scripts/install.sh \
  --auth-key 'chatgpt2api' \
  --base-url 'http://192.168.88.186:3000' \
  --port 3000
```

脚本会自动完成：

- 安装缺失的 `git`、`curl`
- 安装 Docker Engine 和 Docker Compose plugin
- 克隆或更新 `/opt/chatgpt2api`
- 生成 `.env` 和首次 `config.json`
- 使用 [docker-compose.deploy.yml](../docker-compose.deploy.yml) 构建并启动容器
- 验证 `http://127.0.0.1:3000/docs`

## 常用命令

进入部署目录：

```bash
cd /opt/chatgpt2api
```

查看状态：

```bash
docker compose -f docker-compose.deploy.yml ps
```

查看日志：

```bash
docker compose -f docker-compose.deploy.yml logs -f --tail=200 app
```

重启：

```bash
docker compose -f docker-compose.deploy.yml restart app
```

停止：

```bash
docker compose -f docker-compose.deploy.yml down
```

再次升级到最新代码：

```bash
bash scripts/install.sh
```

脚本现在会在升级前自动把当前目录打包到 `/opt/chatgpt2api-backups`，并在启动前检查端口占用。常用运维命令：

```bash
# 查看容器状态和最近日志
bash scripts/install.sh --status

# 升级失败后回滚到最近一次安装脚本备份
bash scripts/install.sh --rollback
```

推荐的数据卷结构：

- 代码目录：`/opt/chatgpt2api`
- 应用配置：`/opt/chatgpt2api/.env`、`/opt/chatgpt2api/config.json`
- 持久数据：`/opt/chatgpt2api/data`
- 图片文件：`/opt/chatgpt2api/data/images`
- 缩略图：`/opt/chatgpt2api/data/image-thumbnails`
- 安装备份：`/opt/chatgpt2api-backups`

灰度升级流程建议：

1. 安装脚本先生成备份。
2. Docker 构建新镜像。
3. 容器启动后检查 `/docs`。
4. 健康检查通过才算升级完成。
5. 失败时执行 `bash scripts/install.sh --rollback`。

指定分支升级：

```bash
bash scripts/install.sh --branch main
```

## 配置文件

部署目录下会生成：

- `.env`：Docker 环境变量，权限建议保持仅当前用户可读。
- `config.json`：应用配置，首次安装时自动写入 `auth-key` 和 `base-url`。
- `data/`：账号、图片、任务、数据库等持久化数据。

关键变量：

```env
CHATGPT2API_AUTH_KEY=your_admin_key
CHATGPT2API_BASE_URL=http://192.168.88.186:3000
STORAGE_BACKEND=json
APP_PORT=3000
```

SQLite 示例：

```bash
bash scripts/install.sh \
  --storage sqlite \
  --database-url 'sqlite:////app/data/accounts.db'
```

PostgreSQL 示例：

```bash
bash scripts/install.sh \
  --storage postgres \
  --database-url 'postgresql://user:password@db-host:5432/chatgpt2api'
```

如果 PostgreSQL 端口发布在宿主机本地地址（例如 `127.0.0.1:8085`），容器内应使用 `host.docker.internal`：

```bash
bash scripts/install.sh \
  --storage postgres \
  --database-url 'postgresql://user:password@host.docker.internal:8085/chatgpt2api'
```

## 访问与验证

Web 面板：

```text
http://192.168.88.186:3000
```

API 地址：

```text
http://192.168.88.186:3000/v1
```

验证服务：

```bash
curl -I http://127.0.0.1:3000/docs
curl http://127.0.0.1:3000/v1/models \
  -H "Authorization: Bearer <auth-key>"
```

注意：`/v1/models` 会尝试访问 ChatGPT 上游。如果服务器无法访问 `chatgpt.com` 或没有可用账号，接口可能超时或只返回本地别名；这不代表容器没有启动。

## 防火墙

如果服务器开启了防火墙，需要放行端口 `3000`。

Ubuntu/Debian with ufw：

```bash
sudo ufw allow 3000/tcp
sudo ufw status
```

CentOS/RHEL with firewalld：

```bash
sudo firewall-cmd --permanent --add-port=3000/tcp
sudo firewall-cmd --reload
```

## Nginx 反向代理

如需绑定域名和 HTTPS，建议让容器继续监听本机 `3000`，由 Nginx 转发：

```nginx
server {
    listen 80;
    server_name api.example.com;

    client_max_body_size 50m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
    }
}
```

配置域名后重新执行安装脚本，把 `base-url` 改为域名：

```bash
bash scripts/install.sh --base-url 'https://api.example.com'
```

## 备份与恢复

备份数据和配置：

```bash
cd /opt/chatgpt2api
tar -czf "/tmp/chatgpt2api-backup-$(date +%F-%H%M%S).tgz" .env config.json data
```

恢复：

```bash
cd /opt/chatgpt2api
docker compose -f docker-compose.deploy.yml down
tar -xzf /tmp/chatgpt2api-backup-YYYY-MM-DD-HHMMSS.tgz -C /opt/chatgpt2api
docker compose -f docker-compose.deploy.yml up -d --build
```

## 故障排查

SSH 连接超时：

- 确认服务器和当前电脑在同一网络或 VPN 内。
- 确认服务器 SSH 服务开启，默认端口是 `22`。
- 确认安全组/防火墙放行 SSH。

Docker 权限不足：

```bash
sudo usermod -aG docker "$USER"
newgrp docker
```

容器启动失败：

```bash
cd /opt/chatgpt2api
docker compose -f docker-compose.deploy.yml logs --tail=200 app
```

端口被占用：

```bash
sudo ss -lntp | grep ':3000'
bash scripts/install.sh --port 3001 --base-url 'http://192.168.88.186:3001'
```

上游访问超时：

```bash
curl -I https://chatgpt.com
```

如果超时，需要在设置页或环境变量里配置可用代理，再重启服务。
