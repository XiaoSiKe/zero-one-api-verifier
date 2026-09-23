"""First-party traffic counts and the private operations view."""

from __future__ import annotations

import hashlib
import json
import sqlite3
from datetime import datetime, timedelta
from pathlib import Path

import httpx
import pytest

from web import analytics, leaderboard, partner, ratelimit, server


@pytest.mark.asyncio
async def test_public_visits_are_anonymous_and_admin_dashboard_is_private(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(analytics, "DB_PATH", tmp_path / "visits.sqlite3")
    monkeypatch.setattr(partner, "DB_PATH", tmp_path / "partners.sqlite3")
    ratelimit.reset()
    browser = {"user-agent": "Mozilla/5.0 (compatible; Test Browser)"}
    origin = {"origin": "http://testserver", **browser}
    admin_id = partner.create_admin("analytics-admin", "strong-admin-password-123")
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=server.app), base_url="http://testserver",
        headers=browser,
    ) as client:
        guest = await client.get("/partner/admin?section=visits", follow_redirects=False)
        assert guest.status_code == 303
        first = await client.get("/faq")
        assert first.status_code == 200
        assert analytics.COOKIE_NAME in first.headers["set-cookie"]
        assert "httponly" in first.headers["set-cookie"].lower()
        await client.get("/faq")  # Same page within five seconds is not a second view.
        home = await client.post("/api/visit")
        assert home.status_code == 204
        forged = await client.post("/api/visit", headers={"sec-fetch-site": "cross-site"})
        assert forged.status_code == 204
        stats = analytics.dashboard()
        assert stats["week_views"] == 2
        assert stats["week_visitors"] == 1
        assert {item["page"] for item in stats["top_pages"]} == {"首页", "常见问题"}

        stored_token = client.cookies.get(analytics.COOKIE_NAME)
        assert stored_token is not None
        with sqlite3.connect(analytics.DB_PATH) as conn:
            columns = {row[1] for row in conn.execute("PRAGMA table_info(pageviews)")}
            assert "ip" not in columns and "user_agent" not in columns
            hashes = {row[0] for row in conn.execute("SELECT visitor_hash FROM pageviews")}
            assert hashes == {hashlib.sha256(stored_token.encode()).hexdigest()}
            assert stored_token not in str(conn.execute("SELECT * FROM pageviews").fetchall())

        signed_in = await client.post(
            "/partner/login", data={"name": "analytics-admin", "password": "strong-admin-password-123"},
            headers=origin, follow_redirects=False,
        )
        assert signed_in.status_code == 303
        dashboard = await client.get("/partner/admin?section=visits")
        assert dashboard.status_code == 200
        assert "访问趋势" in dashboard.text
        assert "检测次数趋势" in dashboard.text
        assert "总检测次数" in dashboard.text
        assert "访问最多的页面" in dashboard.text
        assert "近 7 天访客" in dashboard.text
        assert "ops-dashboard-secondary" not in dashboard.text
        assert 'class="partner-workspace-card ops-top-pages-panel"' in dashboard.text
        assert 'class="partner-main admin-visits-page"' in dashboard.text
        assert 'class="partner-workspace admin-visits-workspace"' in dashboard.text
        assert 'class="threads-background" data-threads' in dashboard.text
        # Default window is a month, and half a year is selectable.
        assert "最近 30 天" in dashboard.text
        for key, label in (("7", "最近 7 天"), ("30", "最近 30 天"), ("90", "最近 90 天"), ("180", "最近 180 天（半年）")):
            assert f"?section=visits&amp;range={key}" in dashboard.text, label
        # The removed modules and the storage note must stay gone.
        assert "不记录 IP" not in dashboard.text
        assert "收录申请趋势" not in dashboard.text
        assert "待处理收录" not in dashboard.text
        half_year = await client.get("/partner/admin?section=visits&range=180")
        assert half_year.status_code == 200
        assert "最近 180 天（半年）" in half_year.text
        await client.get("/faq")
        assert analytics.dashboard()["week_views"] == 2  # Admin preview is excluded.

    assert partner.operator_for_id(admin_id)["role"] == "admin"


def test_analytics_windows_cover_half_a_year(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(analytics, "DB_PATH", tmp_path / "visits.sqlite3")
    assert analytics.range_days("180") == 180
    assert analytics.range_days("30") == 30
    assert analytics.range_days("nonsense") == analytics.range_days(analytics.DEFAULT_RANGE)
    assert analytics.RETENTION_DAYS >= max(days for _, _, days in analytics.VISIT_RANGES)
    stats = analytics.dashboard(analytics.range_days("180"))
    assert len(stats["days"]) == 180
    # Long windows still expose ~12 evenly spaced axis marks.
    assert 11 <= len(stats["axis"]) <= 13
    assert stats["days"][0]["day"] < stats["days"][-1]["day"]
    for day in stats["days"]:
        assert day["views"] == 0 and day["visitors"] == 0


def test_detection_activity_counts_public_reports_by_beijing_day(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(leaderboard, "REPORT_DIRS", [tmp_path])
    today = datetime.now(analytics.SHANGHAI).date()
    yesterday = today - timedelta(days=1)

    def write(name: str, base_url: str, timestamp: str) -> None:
        (tmp_path / f"{name}.json").write_text(json.dumps({
            "base_url": base_url, "protocol": "openai", "total_score": 90,
            "verdict": "passed", "timestamp": timestamp,
        }), encoding="utf-8")

    write("today", "https://relay.example", f"{today.isoformat()}T02:00:00Z")
    write("yesterday", "https://relay.example", f"{yesterday.isoformat()}T02:00:00Z")
    write("hidden", "https://api.sunyears.com", f"{today.isoformat()}T02:00:00Z")
    # 无法解析时间戳的报告回退到文件写入时间（即今天），与榜单聚合一致。
    write("broken", "https://relay.example", "not-a-timestamp")

    total, by_day = leaderboard.detection_activity(yesterday.isoformat())
    assert total == 3  # Excluded domains never reach either figure.
    assert by_day == {today.isoformat(): 2, yesterday.isoformat(): 1}

    lifetime_total, today_only = leaderboard.detection_activity(today.isoformat())
    assert lifetime_total == 3
    assert today_only == {today.isoformat(): 2}


def test_analytics_page_names_and_invalid_tokens(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(analytics, "DB_PATH", tmp_path / "visits.sqlite3")
    assert analytics.page_label("/claude") == "Claude 检测"
    assert analytics.page_label("/r/a-report-id") == "检测报告"
    assert analytics.page_label("/partner/account") is None
    token, fresh = analytics.visitor_token("../../unsafe")
    assert fresh is True
    assert "/" not in token and len(token) == 32
    assert analytics.visitor_token(token) == (token, False)
    assert analytics.record_visit("unknown-page", token) is False
