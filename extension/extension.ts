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

    const issues = (await response.json()) as AnalysisIssue[];
    const documentDiagnostics = issues
      .filter(
        (issue) =>
          Number.isInteger(issue.line_number) &&
          issue.line_number >= 1 &&
          issue.line_number <= document.lineCount &&
          typeof issue.description === "string",
      )
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
      .filter((diagnostic) => diagnostic.source === "CogniLint" && typeof diagnostic.code === "string")
      .map((diagnostic) => {
        const action = new vscode.CodeAction(
          "CogniLint: Apply suggested refactor",
          vscode.CodeActionKind.QuickFix,
        );
        action.diagnostics = [diagnostic];
        action.isPreferred = true;
        action.edit = new vscode.WorkspaceEdit();
        action.edit.replace(document.uri, diagnostic.range, diagnostic.code as string);
        return action;
      });
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
