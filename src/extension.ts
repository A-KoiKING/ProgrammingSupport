import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

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
    // Webviewへの参照を保持するためのプロパティを追加
    private _view?: vscode.WebviewView;

    constructor(private readonly _extensionUri: vscode.Uri) {}

    public resolveWebviewView(webviewView: vscode.WebviewView) {
        // 表示されたWebviewをプロパティに保存
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        // HTMLファイルを読み込んでセットする
        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);
    }

    // エラーが出ていたメソッドをここに追加
    public updateVariableInfo(editor: vscode.TextEditor) {
        if (!this._view) {
            return; // ビューが表示されていない場合は何もしない
        }

        const position = editor.selection.active;
        const range = editor.document.getWordRangeAtPosition(position);
        const word = range ? editor.document.getText(range) : 'なし';

        // Webviewにメッセージを送信
        this._view.webview.postMessage({
            type: 'updateVariable',
            name: word,
            line: position.line + 1,
            character: position.character + 1
        });
    }

    private _getHtmlForWebview(webview: vscode.Webview): string {
        const htmlPath = vscode.Uri.joinPath(this._extensionUri, 'media', 'webview.html');
        return fs.readFileSync(htmlPath.fsPath, 'utf8');
    }
}