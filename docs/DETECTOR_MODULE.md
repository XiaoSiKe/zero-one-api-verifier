# 中转站检测模块 v0.1.1

本模块是 Veridrop 的二次开发加固版，保留上游检测器、评分、报告和排行榜，不复制或重写上游核心。它与 `sso-connect/` 独立部署。

## 本地运行

```bash
uv sync --extra dev --extra web
VERIDROP_ALLOW_PRIVATE_TARGETS=1 \
  .venv/bin/python -m uvicorn web.server:app --host 127.0.0.1 --port 8012
```

打开 `http://127.0.0.1:8012`。本地私网开关只用于实验；公网部署不应设置它。

## Web 闭环

```text
提交表单
  → 公网 HTTPS / SSRF 校验
  → 模型存活预检
  → 限流与有界队列
  → 协议检测器
  → JSON 原子持久化
  → HTML / JPG / Sitemap / 排行榜
```

主要接口：

- `POST /api/probe`：有界模型列表探测。
- `POST /api/detect/{claude|openai|gemini}`：异步提交。
- `GET /api/status/{job_id}`：任务状态。
- `GET /api/result/{job_id}.json`：脱敏 JSON 报告。
- `GET /r/{job_id}` 与 `GET /r/{job_id}.jpg`：可分享报告。

## 安全边界

- 默认只允许公网 HTTPS，拒绝 userinfo、query、fragment、私网、保留地址、链路本地和云元数据地址。
- DNS 校验后，实际 TCP 连接固定到已验证 IP；原域名继续用于 Host、TLS SNI 和证书校验。跨域跳转无法使用未登记主机。
- `/models` 上限 1 MB，预检和正式检测上限 8 MB；拒绝上游压缩响应，避免解压膨胀。
- Probe 和 Detect 独立限流，Probe/预检各有全局并发上限，队列满返回 `503 + Retry-After`。
- API Key 只存在运行任务内存中；状态、错误、Detector details 和磁盘报告递归脱敏。
- 生产 systemd 只信任 loopback 反向代理，数据根目录由 `VERIDROP_WEB_DATA_DIR` 指定。

## Thinking signature 口径

Anthropic 检测项存储：

```text
verification_level = shape_only
cryptographically_verified = false
```

本版只检查 thinking 块、`signature` 字段透传与长度形态。它是多维风险证据，不是独立密码学验签或官方身份认证。25% 权重暂时保留，用于维持历史报告和排行榜可比性。

## 数据与配置

默认数据根目录为仓库内 `web_data/`：

```text
web_data/
├── jobs/anthropic/
├── jobs/openai/
├── jobs/gemini/
└── wishlist.txt
```

可配置项：

- `VERIDROP_WEB_DATA_DIR`：统一数据根目录。
- `VERIDROP_JOBS_DIR` / `VERIDROP_WISHLIST_PATH`：兼容旧版单项覆盖。
- `VERIDROP_MAX_PENDING_JOBS`：等待+运行任务上限，默认 24。
- `VERIDROP_MAX_RETAINED_JOBS`：内存中保留的完成任务，默认 500。
- `VERIDROP_ALLOW_PRIVATE_TARGETS=1`：仅本地私网实验。

## 测试

```bash
.venv/bin/pytest tests/ -q
node --check web/static/app.js
bash -n deploy.sh
```

JPG 需要 CJK 字体。Ubuntu 部署先安装 `fonts-noto-cjk`；`veridrop.service` 会在启动前检查字体文件。
