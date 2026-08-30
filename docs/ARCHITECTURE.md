# 架构说明

## 系统边界

零一智鉴由两个同仓模块组成：

1. **React 品牌首页**：位于根目录 `src/`，使用 Vite 启动和构建，负责品牌展示、信任说明和检测入口。
2. **FastAPI 检测平台**：位于 `zero-one-api-verifier/`，包含协议客户端、检测器、评分、异步任务、Jinja2 页面、报告、红黑榜与公开 API。

开发环境中，Vite 作为唯一浏览器入口，将检测页和 API 路径代理到 FastAPI。

```text
浏览器
  │
  ├─ /                          → React/Vite
  │
  └─ /app, /claude, /api, /r… → Vite proxy → FastAPI :8012
                                             │
                                             ├─ 安全 URL 校验
                                             ├─ 协议 Runner
                                             ├─ Detectors
                                             ├─ Scorer
                                             └─ 报告/排行榜存储
```

## 检测流程

1. 用户选择 Claude、OpenAI 或 Gemini 协议。
2. 表单收集 `base_url + api_key + model + mode`。
3. `/api/probe` 尝试识别中转站暴露的模型和协议。
4. 提交前探活验证模型是否实际可用，并保留用户强制继续的逃生路径。
5. Runner 并发执行协议对应的 Detectors。
6. Scorer 将检测证据转换为总分、verdict、critical 问题和字段级细节。
7. 任务结果持久化为可分享报告，并在符合规则时汇入红黑榜。

## 不可混淆的结论边界

- Claude thinking signature 检查的是透传形态和结构证据，不是本服务独立完成的密码学验签。
- OpenAI 和 Gemini 当前主要提供行为级与协议级风险证据。
- 高分表示在本次检测范围内表现良好，不等于厂商身份认证。

## 数据与秘密

- API Key 仅存在于当次任务内存中，不进入报告 Schema、任务文件或排行榜。
- 报告持久化目录由 `VERIDROP_JOBS_DIR` 指定。
- 心愿单文件由 `VERIDROP_WISHLIST_PATH` 指定。
- Docker Compose 使用 `verifier-web-data` 命名卷保留上述运行数据。

## 设计和上游边界

- 品牌、首页、模板、样式和静态资产是零一智鉴的保护区。
- 检测核心、官方基线、协议行为和上游修复通过独立同步分支吸收。
- 混合文件必须逐段人工合并，不使用全局偏向上游的冲突策略。

详细规则见 [UI 设计规范](../zero-one-api-verifier/docs/UI_DESIGN_SPEC.md) 与 [上游同步策略](../zero-one-api-verifier/docs/UPSTREAM_SYNC_POLICY.md)。
