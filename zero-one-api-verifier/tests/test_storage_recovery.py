"""Fresh data, online backup, and concurrent-write checks for web storage."""

from __future__ import annotations

import sqlite3
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Barrier

from web import analytics, partner


def _backup(source: Path, target: Path) -> None:
    with sqlite3.connect(source) as live, sqlite3.connect(target) as copy:
        live.backup(copy)


def _assert_healthy(path: Path) -> None:
    with sqlite3.connect(path) as conn:
        assert conn.execute("PRAGMA integrity_check").fetchone() == ("ok",)
        assert conn.execute("PRAGMA foreign_key_check").fetchall() == []


def test_partner_and_visit_databases_restore_usable_state(tmp_path, monkeypatch):
    partner_path = tmp_path / "partners.sqlite3"
    visits_path = tmp_path / "visits.sqlite3"
    monkeypatch.setattr(partner, "DB_PATH", partner_path)
    monkeypatch.setattr(analytics, "DB_PATH", visits_path)
    owner = partner.register_with_site(
        "backup-owner",
        "strong-password-123",
        "备份站点",
        "backup.example",
        "正式收录申请",
        "qq",
        "12345678",
    )
    session = partner.new_session(owner)
    visitor = "a" * 32
    assert analytics.record_visit("首页", visitor)

    saved_partner = tmp_path / "saved-partners.sqlite3"
    saved_visits = tmp_path / "saved-visits.sqlite3"
    _backup(partner_path, saved_partner)
    _backup(visits_path, saved_visits)
    partner.submit_site(
        owner,
        "后续站点",
        "later.example",
        "备份后提交",
        "qq",
        "12345678",
    )
    assert analytics.record_visit("常见问题", visitor)

    monkeypatch.setattr(partner, "DB_PATH", saved_partner)
    monkeypatch.setattr(analytics, "DB_PATH", saved_visits)
    assert partner.authenticate("backup-owner", "strong-password-123") == owner
    assert partner.operator_for_token(session)["id"] == owner
    assert [site["domain"] for site in partner.sites_for_operator(owner)] == [
        "backup.example"
    ]
    assert analytics.dashboard()["week_views"] == 1
    _assert_healthy(saved_partner)
    _assert_healthy(saved_visits)


def test_concurrent_identical_visits_are_counted_once(tmp_path, monkeypatch):
    monkeypatch.setattr(analytics, "DB_PATH", tmp_path / "visits.sqlite3")
    analytics.dashboard()  # Create schema before racing independent connections.
    gate = Barrier(12)

    def visit(_: int) -> bool:
        gate.wait()
        return analytics.record_visit("首页", "b" * 32)

    with ThreadPoolExecutor(max_workers=12) as pool:
        recorded = list(pool.map(visit, range(12)))

    assert sum(recorded) == 1
    assert analytics.dashboard()["week_views"] == 1
    _assert_healthy(analytics.DB_PATH)


def test_concurrent_site_registration_keeps_one_owner_and_audit(tmp_path, monkeypatch):
    monkeypatch.setattr(partner, "DB_PATH", tmp_path / "partners.sqlite3")
    partner.approved_domains()  # Initialize schema before racing submissions.
    gate = Barrier(8)

    def register(index: int) -> int | None:
        gate.wait()
        try:
            return partner.register_with_site(
                f"owner-{index}",
                "strong-password-123",
                "同域名站点",
                "shared.example",
                "并发提交",
                "qq",
                "12345678",
            )
        except partner.PartnerError:
            return None

    with ThreadPoolExecutor(max_workers=8) as pool:
        owners = list(pool.map(register, range(8)))

    assert sum(owner is not None for owner in owners) == 1
    with sqlite3.connect(partner.DB_PATH) as conn:
        assert conn.execute("SELECT COUNT(*) FROM operators").fetchone() == (1,)
        assert conn.execute("SELECT COUNT(*) FROM site_submissions").fetchone() == (1,)
        assert conn.execute(
            "SELECT COUNT(*) FROM admin_events WHERE kind = 'site_submitted'"
        ).fetchone() == (1,)
    _assert_healthy(partner.DB_PATH)
