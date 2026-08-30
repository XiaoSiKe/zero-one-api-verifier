# Changelog

All notable changes to **Veridrop** are documented here.
This project adheres to [Semantic Versioning](https://semver.org/) and the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

Live demo: <https://veridrop.org> · 中转站检测频道:
[Claude](https://veridrop.org/claude) · [OpenAI](https://veridrop.org/openai) ·
[Gemini](https://veridrop.org/gemini) · [红黑榜](https://veridrop.org/leaderboard)

## [Unreleased]

### Added
- Caddy structured access logs(JSON 格式,含 Cf-Connecting-Ip / Referer / User-Agent)
- 用户画像分析工具 `scripts/analyze_access_log.py` — 把访问者按行为分群
  (比价决策买家 / 疑似中转站运营者 / 自测开发者 / 看了测试页未提交 / 浅浏览 / 一次性跳出 / 爬虫)
- 报告点击排行榜 + 报告评分分布直方图 + 检测可靠性 Dashboard

### Changed
- README:H1 + 首段加中文 SEO 关键词与锚文本回链,提升搜索引擎可见度
- GitHub repo description:关键词前置(去 emoji 占位)

## [0.1.0] - 2026-05-10

### Added
- 三协议检测:Anthropic Messages API、OpenAI Chat Completions、Gemini OpenAI 兼容协议
- **Claude thinking signature 加密级真伪验证**(中转站理论上无法伪造)
- OpenAI usage 字段后端指纹识别(检测 `claude_cache_creation_*` 异源痕迹的「换芯」中转站)
- Gemini 3 thinking-by-default 适配
- 三层 needle-in-haystack 长上下文探针(32k → 1M tokens),抓「宣传 1M 实际只给 200k」式欺诈
- 加权评分 + critical issue 一票否决(单项 critical 把 verdict 上限锁在 marginal)
- 三档运行模式:quick(~$0.005) / standard(~$0.012) / full(~$0.020)
- Web 服务:FastAPI + 异步任务队列、IP 限速、报告 JPG 卡片生成
- 中转站红黑榜:按域名聚合公开报告,贝叶斯排序防 1-sample 刷分
- 永久分享链接 `/r/{id}` 与社交分享图片 `/r/{id}.jpg`
- CLI 工具 `relay-detector`:`detect` / `compare` / `ping` 三个子命令
- 官方基线收集脚本 `bench.sh`(Opus 4.7 / Sonnet 4.6 / Haiku 4.5 / Opus 4.6)

### Privacy
- API key 全程只在内存中,跑完即抹,**不落盘、不写日志、不外发**
- 报告中 key 脱敏为 `sk-y7xU••••••0h` 格式
- 无前端追踪、无 cookie、无注册

[Unreleased]: https://github.com/canarybyte/veridrop/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/canarybyte/veridrop/releases/tag/v0.1.0
