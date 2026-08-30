# 域名与 SEO 契约

## 唯一正式域名

```text
https://mix.01yapi.cc
```

项目中的以下公开标识必须使用该域名：

- HTML Canonical
- Open Graph URL 和报告图 URL
- Twitter Card 图片 URL
- JSON-LD 中的 `url`、`publisher`、`creator` 和面包屑
- Sitemap 静态条目和动态报告/排行榜条目
- `robots.txt` 中的 Sitemap 地址
- `llms.txt` 中的产品入口
- 报告 JPG 中的网站归属文案
- README、设计规范、PRD、同步协议和 SSO 示例链接

## DNS 与 TLS

DNS 接入时二选一：

- 使用 `A/AAAA` 记录指向服务器公网 IP；或
- 使用 `CNAME` 指向已经提供 TLS 和回源的部署平台域名。

上线前需确认：

```bash
dig mix.01yapi.cc
curl -I https://mix.01yapi.cc/healthz
curl -s https://mix.01yapi.cc/ | grep -i canonical
```

## 域名更换规则

未来如果再更换域名，必须在同一发布中同步更新：

1. 模板和结构化数据。
2. 服务端 Sitemap 生成逻辑。
3. 静态 `sitemap.xml`、`robots.txt` 和 `llms.txt`。
4. 报告图生成器的归属文案。
5. 测试中的站点身份契约。
6. GitHub 仓库 Homepage 和 README。
7. DNS、TLS 和旧域名的 301 重定向。

不得只更新页面可见文案而保留旧 Canonical，也不得在同一版本中混用两个正式域名。

## 自动检查

```bash
rg -n '(?<!mix\.)01yapi\.cc' -P . \
  -g '!node_modules' -g '!dist' -g '!**/.git/**'
```

正常情况下该命令应无输出。
