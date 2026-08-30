# 部署指南

## 范围

根目录 `compose.yaml` 主要服务于本地预览和发布前验收。它在同一容器中启动 Vite 和 FastAPI，并使用固定 Compose 项目名 `zero-one-api-verifier-preview`。

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
curl --fail http://127.0.0.1:5173/healthz
```

预期结果：

- 容器名前缀为 `zero-one-api-verifier-preview-`。
- `docker compose ps` 显示 `healthy`。
- `/healthz` 返回 `{"ok": true, ...}`。

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
| `VERIDROP_JOBS_DIR` | 检测任务和报告的持久化目录 |
| `VERIDROP_WISHLIST_PATH` | 心愿单文件路径 |
| `LOCAL_PREVIEW_PORT` | 仅用于本地 Compose 外部端口映射 |

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
