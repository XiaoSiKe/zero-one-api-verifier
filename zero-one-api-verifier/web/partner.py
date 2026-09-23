"""Local operator accounts and pending site submissions.

Accounts use a username and password; no email address is collected. A
submission is never treated as certified merely because an account claimed a
domain.
"""

from __future__ import annotations

import hashlib
import hmac
import io
import ipaddress
import re
import secrets
import sqlite3
import time
from contextlib import contextmanager
from datetime import datetime, timedelta
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo

from PIL import Image, UnidentifiedImageError

from .paths import WEB_DATA_DIR

DB_PATH = WEB_DATA_DIR / "partners.sqlite3"
SESSION_COOKIE = "zeroone_partner_session"
SESSION_SECONDS = 60 * 60 * 24 * 14
ADMIN_SESSION_SECONDS = 60 * 60 * 8
PASSWORD_ITERATIONS = 600_000
AD_SLOT_DEFAULTS = (
    ("S1", "首席赞助", 299), ("S2", "推荐赞助", 199),
    ("S3", "精选赞助", 159),
    *((f"S{number}", "标准赞助", 99) for number in range(4, 9)),
    ("T1", "Top 1 精选", 299), ("T2", "Top 2 精选", 199),
    ("T3", "Top 3 精选", 99),
    *((f"T{number}", f"Top {number} 精选", 49) for number in range(4, 9)),
)
AD_SLOT_LABELS = {code: label for code, label, _ in AD_SLOT_DEFAULTS}
AD_SLOT_PRICES = {code: price for code, _, price in AD_SLOT_DEFAULTS}

# Placement codes that the red/black boards order by. Sponsors (S) render
# before featured picks (T), matching the sponsor grid above the boards.
SPONSOR_CODES = tuple(code for code, _, _ in AD_SLOT_DEFAULTS if code.startswith("S"))
FEATURED_CODES = tuple(code for code, _, _ in AD_SLOT_DEFAULTS if code.startswith("T"))

# 2026-09-16 catalogue revision: S3 becomes 精选赞助 at ¥159/月 and S8 is
# priced at ¥99/月. Rows still holding the previous catalogue value follow the
# revision once; a price an administrator customised is left untouched.
_REVISED_SLOT_PRICES = (("S3", 99, 159), ("S8", None, 99))
MAX_BANNER_BYTES = 2 * 1024 * 1024
_BANNER_NAME_RE = re.compile(r"^[A-Za-z0-9_-]{24,}\.webp$")
_VISITOR_TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{32}$")
_SHANGHAI = ZoneInfo("Asia/Shanghai")


class PartnerError(ValueError):
    pass


def _migrate_legacy_operators(conn: sqlite3.Connection) -> None:
    """Drop stored email addresses without changing operator IDs or FKs."""
    conn.execute("BEGIN IMMEDIATE")
    try:
        columns = {row["name"] for row in conn.execute("PRAGMA table_info(operators)")}
        if "email" not in columns:
            conn.commit()
            return
        old_has_role = "role" in columns
        select_columns = "id, name, password_hash, created_at, role" if old_has_role else "id, name, password_hash, created_at"
        rows = conn.execute(f"SELECT {select_columns} FROM operators ORDER BY id").fetchall()
        conn.execute("""
            CREATE TABLE operators_new (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL COLLATE NOCASE UNIQUE,
                password_hash TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                role TEXT NOT NULL DEFAULT 'operator' CHECK (role IN ('operator', 'admin'))
            )
        """)
        used_names: set[str] = set()
        for row in rows:
            base = row["name"].strip() or f"站长{row['id']}"
            name = base
            suffix = 2
            while name.casefold() in used_names:
                tail = f"-{suffix}"
                name = base[:80 - len(tail)] + tail
                suffix += 1
            used_names.add(name.casefold())
            conn.execute(
                "INSERT INTO operators_new (id, name, password_hash, created_at, role) VALUES (?, ?, ?, ?, ?)",
                (row["id"], name, row["password_hash"], row["created_at"], row["role"] if old_has_role else "operator"),
            )
        conn.execute("DROP TABLE operators")
        conn.execute("ALTER TABLE operators_new RENAME TO operators")
        conn.commit()
    except Exception:
        conn.rollback()
        raise


def _apply_revised_slot_prices(conn: sqlite3.Connection) -> None:
    """Align untouched slot prices with the current catalogue revision.

    Idempotent: after the first pass no row matches the previous value, so the
    migration is a no-op on later connections.
    """
    for code, previous, current in _REVISED_SLOT_PRICES:
        if previous is None:
            conn.execute(
                "UPDATE ad_slots SET price_yuan = ? WHERE code = ? AND price_yuan IS NULL",
                (current, code),
            )
        else:
            conn.execute(
                "UPDATE ad_slots SET price_yuan = ? WHERE code = ? AND price_yuan = ?",
                (current, code, previous),
            )


def _connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    DB_PATH.touch(mode=0o600, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = OFF")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS operators (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL COLLATE NOCASE UNIQUE,
            password_hash TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            role TEXT NOT NULL DEFAULT 'operator' CHECK (role IN ('operator', 'admin'))
        )
    """)
    conn.commit()
    if "email" in {row["name"] for row in conn.execute("PRAGMA table_info(operators)")}:
        _migrate_legacy_operators(conn)
    if "role" not in {row["name"] for row in conn.execute("PRAGMA table_info(operators)")}:
        conn.execute("ALTER TABLE operators ADD COLUMN role TEXT NOT NULL DEFAULT 'operator' CHECK (role IN ('operator', 'admin'))")
        conn.commit()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS sessions (
            token_hash TEXT PRIMARY KEY,
            operator_id INTEGER NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
            expires_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS site_submissions (
            id INTEGER PRIMARY KEY,
            operator_id INTEGER NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            domain TEXT NOT NULL UNIQUE,
            description TEXT NOT NULL DEFAULT '',
            contact_method TEXT NOT NULL DEFAULT '',
            contact_handle TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'approved', 'rejected')),
            created_at INTEGER NOT NULL,
            website_url TEXT NOT NULL DEFAULT '',
            approved_at INTEGER,
            submission_source TEXT NOT NULL DEFAULT 'operator'
        );
        CREATE TABLE IF NOT EXISTS ad_slots (
            code TEXT PRIMARY KEY,
            price_yuan INTEGER CHECK (price_yuan IS NULL OR price_yuan >= 0),
            site_id INTEGER REFERENCES site_submissions(id) ON DELETE SET NULL,
            updated_at INTEGER NOT NULL DEFAULT 0,
            target_url TEXT NOT NULL DEFAULT '',
            banner_image TEXT NOT NULL DEFAULT '',
            banner_image_2 TEXT NOT NULL DEFAULT '',
            starts_at INTEGER,
            ends_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS admin_events (
            id INTEGER PRIMARY KEY,
            actor_id INTEGER REFERENCES operators(id) ON DELETE SET NULL,
            actor_name TEXT NOT NULL DEFAULT '',
            kind TEXT NOT NULL,
            subject TEXT NOT NULL DEFAULT '',
            detail TEXT NOT NULL DEFAULT '',
            created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS ad_clicks (
            id INTEGER PRIMARY KEY,
            day TEXT NOT NULL,
            slot_code TEXT NOT NULL,
            visitor_hash TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS admin_events_created_at_idx ON admin_events(created_at);
        CREATE INDEX IF NOT EXISTS ad_clicks_day_idx ON ad_clicks(day);
        CREATE INDEX IF NOT EXISTS ad_clicks_slot_idx ON ad_clicks(slot_code, created_at);
    """)
    submission_columns = {row["name"] for row in conn.execute("PRAGMA table_info(site_submissions)")}
    if "contact_method" not in submission_columns:
        conn.execute("ALTER TABLE site_submissions ADD COLUMN contact_method TEXT NOT NULL DEFAULT ''")
    if "contact_handle" not in submission_columns:
        conn.execute("ALTER TABLE site_submissions ADD COLUMN contact_handle TEXT NOT NULL DEFAULT ''")
    if "website_url" not in submission_columns:
        conn.execute("ALTER TABLE site_submissions ADD COLUMN website_url TEXT NOT NULL DEFAULT ''")
    if "approved_at" not in submission_columns:
        conn.execute("ALTER TABLE site_submissions ADD COLUMN approved_at INTEGER")
        conn.execute(
            """UPDATE site_submissions SET approved_at = COALESCE(
                 (SELECT MAX(e.created_at) FROM admin_events e
                  WHERE e.kind = 'site_reviewed' AND e.subject = site_submissions.domain
                    AND e.detail LIKE '% -> approved%'), created_at)
               WHERE status = 'approved'"""
        )
    if "submission_source" not in submission_columns:
        conn.execute("ALTER TABLE site_submissions ADD COLUMN submission_source TEXT NOT NULL DEFAULT 'operator'")
        conn.execute(
            """UPDATE site_submissions SET submission_source = 'admin'
               WHERE domain IN (SELECT subject FROM admin_events WHERE kind = 'site_added')"""
        )
        conn.execute(
            """UPDATE site_submissions SET status = 'approved', approved_at = COALESCE(approved_at, created_at)
               WHERE submission_source = 'admin' AND status = 'pending'"""
        )
    slot_columns = {row["name"] for row in conn.execute("PRAGMA table_info(ad_slots)")}
    if "target_url" not in slot_columns:
        conn.execute("ALTER TABLE ad_slots ADD COLUMN target_url TEXT NOT NULL DEFAULT ''")
    if "banner_image" not in slot_columns:
        conn.execute("ALTER TABLE ad_slots ADD COLUMN banner_image TEXT NOT NULL DEFAULT ''")
    if "banner_image_2" not in slot_columns:
        conn.execute("ALTER TABLE ad_slots ADD COLUMN banner_image_2 TEXT NOT NULL DEFAULT ''")
    if "starts_at" not in slot_columns:
        conn.execute("ALTER TABLE ad_slots ADD COLUMN starts_at INTEGER")
    if "ends_at" not in slot_columns:
        conn.execute("ALTER TABLE ad_slots ADD COLUMN ends_at INTEGER")
    conn.executemany(
        "INSERT OR IGNORE INTO ad_slots (code, price_yuan) VALUES (?, ?)",
        [(code, price) for code, _, price in AD_SLOT_DEFAULTS],
    )
    _apply_revised_slot_prices(conn)
    conn.commit()
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


@contextmanager
def _db():
    conn = _connect()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def _password_hash(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, PASSWORD_ITERATIONS)
    return f"pbkdf2_sha256${PASSWORD_ITERATIONS}${salt.hex()}${digest.hex()}"


def _password_matches(password: str, encoded: str) -> bool:
    try:
        algorithm, iterations, salt, expected = encoded.split("$")
        if algorithm != "pbkdf2_sha256":
            return False
        actual = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), int(iterations))
        return hmac.compare_digest(actual, bytes.fromhex(expected))
    except (ValueError, TypeError):
        return False


def _validated_credentials(name: str, password: str) -> tuple[str, str]:
    """Validate account fields and return (name, password_hash)."""
    name = name.strip()
    if not 2 <= len(name) <= 80:
        raise PartnerError("用户名需为 2–80 个字符。")
    if not 10 <= len(password) <= 128:
        raise PartnerError("密码需为 10–128 个字符。")
    return name, _password_hash(password)


def _insert_operator(conn: sqlite3.Connection, name: str, password_hash: str, role: str) -> int:
    try:
        cursor = conn.execute(
            "INSERT INTO operators (name, password_hash, created_at, role) VALUES (?, ?, ?, ?)",
            (name, password_hash, int(time.time()), role),
        )
    except sqlite3.IntegrityError as exc:
        raise PartnerError("该用户名已注册，请直接登录。") from exc
    return int(cursor.lastrowid)


def _create_operator(name: str, password: str, role: str) -> int:
    name, password_hash = _validated_credentials(name, password)
    with _db() as conn:
        return _insert_operator(conn, name, password_hash, role)


def register(name: str, password: str) -> int:
    """Public registration always creates a non-admin operator."""
    return _create_operator(name, password, "operator")


def register_with_site(
    name: str, password: str, site_name: str, domain: str,
    description: str = "", contact_method: str = "", contact_handle: str = "",
    website_url: str = "",
) -> int:
    """Create an operator account together with its first收录 submission.

    Account and site fields are both validated before either row is written,
    and the two inserts share one transaction, so a rejected registration
    never leaves behind a half-created account or an ownerless submission.
    The submission lands as `pending`, which is what the administrator sees
    in the review queue.
    """
    account_name, password_hash = _validated_credentials(name, password)
    if not description.strip():
        raise PartnerError("请填写站点简介。")
    site = _validated_site(site_name, domain, description, contact_method, contact_handle, website_url)
    with _db() as conn:
        conn.execute("BEGIN IMMEDIATE")
        operator_id = _insert_operator(conn, account_name, password_hash, "operator")
        try:
            _insert_pending_submission(conn, operator_id, site)
        except sqlite3.IntegrityError as exc:
            raise PartnerError("该域名已提交收录申请。") from exc
        return operator_id


def create_admin(name: str, password: str) -> int:
    """Offline bootstrap only; never expose through an HTTP endpoint."""
    operator_id = _create_operator(name, password, "admin")
    record_event("admin_created", actor_id=operator_id, actor_name=name, subject=name)
    return operator_id


def operator_for_id(operator_id: int) -> dict | None:
    with _db() as conn:
        row = conn.execute("SELECT id, name, role FROM operators WHERE id = ?", (operator_id,)).fetchone()
    return dict(row) if row else None


def authenticate(name: str, password: str) -> int | None:
    name = name.strip()
    if len(name) > 80 or len(password) > 128:
        return None
    with _db() as conn:
        row = conn.execute("SELECT id, password_hash FROM operators WHERE name = ?", (name,)).fetchone()
    if row and _password_matches(password, row["password_hash"]):
        return int(row["id"])
    return None


def new_session(operator_id: int) -> str:
    token = secrets.token_urlsafe(32)
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    now = int(time.time())
    with _db() as conn:
        row = conn.execute("SELECT role FROM operators WHERE id = ?", (operator_id,)).fetchone()
        if row is None:
            raise PartnerError("账号不存在。")
        duration = ADMIN_SESSION_SECONDS if row["role"] == "admin" else SESSION_SECONDS
        conn.execute("DELETE FROM sessions WHERE expires_at < ?", (now,))
        conn.execute(
            "INSERT INTO sessions (token_hash, operator_id, expires_at) VALUES (?, ?, ?)",
            (token_hash, operator_id, now + duration),
        )
    return token


def operator_for_token(token: str | None) -> dict | None:
    if not token or len(token) > 128:
        return None
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    with _db() as conn:
        row = conn.execute(
            """SELECT operators.id, operators.name, operators.role
               FROM sessions JOIN operators ON operators.id = sessions.operator_id
               WHERE sessions.token_hash = ? AND sessions.expires_at > ?""",
            (token_hash, int(time.time())),
        ).fetchone()
    return dict(row) if row else None


def end_session(token: str | None) -> None:
    if not token:
        return
    with _db() as conn:
        conn.execute("DELETE FROM sessions WHERE token_hash = ?", (hashlib.sha256(token.encode()).hexdigest(),))


def change_password(operator_id: int, current_password: str, new_password: str) -> None:
    if not 10 <= len(new_password) <= 128:
        raise PartnerError("新密码需为 10–128 个字符。")
    with _db() as conn:
        row = conn.execute("SELECT password_hash FROM operators WHERE id = ?", (operator_id,)).fetchone()
        if row is None or not _password_matches(current_password, row["password_hash"]):
            raise PartnerError("当前密码不正确。")
        conn.execute("UPDATE operators SET password_hash = ? WHERE id = ?", (_password_hash(new_password), operator_id))
        conn.execute("DELETE FROM sessions WHERE operator_id = ?", (operator_id,))


def _validated_site(
    name: str, domain: str, description: str, contact_method: str, contact_handle: str,
    website_url: str = "",
) -> tuple[str, str, str, str, str, str]:
    from .leaderboard import is_valid_domain

    name = name.strip()
    domain = domain.strip().lower()
    description = description.strip()
    contact_method = contact_method.strip().lower()
    contact_handle = contact_handle.strip()
    if not 2 <= len(name) <= 80:
        raise PartnerError("站点名称需为 2–80 个字符。")
    if not is_valid_domain(domain):
        raise PartnerError("请填写域名，不要包含协议、路径或端口。")
    if len(description) > 500:
        raise PartnerError("站点简介不能超过 500 个字符。")
    if contact_method not in {"qq", "wechat"}:
        raise PartnerError("请选择 QQ 或微信作为联系方式。")
    if not 1 <= len(contact_handle) <= 80:
        raise PartnerError("请填写所选联系方式的账号，最多 80 个字符。")
    website_url = _target_url(website_url, domain)
    return name, domain, description, contact_method, contact_handle, website_url


def _insert_pending_submission(
    conn: sqlite3.Connection, operator_id: int, site: tuple[str, str, str, str, str, str],
) -> None:
    """Insert one operator-submitted site and leave an audit receipt.

    The same path serves registration (account + first submission created
    together) and later submissions, so the administrator review queue sees
    every operator site the moment it exists.
    """
    name, domain, description, contact_method, contact_handle, website_url = site
    conn.execute(
        """INSERT INTO site_submissions
           (operator_id, name, domain, description, contact_method, contact_handle, website_url, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        (operator_id, name, domain, description, contact_method, contact_handle, website_url, int(time.time())),
    )
    owner = conn.execute("SELECT name FROM operators WHERE id = ?", (operator_id,)).fetchone()
    _insert_event(
        conn, "site_submitted", actor_id=operator_id,
        actor_name=owner["name"] if owner else "", subject=domain,
        detail="status=pending",
    )


def submit_site(
    operator_id: int, name: str, domain: str, description: str,
    contact_method: str, contact_handle: str, website_url: str = "",
) -> None:
    site = _validated_site(name, domain, description, contact_method, contact_handle, website_url)
    with _db() as conn:
        try:
            _insert_pending_submission(conn, operator_id, site)
        except sqlite3.IntegrityError as exc:
            raise PartnerError("该域名已提交收录申请。") from exc


def admin_add_site(
    admin_id: int, owner_id: int, name: str, domain: str, description: str,
    contact_method: str, contact_handle: str, website_url: str = "",
) -> None:
    name, domain, description, contact_method, contact_handle, website_url = _validated_site(
        name, domain, description, contact_method, contact_handle, website_url,
    )
    with _db() as conn:
        conn.execute("BEGIN IMMEDIATE")
        admin = conn.execute("SELECT name, role FROM operators WHERE id = ?", (admin_id,)).fetchone()
        if admin is None or admin["role"] != "admin":
            raise PartnerError("管理员权限不足。")
        if conn.execute("SELECT id FROM operators WHERE id = ?", (owner_id,)).fetchone() is None:
            raise PartnerError("请选择有效的站长账号。")
        now = int(time.time())
        try:
            conn.execute(
                """INSERT INTO site_submissions
                   (operator_id, name, domain, description, contact_method, contact_handle,
                    website_url, status, created_at, approved_at, submission_source)
                   VALUES (?, ?, ?, ?, ?, ?, ?, 'approved', ?, ?, 'admin')""",
                (owner_id, name, domain, description, contact_method, contact_handle, website_url, now, now),
            )
        except sqlite3.IntegrityError as exc:
            raise PartnerError("该域名已提交收录申请。") from exc
        _insert_event(conn, "site_added", actor_id=admin_id, actor_name=admin["name"], subject=domain, detail=f"status=approved; owner_id={owner_id}")


def sites_for_operator(operator_id: int) -> list[dict]:
    with _db() as conn:
        rows = conn.execute(
            "SELECT name, domain, description, contact_method, contact_handle, website_url, status, created_at, approved_at, submission_source FROM site_submissions WHERE operator_id = ? ORDER BY id DESC",
            (operator_id,),
        ).fetchall()
    return [dict(row) for row in rows]


def all_site_submissions() -> list[dict]:
    with _db() as conn:
        rows = conn.execute(
            """SELECT s.id, s.name, s.domain, s.description, s.contact_method, s.contact_handle,
                      s.website_url, s.status, s.created_at, s.approved_at, s.submission_source,
                      o.name AS operator_name
               FROM site_submissions s JOIN operators o ON o.id = s.operator_id
               ORDER BY CASE s.status WHEN 'pending' THEN 0 ELSE 1 END, s.id DESC"""
        ).fetchall()
    return [dict(row) for row in rows]


def approved_domains() -> set[str]:
    with _db() as conn:
        rows = conn.execute("SELECT domain FROM site_submissions WHERE status = 'approved'").fetchall()
    return {str(row["domain"]) for row in rows}


def approved_public_sites() -> list[dict]:
    """Public catalog fields only; never expose owner or contact details."""
    with _db() as conn:
        rows = conn.execute(
            "SELECT name, domain, description, website_url FROM site_submissions WHERE status = 'approved' ORDER BY domain"
        ).fetchall()
    return [dict(row) for row in rows]


def _insert_event(
    conn: sqlite3.Connection, kind: str, *, actor_id: int | None = None,
    actor_name: str = "", subject: str = "", detail: str = "",
) -> None:
    conn.execute(
        """INSERT INTO admin_events (actor_id, actor_name, kind, subject, detail, created_at)
           VALUES (?, ?, ?, ?, ?, ?)""",
        (actor_id, actor_name[:80], kind[:50], subject[:253], detail[:500], int(time.time())),
    )
    conn.execute("DELETE FROM admin_events WHERE id <= (SELECT MAX(id) - 10000 FROM admin_events)")


def record_event(
    kind: str, *, actor_id: int | None = None,
    actor_name: str = "", subject: str = "", detail: str = "",
) -> None:
    """Security/operations trail. Never pass passwords, keys or contact handles."""
    with _db() as conn:
        _insert_event(conn, kind, actor_id=actor_id, actor_name=actor_name, subject=subject, detail=detail)


def recent_events(limit: int = 20) -> list[dict]:
    with _db() as conn:
        rows = conn.execute(
            "SELECT actor_name, kind, subject, detail, created_at FROM admin_events ORDER BY id DESC LIMIT ?",
            (max(1, min(limit, 100)),),
        ).fetchall()
    return [dict(row) for row in rows]


def admin_monitoring() -> dict[str, int]:
    now = int(time.time())
    with _db() as conn:
        return {
            "operators": conn.execute("SELECT COUNT(*) FROM operators").fetchone()[0],
            "active_sessions": conn.execute("SELECT COUNT(*) FROM sessions WHERE expires_at > ?", (now,)).fetchone()[0],
            "assigned_slots": conn.execute("SELECT COUNT(*) FROM ad_slots WHERE site_id IS NOT NULL").fetchone()[0],
            "failed_logins_24h": conn.execute(
                "SELECT COUNT(*) FROM admin_events WHERE kind IN ('login_failed', 'login_throttled') AND created_at >= ?",
                (now - 86400,),
            ).fetchone()[0],
        }


def all_operators_summary() -> list[dict]:
    with _db() as conn:
        rows = conn.execute(
            """SELECT o.id, o.name, o.role, o.created_at, COUNT(s.id) AS site_count
               FROM operators o LEFT JOIN site_submissions s ON s.operator_id = o.id
               GROUP BY o.id ORDER BY o.id"""
        ).fetchall()
    return [dict(row) for row in rows]


def approved_sites() -> list[dict]:
    with _db() as conn:
        rows = conn.execute(
            "SELECT id, name, domain, website_url FROM site_submissions WHERE status = 'approved' ORDER BY domain"
        ).fetchall()
    return [dict(row) for row in rows]


def ad_slots() -> list[dict]:
    with _db() as conn:
        rows = conn.execute(
            """SELECT a.code, a.price_yuan, a.site_id, a.updated_at, a.target_url,
                      a.banner_image, a.banner_image_2, a.starts_at, a.ends_at,
                      s.name AS site_name, s.domain, s.website_url, s.status AS site_status,
                      o.name AS operator_name
               FROM ad_slots a
               LEFT JOIN site_submissions s ON s.id = a.site_id
               LEFT JOIN operators o ON o.id = s.operator_id"""
        ).fetchall()
    by_code = {row["code"]: dict(row) for row in rows}
    return [dict(by_code[code], label=label) for code, label, _ in AD_SLOT_DEFAULTS]


def public_ad_slots() -> dict[str, dict[str, str | list[str]]]:
    """Only public display fields; never leak owner/contact information."""
    now = int(time.time())
    return {
        slot["code"]: {
            "name": slot["site_name"], "domain": slot["domain"],
            "url": slot["website_url"] or slot["target_url"] or f"https://{slot['domain']}",
            "tracking_url": f"/out/ad/{slot['code']}",
            "image_url": (
                f"/api/ad-banners/{slot['banner_image'] or slot['banner_image_2']}"
                if slot["banner_image"] or slot["banner_image_2"] else ""
            ),
            "image_urls": [
                f"/api/ad-banners/{name}" for name in (slot["banner_image"], slot["banner_image_2"]) if name
            ],
        }
        for slot in ad_slots()
        if (slot["domain"] and slot["site_status"] == "approved"
            and (slot["starts_at"] is None or slot["starts_at"] <= now)
            and (slot["ends_at"] is None or slot["ends_at"] > now))
    }


def active_ad_target(code: str) -> str | None:
    """Resolve an active public placement without exposing inactive targets."""
    placement = public_ad_slots().get(code.strip().upper())
    return str(placement["url"]) if placement else None


def record_ad_click(code: str, visitor_token: str) -> bool:
    """Record an anonymous click, suppressing rapid duplicate redirects."""
    code = code.strip().upper()
    if code not in AD_SLOT_LABELS or not _VISITOR_TOKEN_RE.fullmatch(visitor_token):
        return False
    now = int(time.time())
    visitor_hash = hashlib.sha256(visitor_token.encode("ascii")).hexdigest()
    day = datetime.fromtimestamp(now, _SHANGHAI).date().isoformat()
    with _db() as conn:
        recent = conn.execute(
            """SELECT 1 FROM ad_clicks WHERE slot_code = ? AND visitor_hash = ?
               AND created_at >= ? LIMIT 1""",
            (code, visitor_hash, now - 5),
        ).fetchone()
        if recent:
            return False
        conn.execute(
            "INSERT INTO ad_clicks (day, slot_code, visitor_hash, created_at) VALUES (?, ?, ?, ?)",
            (day, code, visitor_hash, now),
        )
        cutoff = (datetime.fromtimestamp(now, _SHANGHAI).date() - timedelta(days=180)).isoformat()
        conn.execute("DELETE FROM ad_clicks WHERE day < ?", (cutoff,))
    return True


def ad_dashboard(operator_id: int, days: int = 30) -> dict:
    """Real click totals and daily trend for placements owned by one operator."""
    days = max(1, min(days, 180))
    today = datetime.now(_SHANGHAI).date()
    start = (today - timedelta(days=days - 1)).isoformat()
    week_start = (today - timedelta(days=6)).isoformat()
    with _db() as conn:
        slot_rows = conn.execute(
            """SELECT a.code, a.price_yuan, a.starts_at, a.ends_at,
                      s.name AS site_name, s.domain
               FROM ad_slots a JOIN site_submissions s ON s.id = a.site_id
               WHERE s.operator_id = ? ORDER BY a.code""",
            (operator_id,),
        ).fetchall()
        codes = [row["code"] for row in slot_rows]
        if codes:
            placeholders = ",".join("?" for _ in codes)
            daily_rows = conn.execute(
                f"""SELECT day, COUNT(*) AS clicks, COUNT(DISTINCT visitor_hash) AS visitors
                     FROM ad_clicks WHERE day >= ? AND slot_code IN ({placeholders}) GROUP BY day""",
                (start, *codes),
            ).fetchall()
            totals = conn.execute(
                f"""SELECT COUNT(*) AS clicks, COUNT(DISTINCT visitor_hash) AS visitors,
                            SUM(CASE WHEN day >= ? THEN 1 ELSE 0 END) AS week_clicks
                     FROM ad_clicks WHERE day >= ? AND slot_code IN ({placeholders})""",
                (week_start, start, *codes),
            ).fetchone()
            slot_totals = conn.execute(
                f"""SELECT slot_code, COUNT(*) AS clicks, COUNT(DISTINCT visitor_hash) AS visitors
                     FROM ad_clicks WHERE day >= ? AND slot_code IN ({placeholders}) GROUP BY slot_code""",
                (start, *codes),
            ).fetchall()
        else:
            daily_rows, slot_totals = [], []
            totals = {"clicks": 0, "visitors": 0, "week_clicks": 0}
    by_day = {row["day"]: dict(row) for row in daily_rows}
    by_slot = {row["slot_code"]: dict(row) for row in slot_totals}
    series = []
    for offset in range(days - 1, -1, -1):
        day = today - timedelta(days=offset)
        found = by_day.get(day.isoformat(), {})
        series.append({
            "day": day.isoformat(), "label": day.strftime("%m/%d"),
            "clicks": found.get("clicks", 0), "visitors": found.get("visitors", 0),
        })
    slots = []
    now = int(time.time())
    for row in slot_rows:
        item = dict(row)
        item.update(by_slot.get(row["code"], {"clicks": 0, "visitors": 0}))
        item["active"] = (row["starts_at"] is None or row["starts_at"] <= now) and (row["ends_at"] is None or row["ends_at"] > now)
        slots.append(item)
    return {
        "days": series, "slots": slots, "clicks": int(totals["clicks"] or 0),
        "visitors": int(totals["visitors"] or 0), "week_clicks": int(totals["week_clicks"] or 0),
        "active_slots": sum(bool(slot["active"]) for slot in slots),
    }


def active_slot_domains() -> dict[str, str]:
    """code → domain for placements the public can currently see.

    Ordering follows the slot catalogue (S1–S8, then T1–T8), which is exactly
    the order the 全部站点合集 board lists sponsored and featured sites in.
    """
    return {code: str(info["domain"]) for code, info in public_ad_slots().items()}


def banner_directory():
    return DB_PATH.parent / "ad_banners"


def save_ad_banner(data: bytes) -> str:
    """Normalize an uploaded raster banner to metadata-free WebP."""
    if not data or len(data) > MAX_BANNER_BYTES:
        raise PartnerError("横幅图片须小于 2 MB。")
    try:
        with Image.open(io.BytesIO(data)) as image:
            if (image.format not in {"PNG", "JPEG", "WEBP"}
                    or image.width > 6000 or image.height > 6000
                    or image.width * image.height > 12_000_000):
                raise PartnerError("请上传 PNG、JPG 或 WebP 图片，像素不超过 1200 万。")
            image.load()
            rendered = image.convert("RGBA" if "A" in image.getbands() or "transparency" in image.info else "RGB")
            output = io.BytesIO()
            rendered.save(output, format="WEBP", quality=86)
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError) as exc:
        raise PartnerError("横幅图片无效，请上传 PNG、JPG 或 WebP。") from exc
    if len(output.getvalue()) > MAX_BANNER_BYTES:
        raise PartnerError("处理后的图片超过 2 MB，请压缩后重试。")
    name = secrets.token_urlsafe(24) + ".webp"
    directory = banner_directory()
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    path = directory / name
    path.touch(mode=0o600, exist_ok=False)
    path.write_bytes(output.getvalue())
    return name


def public_banner_path(name: str):
    if not _BANNER_NAME_RE.fullmatch(name):
        return None
    with _db() as conn:
        row = conn.execute(
            """SELECT 1 FROM ad_slots a JOIN site_submissions s ON s.id = a.site_id
               WHERE (a.banner_image = ? OR a.banner_image_2 = ?)
                 AND s.status = 'approved'
                 AND (a.starts_at IS NULL OR a.starts_at <= ?)
                 AND (a.ends_at IS NULL OR a.ends_at > ?)
               LIMIT 1""", (name, name, int(time.time()), int(time.time())),
        ).fetchone()
    path = banner_directory() / name
    return path if row and path.is_file() else None


def admin_banner_path(name: str):
    """Preview a configured banner even after its public placement expires."""
    if not _BANNER_NAME_RE.fullmatch(name):
        return None
    with _db() as conn:
        row = conn.execute(
            "SELECT 1 FROM ad_slots WHERE banner_image = ? OR banner_image_2 = ? LIMIT 1",
            (name, name),
        ).fetchone()
    path = banner_directory() / name
    return path if row and path.is_file() else None


def _target_url(value: str, domain: str) -> str:
    value = value.strip() or f"https://{domain}"
    try:
        parsed = urlsplit(value)
        host, port = parsed.hostname, parsed.port
    except ValueError as exc:
        raise PartnerError("站点链接须为有效的 HTTPS 地址，不能包含账号或端口。") from exc
    if (len(value) > 500 or parsed.scheme != "https" or not parsed.hostname
            or parsed.username or parsed.password or port is not None
            or not host or not re.fullmatch(r"[A-Za-z0-9.-]+", host)
            or "." not in host or any(
                not label or label.startswith("-") or label.endswith("-") for label in host.split(".")
            )):
        raise PartnerError("站点链接须为有效的 HTTPS 地址，不能包含账号或端口。")
    try:
        ipaddress.ip_address(host)
    except ValueError:
        pass
    else:
        raise PartnerError("站点链接不能指向 IP 地址。")
    return value


def slots_for_operator(operator_id: int) -> list[dict]:
    with _db() as conn:
        rows = conn.execute(
            """SELECT a.code, a.price_yuan, a.starts_at, a.ends_at, s.name AS site_name, s.domain
               FROM ad_slots a JOIN site_submissions s ON s.id = a.site_id
               WHERE s.operator_id = ? ORDER BY a.code""",
            (operator_id,),
        ).fetchall()
    return [dict(row) for row in rows]


def clear_ad_slot(admin_id: int, code: str) -> bool:
    """Reset one placement: drop its site, banners, schedule and price change.

    The price returns to the current catalogue value so the slot is ready for a
    new placement; the audit entry keeps the previous values on record.
    """
    code = code.strip().upper()
    if code not in AD_SLOT_LABELS:
        raise PartnerError("无效的广告位。")
    with _db() as conn:
        conn.execute("BEGIN IMMEDIATE")
        admin = conn.execute("SELECT name, role FROM operators WHERE id = ?", (admin_id,)).fetchone()
        if admin is None or admin["role"] != "admin":
            raise PartnerError("管理员权限不足。")
        old = conn.execute(
            """SELECT a.price_yuan, a.banner_image, a.banner_image_2, a.starts_at, a.ends_at, s.domain
               FROM ad_slots a LEFT JOIN site_submissions s ON s.id = a.site_id WHERE a.code = ?""",
            (code,),
        ).fetchone()
        if old is None:
            raise PartnerError("无效的广告位。")
        default_price = AD_SLOT_PRICES[code]
        empty = (
            old["domain"] is None and not old["banner_image"] and not old["banner_image_2"]
            and old["starts_at"] is None and old["ends_at"] is None
            and old["price_yuan"] == default_price
        )
        if empty:
            return False
        conn.execute(
            """UPDATE ad_slots SET price_yuan = ?, site_id = NULL, target_url = '',
               banner_image = '', banner_image_2 = '', starts_at = NULL, ends_at = NULL,
               updated_at = ? WHERE code = ?""",
            (default_price, int(time.time()), code),
        )
        _insert_event(
            conn, "ad_slot_cleared", actor_id=admin_id, actor_name=admin["name"], subject=code,
            detail=f"price {old['price_yuan']} -> {default_price}; site {old['domain'] or '-'} -> -",
        )
        return True


def update_ad_slot(
    admin_id: int, code: str, price_yuan: int | None, domain: str,
    banner_image: str | None = None, banner_image_2: str | None = None,
    clear_banner: bool = False, clear_banner_2: bool = False,
) -> bool:
    """Set price and assignment together, with an atomic audit entry."""
    code = code.strip().upper()
    domain = domain.strip().lower()
    if code not in AD_SLOT_LABELS:
        raise PartnerError("无效的广告位。")
    if price_yuan is not None and not 0 <= price_yuan <= 100000:
        raise PartnerError("广告价格必须在 0–100000 元之间。")
    if any(name is not None and not _BANNER_NAME_RE.fullmatch(name) for name in (banner_image, banner_image_2)):
        raise PartnerError("横幅图片文件名无效。")
    with _db() as conn:
        conn.execute("BEGIN IMMEDIATE")
        admin = conn.execute("SELECT name, role FROM operators WHERE id = ?", (admin_id,)).fetchone()
        if admin is None or admin["role"] != "admin":
            raise PartnerError("管理员权限不足。")
        old = conn.execute(
            """SELECT a.price_yuan, a.site_id, a.target_url, a.banner_image,
                      a.banner_image_2, a.starts_at, a.ends_at, s.domain
               FROM ad_slots a LEFT JOIN site_submissions s ON s.id = a.site_id WHERE a.code = ?""",
            (code,),
        ).fetchone()
        site_id = None
        if domain:
            site = conn.execute("SELECT id, status FROM site_submissions WHERE domain = ?", (domain,)).fetchone()
            if site is None or site["status"] != "approved":
                raise PartnerError("只能将广告位分配给已审核通过的站点。")
            site_id = site["id"]
        same_site = site_id is not None and old["site_id"] == site_id
        new_url = old["target_url"] if same_site else ""
        new_banner = "" if site_id is None or clear_banner else (banner_image or (old["banner_image"] if same_site else ""))
        new_banner_2 = "" if site_id is None or clear_banner_2 else (banner_image_2 or (old["banner_image_2"] if same_site else ""))
        starts_at = old["starts_at"] if same_site else None
        ends_at = old["ends_at"] if same_site else None
        if (old["price_yuan"] == price_yuan and old["site_id"] == site_id
                and old["target_url"] == new_url and old["banner_image"] == new_banner
                and old["banner_image_2"] == new_banner_2
                and old["starts_at"] == starts_at and old["ends_at"] == ends_at):
            return False
        conn.execute(
            """UPDATE ad_slots SET price_yuan = ?, site_id = ?, target_url = ?,
               banner_image = ?, banner_image_2 = ?, starts_at = ?, ends_at = ?, updated_at = ?
               WHERE code = ?""",
            (price_yuan, site_id, new_url, new_banner, new_banner_2, starts_at, ends_at, int(time.time()), code),
        )
        _insert_event(
            conn, "ad_slot_updated", actor_id=admin_id, actor_name=admin["name"], subject=code,
            detail=f"price {old['price_yuan']} -> {price_yuan}; site {old['domain'] or '-'} -> {domain or '-'}",
        )
        return True


def set_ad_duration(admin_id: int, code: str, days: int) -> None:
    """Start or renew a bound placement for a fixed number of days."""
    code = code.strip().upper()
    if code not in AD_SLOT_LABELS or not 1 <= days <= 365:
        raise PartnerError("投放时长须为 1–365 天。")
    with _db() as conn:
        conn.execute("BEGIN IMMEDIATE")
        admin = conn.execute("SELECT name, role FROM operators WHERE id = ?", (admin_id,)).fetchone()
        if admin is None or admin["role"] != "admin":
            raise PartnerError("管理员权限不足。")
        slot = conn.execute(
            """SELECT a.site_id, s.status FROM ad_slots a
               LEFT JOIN site_submissions s ON s.id = a.site_id WHERE a.code = ?""", (code,),
        ).fetchone()
        if slot is None or slot["site_id"] is None or slot["status"] != "approved":
            raise PartnerError("请先绑定已收录站点，再设置投放时长。")
        now = int(time.time())
        conn.execute(
            "UPDATE ad_slots SET starts_at = ?, ends_at = ?, updated_at = ? WHERE code = ?",
            (now, now + days * 86400, now, code),
        )
        _insert_event(
            conn, "ad_duration_set", actor_id=admin_id, actor_name=admin["name"],
            subject=code, detail=f"days={days}",
        )


def set_site_status(domain: str, status: str, *, actor_id: int | None = None) -> bool:
    """Local operator review only; public account holders cannot call this."""
    if status not in {"approved", "rejected", "pending"}:
        raise ValueError("invalid status")
    with _db() as conn:
        conn.execute("BEGIN IMMEDIATE")
        actor_name = ""
        if actor_id is not None:
            actor = conn.execute("SELECT name, role FROM operators WHERE id = ?", (actor_id,)).fetchone()
            if actor is None or actor["role"] != "admin":
                raise PartnerError("管理员权限不足。")
            actor_name = actor["name"]
        domain = domain.strip().lower()
        site = conn.execute("SELECT id, status, approved_at FROM site_submissions WHERE domain = ?", (domain,)).fetchone()
        if site is None:
            return False
        approved_at = int(time.time()) if status == "approved" and site["status"] != "approved" else (
            site["approved_at"] if status == "approved" else None
        )
        conn.execute(
            "UPDATE site_submissions SET status = ?, approved_at = ? WHERE id = ?",
            (status, approved_at, site["id"]),
        )
        cleared = 0
        if status != "approved":
            cleared = conn.execute(
                "UPDATE ad_slots SET site_id = NULL, updated_at = ? WHERE site_id = ?",
                (int(time.time()), site["id"]),
            ).rowcount
        _insert_event(
            conn, "site_reviewed", actor_id=actor_id, actor_name=actor_name or "offline", subject=domain,
            detail=f"{site['status']} -> {status}; cleared_slots={cleared}",
        )
        return True


if __name__ == "__main__":
    import argparse
    import sys

    if len(sys.argv) >= 2 and sys.argv[1] == "create-admin":
        parser = argparse.ArgumentParser(description="Create a local app administrator")
        parser.add_argument("command", choices=("create-admin",))
        parser.add_argument("username")
        args = parser.parse_args()
        password = secrets.token_urlsafe(24)
        try:
            create_admin(args.username, password)
        except PartnerError as exc:
            parser.error(str(exc))
        print(f"admin_username={args.username}\ninitial_password={password}")
        raise SystemExit(0)

    parser = argparse.ArgumentParser(description="Review a site submission after manual ownership checks")
    parser.add_argument("status", choices=("approved", "rejected", "pending"))
    parser.add_argument("domain")
    args = parser.parse_args()
    if not set_site_status(args.domain, args.status):
        parser.error("no submission for this domain")
    print(f"{args.domain}: {args.status}")
