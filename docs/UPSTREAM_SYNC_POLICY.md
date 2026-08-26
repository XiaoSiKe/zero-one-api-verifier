# 零一智鉴上游同步与二开保护协议

> - 版本：1.3
> - 状态：强制执行
> - 自动化状态：产品身份、首页信息架构和关键 DOM Hook 契约已落地；页面流程、视觉快照与受保护路径守卫待补
> - 更新日期：2026-08-26
> - 上游仓库：`canarybyte/veridrop`
> - 下游仓库：`01-Yang/zero-one-api-verifier`
> - 当前上游基线：`16feef72ad76d154c3ae6b4c0917319597fc1888`

## 1. 目标

零一智鉴需要持续吸收 Veridrop 的检测器、协议兼容、基线、评分、报告、任务和排行榜更新，同时永久保留自己的品牌、首页、页面结构、视觉 Token、毛玻璃规则、响应式体验和 SEO 身份。

本协议的核心原则是：

> **上游功能可以更新，零一智鉴的二开 UI 不得在同步过程中被自动覆盖。**

上游同步不是把当前分支重置成上游，也不是点击按钮直接覆盖默认分支。每次同步都必须在独立分支完成，先保护下游 UI，再人工迁入上游对 UI 层的必要修复，最后通过 PR 和完整验证进入 `main`。

## 2. 不可协商规则

1. 不允许把 `main` 直接重置、强制同步或强制推送到 `upstream/main`。
2. 不允许在 `main` 上直接执行未经审查的上游合并。
3. 不允许使用会全局偏向一侧的冲突策略，静默丢弃下游 UI 或上游核心更新。
4. 每次同步必须创建独立的 `sync/upstream-*` 分支和可恢复的同步前 Tag。
5. 自动合并阶段结束时，完全保护区必须与同步前下游版本一致。
6. 上游对完全保护区的改动只能被审阅后手工迁入，不得整文件覆盖。
7. 同步 PR 必须记录上游起止提交、冲突处理、人工迁入内容和验证结果。
8. 已自动化检查任一失败，或尚未自动化的页面流程、视觉快照、受保护路径检查缺少人工证据，都不得合并。

明确禁止：

- `git reset --hard upstream/main`
- `git push --force` 或 `git push --force-with-lease` 到 `main`
- `gh repo sync --force`
- 直接使用 GitHub “Sync fork” 覆盖已经二开的默认分支
- `git merge -X theirs upstream/main`
- 以“解决冲突”为名把首页、模板或样式整文件替换为上游版本

## 3. 三类同步区域

### 3.1 上游优先区

这些区域负责检测能力和业务规则。零一智鉴不在其中做 UI 二开，原则上跟随上游更新：

- `src/relay_detector/**`
- `data/baselines/**`
- `web/jobs.py`
- `web/leaderboard.py`
- `web/probe.py`
- `web/ratelimit.py`

规则：

- 无下游定制时采用上游版本。
- 任何冲突都先确认是否存在越界的下游核心修改。
- 上游更新改变 API、报告字段或页面输入时，不直接改写 UI；应在同步 PR 中记录，并在人工合并区完成兼容适配。
- 全部现有测试通过后才能接受更新。

### 3.2 完全保护区

这些区域承载零一智鉴的首页、页面布局和视觉身份。自动同步不得改变它们：

- `web/templates/**`
- `web/static/style.css`
- `web/static/zero-one-logo.png`
- `docs/assets/zero-one-logo-source.png`
- 后续新增的零一智鉴 Logo、品牌插画、字体声明和静态视觉资源

其中包括但不限于：

- 首页 Hero、Slogan、唯一主 CTA、定义、可核验统计、开源信任、协议入口、检测步骤、结果边界说明和 Evidence Trace；
- WebGL Threads 只在首页挂载的性能边界，以及禁用 JavaScript/WebGL 时的可读回退；
- 三个协议检测页的视觉结构；
- 运行页、报告页、排行榜和 FAQ 的页面布局；
- 黑白 Token、毛玻璃材质、排版、圆角、阴影、动效和响应式规则；
- “零一智鉴 · API 真测雷达”“ZeroOne · API Verification Platform”及其视觉呈现。

规则：

- 自动合并后先恢复为同步前下游版本。
- 必须单独检查上游在这些文件中的变更。
- 上游的安全、可访问性、字段兼容或 Bug 修复可以手工迁入，但必须适配零一智鉴的现有结构，不能用上游整页覆盖。
- 任何有意改变完全保护区的同步提交，都必须列出逐项理由并附视觉对比。

### 3.3 人工合并区

这些文件同时包含功能、品牌或 SEO，不能整体采用上游，也不能永久冻结：

- `web/static/app.js`
- `web/server.py`
- `web/image_report.py`
- `web/faq_data.py`
- `web/static/robots.txt`
- `web/static/sitemap.xml`
- `web/static/llms.txt`
- `README.md`
- `pyproject.toml`
- `.github/**`

规则：

- 使用三方差异逐段审查。
- 优先迁入上游功能、安全和兼容修复。
- 保留零一智鉴品牌、域名、Canonical、分享图、下载文件名和源码入口。
- 不允许重新引入 `veridrop.org` Canonical、上游 Google Analytics ID 或上游品牌作为当前产品身份。
- 如果上游改变 JavaScript Hook、表单字段、状态 Payload 或报告 Schema，必须同步适配并增加/更新契约测试。

## 4. 必须保持的产品身份

每次同步后必须仍满足：

| 项目 | 必须保持的值 |
|---|---|
| 中文产品名 | `零一智鉴 · API 真测雷达` |
| 英文产品名 | `ZeroOne · API Verification Platform` |
| Slogan | `从零到一，让每一个接口有据可鉴！` |
| 正式域名 | `https://01yapi.cc` |
| Canonical 基址 | `https://01yapi.cc` |
| 仓库 | `01-Yang/zero-one-api-verifier` |
| 上游归属 | `Forked from canarybyte/veridrop` |
| 许可证 | `AGPL-3.0-or-later` |

首页、导航、页脚、SEO、Open Graph、JSON-LD、Sitemap、robots、llms 和 JPG 报告卡片不得在同步后恢复为上游产品身份。

## 5. 标准同步流程

以下流程中的日期需要替换为实际同步日期。

### 5.1 创建恢复点和同步分支

```bash
git fetch origin --prune
git fetch upstream --prune
git switch main
git pull --ff-only origin main
git tag pre-upstream-sync-2026-08-24
git switch -c sync/upstream-2026-08-24
```

要求：

- 开始前工作区必须干净。
- Tag 必须指向本次同步前的 `origin/main`。
- 分支名必须能识别同步日期；PR 中同时记录目标上游 SHA。

### 5.2 在同步分支合并上游

```bash
git merge --no-commit --no-ff upstream/main
```

合并未提交前：

1. 解决上游优先区的真实冲突；
2. 从同步前 Tag 恢复完全保护区；
3. 对人工合并区逐段完成三方审查；
4. 检查上游在完全保护区中的改动，建立“需要手工迁入”的清单；
5. 确认没有上游品牌、域名或统计 ID 被重新引入。

恢复完全保护区时，只能使用明确列出的路径和本次同步前 Tag，例如：

```bash
git restore --source=pre-upstream-sync-2026-08-24 -- \
  web/templates \
  web/static/style.css \
  web/static/zero-one-logo.png \
  docs/assets/zero-one-logo-source.png
```

不得使用仓库根目录、通配根路径或不明确的环境变量作为恢复目标。

### 5.3 人工迁入上游 UI 层修复

上游对完全保护区的改动不应被忽略。恢复下游 UI 后，必须查看上游差异并分类：

- 安全修复：必须迁入；
- API/字段兼容：必须迁入并补契约测试；
- 可访问性或浏览器兼容：原则上迁入；
- 上游品牌、布局和视觉调整：不迁入；
- 与零一智鉴功能无关的营销内容：不迁入。

迁入时按零一智鉴当前 DOM、Token 和视觉规范重做必要部分，形成独立、可审查的提交。禁止复制上游整页来解决局部兼容问题。

### 5.4 验证并提交 PR

同步分支至少需要完成：

1. 完整 pytest；
2. 受保护核心与基线的预期差异审查；
3. 完全保护区自动阶段的零差异检查；
4. 产品名、Slogan、正式域名和 Canonical 契约检查；
5. 首页、三个协议页、运行页、报告页、排行榜和 FAQ 浏览器 Smoke；
6. 390px、768px、1440px 视觉快照对比；
7. 自动无障碍检查；
8. API、报告、任务状态和排行榜契约回归。

同步 PR 描述必须包含：

- 上次同步的上游 SHA；
- 本次同步的上游 SHA；
- 上游变更摘要；
- 冲突文件和处理方式；
- 完全保护区是否保持；
- 手工迁入的 UI 层修复；
- 未迁入的上游 UI 变更及理由；
- 全部验证结果和视觉对比链接。

只有 PR 审查通过后才能进入 `main`。同步失败时关闭同步分支或 Revert 同步 Merge Commit；不得通过重置共享的 `main` 恢复。

## 6. 保护检查

### 6.1 自动合并阶段

在手工迁入上游 UI 修复之前，完全保护区相对同步前 Tag 必须零差异：

```bash
git diff --exit-code pre-upstream-sync-2026-08-24 -- \
  web/templates \
  web/static/style.css \
  web/static/zero-one-logo.png \
  docs/assets/zero-one-logo-source.png
```

如果有差异，说明二开 UI 仍可能被同步覆盖，必须停止并处理。

### 6.2 人工迁入阶段

手工迁入后允许出现明确差异，但每个差异必须：

- 对应一项上游功能、安全、兼容或可访问性修复；
- 在 PR 中逐项说明；
- 保持产品身份契约；
- 通过页面流程、视觉和无障碍验证；
- 不恢复上游首页、配色、排版或品牌文案。

### 6.3 持续契约

已落地的 `tests/test_zeroone_identity.py` 覆盖：

- 产品名、Slogan、当前 Fork 入口和上游归属存在；
- 首页保留唯一主 CTA、定义、可核验统计、开源信任、三协议入口、检测步骤和结果边界说明；
- Threads 只出现在首页，服务端渲染的核心内容不依赖 JavaScript 才可读；
- 模板声明的 Canonical 使用 `https://01yapi.cc`，且不回退到 `veridrop.org`；
- 活跃模板与静态前端文件不包含上游 Google Analytics ID；
- 关键 DOM Hook、表单字段和 API Endpoint 仍存在。

该契约保护用户可观察的内容、路由、归属和业务接缝，不锁定字号、容器宽度、SVG 坐标、私有 JavaScript 常量或内部选择器组合。

页面渲染与浏览器流程、首页及关键页面视觉快照、受保护路径差异守卫仍待自动化；在落地前必须按同步 PR 清单提供人工验证证据，不得把本节描述为已全面自动化。

## 7. 维护基线记录

每次同步完成后需要在本文件更新“当前上游基线”，并在同步 PR 中保留历史记录。上游基线只表示已经审查并合入的上游提交，不表示零一智鉴 UI 应与该提交一致。

如果上游在保护区内完成了重要安全或协议修复，应尽快开同步 PR 手工迁入；“保护 UI”不能作为忽略安全更新的理由。

## 8. 验收标准

一次上游同步只有同时满足以下条件才算完成：

1. 上游目标提交已记录并进入独立同步分支。
2. 同步前 Tag 可用于恢复。
3. 核心与业务更新按预期吸收。
4. 首页、模板、样式和品牌资产没有被自动覆盖。
5. 产品名、Slogan、域名、Canonical 和仓库身份保持不变。
6. 上游 UI 层必要修复经过人工迁入，而非整文件替换。
7. 现有完整测试、API 契约和任务流程通过。
8. 核心页面视觉快照没有未批准变化。
9. 自动无障碍检查没有严重或高优先级问题。
10. 同步 PR 已记录冲突、取舍、验证和上游 SHA。
