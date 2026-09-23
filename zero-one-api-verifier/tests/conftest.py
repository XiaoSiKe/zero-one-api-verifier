"""Keep every web store away from preview and production data during tests."""

from __future__ import annotations

import os
import tempfile

_temporary_data = tempfile.TemporaryDirectory(prefix="veridrop-test-data-")
_data_dir = _temporary_data.name
os.environ["VERIDROP_WEB_DATA_DIR"] = _data_dir
os.environ["VERIDROP_JOBS_DIR"] = os.path.join(_data_dir, "jobs")
os.environ["VERIDROP_WISHLIST_PATH"] = os.path.join(_data_dir, "wishlist.txt")
