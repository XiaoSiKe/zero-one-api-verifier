from __future__ import annotations

from io import BytesIO

from PIL import Image, ImageDraw, ImageFont

from web.image_report import (
    _FONT_CANDIDATES_BOLD,
    _FONT_CANDIDATES_REGULAR,
    _detector_layout,
    _fit_text,
    _model_mode_text,
    render_report_jpg,
)


def test_detector_layout_includes_long_context_without_metric_overlap():
    by_name = {
        name: {"name": name, "status": "pass", "score": 100}
        for name in (
            "identity", "behavioral_signature", "thinking_signature",
            "consistency", "knowledge", "pdf", "structured_output",
            "protocol", "integrity", "token_usage", "message_id",
            "long_context",
        )
    }
    labels, row_h, note_y = _detector_layout(
        "anthropic", by_name, "Token 用量存在风险",
    )
    assert labels[-1] == ("long_context", "长上下文真实性")
    assert 42 <= row_h <= 56
    assert note_y is not None
    assert note_y + 54 <= 850 - 20


def test_font_candidates_prefer_macos_chinese_fonts_before_helvetica():
    for candidates in (_FONT_CANDIDATES_REGULAR, _FONT_CANDIDATES_BOLD):
        helvetica = candidates.index("/System/Library/Fonts/Helvetica.ttc")
        assert any(
            "STHeiti" in candidate or "Arial Unicode" in candidate
            for candidate in candidates[:helvetica]
        )


def test_report_jpg_renders_full_anthropic_result_with_long_context():
    names = [
        "identity", "behavioral_signature", "thinking_signature",
        "consistency", "knowledge", "pdf", "structured_output",
        "protocol", "integrity", "token_usage", "message_id",
        "long_context",
    ]
    report = {
        "protocol": "anthropic",
        "total_score": 82,
        "verdict": "marginal",
        "target_model": "claude-sonnet-4-6",
        "mode": "full",
        "base_url": "https://relay.example.com",
        "api_key_masked": "sk-••••demo",
        "timestamp": "2026-08-26T00:00:00Z",
        "results": [
            {
                "name": name,
                "status": "fail" if name in {"token_usage", "long_context"} else "pass",
                "score": 0 if name in {"token_usage", "long_context"} else 100,
            }
            for name in names
        ],
        "performance": {
            "ttft_ms": 800,
            "total_latency_ms": 4200,
            "usage": {"input_tokens": 500, "output_tokens": 120},
        },
    }
    payload = render_report_jpg(report)
    image = Image.open(BytesIO(payload))
    assert image.format == "JPEG"
    assert image.size == (1400, 1000)


def test_long_model_name_is_ellipsized_by_rendered_width():
    draw = ImageDraw.Draw(Image.new("RGB", (500, 100)))
    font = ImageFont.load_default()
    fitted = _fit_text(draw, "gpt-" + "x" * 200, font, 120)
    assert fitted.endswith("…")
    assert draw.textlength(fitted, font=font) <= 120

    combined = _model_mode_text(draw, "gpt-" + "x" * 200, "full", font, 180)
    assert combined.endswith("mode=full")
    assert draw.textlength(combined, font=font) <= 180
