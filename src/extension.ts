import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
    const provider = new ProgrammingSupportViewProvider(context.extensionUri);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('programming-support-view', provider)
    );

    // カーソル位置が変わった時にWebviewへ通知するイベントリスナー
    context.subscriptions.push(
        vscode.window.onDidChangeTextEditorSelection((e) => {
            if (e.textEditor === vscode.window.activeTextEditor) {
                provider.updateVariableInfo(e.textEditor);
            }
        })
    );
}

class ProgrammingSupportViewProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;

    constructor(private readonly _extensionUri: vscode.Uri) {}

    public resolveWebviewView(webviewView: vscode.WebviewView) {
        this._view = webviewView; // ビューへの参照を保存しておく

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);
    }

    // カーソル位置の単語を取得してWebviewに送るメソッド
    public updateVariableInfo(editor: vscode.TextEditor) {
        if (!this._view) return;

        const position = editor.selection.active;
        const range = editor.document.getWordRangeAtPosition(position);
        const word = range ? editor.document.getText(range) : 'なし';

        // Webviewにメッセージを送信
        this._view.webview.postMessage({
            type: 'updateVariable',
            name: word,
            line: position.line + 1, // 行番号（1始まりにする）
            character: position.character + 1
        });
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        return `
            <!DOCTYPE html>
            <html lang="ja">
            <head>
                <meta charset="UTF-8">
                <style>
                    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 10px; }
                    .label { color: var(--vscode-descriptionForeground); font-size: 0.8em; }
                    .value { font-weight: bold; margin-bottom: 10px; font-family: var(--vscode-editor-font-family); }
                    .container { border-left: 2px solid var(--vscode-button-background); padding-left: 10px; }
                </style>
            </head>
            <body>
                <h3>変数情報</h3>
                <div class="container">
                    <div class="label">名前:</div>
                    <div id="var-name" class="value">-</div>
                    <div class="label">位置:</div>
                    <div id="var-pos" class="value">-</div>
                </div>

                <script>
                    const varName = document.getElementById('var-name');
                    const varPos = document.getElementById('var-pos');

                    // 拡張機能からのメッセージを受け取る
                    window.addEventListener('message', event => {
                        const message = event.data;
                        if (message.type === 'updateVariable') {
                            varName.textContent = message.name;
                            varPos.textContent = 'L' + message.line + ':C' + message.character;
                        }
                    });
                </script>
            </body>
            </html>`;
    }
}