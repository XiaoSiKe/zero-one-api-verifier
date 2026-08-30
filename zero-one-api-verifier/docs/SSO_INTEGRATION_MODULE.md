# 零一智鉴 SSO 对接模块

> 状态：本地可运行脚手架已实现
> 核心目标：一次注册，一键直达所有已接入商家；邀请注册人数清晰可查。

实现位于 `sso-connect/`，使用 Node 24、`oidc-provider`、Express 与加密 SQLite Adapter。运行与本地实验方法见 [`sso-connect/README.md`](../sso-connect/README.md)。该实现暂不接入官网。

## 1. 产品边界

- 零一智鉴作为统一身份提供方，商家网站作为接入方。
- “一键直达”只适用于已接入零一智鉴 SSO 的商家，不适用于任意网站。
- 商家邀请链接只能记录来源，不能单独实现自动登录。
- SSO 只负责身份、建号和登录；充值、返佣、历史用户同步不属于首版。
- 本模块属于独立的聚合平台/身份服务，不修改 `zero-one-api-verifier` 的检测、评分和报告核心。

## 2. 用户体验

### 2.1 一键进入商家

```text
用户登录零一智鉴
  → 点击商家卡片
  → 商家验证零一智鉴身份
  → 首次自动创建商家账号，之后复用同一账号
  → 直接进入商家控制台
```

用户不需要在商家处再次填写账号、密码或邀请码。首次依法需要授权时，最多增加一次信息确认；后续进入保持单击直达。

### 2.2 邀请注册统计

每位用户拥有唯一邀请链接：

```text
https://mix.01yapi.cc/i/{invite_code}
```

“邀请注册人数”定义为：通过该链接完成注册并通过账号验证的去重用户数，不等于链接点击量。

统计规则：

- 采用首次有效邀请归因，有效期 30 天。
- 一个新用户只能归属于一个邀请人，注册成功后不可改绑。
- 同一用户重复点击、重复登录只计算一次。
- 自邀、已有账号、无效或风控账号不计入。
- 邀请中心展示：邀请链接、点击量、成功注册人数、转化率、最近注册时间；被邀请人身份默认脱敏。

## 3. 商家接入：一页三步

首选标准 OIDC，兼容 New API、One API 和支持 OIDC 的自研站点。

1. 商家填写域名并选择“自动识别 / New API / One API / 自研”。
2. 系统自动生成 `Issuer/Well-Known`、`Client ID`、`Client Secret` 和回调地址配置卡。
3. 商家复制配置并点击“验证并启用”。

平台自动验证 Discovery、回调地址、授权码交换、Token 签名、首次建号、再次登录和账号一致性。运营端不展示请求 JSON、字段映射和成功表达式等复杂配置。

不支持 OIDC 的商家只需实现一个签名接口：

```http
POST /zeroone/sso/handoff
```

该接口负责验证零一智鉴签名、幂等创建或查找用户，并返回 30～60 秒内有效且仅能使用一次的登录地址。

## 4. 技术实现

### 4.1 标准登录方式

- 协议：OIDC Authorization Code Flow；标准自研客户端强制 PKCE S256。New API/One API 当前版本不发送 PKCE，仅对这两个受控模板使用 Client Secret 兼容例外。New API `rc.25` 还必须把后台「服务器地址」设为公开 Origin，以保证 Token 请求的 Redirect URI 精确匹配。
- 零一智鉴提供：Discovery、Authorization、Token、JWKS 和 UserInfo 端点。
- 商家按 `issuer + sub` 唯一绑定本地账号，不以邮箱作为永久主键。
- 商家启动地址负责生成 `state`、`nonce` 和 PKCE，完成后创建自己的 Session/Cookie。
- 首次建号可写入该商家的合作编号；后续登录不得修改归属。

### 4.2 最小数据模型

| 表 | 关键字段 | 用途 |
|---|---|---|
| `users` | `id`, `invite_code`, `verified_at` | 平台用户与个人邀请链接 |
| `invite_visits` | `invite_code`, `visitor_hash`, `clicked_at` | 点击统计与注册前归因 |
| `user_referrals` | `inviter_user_id`, `invitee_user_id UNIQUE`, `bound_at` | 不可重复的邀请注册关系 |
| `merchant_integrations` | `merchant_id`, `mode`, `client_id`, `redirect_uris`, `start_url`, `status` | 商家 SSO 配置 |
| `merchant_user_bindings` | `user_id`, `merchant_id`, `external_user_id` | 平台用户与商家账号绑定 |
| `sso_transactions` | `state/jti`, `merchant_id`, `user_id`, `expires_at`, `status`, `error_code` | 防重放、审计和排错 |

必须建立唯一约束：`user_referrals.invitee_user_id`、`merchant_user_bindings(user_id, merchant_id)`、`sso_transactions.state/jti`。

### 4.3 最小接口

```text
GET  /i/{invite_code}                    记录邀请访问并进入注册页
GET  /api/me/invites/summary             返回点击、注册人数和转化率
GET  /api/me/invites/registrations       返回脱敏后的邀请注册明细
GET  /sso/merchants/{merchant_id}/start  启动一键进入商家流程
POST /api/integrations/{id}/rotate-secret 首次密钥丢失时安全轮换
GET  /.well-known/openid-configuration   OIDC 自动发现
GET  /oauth/authorize                     OIDC 授权
POST /oauth/token                         授权码换 Token
GET  /.well-known/jwks.json               公钥集合
```

邀请关系必须在“账号注册并验证成功”的同一事务中写入，成功后再更新邀请统计，避免只点击未注册或并发重复计数。

## 5. 安全要求

- 全程 HTTPS；Client Secret、签名私钥只存服务端密钥库。
- Redirect URI 精确白名单，不允许通配域名或任意跳转。
- 授权码、`state`、`nonce`、`jti` 和登录票据均一次性使用，并设置短有效期。
- 使用 pairwise `sub`，避免商家之间直接关联同一用户身份。
- 不在 URL 中传密码、长期 Token 或完整用户资料。
- 登录、建号、邀请绑定均需限流、审计和防重放；失败原因在商家后台可见。

## 6. 首版验收标准

1. 用户通过邀请链接完成验证后，邀请人的“成功注册人数”准确增加 1；重复访问和重复登录不增加。
2. New API `v1.0.0-rc.25@f116414` 真实镜像已跑通登录回路。One API `v0.6.10@3915ce9` 已跑通 JSON Token Wire/API 流程，但官方镜像内置前端缺少 OIDC 登录按钮和回调路由；完整一键登录需升级或补上 One API 前端。
3. 已登录用户点击已接入商家后，无需再次输入账号密码即可进入商家控制台。
4. 首次进入创建一个商家账号；再次进入必须登录同一账号，不得重复建号。
5. 邀请归因一经注册绑定不可篡改；自邀、重放、伪造回调和非白名单跳转均被拒绝。
6. 商家后台能看到接入状态和失败原因；用户能看到自己的邀请链接、成功注册人数和脱敏明细。

## 7. 暂不实现

- 任意未接入网站的自动登录。
- 充值记录查询、充值推送、返佣结算和历史用户同步。
- 统一托管商家余额、API Key 或用户密码。
- 万能接口编排器和面向运营人员的复杂字段映射。
