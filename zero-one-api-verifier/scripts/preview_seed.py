"""Seed a disposable demo dataset so every page has something to show.

This is a *preview* tool, not a migration. It writes only into the data
directory resolved from ``VERIDROP_WEB_DATA_DIR`` (see ``web/paths.py``) and
never into the source tree.

What it creates
---------------
* one administrator account
* several operator accounts, each with an approved site submission
* a couple of pending submissions so the review queue is not empty
* sponsor (S) and featured (T) ad-slot assignments, one with a duration
* detection reports spread across the last 180 days (drives 红黑榜, 检测趋势)
* synthetic pageviews across the same window (drives 访客数据)

Idempotency
-----------
A ``preview_seed.json`` marker is written next to the databases. Re-running
without ``--force`` prints the stored credentials and exits without touching
data. ``--force`` rebuilds the demo content on top of whatever is there.

Usage
-----
    python scripts/preview_seed.py [--force]

Inside Docker Compose (profile ``demo``)::

    docker compose --profile demo up seed
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import secrets
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

ADMIN = os.environ.get("PREVIEW_ADMIN", "preview-admin")
ADMIN_PASSWORD = os.environ.get("PREVIEW_ADMIN_PASSWORD", "preview-admin-2026")
OPERATOR_PASSWORD = os.environ.get("PREVIEW_OPERATOR_PASSWORD", "preview-operator-2026")

# (domain, site name, description)
SITES = [
    ("mxdapi.com", "模型岛中转站", "支持 Claude / GPT / Gemini 全协议透传，双倍赔偿与 7×24 小时在线客服。"),
    ("jizhapi.site", "极智API", "官方 1 折支持 GPT-5，新用户加群送额度，已成立公司并可开票。"),
    ("api.01yapi.com", "零一 API", "本站自运营中转，Claude 与 Gemini 长上下文均可直连。"),
    ("yunshu-api.com", "云枢 API", "面向开发者的低价中转，支持按量计费与团队子账号。"),
    ("nxapi.cloud", "南星 API", "专注 Claude Code 场景，thinking 签名完整透传。"),
    ("starroute.io", "星链中转", "多机房出口，支持 OpenAI 兼容接口与流式响应。"),
]
PENDING_SITES = [
    ("newrelay.example", "新锐中转", "刚上线，提交收录申请待审核。"),
    ("beta-relay.example", "内测中转", "内测阶段，申请收录。"),
]
# (slot code, domain) — S = 赞助置顶, T = 精选展示
SLOT_ASSIGNMENTS = [
    ("S1", "mxdapi.com"),
    ("S3", "api.01yapi.com"),
    ("S8", "yunshu-api.com"),
    ("T1", "jizhapi.site"),
    ("T3", "nxapi.cloud"),
    ("T5", "starroute.io"),
]
DURATION_SLOT = ("T1", 30)

# Extra domains that only appear as detection reports (榜单排名有对比才有意义)。
EXTRA_REPORT_DOMAINS = [
    "extra-relay.example",
    "cheap-relay.example",
    "risky-relay.example",
    "clone-relay.example",
]
PROTOCOLS = ("anthropic", "openai", "gemini")
MODELS = {
    "anthropic": ["claude-sonnet-4-5", "claude-opus-4-1"],
    "openai": ["gpt-5", "gpt-4.1"],
    "gemini": ["gemini-2.5-pro", "gemini-2.5-flash"],
}
REPORT_WINDOW_DAYS = 178
PAGEVIEW_PAGES = ("检测中心", "红黑榜", "站点详情", "检测报告", "常见问题", "Claude 检测", "OpenAI 检测")


def _marker_path(data_dir: Path) -> Path:
    return data_dir / "preview_seed.json"


def seed(data_dir: Path, force: bool) -> dict:
    """Populate `data_dir` with demo content. Returns a printable summary."""
    data_dir.mkdir(parents=True, exist_ok=True)
    marker = _marker_path(data_dir)
    if marker.exists() and not force:
        stored = json.loads(marker.read_text(encoding="utf-8"))
        reports_updated = _backfill_report_performance(data_dir / "jobs")
        return {
            **stored,
            "seeded": False,
            "reports_updated": reports_updated,
            "note": "已存在演示数据；如需重建请加 --force",
        }

    # Paths inside web/*.py are module-level constants, so the environment has
    # to be set before the first import. Everything is derived from `data_dir`
    # on purpose: the job/wishlist overrides are only honoured when they agree
    # with it, otherwise a stray export would scatter demo reports elsewhere.
    os.environ["VERIDROP_WEB_DATA_DIR"] = str(data_dir)
    os.environ["VERIDROP_JOBS_DIR"] = str(data_dir / "jobs")
    os.environ["VERIDROP_WISHLIST_PATH"] = str(data_dir / "wishlist.txt")
    if str(ROOT) not in sys.path:
        sys.path.insert(0, str(ROOT))

    from web import analytics, partner
    from web.jobs import JOBS_DIR  # noqa: F401  (imported for its directory creation)
    from web.server import _DETECTOR_DISPLAY

    for protocol in PROTOCOLS:
        (Path(JOBS_DIR) / protocol).mkdir(parents=True, exist_ok=True)
    (data_dir / "ad_banners").mkdir(parents=True, exist_ok=True)

    admin_id = partner.authenticate(ADMIN, ADMIN_PASSWORD)
    if admin_id is None:
        admin_id = partner.create_admin(ADMIN, ADMIN_PASSWORD)

    approved = 0
    for index, (domain, name, description) in enumerate(SITES):
        try:
            partner.register_with_site(
                f"站长{index + 1:02d}", OPERATOR_PASSWORD, name, domain,
                description, "qq" if index % 2 == 0 else "wechat", f"1000{index}",
            )
        except partner.PartnerError:
            pass  # already registered — keep the existing account
        if partner.set_site_status(domain, "approved"):
            approved += 1

    pending = 0
    for index, (domain, name, description) in enumerate(PENDING_SITES):
        try:
            partner.register_with_site(
                f"待审站长{index + 1:02d}", OPERATOR_PASSWORD, name, domain,
                description, "qq", f"2000{index}",
            )
            pending += 1
        except partner.PartnerError:
            pass

    slots_applied = 0
    for code, domain in SLOT_ASSIGNMENTS:
        try:
            if partner.update_ad_slot(admin_id, code, partner.AD_SLOT_PRICES[code], domain):
                slots_applied += 1
        except partner.PartnerError:
            pass
    try:
        partner.set_ad_duration(admin_id, *DURATION_SLOT)
    except partner.PartnerError:
        pass

    reports = _seed_reports(Path(JOBS_DIR), _DETECTOR_DISPLAY)
    pageviews = _seed_pageviews(data_dir)

    summary = {
        "data_dir": str(data_dir),
        "admin": ADMIN,
        "admin_password": ADMIN_PASSWORD,
        "operator": "站长01",
        "operator_password": OPERATOR_PASSWORD,
        "approved_sites": len(SITES),
        "pending_sites": len(PENDING_SITES),
        "slots_applied": slots_applied,
        "reports_written": reports,
        "pageviews_written": pageviews,
    }
    marker.write_text(json.dumps(summary, ensure_ascii=False, indent=1), encoding="utf-8")
    return {**summary, "seeded": True}


def _seed_reports(jobs_dir: Path, detector_display: dict) -> int:
    """Write detection reports spread over the retention window."""
    existing = sum(len(list((jobs_dir / p).glob("*.json"))) for p in PROTOCOLS)
    target = 6 * 30 + len(EXTRA_REPORT_DOMAINS) * 10
    if existing >= target:
        return 0

    random.seed(20260916)
    now = datetime.now(timezone.utc)
    domains = [domain for domain, _, _ in SITES] + EXTRA_REPORT_DOMAINS
    written = 0
    for index, domain in enumerate(domains):
        band = (97 - index * 4, 72 + (index % 3) * 5)
        count = 46 - index * 4 if index < 6 else 12
        for _ in range(max(3, count)):
            protocol = random.choice(PROTOCOLS)
            score = round(min(99.0, max(38.0, random.uniform(*band))), 1)
            verdict = "passed" if score >= 70 else ("marginal" if score >= 50 else "failed")
            moment = now - timedelta(
                days=random.uniform(0, REPORT_WINDOW_DAYS), hours=random.uniform(0, 23)
            )
            results = []
            for name, _label in detector_display[protocol]:
                status = "pass" if random.random() > (0.06 + (100 - score) / 260) else "fail"
                results.append({
                    "name": name,
                    "status": status,
                    "weight": round(random.uniform(1.0, 3.0), 2),
                    "score": 100.0 if status == "pass" else 0.0,
                    "detail": "字段与官方基线一致。" if status == "pass" else "响应字段与官方基线存在偏差。",
                })
            job_id = f"{protocol[:2]}-{secrets.token_hex(6)}"
            payload = {
                "job_id": job_id,
                "base_url": f"https://{domain}/v1",
                "protocol": protocol,
                "target_model": random.choice(MODELS[protocol]),
                "mode": random.choice(["quick", "standard", "full"]),
                "total_score": score,
                "verdict": verdict,
                "timestamp": moment.replace(microsecond=0).isoformat().replace("+00:00", "Z"),
                "summary": f"{domain} 综合得分 {score:.0f}/100。",
                "results": results,
                "performance": _preview_performance(job_id),
            }
            (jobs_dir / protocol / f"{job_id}.json").write_text(
                json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8"
            )
            written += 1
    return written


def _preview_performance(job_id: str) -> dict:
    """Stable, plausible metrics for disposable local-preview reports."""
    rng = random.Random(f"preview-performance:{job_id}")
    return {
        "ttft_ms": rng.randint(420, 1650),
        "total_latency_ms": rng.randint(4200, 16800),
        "request_count": rng.randint(7, 12),
        "usage": {
            "input_tokens": rng.randint(1800, 6800),
            "output_tokens": rng.randint(420, 1900),
        },
    }


def _backfill_report_performance(jobs_dir: Path) -> int:
    """Upgrade existing preview JSONs without replacing accounts or reports."""
    updated = 0
    for protocol in PROTOCOLS:
        for report_path in (jobs_dir / protocol).glob("*.json"):
            try:
                payload = json.loads(report_path.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                continue
            if payload.get("performance"):
                continue
            payload["performance"] = _preview_performance(report_path.stem)
            report_path.write_text(
                json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8"
            )
            updated += 1
    return updated


def _seed_pageviews(data_dir: Path) -> int:
    """Insert synthetic pageviews so 访客数据 has a trend across all windows.

    ``analytics.record_visit`` stamps rows with the current time, so history has
    to be written directly. Schema and hashing stay identical to the runtime
    path; only the timestamp differs.
    """
    db_path = data_dir / "visits.sqlite3"
    db_path.parent.mkdir(parents=True, exist_ok=True)
    db_path.touch(mode=0o600, exist_ok=True)
    conn = sqlite3.connect(db_path, timeout=5)
    try:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS pageviews (
                id INTEGER PRIMARY KEY,
                day TEXT NOT NULL,
                page TEXT NOT NULL,
                visitor_hash TEXT NOT NULL,
                created_at INTEGER NOT NULL
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS pageviews_day_idx ON pageviews(day)")
        existing = conn.execute("SELECT COUNT(*) FROM pageviews").fetchone()[0]
        if existing:
            return 0

        random.seed(20260916)
        now = datetime.now(timezone(timedelta(hours=8)))
        rows = []
        for days_ago in range(REPORT_WINDOW_DAYS, -1, -1):
            day = (now - timedelta(days=days_ago)).date()
            # weekday bumps make the 7/30/90/180 day charts look like real traffic
            visitors = random.randint(6, 18) + (4 if day.weekday() < 5 else 0)
            for _ in range(visitors):
                token = secrets.token_urlsafe(24)
                visitor_hash = hashlib.sha256(token.encode("ascii")).hexdigest()
                for page in random.sample(PAGEVIEW_PAGES, k=random.randint(1, 3)):
                    moment = datetime.combine(
                        day, datetime.min.time(), tzinfo=timezone(timedelta(hours=8))
                    ) + timedelta(hours=random.uniform(8, 23), minutes=random.uniform(0, 59))
                    rows.append((
                        day.isoformat(), page, visitor_hash, int(moment.timestamp()),
                    ))
        conn.executemany(
            "INSERT INTO pageviews (day, page, visitor_hash, created_at) VALUES (?, ?, ?, ?)",
            rows,
        )
        conn.commit()
        return len(rows)
    finally:
        conn.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Seed demo data for a local preview")
    parser.add_argument("--force", action="store_true", help="重建演示数据（默认已存在则跳过）")
    parser.add_argument(
        "--data-dir", default=os.environ.get("VERIDROP_WEB_DATA_DIR"),
        help="数据目录，默认取 VERIDROP_WEB_DATA_DIR",
    )
    args = parser.parse_args(argv)

    data_dir = Path(args.data_dir).expanduser() if args.data_dir else ROOT / "web_data"
    summary = seed(data_dir, args.force)
    print(json.dumps(summary, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
