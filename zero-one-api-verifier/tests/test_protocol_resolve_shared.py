"""All callers share one model-name protocol heuristic."""

from __future__ import annotations

from relay_detector.cli import _resolve_protocol
from relay_detector.models import Protocol
from relay_detector.protocols.resolve import protocol_from_model
from web.probe import _classify
from web.server import _protocol_from_model


def test_namespaced_aliases_resolve_identically_everywhere():
    cases = {
        "anthropic/claude-opus-4-7": Protocol.ANTHROPIC,
        "openai/gpt-5": Protocol.OPENAI,
        "azure/openai/gpt-4o": Protocol.OPENAI,
        "google/gemini-2.5-flash": Protocol.GEMINI,
        "models/gemini-2.5-pro": Protocol.GEMINI,
        "text-embedding-3-small": Protocol.OPENAI,
    }
    for model, expected in cases.items():
        assert protocol_from_model(model) == expected
        assert _resolve_protocol(None, model) == expected
        assert _classify(model) == expected.value
        assert _protocol_from_model(model) == expected.value


def test_unknown_model_supports_caller_specific_fallback():
    assert protocol_from_model("vendor/model") is None
    assert _classify("vendor/model") is None
    assert (
        protocol_from_model("vendor/model", default=Protocol.ANTHROPIC)
        == Protocol.ANTHROPIC
    )
    assert _resolve_protocol(None, "vendor/model") == Protocol.ANTHROPIC
    assert _protocol_from_model("vendor/model") == "anthropic"
