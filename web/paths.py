"""Shared filesystem locations for the web service.

Defaults are repository-local so a fresh checkout can start without root
permissions. Deployments can move the whole data tree with one environment
variable, while the two legacy per-file overrides remain compatible.
"""

from __future__ import annotations

import os
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
WEB_DATA_DIR = Path(
    os.environ.get("VERIDROP_WEB_DATA_DIR", PROJECT_ROOT / "web_data")
).expanduser()
JOBS_DIR = Path(os.environ.get("VERIDROP_JOBS_DIR", WEB_DATA_DIR / "jobs")).expanduser()
WISHLIST_PATH = Path(
    os.environ.get("VERIDROP_WISHLIST_PATH", WEB_DATA_DIR / "wishlist.txt")
).expanduser()


def report_dirs() -> list[Path]:
    """Protocol report directories plus the legacy flat directory."""
    return [
        JOBS_DIR / "anthropic",
        JOBS_DIR / "openai",
        JOBS_DIR / "gemini",
        JOBS_DIR,
    ]
