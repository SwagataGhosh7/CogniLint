import pytest
from httpx import ASGITransport, AsyncClient

import main


def test_sanitize_model_response_removes_thinking_tags_and_markdown() -> None:
    response = """<|think|>checking<|endofthink|>
```json
[{"line_number": 2, "issue_type": "vulnerability",
"description": "Unsafe eval", "suggested_refactor": "safe_call(value)"}]
```"""

    assert main.sanitize_model_response(response) == [
        {
            "line_number": 2,
            "issue_type": "vulnerability",
            "description": "Unsafe eval",
            "suggested_refactor": "safe_call(value)",
        }
    ]


def test_sanitize_model_response_rejects_unknown_fields() -> None:
    with pytest.raises(ValueError):
        main.sanitize_model_response(
            '[{"line_number": 1, "issue_type": "complexity", '
            '"description": "Complex", "suggested_refactor": "refactor()", '
            '"unexpected": true}]'
        )


@pytest.mark.asyncio
async def test_analyze_code_uses_ollama_result(monkeypatch: pytest.MonkeyPatch) -> None:
    expected = [
        {
            "line_number": 1,
            "issue_type": "complexity",
            "description": "Too many branches",
            "suggested_refactor": "extract_helper()",
        }
    ]

    async def fake_ollama(code: str, language: str) -> list[dict[str, object]]:
        assert code == "if value:"
        assert language == "python"
        return expected

    monkeypatch.setattr(main, "analyze_with_ollama", fake_ollama)
    transport = ASGITransport(app=main.app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            "/analyze-code",
            json={"code": "if value:", "language": "python"},
        )

    assert response.status_code == 200
    assert response.json() == expected


@pytest.mark.asyncio
async def test_analyze_code_falls_back_to_gemini(monkeypatch: pytest.MonkeyPatch) -> None:
    expected = [
        {
            "line_number": 1,
            "issue_type": "vulnerability",
            "description": "Unsafe call",
            "suggested_refactor": "safe_call()",
        }
    ]

    async def failing_ollama(code: str, language: str) -> list[dict[str, object]]:
        raise RuntimeError("Ollama unavailable")

    async def fake_gemini(code: str, language: str) -> list[dict[str, object]]:
        return expected

    monkeypatch.setattr(main, "GEMINI_API_KEY", "test-key")
    monkeypatch.setattr(main, "analyze_with_ollama", failing_ollama)
    monkeypatch.setattr(main, "analyze_with_gemini", fake_gemini)
    transport = ASGITransport(app=main.app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            "/analyze-code",
            json={"code": "eval(value)", "language": "python"},
        )

    assert response.status_code == 200
    assert response.json() == expected
