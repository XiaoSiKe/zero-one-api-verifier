"""Small first-party pageview counter for the private operations dashboard.

No IP address, user agent, query string or raw visitor cookie is stored.
Counts begin when this module is deployed; they are not backfilled.
"""

from __future__ import annotations

import hashlib
import re
import secrets
import sqlite3
import time
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from .paths import WEB_DATA_DIR

DB_PATH = WEB_DATA_DIR / "visits.sqlite3"
COOKIE_NAME = "zeroone_visitor"
COOKIE_MAX_AGE = 60 * 60 * 24 * 30
SHANGHAI = ZoneInfo("Asia/Shanghai")
# Rows older than the longest offered window are dropped so every range the
# dashboard offers is fully covered by stored data.
RETENTION_DAYS = 180
# Windows offered by the 访问趋势 selector: key → (label, days).
VISIT_RANGES = (
    ("7", "最近 7 天", 7),
    ("30", "最近 30 天", 30),
    ("90", "最近 90 天", 90),
    ("180", "最近 180 天（半年）", 180),
)
DEFAULT_RANGE = "30"
_DAYS_BY_RANGE = {key: days for key, _, days in VISIT_RANGES}
_AXIS_MARKS = 12
_TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{32}$")
_PAGES = {
    "/": "检测中心",
    "/app": "检测中心",
    "/claude": "Claude 检测",
    "/openai": "OpenAI 检测",
    "/gemini": "Gemini 检测",
    "/leaderboard": "红黑榜",
    "/faq": "常见问题",
}


def page_label(path: str) -> str | None:
    if path in _PAGES:
        return _PAGES[path]
    if path.startswith("/leaderboard/"):
        return "站点详情"
    if path.startswith("/r/"):
        return "检测报告"
    return None


def visitor_token(existing: str | None) -> tuple[str, bool]:
    if existing and _TOKEN_RE.fullmatch(existing):
        return existing, False
    return secrets.token_urlsafe(24), True


def _connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    DB_PATH.touch(mode=0o600, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=5)
    conn.row_factory = sqlite3.Row
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS pageviews (
            id INTEGER PRIMARY KEY,
            day TEXT NOT NULL,
            page TEXT NOT NULL,
            visitor_hash TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS pageviews_day_idx ON pageviews(day);
        CREATE INDEX IF NOT EXISTS pageviews_recent_idx
            ON pageviews(visitor_hash, page, created_at);
    """)
    return conn


def record_visit(page: str, token: str) -> bool:
    """Record one pageview, suppressing duplicate requests within five seconds."""
    if page not in {*_PAGES.values(), "首页", "站点详情", "检测报告"}:
        return False
    now = int(time.time())
    day = datetime.fromtimestamp(now, SHANGHAI).date().isoformat()
    visitor_hash = hashlib.sha256(token.encode("ascii")).hexdigest()
    conn = _connect()
    try:
        # Serialize the duplicate check with the insert across requests.
        # Without a write transaction, simultaneous first visits can all
        # observe no row and inflate both pageviews and unique visitors.
        conn.execute("BEGIN IMMEDIATE")
        recent = conn.execute(
            """SELECT 1 FROM pageviews WHERE visitor_hash = ? AND page = ?
               AND created_at >= ? LIMIT 1""",
            (visitor_hash, page, now - 5),
        ).fetchone()
        if recent:
            conn.rollback()
            return False
        conn.execute(
            "INSERT INTO pageviews (day, page, visitor_hash, created_at) VALUES (?, ?, ?, ?)",
            (day, page, visitor_hash, now),
        )
        cutoff = (datetime.fromtimestamp(now, SHANGHAI).date() - timedelta(days=RETENTION_DAYS)).isoformat()
        conn.execute("DELETE FROM pageviews WHERE day < ?", (cutoff,))
        conn.commit()
        return True
    finally:
        conn.close()


def range_days(key: str) -> int:
    """Resolve a 访问趋势 selector value to a day count (fallback: default range)."""
    return _DAYS_BY_RANGE.get(key, _DAYS_BY_RANGE[DEFAULT_RANGE])


def _axis_marks(series: list[dict]) -> list[dict]:
    """≈12 evenly spaced axis labels so long windows stay readable."""
    step = max(1, round(len(series) / _AXIS_MARKS))
    return [
        {"index": index, "label": series[index]["label"], "span": step}
        for index in range(0, len(series), step)
    ]


def dashboard(days: int = 30) -> dict:
    """Daily traffic, seven-day totals and top pages; all from actual visits."""
    days = max(1, min(days, RETENTION_DAYS))
    today = datetime.now(SHANGHAI).date()
    start = (today - timedelta(days=days - 1)).isoformat()
    week_start = (today - timedelta(days=6)).isoformat()
    conn = _connect()
    try:
        daily_rows = conn.execute(
            """SELECT day, COUNT(*) AS views, COUNT(DISTINCT visitor_hash) AS visitors
               FROM pageviews WHERE day >= ? GROUP BY day""",
            (start,),
        ).fetchall()
        week = conn.execute(
            """SELECT COUNT(*) AS views, COUNT(DISTINCT visitor_hash) AS visitors
               FROM pageviews WHERE day >= ?""",
            (week_start,),
        ).fetchone()
        pages = conn.execute(
            """SELECT page, COUNT(*) AS views FROM pageviews WHERE day >= ?
               GROUP BY page ORDER BY views DESC, page LIMIT 6""",
            (week_start,),
        ).fetchall()
    finally:
        conn.close()
    by_day = {row["day"]: dict(row) for row in daily_rows}
    series = []
    for offset in range(days - 1, -1, -1):
        day = today - timedelta(days=offset)
        found = by_day.get(day.isoformat(), {})
        series.append({
            "day": day.isoformat(), "label": day.strftime("%m/%d"),
            "views": found.get("views", 0), "visitors": found.get("visitors", 0),
        })
    return {
        "days": series,
        "axis": _axis_marks(series),
        "window_days": days,
        "week_views": week["views"],
        "week_visitors": week["visitors"],
        "top_pages": [dict(row) for row in pages],
    }
