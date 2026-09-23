"""Narrow source contracts for the ZeroOne UI identity."""

from __future__ import annotations

import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TEMPLATES = ROOT / "web" / "templates"
STATIC = ROOT / "web" / "static"

PRODUCT_NAME = "零一智鉴 · API 真测雷达"
SLOGAN = "从零到一，让每一个接口有据可鉴！"
SITE_ORIGIN = "https://mix.01yapi.cc"
FORK_URL = "https://github.com/XiaoSiKe/zero-one-api-verifier"
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


def test_hub_reuses_the_full_three_step_module():
    source = _read(TEMPLATES / "hub.html")
    content = source.split("{% block content %}", 1)[1].split("{% endblock %}", 1)[0]

    for expected in (
        '{% block main_class %} hub-container{% endblock %}',
        '{% block footer %}{% endblock %}',
        '<script src="/static/home-specular.js" defer></script>',
    ):
        assert expected in source
    for expected in (
        'id="how-title">怎么用?三步 60 秒',
        '填中转站地址 + API key',
        '点「开始检测」,等 30-70 秒',
        '看报告,重点看警告与未通过项',
        'class="home-how-steps home-how-steps-continuation"',
    ):
        assert expected in content
    assert 'class="home-protocol-grid"' in content
    assert content.count('class="home-protocol-card"') == 3
    assert content.count('class="home-protocol-button home-specular-button"') == 3
    assert content.count('data-home-specular') == 4
    assert 'class="home-app-leaderboard-cta"' in content
    assert 'href="/leaderboard" data-home-specular' in content
    assert '<span class="home-specular-label">API 红黑榜</span>' in content

    for removed in (
        PRODUCT_NAME,
        SLOGAN,
        'class="hub-hero"',
    ):
        assert removed not in content

    for route in ("/claude", "/openai", "/gemini"):
        assert f'href="{route}"' in source


def test_hub_specular_effect_keeps_pointer_and_motion_fallbacks():
    js = _read(STATIC / "home-specular.js")
    css = _read(STATIC / "style.css")

    assert "getContext('webgl2'" in js
    assert "(hover: hover) and (pointer: fine)" in js
    assert "(prefers-reduced-motion: reduce)" in js
    assert "attributeFilter: ['data-theme']" in js
    assert "@keyframes home-title-flow" in css
    assert ".home-specular-button:active { transform: scale(0.97); }" in css


def test_protocol_submit_buttons_keep_their_labels_and_specular_layers():
    for template_name in ("index.html", "openai.html", "gemini.html"):
        source = _read(TEMPLATES / template_name)
        assert '<script src="/static/home-specular.js" defer></script>' in source
        assert 'id="submit-btn" class="btn btn-primary home-detect-submit home-specular-button" data-home-specular' in source
        assert '<span class="home-specular-label">开始检测</span>' in source
        assert 'href="/leaderboard" class="home-detect-submit home-detect-secondary home-specular-button" data-home-specular' in source
        assert '<span class="home-specular-label">API 红黑榜</span>' in source

    js = _read(STATIC / "app.js")
    assert "const submitLabel = submitBtn.querySelector('.home-specular-label')" in js
    assert "setSubmitText('正在确认模型可用…')" in js


def test_detection_navigation_matches_homepage_destinations():
    base = _read(TEMPLATES / "base.html")
    homepage = _read(ROOT.parent / "src" / "App.jsx")

    for route in ("claude", "openai", "gemini"):
        assert f'href="/{route}"' in base
        assert f'href="/{route}"' in homepage
    assert 'class="nav-action" href="/app">开始</a>' in base
    assert 'className="nav-action" href={API_TEST_URL}>开始</a>' in homepage
    assert '<span class="brand-name-full">' not in base
    assert '<span className="brand-name-full">' not in homepage
    assert "fetch('/partner/session'" in homepage
    assert 'class="nav-action"' in base
    assert 'className="homepage" id="top"' in homepage
    assert '<a href="#top">首页</a>' in homepage
    assert '<a href="#hero-title">首页</a>' not in homepage


def test_homepage_contact_and_leaderboard_entries():
    homepage = _read(ROOT.parent / "src" / "App.jsx")
    contact = _read(ROOT.parent / "src" / "ContactSection.jsx")
    boards = _read(ROOT.parent / "src" / "BoardsSection.jsx")

    assert '赞助与靠谱榜单' in homepage
    assert '我是站长 · 申请收录' in homepage
    assert "href={partnerSession.authenticated ? partnerSession.home : '/partner/register'}" in homepage
    assert 'scrollIntoView' in homepage
    assert '<BoardsSection specularProps={specularProps} onContact={showContactSection} />' in homepage
    assert '<ContactSection />' in homepage
    assert 'API 红黑榜' in boards
    assert '联系与合作' in boards
    assert 'prefix="S"' in boards and 'prefix="T"' in boards
    assert homepage.index('home-how-section"') < homepage.index('home-trust-section"')
    assert '零一智鉴 · 站长收录' not in boards
    assert '广告展位与检测榜单分开呈现' not in boards
    assert '精选依据公开检测报告' not in boards
    assert '赞助置顶榜' in boards and '靠谱精选榜' in boards
    assert 'className="home-flow-title" id="contact-title"' in contact
    assert 'src="/qq-qr.png"' in contact
    assert (ROOT.parent / "public" / "qq-qr.png").is_file()


def test_partner_titles_share_homepage_section_style():
    for template_name in ("partner_register.html", "partner_login.html"):
        source = _read(TEMPLATES / template_name)
        assert '<h1 class="home-flow-title">' in source
        assert 'name="email"' not in source
        assert '<script src="/static/home-specular.js" defer></script>' in source
        assert source.count('class="partner-cta home-specular-button" data-home-specular') == 2


def test_protocol_and_faq_pages_space_titles_and_hide_shared_footer():
    base = _read(TEMPLATES / "base.html")
    css = _read(STATIC / "style.css")

    assert 'class="container{% block main_class %}{% endblock %}"' in base
    assert ".container.top-spaced-page" in css
    for template_name in ("index.html", "openai.html", "gemini.html", "faq.html"):
        source = _read(TEMPLATES / template_name)
        assert "{% block main_class %} top-spaced-page{% endblock %}" in source
        assert "{% block footer %}{% endblock %}" in source


def test_public_page_titles_share_homepage_flow_style():
    css = _read(STATIC / "style.css")
    assert "h1.home-flow-title" in css
    assert "@keyframes home-title-flow" in css
    for template_name in ("index.html", "openai.html", "gemini.html", "faq.html", "leaderboard.html"):
        source = _read(TEMPLATES / template_name)
        assert re.search(r'<h1 class="home-flow-title">[^<]+</h1>', source)


def test_light_theme_keeps_colored_flow_titles():
    for path in (ROOT.parent / "src" / "styles.css", STATIC / "style.css"):
        css = _read(path)
        light_rule = re.search(r'html\[data-theme="light"\] \.home-flow-title \{([^}]+)\}', css)
        assert light_rule, f"light title rule missing from {path}"
        for expected in ("background-image: linear-gradient", "#1d4ed8", "#6d28d9", "-webkit-text-fill-color: transparent"):
            assert expected in light_rule.group(1)
        assert "animation: none" not in light_rule.group(1)
        assert "@media (prefers-reduced-motion: reduce)" in css


def test_protocol_landing_pages_keep_forms_without_promotional_sections():
    for template_name in ("index.html", "openai.html", "gemini.html"):
        source = _read(TEMPLATES / template_name)
        content = source.split("{% block content %}", 1)[1].split("{% endblock %}", 1)[0]
        assert 'id="detect-form"' in content
        assert '<section class="features">' not in content
        assert '<section class="faq"' not in content
        assert 'class="hero-sub answer-capsule"' not in content
        assert 'class="faq-more"' not in content
        assert '"@type": "FAQPage"' not in source

    claude = _read(TEMPLATES / "index.html")
    openai = _read(TEMPLATES / "openai.html")
    assert '点击/聚焦可见预设模型;<br />' in claude
    for source in (claude, openai):
        # 标准长上下文选项保留说明，极限档只保留成本提示，
        # 「宣传 1M 实际只给 200k」这类夸大卖点已从两个表单删除。
        assert '路由到小窗口模型)。<br />' in source
        assert '标准档完全测不到。' not in source
        assert '高端中转站欺诈' not in source
        assert '由你的 API key 支付' in source

    assert '<section class="card protocol-note">' not in openai
    assert '<section class="card protocol-note">' not in _read(TEMPLATES / "gemini.html")


def test_faq_and_leaderboard_omit_requested_bottom_sections():
    faq = _read(TEMPLATES / "faq.html")
    leaderboard = _read(TEMPLATES / "leaderboard.html")

    assert 'class="faq-no-answer"' not in faq
    assert 'class="faq-hero-sub"' not in faq
    assert 'class="faq-entry"' in faq
    assert "红黑榜怎么算的?" not in leaderboard
    assert "{% block footer %}{% endblock %}" in leaderboard
    assert "数据自动聚合,按 <strong>贝叶斯加权评分</strong>" in leaderboard
    assert 'class="answer-capsule leaderboard-intro"' in leaderboard
    for removed in ("数据来自 <strong>", "数据每 10 分钟刷新", "暂无检测数据。", "去做第一次检测"):
        assert removed not in leaderboard


def test_site_detail_splits_the_verdict_and_drops_the_issue_ranking():
    """结论 / 覆盖协议 / 最近检测时间各占一行；「最常出问题的检测项」已下线。"""
    detail = _read(TEMPLATES / "leaderboard_detail.html")
    css = _read(STATIC / "style.css")

    assert detail.count('class="answer-line"') == 3
    assert "最近一次检测:" in detail
    assert ".answer-capsule .answer-line" in css
    for removed in ("最常出问题的检测项", "软肋", "lb-detail-issues", "lb-issues-list", "failed_summary"):
        assert removed not in detail
    for removed in (".lb-detail-issues", ".lb-issues-list", ".lb-issues-count"):
        assert removed not in css


def test_leaderboard_protocol_summary_is_distilled_and_history_keeps_report_links():
    leaderboard = _read(TEMPLATES / "leaderboard.html")
    detail = _read(TEMPLATES / "leaderboard_detail.html")

    assert 'class="lb-protocols"' not in leaderboard
    assert '<span class="lb-proto-chip' in detail
    assert '<a class="lb-proto-chip' not in detail
    assert 'class="lb-proto-report"' not in leaderboard
    assert 'class="lb-proto-report"' not in detail
    assert '>查看报告</a>' not in leaderboard
    assert '>查看报告</a>' not in detail
    assert '<nav class="breadcrumb"' not in detail
    assert '<td><a href="/r/{{ j.job_id }}">查看 →</a></td>' in detail
    assert '<th class="num">分数</th>' not in detail
    assert '<th class="num">扣分项</th>' not in detail
    assert '{{ j.failed_count }}' not in detail


def test_leaderboard_metadata_shares_the_title_line_and_panels_are_translucent():
    leaderboard = _read(TEMPLATES / "leaderboard.html")
    result = _read(TEMPLATES / "result.html")
    css = _read(STATIC / "style.css")

    assert leaderboard.count('class="lb-title-line"') == 2
    assert '.lb-title-line {' in css
    assert 'background: var(--panel-translucent);' in css
    assert 'background: var(--panel-soft-translucent);' in css
    assert '{% block main_class %} report-page{% endblock %}' in result
    assert '.container.report-page {' in css


def test_leaderboard_cards_are_compact_and_protocol_summary_is_readable():
    css = _read(STATIC / "style.css")

    row = css.split(".lb-row {", 1)[1].split("}", 1)[0]
    modules = css.split(".lb-modules {", 1)[1].split("}", 1)[0]
    score = css.split(".lb-score-num {", 1)[1].split("}", 1)[0]
    rank = css.split(".lb-rank-line {", 1)[1].split("}", 1)[0]
    protocol = css.split(".lb-detail-summary .lb-proto-chip {", 1)[1].split("}", 1)[0]

    assert "padding: 19px 18px" in row
    assert "margin: 0" in modules
    assert "font-size: 30px" in score
    assert "font-size: 14px" in rank
    assert "font-size: 14.5px" in protocol


def test_leaderboard_actions_align_with_the_data_modules():
    css = _read(STATIC / "style.css")
    actions = css.split(".lb-actions {", 1)[1].split("}", 1)[0]

    assert "flex-direction: row" in actions
    assert "align-self: end" in actions


def test_partner_site_submission_drops_the_requested_helper_copy():
    template = _read(TEMPLATES / "partner_site_new.html")
    sites = _read(TEMPLATES / "partner_sites.html")
    css = _read(STATIC / "style.css")

    assert "填写站点基本信息并提交审核，审核通过后进入红黑榜收录列表。" not in template
    assert "域名填写纯域名，不加协议、路径或端口；联系方式用于审核沟通。" not in template
    assert 'id="site-description" name="description" maxlength="500" rows="3"' in template
    assert "#site-description { min-height: 82px; }" in css
    assert "访问官网 ↗" not in sites


def test_sponsor_placements_have_the_highest_visual_tier():
    leaderboard = _read(TEMPLATES / "leaderboard.html")
    css = _read(STATIC / "style.css")

    assert "lb-slot-badge-sponsor" in leaderboard
    assert "赞助置顶 · S{{ number }}" in leaderboard
    assert "广告位 · S{{ number }}" not in leaderboard
    assert ".lb-slot-badge-sponsor {" in css
    sponsor_badge = css.split(".lb-slot-badge-sponsor {", 1)[1].split("}", 1)[0]
    sponsor_slot = css.split(".board-sponsor-slot {", 1)[1].split("}", 1)[0]
    assert "background: transparent" in sponsor_badge
    assert "color: #a5b4fc" in sponsor_badge
    assert "border: 1px solid rgba(255, 255, 255, 0.22)" in sponsor_slot
    assert "background: rgba(20, 20, 20, 0.82)" in sponsor_slot


def test_administration_splits_sponsor_and_recommended_inventory_and_removes_helper_copy():
    template = _read(TEMPLATES / "partner_admin.html")

    assert "?section=ads&amp;ad_type=sponsor" in template
    assert "?section=ads&amp;ad_type=recommended" in template
    assert "赞助广告位" in template and "推荐广告位" in template
    assert "横幅最多两张，绑定站点后使用该站点的官网网址。每个广告位可随时清空重置。" not in template
    assert "解除站点绑定、撤下横幅与投放时长，价格恢复目录价后立即保存。" not in template


def test_home_protocol_cards_keep_compact_spacing():
    css = _read(STATIC / "style.css")
    grid = css.split(".home-protocol-grid {", 1)[1].split("}", 1)[0]
    card = css.split(".home-protocol-card {", 1)[1].split("}", 1)[0]

    assert "gap: 12px" in grid
    assert "min-height: 296px" in card
    assert "padding: 22px" in card


def test_leaderboard_drops_top_captions_and_issue_faq():
    """榜单列表页:Top N 标题后缀、排序/分页说明、「常见问题:」软肋段均已下线。"""
    leaderboard = _read(TEMPLATES / "leaderboard.html")

    for removed in (
        "Top {{ top_relays|length }}",
        "T1–T8 精选展示位 · 展示合作不改变检测评分与排名",
        "按贝叶斯加权评分排序 — 测试越多次的中转站,分数越能反映真实能力",
        "共 {{ board_count }} 家,按赞助位 S1–S8、精选位 T1–T8 优先排列",
        "当前第 {{ page }} / {{ total_pages }} 页",
        "常见问题:",
        "lb-issues",
    ):
        assert removed not in leaderboard


def test_site_detail_drops_protocol_hints_and_suppresses_footer():
    """详情页:两份协议提示、全局页脚均不再出现。"""
    detail = _read(TEMPLATES / "leaderboard_detail.html")

    assert "lb-detail-hint" not in detail
    assert "点击任一协议徽章查看该协议下最近一次的完整检测报告" not in detail
    assert "每份报告都是某次具体的真实请求,点击即可查看完整字段级证据" not in detail
    # 详情页显式清空全局页脚(零一智鉴 · API 真测雷达 等)。
    assert "{% block footer %}{% endblock %}" in detail


def test_detection_depth_picker_is_anchored_below_the_control():
    css = _read(STATIC / "style.css")
    assert "select#mode::picker(select)" in css
    assert "appearance: base-select" in css
    assert "position-area: bottom center" in css
    assert "position-try-fallbacks: flip-block" in css


def test_threads_background_is_shared_by_all_html_pages():
    base = _read(TEMPLATES / "base.html")
    hub = _read(TEMPLATES / "hub.html")

    assert base.count("data-threads") == 1
    assert "data-threads" not in hub


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

    # The protocol links remain readable without JavaScript; only the heading is visually hidden.
    assert not re.search(r"\shidden(?:\s|>)", re.sub(r"aria-hidden=\"true\"", "", hub))


def test_hub_no_longer_mounts_shiny_title():
    hub = _read(TEMPLATES / "hub.html")
    assert 'data-stroke-text' not in hub
    assert 'data-shiny-after-fill' not in hub


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
    for removed in (
        'id="share-btn"',
        '<nav class="breadcrumb"',
        '这份结果怎么理解?',
        '检测项各自检查什么?',
        '由 https://mix.01yapi.cc 生成',
    ):
        assert removed not in result
    assert 'class="result-download home-specular-button"' in result
    assert '{% block footer %}{% endblock %}' in result
    assert 'id="status-headline"' in running
    assert 'id="run-error"' in running


def test_probe_credentials_changes_cancel_stale_auth_failure_state():
    js = _read(STATIC / "app.js")
    assert "apiKeyInput.addEventListener('input'" in js
    assert "baseUrlInput.addEventListener('input'" in js
    assert "if (inflight && inflight.abort) inflight.abort()" in js
    assert "lastKey = null" in js
    assert "setSubmitEnabled(true)" in js
