# 贡献指南

感谢你帮助改进零一智鉴。项目同时包含 React 首页和 Python/FastAPI 检测平台，请让每一个改动保持可追溯、可测试和边界清晰。

## 开发环境

```bash
npm ci
python3 -m venv zero-one-api-verifier/.venv
zero-one-api-verifier/.venv/bin/pip install -e "./zero-one-api-verifier[dev,web]"
npm run dev -- --host 127.0.0.1
```

## 改动原则

- 不要在 UI 改动中附带修改评分权重、协议实现、报告 Schema 或 API 契约。
- 不要使用全局字符串替换破坏上游归属、历史记录或协议文档。
- 修改产品域名时，按 [域名与 SEO 契约](docs/DOMAIN_AND_SEO.md) 同步所有公开表面。
- 页面交互必须支持键盘、明确焦点、减少动态效果和 390px 移动视口。
- 新增的错误状态先给出用户可理解的摘要，技术细节作为次级信息。
- 不在代码、Issue、截图、报告或测试 Fixture 中提交真实 API Key。

## 必要验证

```bash
npm run build
cd zero-one-api-verifier
.venv/bin/pytest
```

对涉及页面的改动，还应验证：

- 首页、检测中心、三个协议页、红黑榜和 FAQ 没有控制台错误。
- 移动导航可打开、关闭，`Escape` 和页面外点击能正常收起。
- 表单标签、原生校验、模型组合框、错误恢复和加载/禁用状态仍可用。
- Canonical、Open Graph、JSON-LD 和 Sitemap 与正式域名一致。

## 上游同步

检测核心 Fork 自 `canarybyte/veridrop`。上游同步使用独立 `sync/upstream-*` 分支，经 Tag、PR、回归测试和视觉对比后合并。完整流程见 [UPSTREAM_SYNC_POLICY.md](zero-one-api-verifier/docs/UPSTREAM_SYNC_POLICY.md)。

## 提交和 Pull Request

- 一个提交只表达一个完整意图。
- 提交说明建议使用 `feat:`、`fix:`、`docs:`、`test:`、`refactor:` 或 `chore:` 前缀。
- PR 说明需要列出用户可观察变化、契约变化、测试结果和截图（如果涉及 UI）。
- 任何协议、评分或 API 契约变化都必须单独立项，不得夹带在视觉修复中。
