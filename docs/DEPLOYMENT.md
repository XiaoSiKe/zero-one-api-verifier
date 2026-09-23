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

## 反向代理

以 Caddy 为例，应用服务如果在本机 `5173` 端口监听：

```caddyfile
mix.01yapi.cc {
    encode zstd gzip
    reverse_proxy 127.0.0.1:5173
}
```

如果反向代理与应用处于不同容器，应使用 Compose 网络中的服务名，不要将应用端口额外暴露到公网。

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

## 数据备份与恢复

生产数据目录由 `VERIDROP_WEB_DATA_DIR` 决定。需要一起保留 `partners.sqlite3`（站长、站点、广告与审计）、`visits.sqlite3`（访问统计）、`jobs/`（检测报告）、`ad_banners/`（广告横幅）和 `wishlist.txt`（若存在）。SSO 是独立模块，其数据库及签名密钥见 [SSO 文档](../zero-one-api-verifier/sso-connect/README.md)。

- 在线备份 SQLite 时使用 `sqlite3.Connection.backup()` 或 SQLite `.backup`，不要只复制主 `.sqlite3` 文件：尚未 checkpoint 的 WAL 可能包含已提交数据。
- 将两个数据库快照与报告、横幅、心愿单放在同一带时间戳的备份目录；需要跨存储点严格一致时，先短暂停止写入再做整目录快照。
- 恢复前在隔离环境验证两个数据库的 `PRAGMA integrity_check` 和 `PRAGMA foreign_key_check`，并实测账号登录、站点资料、访问统计及已有报告链接。恢复时保留原数据卷作为回退点；不要执行预览种子脚本。

本地发布验收可用独立 Compose 项目与全新卷运行 `python3 scripts/smoke_stack.py --base-url http://127.0.0.1:5175`。该脚本会创建测试账号和访问记录，只接受本机 HTTP 地址，不应对生产域名运行。
