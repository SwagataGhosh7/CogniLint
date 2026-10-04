"""CogniLint FastAPI backend."""

from __future__ import annotations

import json
import os
import re
import asyncio
from typing import Any, Literal

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, ConfigDict, Field

load_dotenv()

OLLAMA_URL = "http://localhost:11434/api/generate"
OLLAMA_MODEL = "gemma4:e4b"
OLLAMA_TIMEOUT_SECONDS = float(os.getenv("OLLAMA_TIMEOUT_SECONDS", "45"))
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-3.8-flash")
GEMINI_URL = (
    "https://generativelanguage.googleapis.com/v1beta/models/"
    f"{GEMINI_MODEL}:generateContent"
)

SYSTEM_PROMPT = """You are CogniLint, a precise code security and complexity analyzer.
Analyze the supplied source code for real security vulnerabilities and high cyclomatic
complexity. Return ONLY one raw JSON array. Do not use Markdown fences, explanations,
comments, or <|think|> tags.

Every array item MUST be an object with exactly these keys:
- "line_number": an integer using the 1-based source line containing the issue
- "issue_type": either "vulnerability" or "complexity"
- "description": a concise string explaining the issue
- "suggested_refactor": a concrete replacement for the affected line or code snippet

Return [] when no actionable issue is found. Never invent line numbers."""

RESPONSE_SCHEMA = {
    "type": "array",
    "items": {
        "type": "object",
        "required": ["line_number", "issue_type", "description", "suggested_refactor"],
        "properties": {
            "line_number": {"type": "integer", "minimum": 1},
            "issue_type": {"type": "string", "enum": ["vulnerability", "complexity"]},
            "description": {"type": "string"},
            "suggested_refactor": {"type": "string"},
        },
    },
}


class AnalyzeRequest(BaseModel):
    code: str
    language: str = Field(min_length=1)


class AnalysisIssue(BaseModel):
    model_config = ConfigDict(extra="forbid")

    line_number: int = Field(ge=1)
    issue_type: Literal["vulnerability", "complexity"]
    description: str
    suggested_refactor: str


app = FastAPI(title="CogniLint Analyzer", version="1.0.0")


def sanitize_model_response(response: str) -> list[dict[str, Any]]:
    """Extract and validate the JSON array from a model response."""
    cleaned = re.sub(r"<\|/?(?:think|endofthink)\|>", "", response, flags=re.IGNORECASE)
    start = cleaned.find("[")
    end = cleaned.rfind("]")
    if start < 0 or end < start:
        raise ValueError("Model response did not contain a JSON array")

    try:
        parsed = json.loads(cleaned[start : end + 1])
    except json.JSONDecodeError as exc:
        raise ValueError("Model response contained invalid JSON") from exc

    if not isinstance(parsed, list):
        raise ValueError("Model response must be a JSON array")

    issues: list[dict[str, Any]] = []
    for item in parsed:
        if not isinstance(item, dict):
            raise ValueError("Every analysis result must be an object")
        issue = AnalysisIssue.model_validate(item)
        issues.append(issue.model_dump())
    return issues


async def analyze_with_ollama(code: str, language: str) -> list[dict[str, Any]]:
    """Ask the local Ollama model to analyze source code."""
    payload = {
        "model": OLLAMA_MODEL,
        "system": SYSTEM_PROMPT,
        "prompt": f"Language: {language}\n\nSource code:\n```{language}\n{code}\n```",
        "stream": False,
        "format": RESPONSE_SCHEMA,
        "think": False,
    }
    try:
        async with httpx.AsyncClient(timeout=OLLAMA_TIMEOUT_SECONDS) as client:
            result = await client.post(OLLAMA_URL, json=payload)
            result.raise_for_status()
            body = result.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise RuntimeError("Unable to reach or decode the Ollama response") from exc

    response_text = body.get("response")
    if not isinstance(response_text, str):
        raise RuntimeError("Ollama response did not contain text")
    try:
        return sanitize_model_response(response_text)
    except ValueError as exc:
        raise RuntimeError(str(exc)) from exc


async def analyze_with_gemini(code: str, language: str) -> list[dict[str, Any]]:
    """Use Gemini as a remote fallback when explicitly configured."""
    if not GEMINI_API_KEY:
        raise RuntimeError("GEMINI_API_KEY is not configured")

    payload = {
        "systemInstruction": {"parts": [{"text": SYSTEM_PROMPT}]},
        "contents": [
            {
                "parts": [
                    {
                        "text": (
                            f"Language: {language}\n\nSource code:\n"
                            f"```{language}\n{code}\n```"
                        )
                    }
                ]
            }
        ],
        "generationConfig": {"responseMimeType": "application/json", "responseSchema": RESPONSE_SCHEMA},
    }
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            for attempt in range(2):
                result = await client.post(
                    GEMINI_URL,
                    headers={"Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY},
                    json=payload,
                )
                if result.status_code != 503 or attempt == 1:
                    result.raise_for_status()
                    body = result.json()
                    break
                await asyncio.sleep(2)
    except (httpx.HTTPError, ValueError) as exc:
        raise RuntimeError("Unable to reach or decode the Gemini response") from exc

    try:
        response_text = body["candidates"][0]["content"]["parts"][0]["text"]
    except (KeyError, IndexError, TypeError) as exc:
        raise RuntimeError("Gemini response did not contain text") from exc
    try:
        return sanitize_model_response(response_text)
    except ValueError as exc:
        raise RuntimeError(str(exc)) from exc


@app.post("/analyze-code", response_model=list[AnalysisIssue])
async def analyze_code(request: AnalyzeRequest) -> list[dict[str, Any]]:
    try:
        return await analyze_with_ollama(request.code, request.language)
    except RuntimeError as ollama_error:
        if not GEMINI_API_KEY:
            raise HTTPException(status_code=502, detail=str(ollama_error)) from ollama_error
        try:
            return await analyze_with_gemini(request.code, request.language)
        except RuntimeError as gemini_error:
            raise HTTPException(
                status_code=502,
                detail=f"Ollama failed: {ollama_error}; Gemini fallback failed: {gemini_error}",
            ) from gemini_error
