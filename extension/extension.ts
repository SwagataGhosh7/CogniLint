import * as vscode from "vscode";

const BACKEND_URL = "http://localhost:8000/analyze-code";
const ANALYSIS_DELAY_MS = 2000;
const diagnostics = vscode.languages.createDiagnosticCollection("cognilint");
const timers = new Map<string, ReturnType<typeof setTimeout>>();

interface AnalysisIssue {
  line_number: number;
  issue_type: "vulnerability" | "complexity";
  description: string;
  suggested_refactor: string;
}

function isAnalysisIssue(value: unknown): value is AnalysisIssue {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const issue = value as Record<string, unknown>;
  return (
    typeof issue.line_number === "number" &&
    Number.isInteger(issue.line_number) &&
    issue.line_number >= 1 &&
    (issue.issue_type === "vulnerability" || issue.issue_type === "complexity") &&
    typeof issue.description === "string" &&
    typeof issue.suggested_refactor === "string"
  );
}

function getSafeReplacement(document: vscode.TextDocument, diagnostic: vscode.Diagnostic): string | undefined {
  if (typeof diagnostic.code !== "string" || diagnostic.code.trim().length === 0) {
    return undefined;
  }

  const suggestion = diagnostic.code.trim();
  if (suggestion.includes("\n") || suggestion.includes("\r")) {
    return undefined;
  }

  const sourceLine = document.lineAt(diagnostic.range.start.line).text;
  const indentation = sourceLine.match(/^\s*/)?.[0] ?? "";
  return `${indentation}${suggestion}`;
}

function scheduleAnalysis(document: vscode.TextDocument): void {
  const key = document.uri.toString();
  const previousTimer = timers.get(key);
  if (previousTimer) {
    clearTimeout(previousTimer);
  }

  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key);
      void analyzeDocument(document);
    }, ANALYSIS_DELAY_MS),
  );
}

async function analyzeDocument(document: vscode.TextDocument): Promise<void> {
  if (document.uri.scheme !== "file" || document.isClosed) {
    return;
  }

  const documentVersion = document.version;

  try {
    const response = await fetch(BACKEND_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: document.getText(),
        language: document.languageId,
      }),
    });

    if (!response.ok) {
      throw new Error(`Backend returned HTTP ${response.status}`);
    }

    const responseBody: unknown = await response.json();
    if (!Array.isArray(responseBody) || !responseBody.every(isAnalysisIssue)) {
      throw new Error("Backend returned an invalid analysis response");
    }

    if (document.isClosed || document.version !== documentVersion) {
      return;
    }

    const issues = responseBody;
    const documentDiagnostics = issues
      .filter((issue) => issue.line_number <= document.lineCount)
      .map((issue) => {
        const line = issue.line_number - 1;
        const range = document.lineAt(line).range;
        const diagnostic = new vscode.Diagnostic(
          range,
          `[${issue.issue_type}] ${issue.description}`,
          vscode.DiagnosticSeverity.Warning,
        );
        diagnostic.source = "CogniLint";
        diagnostic.code = issue.suggested_refactor;
        return diagnostic;
      });
    diagnostics.set(document.uri, documentDiagnostics);
  } catch (error) {
    diagnostics.delete(document.uri);
    const message = error instanceof Error ? error.message : "Unknown analysis error";
    vscode.window.setStatusBarMessage(`CogniLint: ${message}`, 5000);
  }
}

class RefactorCodeActionProvider implements vscode.CodeActionProvider {
  provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    return context.diagnostics
      .filter((diagnostic) => diagnostic.source === "CogniLint")
      .map((diagnostic) => {
        const replacement = getSafeReplacement(document, diagnostic);
        if (!replacement) {
          return undefined;
        }

        const action = new vscode.CodeAction(
          "CogniLint: Apply suggested refactor",
          vscode.CodeActionKind.QuickFix,
        );
        action.diagnostics = [diagnostic];
        action.isPreferred = true;
        action.edit = new vscode.WorkspaceEdit();
        action.edit.replace(document.uri, diagnostic.range, replacement);
        return action;
      })
      .filter((action): action is vscode.CodeAction => action !== undefined);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    diagnostics,
    vscode.workspace.onDidChangeTextDocument((event) => scheduleAnalysis(event.document)),
    vscode.workspace.onDidCloseTextDocument((document) => {
      const timer = timers.get(document.uri.toString());
      if (timer) {
        clearTimeout(timer);
        timers.delete(document.uri.toString());
      }
      diagnostics.delete(document.uri);
    }),
    vscode.commands.registerCommand("cognilint.analyzeDocument", () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        return analyzeDocument(editor.document);
      }
    }),
    vscode.languages.registerCodeActionsProvider(
      { scheme: "file" },
      new RefactorCodeActionProvider(),
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
    ),
  );
}

export function deactivate(): void {
  for (const timer of timers.values()) {
    clearTimeout(timer);
  }
  timers.clear();
}
