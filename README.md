# 零一智鉴 · API 真测雷达

> 从零到一，让每一个接口有据可鉴！

零一智鉴是一个开源 AI API 中转站风险检测平台。它通过真实请求、协议字段、能力响应、用量信号和官方基线对比，评估 Claude、OpenAI 与 Gemini 接口是否按声明工作。

- 正式域名：[https://mix.01yapi.cc](https://mix.01yapi.cc)
- GitHub：[https://github.com/XiaoSiKe/zero-one-api-verifier](https://github.com/XiaoSiKe/zero-one-api-verifier)
- 许可证：AGPL-3.0-or-later
- 上游项目：[canarybyte/veridrop](https://github.com/canarybyte/veridrop)

## 能做什么

- 检查 Claude Messages API、OpenAI Chat Completions 和 Gemini OpenAI-compatible API。
- 识别模型换芯、能力剥离、协议异常、流式/非流式不一致和 usage 异源痕迹。
- 按需运行长上下文 needle-in-haystack 探针。
- 生成可分享的 HTML 报告和 JPG 报告卡片。
- 按公开报告汇总中转站红黑榜。
- 检测逻辑、评分权重与证据生成路径公开可审计。

> 检测结果是风险证据，不是模型厂商背书或独立密码学身份认证。

## 项目结构

```text
.
├── src/                         # React 品牌首页
├── public/                      # 首页静态资产
├── scripts/dev.mjs              # 联合启动 Vite + FastAPI
├── zero-one-api-verifier/       # Python 检测核心、Web 应用与测试
│   ├── src/relay_detector/       # 协议客户端、检测器、评分与运行器
│   ├── web/                      # FastAPI、Jinja2、任务与排行榜
│   ├── tests/                    # Python 回归测试
│   └── docs/                     # 设计、PRD、同步与模块文档
├── Dockerfile
├── compose.yaml
└── docs/                        # 联合工作区架构、部署与域名文档
```

详细说明见 [架构文档](docs/ARCHITECTURE.md)。

## 快速开始

### Docker Compose（推荐用于本地预览）

Docker Compose 项目名固定为 `zero-one-api-verifier-preview`。

```bash
docker compose up --build -d
```

打开 [http://127.0.0.1:5173](http://127.0.0.1:5173)。

```bash
# 查看状态
docker compose ps

# 查看日志
docker compose logs -f web

# 停止（不删除数据卷）
docker compose down
```

如果 5173 端口已被占用：

```bash
LOCAL_PREVIEW_PORT=4173 docker compose up --build -d
```

### 直接本地运行

需要 Node.js 20+ 和 Python 3.10+。

```bash
npm ci
python3 -m venv zero-one-api-verifier/.venv
zero-one-api-verifier/.venv/bin/pip install -e "./zero-one-api-verifier[dev,web]"
npm run dev -- --host 127.0.0.1
```

联合开发服务会启动：

- Vite：`http://127.0.0.1:5173`
- FastAPI：`http://127.0.0.1:8012`
- Vite 将 `/app`、`/claude`、`/openai`、`/gemini`、`/leaderboard`、`/faq`、`/api`、`/r` 等路径代理到 FastAPI。

## 常用路由

| 路径 | 用途 |
| --- | --- |
| `/` | React 品牌首页 |
| `/app` | FastAPI 检测中心 |
| `/claude` | Claude 中转站检测 |
| `/openai` | OpenAI 中转站检测 |
| `/gemini` | Gemini 中转站检测 |
| `/leaderboard` | 中转站红黑榜 |
| `/faq` | 常见问题 |
| `/healthz` | 健康检查 |

## 测试

```bash
# React 生产构建
npm run build

# Python 完整回归测试
cd zero-one-api-verifier
.venv/bin/pytest
```

页面级改动至少需要验证 `/`、`/app`、三个协议表单、`/leaderboard` 和 `/faq`，并检查移动导航、键盘焦点、减少动态效果与浏览器控制台。

## 部署与域名

正式域名和 Canonical 基址均为 `https://mix.01yapi.cc`。DNS、TLS、反向代理、数据卷与发布检查清单见 [部署文档](docs/DEPLOYMENT.md) 和 [域名与 SEO 契约](docs/DOMAIN_AND_SEO.md)。

> 根目录的 Docker Compose 主要用于本地预览。生产环境应使用可审计的固定版本镜像、HTTPS 反向代理、持久化存储和独立的密钥管理。

## 安全与隐私

- API Key 只用于当次检测，不写入报告和持久化存储。
- 公开报告不得包含完整 API Key、Authorization Header 或其他认证秘密。
- 输入的中转地址经过 SSRF 防护和安全 HTTP 边界校验。
- 发现安全问题时，请按 [SECURITY.md](SECURITY.md) 私下报告，不要在公开 Issue 中披露可利用细节。

## 贡献与上游同步

贡献前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。检测核心源自 Veridrop，上游更新必须遵循 [受控同步策略](zero-one-api-verifier/docs/UPSTREAM_SYNC_POLICY.md)，不得用整页或整文件覆盖零一智鉴的品牌、模板、样式和可访问性修复。

## 许可证

本仓库以 **AGPL-3.0-or-later** 发布，完整许可证文本见 [zero-one-api-verifier/LICENSE](zero-one-api-verifier/LICENSE)。

项目 Fork 自 [canarybyte/veridrop](https://github.com/canarybyte/veridrop)，保留上游归属、修改说明和无担保条款。将修改版通过网络向用户提供服务时，需要向这些用户提供对应运行版本的完整源码。
