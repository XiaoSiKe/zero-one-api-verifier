"""Narrow source contracts for the ZeroOne UI identity."""

from __future__ import annotations

import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TEMPLATES = ROOT / "web" / "templates"
STATIC = ROOT / "web" / "static"

PRODUCT_NAME = "零一智鉴 · API 真测平台"
SLOGAN = "从零到一，让每一个接口有据可鉴！"
SITE_ORIGIN = "https://01yapi.cc"
FORK_URL = "https://github.com/01-Yang/zero-one-api-verifier"
UPSTREAM_URL = "https://github.com/canarybyte/veridrop"
UPSTREAM_GA_ID = "G-LWRPQF2182"

CANONICAL_BLOCK = re.compile(
    r"{%\s*block\s+canonical\s*%}(.*?){%\s*endblock\s*%}",
    re.DOTALL,
)


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def test_base_template_keeps_identity_and_fork_attribution():
    source = _read(TEMPLATES / "base.html")

    for expected in (PRODUCT_NAME, SLOGAN, FORK_URL, UPSTREAM_URL):
        assert expected in source


def test_hub_hero_keeps_requested_brand_copy():
    source = _read(TEMPLATES / "hub.html")

    assert '<p class="hero-eyebrow">ZeroOne · API Verification Platform</p>' in source
    assert f"<h1>{PRODUCT_NAME}</h1>" in source
    assert f'<p class="hero-slogan">{SLOGAN}</p>' in source


def test_declared_canonical_blocks_use_zeroone_origin():
    blocks = [
        (path, match.group(1))
        for path in sorted(TEMPLATES.glob("*.html"))
        for match in CANONICAL_BLOCK.finditer(_read(path))
    ]

    assert blocks
    for path, block in blocks:
        assert SITE_ORIGIN in block, f"ZeroOne origin missing from {path.name}"
        assert "veridrop.org" not in block, f"upstream origin found in {path.name}"


def test_upstream_google_analytics_id_is_absent_from_active_ui_sources():
    paths = sorted(TEMPLATES.glob("*.html"))
    paths += sorted(
        path for path in STATIC.iterdir() if path.suffix in {".css", ".js"}
    )

    for path in paths:
        assert UPSTREAM_GA_ID not in _read(path), f"upstream GA ID found in {path}"


def test_critical_dom_hooks_and_form_endpoints_remain_available():
    base = _read(TEMPLATES / "base.html")
    assert 'class="nav-toggle"' in base
    assert 'id="site-nav"' in base

    forms = {
        "index.html": "/api/detect/claude",
        "openai.html": "/api/detect/openai",
        "gemini.html": "/api/detect/gemini",
    }
    for template_name, endpoint in forms.items():
        source = _read(TEMPLATES / template_name)
        for expected in (
            'id="detect-form"',
            f'data-endpoint="{endpoint}"',
            'id="base_url"',
            'name="base_url"',
            'id="api_key"',
            'name="api_key"',
            'id="model"',
            'name="model"',
            'id="model-list"',
            'class="combo-item"',
            'id="submit-btn"',
            'id="form-error"',
        ):
            assert expected in source, f"{expected} missing from {template_name}"

    result = _read(TEMPLATES / "result.html")
    running = _read(TEMPLATES / "running.html")
    assert 'id="share-btn"' in result
    assert 'id="status-headline"' in running
    assert 'id="run-error"' in running
