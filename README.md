# CogniLint

CogniLint is a privacy-first, real-time AI code analyzer for Visual Studio Code. It
detects potential security vulnerabilities and high cyclomatic complexity while
providing suggested refactors through VS Code diagnostics and Quick Fix actions.

The primary analysis provider is a local Ollama server running
`gemma4:e4b`. When local analysis is unavailable, slow, or returns an unusable
response, CogniLint can optionally route the request to Google's Gemini
`gemini-3.8-flash` model as a fallback.

## Use cases

- Detect dangerous patterns such as dynamic code execution and unsafe input handling.
- Identify functions with excessive branching or cyclomatic complexity.
- Receive line-specific warnings directly in the editor.
- Apply model-generated, line-level refactoring suggestions through Quick Fixes.
- Keep source code local by default with Ollama.
- Continue analysis during local-model outages when an optional Gemini fallback is configured.

## Architecture

```text
┌──────────────────────────────┐
│        VS Code Extension     │
│                              │
│  Text document change event  │
│  2-second debounce            │
│  Diagnostics + Quick Fixes    │
└──────────────┬───────────────┘
               │ HTTP POST
               │ /analyze-code
               ▼
┌──────────────────────────────┐
│       FastAPI Backend        │
│                              │
│  Request validation           │
│  Provider routing             │
│  JSON sanitization            │
│  Response validation          │
└──────────────┬───────────────┘
               │
       ┌───────┴────────┐
       │                │
       ▼                ▼
┌──────────────┐  ┌──────────────┐
│ Ollama       │  │ Gemini       │
│ gemma4:e4b   │  │ 3.8-flash    │
│ Local-first  │  │ Optional     │
└──────────────┘  └──────────────┘
```

### Analysis flow

1. A source document changes in VS Code.
2. The extension waits two seconds before analyzing, preventing a request for
   every keystroke.
3. The extension sends the source code and language ID to the local FastAPI
   endpoint.
4. FastAPI sends a strict analysis prompt and JSON schema to Ollama.
5. If Ollama fails or returns invalid output, FastAPI tries Gemini when
   `GEMINI_API_KEY` is configured.
6. The backend sanitizes and validates the model result.
7. VS Code displays warning diagnostics on the reported lines.
8. A Quick Fix can replace the affected line with a safe, single-line suggestion.

## Project structure

```text
CogniLint/
├── backend/
│   ├── main.py                  # FastAPI API and model routing
│   ├── requirements.txt         # Runtime Python dependencies
│   ├── requirements-dev.txt     # Test dependencies
│   ├── .env.example             # Safe environment template
│   └── tests/
│       └── test_main.py         # Backend unit and fallback tests
├── extension/
│   ├── extension.ts             # VS Code extension implementation
│   ├── package.json             # Extension manifest and scripts
│   ├── tsconfig.json            # TypeScript configuration
│   └── .vscode/
│       └── launch.json          # Extension-folder debug configuration
├── .vscode/
│   ├── launch.json              # Repository-root debug configuration
│   └── tasks.json               # Root compile task
└── .gitignore                   # Secrets and generated files
```

## Technology stack

### Backend

- Python 3.14
- FastAPI
- Uvicorn
- HTTPX
- Pydantic
- python-dotenv
- Ollama REST API
- Gemini REST API

### VS Code extension

- TypeScript
- VS Code Extension API
- `vscode.DiagnosticCollection`
- `vscode.CodeActionProvider`
- Native `fetch`
- TypeScript compiler

## Model providers

### Local primary provider: Ollama

CogniLint first sends analysis requests to:

```text
http://localhost:11434/api/generate
```

with the model:

```text
gemma4:e4b
```

Ollama is the default provider so source code can remain on the developer's
machine.

### Optional fallback provider: Gemini

If Ollama times out, is unavailable, or produces invalid output, the backend
uses Google's Gemini API when configured:

```text
gemini-3.8-flash
```

Gemini fallback is opt-in and requires a local API key. Do not commit the key or
send it through chat.

## Requirements

- Windows, macOS, or Linux
- Python 3.11 or newer
- Node.js and npm
- Visual Studio Code
- Ollama
- The Ollama `gemma4:e4b` model
- Optional: a Gemini API key for remote fallback

## Installation

### 1. Install and prepare Ollama

Install Ollama, then download the configured model:

```powershell
ollama pull gemma4:e4b
```

Make sure Ollama is running on port `11434`.

### 2. Install backend dependencies

```powershell
cd backend

python -m venv .venv
.\.venv\Scripts\Activate.ps1

python -m pip install -r requirements.txt
```

For backend tests:

```powershell
python -m pip install -r requirements-dev.txt
```

### 3. Configure the optional Gemini fallback

Copy the template to `backend/.env` and edit it locally:

```env
GEMINI_API_KEY=your_gemini_api_key
GEMINI_MODEL=gemini-3.8-flash
OLLAMA_TIMEOUT_SECONDS=45
```

`backend/.env` is ignored by Git. Never commit credentials.

### 4. Install extension dependencies

```powershell
cd extension
npm install
npm run compile
```

## Run locally

### Start the backend

From the `backend` directory:

```powershell
python -m uvicorn main:app --host 127.0.0.1 --port 8000
```

The API is available at:

```text
http://127.0.0.1:8000
```

Interactive API documentation is available at:

```text
http://127.0.0.1:8000/docs
```

### Launch the extension

1. Open the repository root in VS Code.
2. Open the **Run and Debug** panel.
3. Select **Run CogniLint Extension**.
4. Press `F5` or click the green play button.
5. In the new Extension Development Host window, open a source file.

## Test the API manually

```powershell
$body = @{
  code = "user_input = input()`nresult = eval(user_input)"
  language = "python"
} | ConvertTo-Json

Invoke-RestMethod `
  -Uri http://127.0.0.1:8000/analyze-code `
  -Method Post `
  -ContentType "application/json" `
  -Body $body
```

Expected response shape:

```json
[
  {
    "line_number": 2,
    "issue_type": "vulnerability",
    "description": "Use of eval() on untrusted input can execute arbitrary code.",
    "suggested_refactor": "safe_parse(user_input)"
  }
]
```

## Test locally in VS Code

Create a file such as `test.py` in the Extension Development Host:

```python
user_input = input()
result = eval(user_input)
```

Save the file and wait two seconds. CogniLint should display a warning on the
second line. Hover over the warning and select:

```text
CogniLint: Apply suggested refactor
```

The extension validates backend responses, ignores stale results when the file
changes during analysis, preserves indentation, and only offers Quick Fixes for
non-empty single-line suggestions.

## Automated validation

Run backend tests:

```powershell
cd backend
python -m pytest tests -q
```

Build the extension:

```powershell
cd extension
npm run compile
```

## API contract

### Request

`POST /analyze-code`

```json
{
  "code": "source code as a string",
  "language": "python"
}
```

### Response

```json
[
  {
    "line_number": 1,
    "issue_type": "vulnerability",
    "description": "Issue description",
    "suggested_refactor": "Replacement line"
  }
]
```

`issue_type` must be either `vulnerability` or `complexity`.
`line_number` is one-based.

## Privacy and security

- Ollama is the default provider and runs locally.
- Gemini fallback sends source code to Google's API only when configured and
  when the local provider fails.
- Gemini credentials are loaded from environment variables or `backend/.env`.
- `.env` files, virtual environments, Python bytecode, extension dependencies,
  and compiled extension output are ignored by Git.
- Model output is validated before it reaches the editor.
- No API key should be committed to the repository.

## Current limitations

- Quick Fixes currently support safe single-line replacements.
- AI output quality depends on the selected model and available hardware.
- Complexity detection is model-based rather than a deterministic AST metric.
- The extension is currently run locally through an Extension Development Host
  and is not yet published to the VS Code Marketplace.

## Roadmap

- Add deterministic cyclomatic complexity calculations.
- Support structured multi-line refactoring ranges.
- Add configurable backend URL, timeout, and provider settings.
- Add richer provider status and loading indicators.
- Add extension integration tests.
- Package and publish the extension as a `.vsix`.
- Publish CogniLint to the VS Code Marketplace.

## License

The project license has not yet been selected.
