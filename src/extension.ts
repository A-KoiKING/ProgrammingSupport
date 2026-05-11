import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
    const provider = new ProgrammingSupportViewProvider(context.extensionUri);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('programming-support-view', provider)
    );

    // カーソル位置が変わった時に情報を更新
    context.subscriptions.push(
        vscode.window.onDidChangeTextEditorSelection(async (e) => {
            if (e.textEditor === vscode.window.activeTextEditor) {
                await provider.updateVariableInfo(e.textEditor);
            }
        })
    );

    // アクティブエディタが切り替わった時にも情報を更新
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(async (editor) => {
            if (editor) {
                await provider.updateVariableInfo(editor);
            }
        })
    );
}

class ProgrammingSupportViewProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;

    constructor(private readonly _extensionUri: vscode.Uri) {}

    public resolveWebviewView(webviewView: vscode.WebviewView) {
        this._view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };
        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);
    }

    /**
     * カーソル位置の単語とその型情報を取得してWebviewに送信
     */
    public async updateVariableInfo(editor: vscode.TextEditor) {
        if (!this._view) return;

        const position = editor.selection.active;
        const range = editor.document.getWordRangeAtPosition(position);

        let word = 'なし';
        let typeInfo = '情報なし';

        if (range) {
            word = editor.document.getText(range);

            const hoverData = await vscode.commands.executeCommand<vscode.Hover[]>(
                'vscode.executeHoverProvider',
                editor.document.uri,
                position
            );

            if (hoverData && hoverData.length > 0) {
                const contents = hoverData[0].contents.map(c => {
                    if (typeof c === 'string') return c;
                    return (c as vscode.MarkdownString).value;
                }).join('\n');

                typeInfo = this._parseTypeInfo(contents, word) ?? '情報なし';
            }
        }

        this._view.webview.postMessage({
            type: 'update',
            word,
            typeInfo
        });
    }

    private _parseTypeInfo(contents: string, word: string): string | undefined {
        const normalized = contents.replace(/\r\n/g, '\n');
        const cleanContents = normalized.replace(/```[\s\S]*?```/g, match => match.replace(/\n/g, '\n'));

        const directiveMatch = cleanContents.match(/(?:type|Type|型)\s*[:=]\s*([A-Za-z_][A-Za-z0-9_\s\*:&<>,\[\]]*)/);
        if (directiveMatch) {
            return directiveMatch[1].trim();
        }

        const codeBlockMatch = normalized.match(/```(?:[^\n]*)\n([\s\S]*?)```/);
        const haystack = codeBlockMatch ? codeBlockMatch[1] : normalized;

        const escapedWord = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const typePattern = new RegExp(
            `(?:^|[\n\r])\s*([A-Za-z_][A-Za-z0-9_\s:\*<&>,\[\]]*?)\s+${escapedWord}\b`,
            'i'
        );
        const match = haystack.match(typePattern);
        if (match) {
            return match[1].trim();
        }

        const simpleTypeMatch = cleanContents.match(/(?:^|[\n\r])\s*(unsigned\s+)?(long\s+long|long|short|int|char|float|double|bool|void|auto|size_t|ssize_t)\b/i);
        if (simpleTypeMatch) {
            return simpleTypeMatch[0].trim();
        }

        const firstLine = normalized.split(/[\n\r]/)[0].trim();
        return firstLine || undefined;
    }

    private _getHtmlForWebview(webview: vscode.Webview): string {
        const nonce = this._getNonce();
        return `<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            margin: 0;
            padding: 16px;
            color: #d4d4d4;
            background-color: #1e1e1e;
        }
        h2 {
            margin: 0 0 8px 0;
            font-size: 1rem;
            color: #9cdcfe;
        }
        .card {
            padding: 12px;
            border: 1px solid #444;
            border-radius: 8px;
            background: #252526;
        }
        .label {
            font-size: 0.85rem;
            color: #9cdcfe;
            margin-bottom: 4px;
            display: block;
        }
        .value {
            font-size: 1rem;
            color: #d4d4d4;
            word-break: break-word;
        }
    </style>
    <title>Programming Support</title>
</head>
<body>
    <div class="card">
        <div>
            <span class="label">選択中の単語</span>
            <div id="word" class="value">なし</div>
        </div>
        <div style="margin-top: 16px;">
            <span class="label">型情報</span>
            <div id="typeInfo" class="value">情報なし</div>
        </div>
    </div>
    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        window.addEventListener('message', event => {
            const message = event.data;
            if (message.type === 'update') {
                document.getElementById('word').textContent = message.word;
                document.getElementById('typeInfo').textContent = message.typeInfo;
            }
        });
    </script>
</body>
</html>`;
    }

    private _getNonce(): string {
        let text = '';
        const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        for (let i = 0; i < 16; i++) {
            text += possible.charAt(Math.floor(Math.random() * possible.length));
        }
        return text;
    }
}
