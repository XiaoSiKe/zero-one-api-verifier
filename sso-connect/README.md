# 零一智鉴 · SSO Connect

独立的一键式商家 SSO 对接脚手架。它不依赖、不修改零一智鉴官网或 API 检测核心。

## 一条命令启动

```bash
docker compose up --build
```

启动后打开：

- 商家接入页：<http://127.0.0.1:8020/connect?demo=1>
- 本地演示商家：<http://127.0.0.1:8021>

Compose 仅绑定宿主机 `127.0.0.1`，不会把免登录 Demo 管理面暴露到局域网。

也可以直接使用本机 Node 24：

```bash
npm ci
npm run demo
```

## 本地完整实验

1. 打开商家接入页，页面已预填演示商家地址。
2. 点击“自动接入”。系统自动创建 OIDC Client，并立即跑通 Authorization Code + PKCE。
3. 首次进入演示商家时自动建号；再次进入时复用同一账号，商家用户数保持为 `1`。
4. 返回接入页，打开“邀请注册统计”。
5. 用另一个浏览器窗口打开邀请链接，完成明确标注的本地模拟验证。
6. 原邀请人的“成功注册”增加 `1`；重复访问和重复登录不会重复计数。

## 真实商家接入边界

页面会自动识别 New API、One API 或标准 OIDC，并生成可复制配置。真实外部商家仍必须在自己的后台粘贴并保存一次配置；在没有商家后台权限或专用插件时，任何平台都无法安全地替商家完成这一步。

如果首次 Client Secret 响应因断网等原因丢失，可在技术参数中选择“重新生成 Client Secret”；旧密钥会立即失效。

- 标准自研客户端与演示商家：强制 PKCE S256。
- New API `v1.0.0-rc.25`：使用 Client Secret 兼容其当前无 PKCE 的实现。
- One API `v0.6.10`：除无 PKCE兼容外，使用独立 JSON Token 适配入口。
- 不支持 OIDC 的自研站：可实现一个 RS256 signed handoff 接口作为兜底；该模式不是 OIDC。

New API/One API 的不同版本仍需用目标实例进行最终联调。当前脚手架不会索取商家管理员 Token，也不会尝试修改任意远端后台。

## 安全与生产边界

- OIDC 协议实现来自 OpenID Certified 的 `oidc-provider@9.11.5`。
- Client Secret 只在创建时返回一次，OIDC Artifact 使用 AES-256-GCM 加密后写入 SQLite。
- Redirect URI 精确匹配；授权码、Interaction、登录票据与 handoff `jti` 均短期且一次性。
- 外部站点探测拒绝私网、保留地址、非 HTTPS、跨域跳转和超大响应；loopback HTTP 只在 Demo 模式开放。
- SQLite 只适合当前单实例脚手架。多副本生产部署前应更换共享数据库或 Redis Adapter。
- 生产环境必须使用 HTTPS、正式用户与邮箱验证服务、受控反向代理，并完成安全审计。

## 测试

```bash
npm test
npx playwright install chromium
npm run test:e2e
```

自动化覆盖 Discovery、JWKS、PKCE、New API/One API兼容、授权码防重放、pairwise `sub`、signed handoff、邀请去重和 390px 窄屏。
