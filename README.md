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

Docker Compose 项目名为 `zeroone-zhijian-current`，与同机上的旧版预览隔离。
它一次启动两个服务，浏览器只需要打开一个入口就能预览全部页面：

| 服务 | 端口 | 内容 |
| --- | --- | --- |
| `web` | <http://127.0.0.1:5175> | 营销站，并把 `/leaderboard`、`/partner`、`/api` 等路径反代到 `verifier` |
| `verifier` | <http://127.0.0.1:8123> | FastAPI 服务：检测页、红黑榜、站点详情、站长中心、管理后台 |

```bash
docker compose up --build -d
```

打开 [http://127.0.0.1:5175](http://127.0.0.1:5175)。

可选的演示数据（站点、广告位、半年检测报告与访客记录），只写进数据卷、默认不运行：

```bash
docker compose --profile demo up seed
# 输出管理员 preview-admin / preview-admin-2026，站长 站长01 / preview-operator-2026
```

```bash
# 查看状态
docker compose ps

# 查看日志
docker compose logs -f web
docker compose logs -f verifier

# 停止（不删除数据卷）
docker compose down
```

如果端口已被占用：

```bash
LOCAL_PREVIEW_PORT=4173 VERIFIER_PREVIEW_PORT=8223 docker compose up --build -d
```

> 若 `docker compose up --build` 报 `failed to dial gRPC ... x-docker-expose-session-sharedkey`
> （本机 Compose bake 与 Docker Desktop 守护进程不兼容），改用经典构建器：
> `DOCKER_BUILDKIT=0 docker compose up --build -d`。

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
- `/partner/register`、`/partner/login`、`/partner/sites` 同样由 FastAPI 提供；不注册也可打开 `/app` 和三个协议检测页。
- 如果本机已经占用 5173，可使用 `npm run dev -- --host 127.0.0.1 --port 5174 --strictPort`，然后打开 `http://127.0.0.1:5174/`。

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
| `/api/ad-slots` | 公开已分配广告位的展示名称、域名、HTTPS 跳转链接与横幅地址 |
| `/api/ad-banners/{filename}` | 仅提供正在展示且站点已收录的 WebP 横幅 |
| `POST /api/visit` | 首页匿名访问计数（不影响公开页面使用） |
| `/partner/register` | 站长注册（用户名与密码，无邮箱） |
| `/partner/login` | 站长登录 |
| `/partner/sites` | 我的站点：站点资料、审核进度与广告数据 |
| `/partner/sites/new` | 提交站点收录申请 |
| `/partner/pricing`、`/partner/subscription` | 合作方式与广告订阅（暂不提供在线购买） |
| `/partner/featured`、`/partner/ads` | 展示合作说明与广告统计入口（无真实投放时不伪造数据） |
| `/partner/account` | 账号信息与密码修改 |
| `/partner/admin?section=sites` | 运维后台：已收录/待审核站点信息与审核（需管理员账号） |
| `/partner/admin/sites/new` | 管理员添加站点，指定归属账号并直接收录 |
| `/partner/admin?section=ads` | 广告位价格、站点绑定、双横幅与投放时长 |
| `/partner/admin?section=visits` | 匿名访问趋势、站长申请与收录概览 |

## 测试

```bash
# React 生产构建
npm run build

# Python 完整回归测试
cd zero-one-api-verifier
.venv/bin/pytest

# 独立 SSO 模块（Node 24）
cd sso-connect
npm test
npm run test:e2e
```

完整本地容器验收使用独立 Compose 项目与全新数据卷启动，且不运行 `demo` profile，然后从仓库根目录运行 `python3 scripts/smoke_stack.py`。该脚本会写入测试账号，只接受本机地址。备份和隔离恢复要求见 [部署文档](docs/DEPLOYMENT.md)。
Python 测试会强制把报告、站长库、访问库和心愿单重定向到单次运行的临时目录，不读取本地预览卷或生产数据。

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
