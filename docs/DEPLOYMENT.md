# 部署指南

## 范围

根目录 `compose.yaml` 主要服务于本地预览和发布前验收。它启动两个服务并使用固定 Compose 项目名 `zeroone-zhijian-current`：

| 服务 | 容器内端口 | 默认宿主端口 | 职责 |
| --- | --- | --- | --- |
| `verifier` | 8012 | 8123 | FastAPI + Jinja2：检测页、红黑榜、站点详情、站长中心、管理后台 |
| `web` | 5173 | 5175 | Vite 营销站，并把 `/leaderboard`、`/partner`、`/api`、`/static` 等路径反代到 `verifier` |

两个服务共享命名卷 `verifier-web-data`（挂载在 `/app/zero-one-api-verifier/web_data`），保证预览数据在重建容器后仍然保留。
预览端口默认仅绑定宿主机 `127.0.0.1`；需要从其他机器访问时，应经受控反向代理转发。
该卷和可选的 `seed` 服务只用于本地预览；不得把预览卷或演示账号作为生产数据迁移。

生产环境的最低要求：

- `https://mix.01yapi.cc` 具有有效 TLS 证书。
- 公网只暴露 80/443，应用端口仅对反向代理或容器网络开放。
- 报告和排行榜数据使用持久化卷并定期备份。
- 镜像使用固定版本或 digest，不在生产主机上执行不可审计的自动更新。
- 运行版本的完整对应源码持续可从页脚和 GitHub 入口获取。

## 本地镜像验证

```bash
docker compose up --build -d
docker compose ps
curl --fail http://127.0.0.1:5175/healthz   # 经 Vite 反代
curl --fail http://127.0.0.1:8123/healthz   # 直连 FastAPI
```

需要演示数据（站点、广告位、半年检测报告与访客记录）时：

```bash
docker compose --profile demo up seed
```

预期结果：

- 容器名前缀为 `zeroone-zhijian-current-`。
- `docker compose ps` 显示两个服务均 `healthy`。
- 两个端口的 `/healthz` 都返回 `{"ok": true, ...}`。

`/healthz` 只证明进程在响应；数据库可读写与报告持久化仍须通过下文的隔离验收和恢复检查确认。

已知环境问题：部分 Docker Desktop（Compose v5 + bake）在本机执行 `docker compose build` 会报
`failed to dial gRPC ... x-docker-expose-session-sharedkey`。此时改用经典构建器即可：

```bash
DOCKER_BUILDKIT=0 docker compose up --build -d
```

## 网络入口

本地预览的 Vite 会把检测路径转发给 FastAPI；公网不得直接指向其 `5173` 开发端口。独立生产栈使用下文的静态 Web 容器和本机 `8180` 端口，再经 Cloudflare Tunnel 接入域名，不改动已有中转站的 80/443 Edge。

## 环境和数据

| 变量 | 用途 |
| --- | --- |
| `VERIDROP_WEB_DATA_DIR` | 整个数据树的根目录：站点库、访客库、检测报告、广告横幅 |
| `VERIDROP_JOBS_DIR` | 检测任务和报告的持久化目录（默认在数据目录下 `jobs/`） |
| `VERIDROP_WISHLIST_PATH` | 心愿单文件路径 |
| `LOCAL_PREVIEW_PORT` | `web` 服务的宿主端口，默认 5175 |
| `VERIFIER_PREVIEW_PORT` | `verifier` 服务的宿主端口，默认 8123 |
| `VERIFIER_TARGET` | Vite 反代目标，本地默认 `http://127.0.0.1:8012`，Compose 内为 `http://verifier:8012` |
| `PREVIEW_ADMIN` / `PREVIEW_ADMIN_PASSWORD` / `PREVIEW_OPERATOR_PASSWORD` | 仅 `seed` 服务使用的演示账号口令 |

生产中不要把 API Key 写入镜像、Git 历史、环境样例或报告目录。

## 发布前检查清单

1. `npm run build` 通过。
2. `zero-one-api-verifier/.venv/bin/pytest` 全部通过。
3. Docker 镜像重建成功，容器状态为 `healthy`。
4. `/`、`/app`、`/claude`、`/openai`、`/gemini`、`/leaderboard`、`/faq` 可访问。
5. Canonical、Open Graph、JSON-LD、Sitemap、robots.txt 均使用 `https://mix.01yapi.cc`。
6. 报告 HTML 和 JPG 不包含完整 API Key 或 Authorization Header。
7. 移动导航、键盘流程、减少动态效果和强制色彩降级不丢失核心操作。
8. GitHub 项目主页和页脚源码链接指向当前运行版本。

## 回滚

- 保留上一个可用镜像的 tag 或 digest。
- 回滚应用镜像时不要删除报告数据卷。
- 域名、Canonical 和分享图链接应作为一个整体回滚，避免搜索和社交预览出现混合域名。

## 独立生产部署（与零一中转站隔离）

`deploy/production/` 是智鉴站的生产栈。它与现有零一中转站使用不同的 Compose project、容器网络、镜像和数据目录；不连接中转站的 PostgreSQL、Redis 或 `state/`，也不绑定服务器的 80/443。官网由静态 Caddy 容器提供，FastAPI 后端只在该栈的内部网络可见。唯一宿主入口默认是 `127.0.0.1:8180`。

生产机使用独立目录 `/srv/zero-one-verifier`，源码放在其中的 `source/`，持久化数据放在 `state/`。创建数据目录时将其交给容器用户 UID/GID `10001`，权限设为 `0700`。部署命令须在 `source/` 执行，并提供当前完整 Git SHA：

```bash
export VERIFIER_REVISION="$(git rev-parse HEAD)"
export VERIFIER_DATA_DIR=/srv/zero-one-verifier/state
docker compose -f deploy/production/compose.yaml config --quiet
docker compose -f deploy/production/compose.yaml up -d --build --wait
curl --fail http://127.0.0.1:8180/healthz
```

构建和运行版本都用该 SHA 标识。首次发布前先在隔离目录运行完整的 HTTP、SQLite 和报告恢复验收；线上目录不运行预览种子，也不运行会写入测试账号的 `scripts/smoke_stack.py`。后续回滚仅切换智鉴站的固定镜像版本，保留 `state/`，不执行 `down -v`。

独立备份命令为 `sudo python3 deploy/production/backup.py --data-dir /srv/zero-one-verifier/state --backup-root /srv/zero-one-verifier/backups`。脚本在线快照两个 SQLite 库、复制报告和横幅，并核对数据库完整性；`zero-one-verifier-backup.service` 与 `.timer` 可安排每日执行。备份目录仍在同一台服务器上，正式抗主机故障还需将备份加密复制到另一处存储。

现有中转站已经占用 80/443。若要求完全不改其 Edge，可以为智鉴站单独创建 **Cloudflare Tunnel**，把 Cloudflare 上的公开主机名 `mix.01yapi.cc` 路由到同机 `http://127.0.0.1:8180`。`compose.tunnel.yaml` 只启动独立的 `cloudflared`，使用放在 Git 之外的 token 文件和固定 digest 镜像；不修改中转站的容器或防火墙入站规则。官方镜像以 UID/GID `65532` 运行，因此 token 文件须由该 UID 持有、权限设为 `0400`，其宿主目录由 root 持有、权限设为 `0700`。取得 token 后，将它安全写入 `VERIFIER_TUNNEL_TOKEN_FILE` 指向的服务器文件，运行 `docker compose -f deploy/production/compose.yaml -f deploy/production/compose.tunnel.yaml up -d tunnel`。Cloudflare [官方路由说明](https://developers.cloudflare.com/tunnel/concepts/routing/)指出，添加公开主机名时会在当前权威 DNS 中创建指向 Tunnel 的记录。

截至 2026-09-23，`01yapi.cc` 的权威名称服务器是 Cloudflare；从生产机查询 `mix.01yapi.cc` 得到 NXDOMAIN。Spaceship 页面显示为“非活动”的记录不能作为已生效解析使用。Cloudflare 区域内还存在 `api.01yapi.cc` 的记录，**不要为修复智鉴站而切换整个域名的名称服务器**；应在当前权威 Cloudflare 区域创建本项目的独立 Tunnel 路由，并在公网确认 DNS、TLS、`/healthz`、检测页面和报告链路后才宣布上线。

## 数据备份与恢复

生产数据目录由 `VERIDROP_WEB_DATA_DIR` 决定。需要一起保留 `partners.sqlite3`（站长、站点、广告与审计）、`visits.sqlite3`（访问统计）、`jobs/`（检测报告）、`ad_banners/`（广告横幅）和 `wishlist.txt`（若存在）。SSO 是独立模块，其数据库及签名密钥见 [SSO 文档](../zero-one-api-verifier/sso-connect/README.md)。

- 在线备份 SQLite 时使用 `sqlite3.Connection.backup()` 或 SQLite `.backup`，不要只复制主 `.sqlite3` 文件：尚未 checkpoint 的 WAL 可能包含已提交数据。
- 将两个数据库快照与报告、横幅、心愿单放在同一带时间戳的备份目录；需要跨存储点严格一致时，先短暂停止写入再做整目录快照。
- 恢复前在隔离环境验证两个数据库的 `PRAGMA integrity_check` 和 `PRAGMA foreign_key_check`，并实测账号登录、站点资料、访问统计及已有报告链接。恢复时保留原数据卷作为回退点；不要执行预览种子脚本。

本地发布验收可用独立 Compose 项目与全新卷运行 `python3 scripts/smoke_stack.py --base-url http://127.0.0.1:5175`。该脚本会创建测试账号和访问记录，只接受本机 HTTP 地址，不应对生产域名运行。
