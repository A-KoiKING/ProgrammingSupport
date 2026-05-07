// モジュール 'vscode' には VS Code 拡張機能 API が含まれています
// モジュールをインポートし、以下のコードで vscode というエイリアスで参照します
import * as vscode from 'vscode';

// このメソッドは拡張機能がアクティベートされたときに呼ばれます
// 拡張機能は初めてコマンドが実行されるときにアクティベートされます
export function activate(context: vscode.ExtensionContext) {

	// コンソールを使用して診断情報 (console.log) とエラー (console.error) を出力します
	// このコード行は拡張機能がアクティベートされたときに 1 回だけ実行されます
	console.log('Congratulations, your extension "programmingsupport" is now active!');

	// コマンドは package.json ファイルで定義されています
	// 次に registerCommand でコマンドの実装を提供します
	// commandId パラメーターは package.json の command フィールドと一致する必要があります
	const disposable = vscode.commands.registerCommand('programmingsupport.helloWorld', () => {
		// ここに配置したコードは、コマンドが実行されるたびに実行されます
		// ユーザーにメッセージ ボックスを表示します
		vscode.window.showInformationMessage('Hello World from ProgrammingSupport!');
	});

	context.subscriptions.push(disposable);

	// Webviewビューのプロバイダーを登録
    const provider = new ProgrammingSupportViewProvider(context.extensionUri);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('programming-support-view', provider)
    );
}

class ProgrammingSupportViewProvider implements vscode.WebviewViewProvider {
    constructor(private readonly _extensionUri: vscode.Uri) {}

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        webviewView.webview.options = {
            enableScripts: true, // スクリプトを有効にする
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        return `
            <!DOCTYPE html>
            <html lang="ja">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <style>
                    body { font-family: sans-serif; padding: 10px; }
                    button { width: 100%; padding: 5px; cursor: pointer; }
                </style>
                <title>Support</title>
            </head>
            <body>
                <h3>Support Dashboard</h3>
                <p>プログラミングをサポートします</p>
                <button id="btn">Hello</button>
                <script>
                    const vscode = acquireVsCodeApi();
                    document.getElementById('btn').addEventListener('click', () => {
                        vscode.postMessage({ command: 'alert', text: 'Hello from Webview!' });
                    });
                </script>
            </body>
            </html>`;
    }
}

// このメソッドは拡張機能がデアクティベートされたときに呼ばれます
export function deactivate() {}
