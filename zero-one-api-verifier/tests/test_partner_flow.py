"""Operator registration and listing remain separate from public scoring."""

from __future__ import annotations

import sqlite3
import hashlib
import io
import time
from pathlib import Path

import httpx
import pytest
from PIL import Image

from web import analytics, partner, ratelimit, server
from web.leaderboard import ProtocolStats, RelayStats

# 站长注册必须同时提交收录资料，站长中心与审核队列才会立刻拿到申请。
REGISTRATION = {
    "name": "站长",
    "password": "strong-password-123",
    "site_name": "注册中转站",
    "domain": "register.example",
    "description": "注册时一并提交",
    "contact_method": "qq",
    "contact_handle": "12345678",
}


@pytest.mark.asyncio
async def test_registration_accepts_same_origin_when_proxy_proto_is_blank(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(partner, "DB_PATH", tmp_path / "partners.sqlite3")
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=server.app), base_url="http://testserver",
    ) as client:
        response = await client.post(
            "/partner/register", data=REGISTRATION,
            headers={"origin": "http://testserver", "x-forwarded-proto": ""},
            follow_redirects=False,
        )
    assert response.status_code == 303


@pytest.mark.asyncio
async def test_register_login_and_pending_site_submission(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(partner, "DB_PATH", tmp_path / "partners.sqlite3")
    ratelimit.reset()
    origin = {"origin": "http://testserver"}
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=server.app), base_url="http://testserver",
    ) as client:
        guest = await client.get("/partner/sites", follow_redirects=False)
        assert guest.status_code == 303
        assert guest.headers["location"] == "/partner/login"
        assert (await client.get("/partner/session")).json() == {"authenticated": False, "home": "/partner/sites"}

        page = await client.get("/partner/register")
        assert page.status_code == 200
        assert 'name="email"' not in page.text
        assert "邮箱" not in page.text
        # 收录信息必须与账号一起填写，注册即产生待审核申请。
        for field in ('name="site_name"', 'name="domain"', 'name="description"', 'name="contact_method"', 'name="contact_handle"'):
            assert field in page.text
        assert 'name="website_url"' not in page.text
        assert '账号资料与站点收录资料一次填完' not in page.text
        assert '注册即提交收录申请' not in page.text
        assert 'class="partner-form-grid partner-form-grid--site-identity"' in page.text
        assert 'name="description" required' in page.text

        blocked = await client.post(
            "/partner/register", data=REGISTRATION, headers={"origin": "https://attacker.example"},
        )
        assert blocked.status_code == 403

        missing_description = await client.post(
            "/partner/register", data=dict(REGISTRATION, description=""), headers=origin,
        )
        assert missing_description.status_code in {400, 422}
        if missing_description.status_code == 400:
            assert "请填写站点简介" in missing_description.text

        created = await client.post(
            "/partner/register", data=REGISTRATION, headers=origin, follow_redirects=False,
        )
        assert created.status_code == 303
        assert created.headers["location"] == "/partner/sites?submitted=1"
        assert "httponly" in created.headers["set-cookie"].lower()
        assert "samesite=strict" in created.headers["set-cookie"].lower()
        assert "password" not in created.headers["set-cookie"].lower()
        assert (await client.get("/partner/session")).json() == {"authenticated": True, "home": "/partner/sites"}
        duplicate = await client.post(
            "/partner/register",
            data=dict(REGISTRATION, password="another-password-123", domain="other.example"),
            headers=origin,
        )
        assert duplicate.status_code == 400
        assert "该用户名已注册" in duplicate.text
        duplicate_domain = await client.post(
            "/partner/register",
            data=dict(REGISTRATION, name="另一位站长"),
            headers=origin,
        )
        assert duplicate_domain.status_code == 400
        assert "该域名已提交收录申请" in duplicate_domain.text

        dashboard = await client.get("/partner/sites")
        assert dashboard.status_code == 200
        assert dashboard.headers["cache-control"] == "private, no-store"
        # 注册时提交的站点立刻出现在站长中心并入待审队列。
        assert "register.example" in dashboard.text
        assert "注册中转站" in dashboard.text
        assert "QQ · 12345678" in dashboard.text
        assert "待审核" in dashboard.text
        assert "提交时间" in dashboard.text
        assert "申请收录站点" not in dashboard.text  # 已有站点时不再显示空状态
        assert "管理当前账号提交的中转站、审核进度以及广告位到期时间。" not in dashboard.text
        assert "共 1 个站点 · 审核通过后正式进入红黑榜收录列表" not in dashboard.text
        assert "查看展示合作 →" not in dashboard.text
        assert "当前账号站点已获分配的广告位；展示与点击统计暂未接入" not in dashboard.text
        assert "了解广告订阅 →" not in dashboard.text
        assert "广告位与到期时间" not in dashboard.text
        assert "目前没有可展示的广告投放数据。广告订阅开通后，真实数据会显示在这里。" not in dashboard.text
        assert '<span class="home-specular-label">提交收录</span>' not in dashboard.text
        assert "当前账号还没有提交站点。可以先申请收录，再在这里查看审核进度。" not in dashboard.text
        assert "目前没有可展示的广告投放数据。广告订阅开通后，真实数据会显示在这里。" not in dashboard.text
        assert '<span class="home-specular-label">提交收录</span>' not in dashboard.text
        assert 'aria-label="站长中心导航"' in dashboard.text
        assert '零一站长中心' in dashboard.text
        assert 'href="/partner/subscription"' in dashboard.text
        assert 'href="/partner/pricing"' not in dashboard.text
        assert 'class="threads-background" data-threads' in dashboard.text
        assert 'class="site-header partner-topbar"' in dashboard.text
        assert 'class="partner-sidebar"' not in dashboard.text
        assert 'id="site-details"' in dashboard.text
        assert 'id="ad-data"' in dashboard.text
        assert "广告数据" in dashboard.text
        assert "暂无广告订阅" in dashboard.text
        for label in ("近 30 天点击", "点击趋势"):
            assert label not in dashboard.text
        assert "北京时间 · 5 秒内重复点击合并" not in dashboard.text
        assert "广告位开通后，订阅状态、到期时间和真实点击会显示在这里。" not in dashboard.text
        assert '<span class="home-specular-label">广告订阅</span>' in dashboard.text
        assert 'aria-label="账户：站长"' in dashboard.text
        assert 'href="/partner/account"' in dashboard.text
        assert 'action="/partner/logout"' in dashboard.text
        assert 'href="/partner/sites/new"' in dashboard.text

        new_site_page = await client.get("/partner/sites/new")
        assert new_site_page.status_code == 200
        assert 'action="/partner/sites"' in new_site_page.text
        assert "只填域名，不包含 https://、路径或端口。" not in new_site_page.text
        assert 'name="contact_method" value="qq" required' in new_site_page.text
        assert 'name="contact_method" value="wechat" required' in new_site_page.text
        assert 'name="contact_handle" type="text" required' in new_site_page.text
        assert 'QQ 或 微信 <span aria-hidden="true">*</span>' in new_site_page.text
        assert 'QQ 号或微信号' not in new_site_page.text
        assert '返回我的站点' not in new_site_page.text
        assert "；无需提供中转站 API key。" not in new_site_page.text
        assert "审核通过不代表自动获得检测分数或榜单排名。" not in new_site_page.text
        for path, title in (
            ("/partner/pricing", "套餐报价"),
            ("/partner/subscription", "广告订阅"),
            ("/partner/featured", "精选置顶"),
            ("/partner/ads", "广告统计"),
            ("/partner/account", "账号信息"),
        ):
            section = await client.get(path)
            assert section.status_code == 200
            assert title in section.text
            assert 'aria-label="站长中心导航"' in section.text

        subscription = await client.get("/partner/subscription")
        assert subscription.text.count('class="partner-offer-card"') == 2
        assert subscription.text.count('class="partner-slot-card"') == 16
        assert subscription.text.count('class="partner-secondary home-specular-button"') == 2
        header_end = subscription.text.index('</header>', subscription.text.index('class="partner-workspace-header"'))
        header = subscription.text[:header_end]
        assert "联系申请展示" in header and "查看广告数据" in header
        assert subscription.text.count("联系申请展示") == 1
        assert subscription.text.count("查看广告数据") == 1
        assert subscription.text.count('class="partner-slot-code partner-slot-code-t"') == 8
        assert subscription.text.count("专业版是后台数据工具套餐。") == 1
        assert "<li>专业版是后台数据工具套餐。</li>" in subscription.text
        for rank in range(1, 9):
            assert f"赞助区第 {rank} 位" in subscription.text
            assert f"精选排名第 {rank} 位" in subscription.text
        assert "模型组赞助区第" not in subscription.text
        assert "Top 10 精选排名第" not in subscription.text
        for expected in (
            "基础收录与专业玩家", "基础收录", "¥49", "专业玩家", "¥99",
            "广告置顶与精选", "赞助置顶榜", "靠谱精选榜",
            "S1", "S8", "精选赞助", "T1", "T8",
            "¥299/月", "¥199/月", "¥159/月", "¥99/月", "¥49/月",
        ):
            assert expected in subscription.text
        # S3 为精选赞助 159/月，S8 为标准赞助 99/月，暂不再出现“价格待定”。
        assert "价格待定" not in subscription.text
        for removed in ("广告位价格", "不包含数据看板、点击明细和广告位。", "专业版是后台工具套餐。"):
            assert removed not in subscription.text

        invalid = await client.post(
            "/partner/sites", data={"name": "样本站", "domain": "https://relay.example/v1", "description": "test",
                                   "contact_method": "qq", "contact_handle": "12345678"},
            headers=origin,
        )
        assert invalid.status_code == 400
        unsafe_website = await client.post(
            "/partner/sites", data={"name": "样本站", "domain": "relay.example",
                                   "website_url": "http://relay.example",
                                   "contact_method": "qq", "contact_handle": "12345678"},
            headers=origin,
        )
        assert unsafe_website.status_code == 400
        assert "HTTPS 地址" in unsafe_website.text

        missing_method = await client.post(
            "/partner/sites", data={"name": "样本站", "domain": "relay.example", "contact_handle": "12345678"},
            headers=origin,
        )
        assert missing_method.status_code == 400
        assert "请选择 QQ 或微信" in missing_method.text
        missing_handle = await client.post(
            "/partner/sites", data={"name": "样本站", "domain": "relay.example", "contact_method": "qq"},
            headers=origin,
        )
        assert missing_handle.status_code == 400
        assert "请填写所选联系方式的账号" in missing_handle.text
        invalid_method = await client.post(
            "/partner/sites", data={"name": "样本站", "domain": "relay.example",
                                   "contact_method": "telegram", "contact_handle": "other"},
            headers=origin,
        )
        assert invalid_method.status_code == 400

        submitted = await client.post(
            "/partner/sites", data={"name": "样本站", "domain": "relay.example", "description": "Claude and GPT",
                                   "contact_method": "qq", "contact_handle": "12345678"},
            headers=origin, follow_redirects=False,
        )
        assert submitted.status_code == 303
        assert submitted.headers["location"] == "/partner/sites?submitted=1"
        assert partner.approved_domains() == set()
        dashboard = await client.get("/partner/sites")
        assert "relay.example" in dashboard.text
        assert "QQ · 12345678" in dashboard.text
        assert "待审核" in dashboard.text
        wechat_submission = await client.post(
            "/partner/sites", data={"name": "微信站点", "domain": "wechat.example",
                                   "contact_method": "wechat", "contact_handle": "wx_example"},
            headers=origin, follow_redirects=False,
        )
        assert wechat_submission.status_code == 303
        assert "微信 · wx_example" in (await client.get("/partner/sites")).text

        logged_out = await client.post("/partner/logout", headers=origin, follow_redirects=False)
        assert logged_out.status_code == 303
        assert (await client.get("/partner/sites", follow_redirects=False)).status_code == 303
        assert (await client.get("/partner/session")).json() == {"authenticated": False, "home": "/partner/sites"}

        wrong = await client.post(
            "/partner/login", data={"name": "站长", "password": "wrong-password"}, headers=origin,
        )
        assert wrong.status_code == 400
        signed_in = await client.post(
            "/partner/login", data={"name": "站长", "password": "strong-password-123"},
            headers=origin, follow_redirects=False,
        )
        assert signed_in.status_code == 303

        password_changed = await client.post(
            "/partner/account/password",
            data={"current_password": "strong-password-123", "new_password": "replacement-password-123"},
            headers=origin, follow_redirects=False,
        )
        assert password_changed.status_code == 303
        assert password_changed.headers["location"] == "/partner/login?changed=1"
        assert (await client.get("/partner/account", follow_redirects=False)).status_code == 303
        assert partner.authenticate("站长", "strong-password-123") is None
        assert partner.authenticate("站长", "replacement-password-123") is not None

    with sqlite3.connect(partner.DB_PATH) as conn:
        stored = conn.execute("SELECT password_hash FROM operators WHERE name = ?", ("站长",)).fetchone()
        assert stored and "strong-password-123" not in stored[0]
        assert conn.execute("SELECT role FROM operators WHERE name = '站长'").fetchone()[0] == "operator"
        assert "email" not in {row[1] for row in conn.execute("PRAGMA table_info(operators)")}
        assert conn.execute("SELECT status FROM site_submissions WHERE domain='register.example'").fetchone()[0] == "pending"
        assert conn.execute("SELECT contact_method, contact_handle FROM site_submissions WHERE domain='relay.example'").fetchone() == ("qq", "12345678")
    assert (partner.DB_PATH.stat().st_mode & 0o777) == 0o600


@pytest.mark.asyncio
async def test_leaderboard_modes_do_not_promote_unreviewed_sites(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(partner, "DB_PATH", tmp_path / "partners.sqlite3")
    monkeypatch.setattr(server.leaderboard, "aggregate", lambda: ([], {"total_reports": 0, "total_relays": 0, "ranked_relays": 0}))
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=server.app), base_url="http://testserver",
    ) as client:
        for board, label in (("featured", "靠谱精选榜"), ("certified", "认证综合榜"), ("all", "全部站点合集")):
            response = await client.get(f"/leaderboard?board={board}")
            assert response.status_code == 200
            assert label in response.text
            assert response.text.count('class="board-sponsor-slot"') == 8
            assert '赞助位 S1' in response.text and '赞助位 S8' in response.text
            assert 'class="lb-row"' not in response.text
            assert "这个榜单暂时没有站点" not in response.text


@pytest.mark.asyncio
async def test_certified_board_requires_review_and_report_evidence(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(partner, "DB_PATH", tmp_path / "partners.sqlite3")
    operator_id = partner.register("站长", "strong-password-123")
    partner.submit_site(operator_id, "示例中转站", "relay.example", "", "qq", "12345678")
    relay = RelayStats(domain="relay.example")
    relay.by_protocol["openai"] = ProtocolStats(protocol="openai", count=2, scores=[91, 93], last_score=93, last_job_id="example")
    monkeypatch.setattr(server.leaderboard, "aggregate", lambda: ([relay], {"total_reports": 2, "total_relays": 1, "ranked_relays": 1}))
    admin_id = partner.create_admin("精选管理员", "admin-password-123")
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=server.app), base_url="http://testserver",
    ) as client:
        pending = await client.get("/leaderboard?board=certified")
        assert "relay.example" not in pending.text
        # 未占用 T1–T8 展示位时，靠谱精选榜为空。
        featured = await client.get("/leaderboard?board=featured")
        assert "relay.example" not in featured.text
        assert "T1–T8 精选展示位" in featured.text
        all_sites = await client.get("/leaderboard?board=all")
        assert "relay.example" not in all_sites.text
        assert "12345678" not in all_sites.text

        assert partner.set_site_status("relay.example", "approved") is True
        certified = await client.get("/leaderboard?board=certified")
        assert "relay.example" in certified.text
        assert "已收录认证" in certified.text
        assert 'class="lb-row"' in certified.text
        all_sites = await client.get("/leaderboard?board=all")
        assert "relay.example" in all_sites.text
        assert "已收录认证" in all_sites.text

        # 精选榜只呈现 T1–T8 展示位上的站点，并带精选展示与认证图标。
        assert partner.update_ad_slot(admin_id, "T1", 299, "relay.example") is True
        featured = await client.get("/leaderboard?board=featured")
        assert "relay.example" in featured.text
        assert "精选展示 · T1" in featured.text
        assert "已收录认证" in featured.text

        # 全部站点合集按 S1–S8 / T1–T8 展示位优先：分数更高的普通站点排在其后。
        other = RelayStats(domain="plain.example")
        other.by_protocol["openai"] = ProtocolStats(
            protocol="openai", count=3, scores=[99, 99, 99], last_score=99, last_job_id="plain",
        )
        partner.submit_site(operator_id, "普通站点", "plain.example", "", "qq", "private")
        assert partner.set_site_status("plain.example", "approved") is True
        monkeypatch.setattr(server.leaderboard, "aggregate", lambda: (
            [other, relay], {"total_reports": 5, "total_relays": 2, "ranked_relays": 2},
        ))
        all_sites = await client.get("/leaderboard?board=all")
        assert all_sites.text.index('id="relay.example"') < all_sites.text.index('id="plain.example"')
        assert "精选展示 · T1" in all_sites.text
        assert "全部站点合集" in all_sites.text
        # 合集页不出现其它榜单的标题。
        assert "🏆 认证综合榜" not in all_sites.text
        assert "🏆 靠谱精选榜" not in all_sites.text
        assert "🏆 认证综合榜" in (await client.get("/leaderboard?board=certified")).text


@pytest.mark.asyncio
async def test_admin_added_site_catalog_and_banner_flow(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(partner, "DB_PATH", tmp_path / "partners.sqlite3")
    monkeypatch.setattr(server.leaderboard, "aggregate", lambda: ([], {"total_reports": 0, "total_relays": 0, "ranked_relays": 0}))
    ratelimit.reset()
    owner_id = partner.register("站长乙", "operator-password-123")
    admin_id = partner.create_admin("管理员乙", "admin-password-123")
    origin = {"origin": "http://testserver"}
    transport = httpx.ASGITransport(app=server.app)

    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as owner_client:
        owner_client.cookies.set(partner.SESSION_COOKIE, partner.new_session(owner_id))
        denied = await owner_client.post(
            "/partner/admin/sites/new",
            data={"name": "目录站", "domain": "catalog.example", "owner_id": owner_id,
                  "contact_method": "qq", "contact_handle": "private-contact"},
            headers=origin,
        )
        assert denied.status_code == 403

    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as admin_client:
        admin_client.cookies.set(partner.SESSION_COOKIE, partner.new_session(admin_id))
        form = await admin_client.get("/partner/admin/sites/new")
        assert form.status_code == 200
        assert "归属账号" in form.text
        assert 'name="status"' not in form.text
        assert 'name="website_url"' in form.text
        created = await admin_client.post(
            "/partner/admin/sites/new",
            data={"name": "目录站", "domain": "catalog.example", "owner_id": owner_id,
                  "status": "pending", "description": "已收录，尚未检测",
                  "website_url": "https://catalog.example/welcome",
                  "contact_method": "qq", "contact_handle": "private-contact"},
            headers=origin, follow_redirects=False,
        )
        assert created.status_code == 303
        assert created.headers["location"].endswith("added=1")
        assert partner.sites_for_operator(owner_id)[0]["status"] == "approved"
        assert partner.sites_for_operator(owner_id)[0]["submission_source"] == "admin"
        assert partner.sites_for_operator(owner_id)[0]["approved_at"] is not None
        site_page = await admin_client.get("/partner/admin")
        assert "目录站" in site_page.text and "站长乙" in site_page.text
        assert "收录时间" in site_page.text
        assert "拒绝" not in site_page.text and "设为待审" not in site_page.text
        assert "已收录认证" not in site_page.text
        assert "待审核站点" in site_page.text

        all_page = await admin_client.get("/leaderboard?board=all")
        assert "目录站" in all_page.text
        assert "暂无公开检测报告" in all_page.text
        assert "已收录认证" in all_page.text
        assert "private-contact" not in all_page.text
        certified_without_report = await admin_client.get("/leaderboard?board=certified")
        assert "目录站" not in certified_without_report.text

        relay = RelayStats(domain="catalog.example")
        relay.by_protocol["openai"] = ProtocolStats(
            protocol="openai", count=1, scores=[91], last_score=91, last_job_id="sample",
        )
        monkeypatch.setattr(server.leaderboard, "aggregate", lambda: (
            [relay], {"total_reports": 1, "total_relays": 1, "ranked_relays": 0},
        ))
        certified_with_report = await admin_client.get("/leaderboard?board=certified")
        assert "catalog.example" in certified_with_report.text
        assert "已收录认证" in certified_with_report.text
        assert "单次样本" in certified_with_report.text

        picture = io.BytesIO()
        Image.new("RGB", (600, 200), "#111827").save(picture, format="PNG")
        picture_2 = io.BytesIO()
        Image.new("RGB", (600, 200), "#404040").save(picture_2, format="PNG")
        assigned = await admin_client.post(
            "/partner/admin/ad-slot",
            data={"code": "S1", "price_yuan": "299", "domain": "catalog.example"},
            files={
                "banner": ("banner.png", picture.getvalue(), "image/png"),
                "banner_2": ("banner2.png", picture_2.getvalue(), "image/png"),
            },
            headers=origin, follow_redirects=False,
        )
        assert assigned.status_code == 303
        placement = (await admin_client.get("/api/ad-slots")).json()["slots"]["S1"]
        assert placement["url"] == "https://catalog.example/welcome"
        assert placement["image_url"].startswith("/api/ad-banners/")
        assert len(placement["image_urls"]) == 2
        assert "private-contact" not in str(placement)
        private_preview = placement["image_url"].replace("/api/ad-banners/", "/partner/admin/ad-banner/")
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as outside:
            assert (await outside.get(private_preview, follow_redirects=False)).status_code == 303
            outside.cookies.set(partner.SESSION_COOKIE, partner.new_session(owner_id))
            assert (await outside.get(private_preview)).status_code == 403
        for image_url in placement["image_urls"]:
            image = await admin_client.get(image_url)
            assert image.status_code == 200
            assert image.headers["content-type"] == "image/webp"
            assert image.content[:4] == b"RIFF"
        sponsor_page = await admin_client.get("/leaderboard")
        assert all(url in sponsor_page.text for url in placement["image_urls"])
        assert placement["tracking_url"] in sponsor_page.text
        assert placement["url"] not in sponsor_page.text
        assert 'has-rotation' in sponsor_page.text
        ads_page = await admin_client.get("/partner/admin?section=ads")
        assert 'name="target_url"' not in ads_page.text
        assert 'name="banner_2"' in ads_page.text
        assert 'name="duration_days"' in ads_page.text
        assert "赞助广告位" in ads_page.text
        assert ads_page.text.count('class="partner-admin-slot-card"') == 8
        recommended_ads = await admin_client.get("/partner/admin?section=ads&ad_type=recommended")
        assert "推荐广告位" in recommended_ads.text
        assert recommended_ads.text.count('class="partner-admin-slot-card"') == 8
        duration = await admin_client.post(
            "/partner/admin/ad-duration",
            data={"code": "S1", "duration_days": "30"},
            headers=origin, follow_redirects=False,
        )
        assert duration.status_code == 303
        assert next(slot for slot in partner.ad_slots() if slot["code"] == "S1")["ends_at"] is not None
        with partner._db() as conn:
            conn.execute("UPDATE ad_slots SET ends_at = ? WHERE code = 'S1'", (int(time.time()) - 1,))
        assert "S1" not in (await admin_client.get("/api/ad-slots")).json()["slots"]
        for image_url in placement["image_urls"]:
            assert (await admin_client.get(image_url)).status_code == 404
            private_preview = image_url.replace("/api/ad-banners/", "/partner/admin/ad-banner/")
            assert (await admin_client.get(private_preview)).status_code == 200
        renewed = await admin_client.post(
            "/partner/admin/ad-duration",
            data={"code": "S1", "duration_days": "30"},
            headers=origin, follow_redirects=False,
        )
        assert renewed.status_code == 303
        assert "S1" in (await admin_client.get("/api/ad-slots")).json()["slots"]
        invalid_duration = await admin_client.post(
            "/partner/admin/ad-duration",
            data={"code": "S1", "duration_days": "0"},
            headers=origin,
        )
        assert invalid_duration.status_code == 400
        bad_image = await admin_client.post(
            "/partner/admin/ad-slot",
            data={"code": "S1", "price_yuan": "299", "domain": "catalog.example"},
            files={"banner": ("bad.png", b"not an image", "image/png")},
            headers=origin,
        )
        assert bad_image.status_code == 400

        revoked = await admin_client.post(
            "/partner/admin/review", data={"domain": "catalog.example", "status": "pending"},
            headers=origin, follow_redirects=False,
        )
        assert revoked.status_code == 303
        assert (await admin_client.get("/api/ad-slots")).json()["slots"] == {}
        for image_url in placement["image_urls"]:
            assert (await admin_client.get(image_url)).status_code == 404
        assert "已收录认证" not in (await admin_client.get("/leaderboard?board=certified")).text


def test_legacy_accounts_migrate_without_losing_sessions_or_sites(tmp_path: Path, monkeypatch):
    db_path = tmp_path / "legacy-partners.sqlite3"
    conn = sqlite3.connect(db_path)
    conn.executescript("""
        CREATE TABLE operators (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
        CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, operator_id INTEGER NOT NULL REFERENCES operators(id),
            expires_at INTEGER NOT NULL);
        CREATE TABLE site_submissions (id INTEGER PRIMARY KEY, operator_id INTEGER NOT NULL REFERENCES operators(id),
            name TEXT NOT NULL, domain TEXT NOT NULL UNIQUE, description TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL);
    """)
    password_hash = partner._password_hash("legacy-password-123")
    conn.execute("INSERT INTO operators VALUES (1, '站长', 'first@example.invalid', ?, 1)", (password_hash,))
    conn.execute("INSERT INTO operators VALUES (2, '站长', 'second@example.invalid', ?, 1)", (password_hash,))
    conn.execute("INSERT INTO sessions VALUES (?, 1, 9999999999)", (hashlib.sha256(b"legacy-session").hexdigest(),))
    conn.execute("INSERT INTO site_submissions VALUES (1, 2, '旧站点', 'legacy.example', '', 'pending', 1)")
    conn.commit()
    conn.close()

    monkeypatch.setattr(partner, "DB_PATH", db_path)
    assert partner.authenticate("站长", "legacy-password-123") == 1
    assert partner.authenticate("站长-2", "legacy-password-123") == 2
    assert partner.operator_for_token("legacy-session")["id"] == 1
    assert partner.sites_for_operator(2)[0]["domain"] == "legacy.example"
    assert partner.sites_for_operator(2)[0]["contact_method"] == ""
    with sqlite3.connect(db_path) as conn:
        assert "email" not in {row[1] for row in conn.execute("PRAGMA table_info(operators)")}
        assert conn.execute("SELECT role FROM operators WHERE id = 1").fetchone()[0] == "operator"
        assert conn.execute("PRAGMA foreign_key_check").fetchall() == []


def test_existing_username_accounts_gain_operator_role(tmp_path: Path, monkeypatch):
    db_path = tmp_path / "username-partners.sqlite3"
    conn = sqlite3.connect(db_path)
    conn.executescript("""
        CREATE TABLE operators (id INTEGER PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE,
            password_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
        CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, operator_id INTEGER NOT NULL REFERENCES operators(id),
            expires_at INTEGER NOT NULL);
        CREATE TABLE site_submissions (id INTEGER PRIMARY KEY, operator_id INTEGER NOT NULL REFERENCES operators(id),
            name TEXT NOT NULL, domain TEXT NOT NULL UNIQUE, description TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL);
    """)
    conn.execute("INSERT INTO operators VALUES (3, '旧站长', 'stored-hash', 1)")
    conn.execute("INSERT INTO site_submissions VALUES (4, 3, '旧站点', 'kept.example', '', 'pending', 1)")
    conn.commit()
    conn.close()

    monkeypatch.setattr(partner, "DB_PATH", db_path)
    assert partner.operator_for_id(3)["role"] == "operator"
    assert partner.sites_for_operator(3)[0]["domain"] == "kept.example"
    assert partner.sites_for_operator(3)[0]["contact_handle"] == ""
    with sqlite3.connect(db_path) as conn:
        assert "role" in {row[1] for row in conn.execute("PRAGMA table_info(operators)")}
        assert conn.execute("PRAGMA foreign_key_check").fetchall() == []


def test_existing_ads_gain_second_banner_and_duration_without_losing_assignment(tmp_path: Path, monkeypatch):
    db_path = tmp_path / "prior-version.sqlite3"
    with sqlite3.connect(db_path) as conn:
        conn.executescript("""
            CREATE TABLE operators (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL, created_at INTEGER NOT NULL,
                role TEXT NOT NULL DEFAULT 'operator');
            CREATE TABLE site_submissions (id INTEGER PRIMARY KEY, operator_id INTEGER NOT NULL,
                name TEXT NOT NULL, domain TEXT NOT NULL UNIQUE, description TEXT NOT NULL DEFAULT '',
                contact_method TEXT NOT NULL DEFAULT '', contact_handle TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL);
            CREATE TABLE ad_slots (code TEXT PRIMARY KEY, price_yuan INTEGER,
                site_id INTEGER, updated_at INTEGER NOT NULL DEFAULT 0,
                target_url TEXT NOT NULL DEFAULT '', banner_image TEXT NOT NULL DEFAULT '');
        """)
        conn.execute("INSERT INTO operators VALUES (1, 'old-owner', 'hash', 1, 'operator')")
        conn.execute(
            "INSERT INTO site_submissions VALUES (1, 1, '旧站点', 'legacy.example', '', 'qq', 'private', 'approved', 1000)"
        )
        conn.execute(
            "INSERT INTO ad_slots VALUES ('S1', 299, 1, 1000, 'https://legacy.example/offer', 'old-image.webp')"
        )
    monkeypatch.setattr(partner, "DB_PATH", db_path)
    slot = next(slot for slot in partner.ad_slots() if slot["code"] == "S1")
    assert slot["domain"] == "legacy.example"
    assert slot["banner_image"] == "old-image.webp"
    assert slot["banner_image_2"] == ""
    assert slot["ends_at"] is None
    assert partner.public_ad_slots()["S1"]["url"] == "https://legacy.example/offer"
    assert partner.public_ad_slots()["S1"]["tracking_url"] == "/out/ad/S1"
    assert partner.public_ad_slots()["S1"]["image_urls"] == ["/api/ad-banners/old-image.webp"]
    assert partner.sites_for_operator(1)[0]["approved_at"] == 1000
    with sqlite3.connect(db_path) as conn:
        assert conn.execute("PRAGMA foreign_key_check").fetchall() == []


@pytest.mark.asyncio
async def test_ad_click_redirect_and_operator_dashboard_use_real_counts(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(partner, "DB_PATH", tmp_path / "partners.sqlite3")
    owner_id = partner.register("数据站长", "operator-password-123")
    partner.submit_site(owner_id, "数据站点", "metrics.example", "广告数据测试", "qq", "123456")
    assert partner.set_site_status("metrics.example", "approved") is True
    admin_id = partner.create_admin("数据管理员", "admin-password-123")
    assert partner.update_ad_slot(admin_id, "S1", 299, "metrics.example") is True

    transport = httpx.ASGITransport(app=server.app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as visitor:
        redirect = await visitor.get("/out/ad/S1", headers={"user-agent": "Mozilla/5.0"}, follow_redirects=False)
        assert redirect.status_code == 303
        assert redirect.headers["location"] == "https://metrics.example"
        assert analytics.COOKIE_NAME in redirect.cookies

    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as owner:
        owner.cookies.set(partner.SESSION_COOKIE, partner.new_session(owner_id))
        dashboard = await owner.get("/partner/sites")
        assert dashboard.status_code == 200
        assert "广告数据" in dashboard.text
        assert "S1 · 数据站点" in dashboard.text
        assert "metrics.example" in dashboard.text
        assert "30 天点击 <b>1</b>" not in dashboard.text
        assert "访客 <b>1</b>" not in dashboard.text
        assert "展示中" in dashboard.text

    data = partner.ad_dashboard(owner_id)
    assert data["clicks"] == 1
    assert data["visitors"] == 1
    assert data["week_clicks"] == 1
    assert data["active_slots"] == 1


@pytest.mark.asyncio
async def test_admin_role_is_offline_only_and_review_is_authorized(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(partner, "DB_PATH", tmp_path / "partners.sqlite3")
    ratelimit.reset()
    origin = {"origin": "http://testserver"}
    transport = httpx.ASGITransport(app=server.app)

    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as operator_client:
        guest = await operator_client.get("/partner/admin", follow_redirects=False)
        assert guest.status_code == 303
        assert guest.headers["location"] == "/partner/login"

        created = await operator_client.post(
            "/partner/register",
            data={"name": "普通站长", "password": "operator-password-123", "role": "admin",
                  "site_name": "注册待审站点", "domain": "register.example",
                  "description": "用于注册流程测试", "contact_method": "qq", "contact_handle": "register_qq"},
            headers=origin, follow_redirects=False,
        )
        assert created.status_code == 303
        assert partner.operator_for_id(1)["role"] == "operator"
        # 注册即入待审队列，管理员无需等站长再提交一次。
        assert [site["domain"] for site in partner.all_site_submissions()] == ["register.example"]
        await operator_client.post(
            "/partner/sites", data={"name": "待审站点", "domain": "pending.example",
                                   "contact_method": "wechat", "contact_handle": "review_wechat"},
            headers=origin,
        )
        assert (await operator_client.get("/partner/admin")).status_code == 403
        denied = await operator_client.post(
            "/partner/admin/review", data={"domain": "pending.example", "status": "approved"}, headers=origin,
        )
        assert denied.status_code == 403
        assert partner.approved_domains() == set()

    admin_id = partner.create_admin("zeroone-admin", "initial-admin-password-123")
    assert partner.operator_for_id(admin_id)["role"] == "admin"

    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as referer_client:
        referer_login = await referer_client.post(
            "/partner/login", data={"name": "zeroone-admin", "password": "initial-admin-password-123"},
            headers={"referer": "http://testserver/partner/login"}, follow_redirects=False,
        )
        assert referer_login.status_code == 303

    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as admin_client:
        signed_in = await admin_client.post(
            "/partner/login", data={"name": "zeroone-admin", "password": "initial-admin-password-123"},
            headers=origin, follow_redirects=False,
        )
        assert signed_in.status_code == 303
        assert signed_in.headers["location"] == "/partner/admin"
        assert f"Max-Age={partner.ADMIN_SESSION_SECONDS}" in signed_in.headers["set-cookie"]
        assert (await admin_client.get("/partner/session")).json() == {"authenticated": True, "home": "/partner/admin"}

        admin_page = await admin_client.get("/partner/admin")
        assert admin_page.status_code == 200
        assert admin_page.headers["cache-control"] == "private, no-store"
        assert admin_page.headers["x-frame-options"] == "DENY"
        assert admin_page.headers["x-content-type-options"] == "nosniff"
        assert admin_page.headers["referrer-policy"] == "same-origin"
        assert '零一运维后台' in admin_page.text
        assert 'href="/partner/admin?section=sites"' in admin_page.text
        assert 'href="/partner/admin?section=ads"' in admin_page.text
        assert 'href="/partner/admin?section=visits"' in admin_page.text
        assert 'href="/#contact"' not in admin_page.text
        assert 'href="/partner/admin/sites/new"' in admin_page.text
        assert "站长账号</h2>" not in admin_page.text
        assert "操作与安全记录" not in admin_page.text
        assert (await admin_client.get("/partner/sites")).status_code == 200
        assert "pending.example" not in admin_page.text
        pending_page = await admin_client.get("/partner/admin?section=sites&status=pending")
        assert "pending.example" in pending_page.text
        assert "普通站长" in pending_page.text
        assert "微信 · review_wechat" in pending_page.text
        assert "通过收录" in pending_page.text
        assert "拒绝" not in pending_page.text and "设为待审" not in pending_page.text
        assert "initial-admin-password-123" not in admin_page.text
        assert "广告位置管理" not in admin_page.text
        ads_page = await admin_client.get("/partner/admin?section=ads")
        assert "赞助广告位" in ads_page.text
        assert "赞助" in ads_page.text and "推荐" in ads_page.text
        assert ads_page.text.count('class="partner-admin-slot-card"') == 8
        assert 'name="banner" type="file"' in ads_page.text
        account_page = await admin_client.get("/partner/account")
        assert "已提交站点" not in account_page.text
        assert "进入收录审核" not in account_page.text

        cross_site = await admin_client.post(
            "/partner/admin/review", data={"domain": "pending.example", "status": "approved"},
            headers={"origin": "https://attacker.example"},
        )
        assert cross_site.status_code == 403
        assert partner.approved_domains() == set()

        approved = await admin_client.post(
            "/partner/admin/review", data={"domain": "pending.example", "status": "approved"},
            headers=origin, follow_redirects=False,
        )
        assert approved.status_code == 303
        assert partner.approved_domains() == {"pending.example"}

        wrong_password = await admin_client.post(
            "/partner/admin/password",
            data={"current_password": "wrong-password", "new_password": "new-admin-password-123"},
            headers=origin,
        )
        assert wrong_password.status_code == 400
        changed = await admin_client.post(
            "/partner/admin/password",
            data={"current_password": "initial-admin-password-123", "new_password": "new-admin-password-123"},
            headers=origin, follow_redirects=False,
        )
        assert changed.status_code == 303
        assert changed.headers["location"] == "/partner/login?changed=1"
        assert (await admin_client.get("/partner/admin", follow_redirects=False)).status_code == 303
        old_login = await admin_client.post(
            "/partner/login", data={"name": "zeroone-admin", "password": "initial-admin-password-123"}, headers=origin,
        )
        assert old_login.status_code == 400
        new_login = await admin_client.post(
            "/partner/login", data={"name": "zeroone-admin", "password": "new-admin-password-123"},
            headers=origin, follow_redirects=False,
        )
        assert new_login.status_code == 303
        assert new_login.headers["location"] == "/partner/admin"


@pytest.mark.asyncio
async def test_admin_ad_assignment_price_and_audit_are_private_and_consistent(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(partner, "DB_PATH", tmp_path / "partners.sqlite3")
    ratelimit.reset()
    origin = {"origin": "http://testserver"}
    operator_id = partner.register("站长甲", "operator-password-123")
    partner.submit_site(operator_id, "公开中转站", "approved.example", "", "qq", "private-qq-123")
    partner.submit_site(operator_id, "待审中转站", "pending.example", "", "wechat", "private-wechat")
    admin_id = partner.create_admin("运维管理员", "initial-admin-password-123")
    assert len(partner.ad_slots()) == 16
    assert partner.public_ad_slots() == {}

    with pytest.raises(partner.PartnerError, match="管理员权限不足"):
        partner.update_ad_slot(operator_id, "S1", 399, "")

    transport = httpx.ASGITransport(app=server.app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as operator_client:
        token = partner.new_session(operator_id)
        operator_client.cookies.set(partner.SESSION_COOKIE, token)
        denied = await operator_client.post(
            "/partner/admin/ad-slot", data={"code": "S1", "price_yuan": "399", "domain": "approved.example"},
            headers=origin,
        )
        assert denied.status_code == 403

    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as admin_client:
        wrong = await admin_client.post(
            "/partner/login", data={"name": "运维管理员", "password": "wrong-password"}, headers=origin,
        )
        assert wrong.status_code == 400
        signed_in = await admin_client.post(
            "/partner/login", data={"name": "运维管理员", "password": "initial-admin-password-123"},
            headers=origin, follow_redirects=False,
        )
        assert signed_in.status_code == 303
        assert partner.admin_monitoring()["failed_logins_24h"] >= 1

        pending_target = await admin_client.post(
            "/partner/admin/ad-slot", data={"code": "S1", "price_yuan": "399", "domain": "pending.example"},
            headers=origin,
        )
        assert pending_target.status_code == 400
        assert "只能将广告位分配给已审核通过的站点" in pending_target.text
        bad_price = await admin_client.post(
            "/partner/admin/ad-slot", data={"code": "S1", "price_yuan": "1.50", "domain": ""},
            headers=origin,
        )
        assert bad_price.status_code == 400
        cross_site = await admin_client.post(
            "/partner/admin/ad-slot", data={"code": "S1", "price_yuan": "399", "domain": ""},
            headers={"origin": "https://attacker.example"},
        )
        assert cross_site.status_code == 403

        approved = await admin_client.post(
            "/partner/admin/review", data={"domain": "approved.example", "status": "approved"},
            headers=origin, follow_redirects=False,
        )
        assert approved.status_code == 303
        assigned = await admin_client.post(
            "/partner/admin/ad-slot",
            data={"code": "S1", "price_yuan": "399", "domain": "approved.example"},
            headers=origin, follow_redirects=False,
        )
        assert assigned.status_code == 303
        assert assigned.headers["location"].endswith("#ad-slots")
        t_assigned = await admin_client.post(
            "/partner/admin/ad-slot",
            data={"code": "T1", "price_yuan": "299", "domain": "approved.example"},
            headers=origin, follow_redirects=False,
        )
        assert t_assigned.status_code == 303
        assert partner.admin_monitoring()["assigned_slots"] == 2
        assert partner.slots_for_operator(operator_id)[0]["domain"] == "approved.example"
        assert partner.public_ad_slots()["S1"] == {
            "name": "公开中转站", "domain": "approved.example",
            "url": "https://approved.example", "tracking_url": "/out/ad/S1",
            "image_url": "", "image_urls": [],
        }

        public = await admin_client.get("/api/ad-slots")
        assert public.status_code == 200
        assert public.json()["slots"]["S1"]["domain"] == "approved.example"
        assert "private-qq-123" not in public.text
        assert "站长甲" not in public.text
        leaderboard_page = await admin_client.get("/leaderboard")
        assert "公开中转站" in leaderboard_page.text
        assert "private-qq-123" not in leaderboard_page.text
        pricing = await admin_client.get("/partner/subscription")
        assert "¥399/月" in pricing.text
        owner_page = await admin_client.get("/partner/sites")
        assert "S1" not in owner_page.text  # Admin does not own the operator's site.

        revoked = await admin_client.post(
            "/partner/admin/review", data={"domain": "approved.example", "status": "pending"},
            headers=origin, follow_redirects=False,
        )
        assert revoked.status_code == 303
        assert partner.public_ad_slots() == {}
        assert partner.admin_monitoring()["assigned_slots"] == 0
        assert next(slot for slot in partner.ad_slots() if slot["code"] == "S1")["price_yuan"] == 399
        events = partner.recent_events()
        assert any(event["kind"] == "ad_slot_updated" and event["subject"] == "S1" for event in events)
        assert any(event["kind"] == "site_reviewed" and event["subject"] == "approved.example" for event in events)
        assert all("private-qq-123" not in event["detail"] for event in events)

    with sqlite3.connect(partner.DB_PATH) as conn:
        assert conn.execute("PRAGMA foreign_key_check").fetchall() == []


@pytest.mark.asyncio
async def test_admin_can_clear_and_reset_an_ad_slot(tmp_path: Path, monkeypatch):
    """清空重置替代逐条清除横幅：一键清空广告位并立即保存。"""
    monkeypatch.setattr(partner, "DB_PATH", tmp_path / "partners.sqlite3")
    ratelimit.reset()
    origin = {"origin": "http://testserver"}
    owner_id = partner.register("清空站长", "operator-password-123")
    partner.submit_site(owner_id, "清空站点", "reset.example", "", "qq", "reset-qq")
    assert partner.set_site_status("reset.example", "approved") is True
    admin_id = partner.create_admin("清空管理员", "admin-password-123")
    transport = httpx.ASGITransport(app=server.app)

    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as admin_client:
        admin_client.cookies.set(partner.SESSION_COOKIE, partner.new_session(admin_id))
        ads_page = await admin_client.get("/partner/admin?section=ads")
        assert ads_page.status_code == 200
        assert "清空重置" in ads_page.text
        assert 'name="clear_banner"' not in ads_page.text
        assert 'name="clear_banner_2"' not in ads_page.text

        picture = io.BytesIO()
        Image.new("RGB", (600, 200), "#101820").save(picture, format="PNG")
        assigned = await admin_client.post(
            "/partner/admin/ad-slot",
            data={"code": "S3", "price_yuan": "159", "domain": "reset.example"},
            files={"banner": ("banner.png", picture.getvalue(), "image/png")},
            headers=origin, follow_redirects=False,
        )
        assert assigned.status_code == 303
        assert partner.public_ad_slots()["S3"]["domain"] == "reset.example"
        assert partner.update_ad_slot(admin_id, "S3", 159, "reset.example") is False  # 无变化不写审计

        duration = await admin_client.post(
            "/partner/admin/ad-duration", data={"code": "S3", "duration_days": "30"},
            headers=origin, follow_redirects=False,
        )
        assert duration.status_code == 303

    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as owner_client:
        owner_client.cookies.set(partner.SESSION_COOKIE, partner.new_session(owner_id))
        own_page = await owner_client.get("/partner/sites")
        assert "到期时间" in own_page.text
        assert "剩余 30 天" in own_page.text

    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as admin_client:
        admin_client.cookies.set(partner.SESSION_COOKIE, partner.new_session(admin_id))
        cleared = await admin_client.post(
            "/partner/admin/ad-reset", data={"code": "S3"}, headers=origin, follow_redirects=False,
        )
        assert cleared.status_code == 303
        assert cleared.headers["location"].endswith("ad_type=sponsor&reset=1#ad-slots")
        assert partner.public_ad_slots() == {}
        slot = next(item for item in partner.ad_slots() if item["code"] == "S3")
        assert slot["site_id"] is None
        assert slot["banner_image"] == "" and slot["banner_image_2"] == ""
        assert slot["ends_at"] is None and slot["starts_at"] is None
        assert slot["price_yuan"] == 159  # 价格回到当前目录价
        assert any(event["kind"] == "ad_slot_cleared" for event in partner.recent_events())

        # 已经空置的广告位再次重置是无操作，但依然保持幂等。
        again = await admin_client.post(
            "/partner/admin/ad-reset", data={"code": "S3"}, headers=origin, follow_redirects=False,
        )
        assert again.status_code == 303
        assert again.headers["location"].endswith("ad_type=sponsor&reset=0#ad-slots")

        invalid = await admin_client.post(
            "/partner/admin/ad-reset", data={"code": "X9"}, headers=origin,
        )
        assert invalid.status_code == 400
