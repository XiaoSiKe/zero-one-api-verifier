"""Create a private, consistent backup of the verifier's independent data tree."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sqlite3
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path

DATABASES = ("partners.sqlite3", "visits.sqlite3")
DIRECTORIES = ("jobs", "ad_banners")
FILES = ("wishlist.txt",)


def _snapshot_database(source: Path, target: Path) -> None:
    with (
        sqlite3.connect(f"file:{source}?mode=ro", uri=True) as live,
        sqlite3.connect(target) as saved,
    ):
        live.backup(saved)
        if saved.execute("PRAGMA integrity_check").fetchone() != ("ok",):
            raise RuntimeError(f"backup integrity check failed: {source.name}")
        if saved.execute("PRAGMA foreign_key_check").fetchall():
            raise RuntimeError(f"backup foreign key check failed: {source.name}")
    target.chmod(0o600)


def backup(data_dir: Path, backup_root: Path) -> Path:
    source = data_dir.resolve(strict=True)
    root = backup_root.resolve()
    if source == root or source.is_relative_to(root) or root.is_relative_to(source):
        raise ValueError("backup directory must be separate from the data directory")
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    root.chmod(0o700)
    temporary = Path(tempfile.mkdtemp(prefix=".verifier-backup-", dir=root))
    try:
        saved: list[str] = []
        for name in DATABASES:
            path = source / name
            if path.exists():
                _snapshot_database(path, temporary / name)
                saved.append(name)
        for name in DIRECTORIES:
            path = source / name
            if path.exists():
                shutil.copytree(path, temporary / name)
                saved.append(name + "/")
        for name in FILES:
            path = source / name
            if path.exists():
                shutil.copy2(path, temporary / name)
                saved.append(name)

        for path in temporary.rglob("*"):
            path.chmod(0o700 if path.is_dir() else 0o600)
        manifest = {
            "created_at": datetime.now(timezone.utc).isoformat(),
            "contents": saved,
        }
        (temporary / "manifest.json").write_text(
            json.dumps(manifest, indent=2), encoding="utf-8"
        )
        (temporary / "manifest.json").chmod(0o600)
        name = datetime.now(timezone.utc).strftime("verifier-%Y%m%dT%H%M%SZ")
        destination = root / f"{name}-{uuid.uuid4().hex[:8]}"
        os.replace(temporary, destination)
        return destination
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--backup-root", type=Path, required=True)
    args = parser.parse_args()
    print(backup(args.data_dir, args.backup_root))


if __name__ == "__main__":
    main()
