"""Narrow source contracts for the ZeroOne UI identity."""

from __future__ import annotations

import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TEMPLATES = ROOT / "web" / "templates"
STATIC = ROOT / "web" / "static"

PRODUCT_NAME = "零一智鉴 · API 真测雷达"
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

    for expected in (
        PRODUCT_NAME,
        SLOGAN,
        FORK_URL,
        UPSTREAM_URL,
        "Forked from canarybyte/veridrop",
        "AGPL-3.0-or-later",
    ):
        assert expected in source


def test_hub_keeps_complete_public_information_architecture():
    source = _read(TEMPLATES / "hub.html")

    assert '<p class="hero-eyebrow">ZeroOne · API Verification Platform</p>' in source
    assert PRODUCT_NAME in source
    assert SLOGAN in source

    # These sections are the public homepage contract, irrespective of their
    # internal layout or the exact visual implementation.
    for expected in (
        'id="hub-definition"',
        'id="hub-stats"',
        'class="trust-strip"',
        'class="protocol-grid"',
        'class="how-it-works"',
        'class="hub-note"',
    ):
        assert expected in source

    for route in ("/claude", "/openai", "/gemini"):
        assert f'href="{route}"' in source

    primary_links = [
        tag
        for tag in re.findall(r"<a\b[^>]*>", source)
        if re.search(r'class="[^"]*\bbtn-primary\b[^"]*"', tag)
    ]
    assert len(primary_links) == 1
    assert 'href="/claude"' in primary_links[0]


def test_threads_background_is_homepage_only():
    base = _read(TEMPLATES / "base.html")
    hub = _read(TEMPLATES / "hub.html")

    assert "data-threads" not in base
    assert hub.count("data-threads") == 1


def test_theme_and_motion_keep_accessible_fallbacks():
    base = _read(TEMPLATES / "base.html")
    hub = _read(TEMPLATES / "hub.html")
    css = _read(STATIC / "style.css")

    assert 'class="theme-toggle"' in base
    assert 'aria-label="切换为深色模式"' in base
    assert 'zeroone_theme' in base
    assert 'html[data-theme="dark"]' in css
    assert '@media (prefers-reduced-motion: reduce)' in css
    assert '@media (forced-colors: active)' in css
    assert 'aria-hidden="true"' in hub

    # Static templates carry the complete readable copy. JavaScript only adds
    # decoration, so disabling it cannot remove the core homepage information.
    assert "hidden" not in re.sub(r"aria-hidden=\"true\"", "", hub)


def test_hub_shine_is_neutral_eight_second_round_trip():
    hub = _read(TEMPLATES / "hub.html")
    css = _read(STATIC / "style.css")
    js = _read(STATIC / "app.js")

    assert hub.count("data-shiny-after-fill") == 2
    assert "--shiny-base:" in css
    assert "--shiny-highlight:" in css
    assert "var(--shiny-base)" in js
    assert "var(--shiny-highlight)" in js
    assert "dur: '8s'" in js
    assert re.search(r"values:\s*`0 0;.*; 0 0`", js)
    assert "#3b82f6" not in js
    assert "#7c3aed" not in js


def test_public_project_text_keeps_brand_and_provenance():
    for path in (ROOT / "README.md", STATIC / "llms.txt"):
        source = _read(path)
        for expected in (PRODUCT_NAME, FORK_URL, UPSTREAM_URL, "AGPL-3.0-or-later"):
            assert expected in source, f"{expected} missing from {path.name}"
        assert "零一智鉴 · API 真测平台" not in source


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
