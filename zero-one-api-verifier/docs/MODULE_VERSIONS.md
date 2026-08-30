# 零一智鉴模块版本

| 模块 | 版本 | Git 标签 | 源分支 | 入口 |
|---|---|---|---|---|
| 官网 / UI | 0.2.0 | `ui-refresh-v0.2.0` | `feat/zeroone-ui-refresh` | `http://127.0.0.1:8012/` |
| 中转站检测 | 0.1.1 | `detector-v0.1.1` | `fix/detector-fullstack-v0.1.1` | `http://127.0.0.1:8012/claude` |
| 商家 SSO | 0.1.1 | `sso-connect-v0.1.1` | `fix/sso-connect-v0.1.1` | `http://127.0.0.1:8020/connect?demo=1` |
| 组合预览 | 0.2.0 | `zeroone-modular-v0.2.0` | `feat/modular-platform-v0.2.0` | 上述入口同时可用 |

组合分支只合并各模块已验收的提交，不直接修改 `main`。

本地启动：

```bash
# 官网 + 检测
VERIDROP_ALLOW_PRIVATE_TARGETS=1 \
  .venv/bin/python -m uvicorn web.server:app --host 127.0.0.1 --port 8012

# SSO + Demo 商家
cd sso-connect
docker compose up --build
```
