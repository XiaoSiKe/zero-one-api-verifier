"""Contract + smoke coverage for the Docker preview stack.

The stack is the supported way to look at every page locally, so two things
must stay true: Compose wires the two services together (Vite proxies to the
FastAPI service by name), and the demo seed produces a dataset that renders
every module without leaving the data directory in a half-built state.
"""

from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = ROOT.parent
COMPOSE = (REPO_ROOT / "compose.yaml").read_text(encoding="utf-8")
VITE_CONFIG = (REPO_ROOT / "vite.config.js").read_text(encoding="utf-8")


def test_compose_serves_the_verifier_alongside_the_marketing_site():
    assert "verifier:" in COMPOSE
    assert "web.server:app" in COMPOSE
    assert "VERIFIER_TARGET: http://verifier:8012" in COMPOSE
    # every preview surface is reachable through the Vite origin
    assert "VERIDROP_WEB_DATA_DIR: /app/zero-one-api-verifier/web_data" in COMPOSE
    assert "verifier-web-data:/app/zero-one-api-verifier/web_data" in COMPOSE
    assert "127.0.0.1:${VERIFIER_PREVIEW_PORT:-8123}:8012" in COMPOSE
    assert "127.0.0.1:${LOCAL_PREVIEW_PORT:-5175}:5173" in COMPOSE


def test_vite_proxy_target_is_overridable_for_compose():
    assert "process.env.VERIFIER_TARGET" in VITE_CONFIG
    assert "'http://127.0.0.1:8012'" in VITE_CONFIG


def test_demo_seed_is_opt_in_behind_a_profile():
    assert "profiles:" in COMPOSE
    assert "- demo" in COMPOSE
    assert "scripts/preview_seed.py" in COMPOSE


def _run_seed(data_dir: Path, *extra: str) -> dict:
    env = {**os.environ, "PYTHONPATH": os.pathsep.join([str(ROOT), str(ROOT / "src")])}
    env.pop("VERIDROP_WEB_DATA_DIR", None)
    proc = subprocess.run(
        [sys.executable, "scripts/preview_seed.py", "--data-dir", str(data_dir), *extra],
        cwd=ROOT, env=env, capture_output=True, text=True, timeout=180,
    )
    assert proc.returncode == 0, proc.stderr
    return json.loads(proc.stdout)


def test_preview_seed_populates_every_module_then_stays_idempotent():
    with tempfile.TemporaryDirectory() as tmp:
        data_dir = Path(tmp) / "web_data"
        first = _run_seed(data_dir)

        assert first["seeded"] is True
        assert first["reports_written"] > 0
        assert first["pageviews_written"] > 0
        assert (data_dir / "preview_seed.json").exists()
        assert (data_dir / "partners.sqlite3").exists()

        # detection reports land where the leaderboard reads them
        report_files = sorted((data_dir / "jobs").glob("*/*.json"))
        assert report_files, "no detection reports were written"

        # visits span every window the dashboard offers
        conn = sqlite3.connect(data_dir / "visits.sqlite3")
        try:
            days = conn.execute("SELECT COUNT(DISTINCT day) FROM pageviews").fetchone()[0]
        finally:
            conn.close()
        assert days >= 150

        # approved + pending submissions both exist
        conn = sqlite3.connect(data_dir / "partners.sqlite3")
        try:
            statuses = dict(conn.execute(
                "SELECT status, COUNT(*) FROM site_submissions GROUP BY status"
            ).fetchall())
        finally:
            conn.close()
        assert statuses.get("approved", 0) >= 6
        assert statuses.get("pending", 0) >= 2

        second = _run_seed(data_dir)
        assert second["seeded"] is False
        assert second["admin_password"] == first["admin_password"]
