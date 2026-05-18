import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export function activate(context: vscode.ExtensionContext) {
    const provider = new ProgrammingSupportViewProvider(context.extensionUri);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('programming-support-view', provider)
    );

    context.subscriptions.push(
        vscode.window.onDidChangeTextEditorSelection(async (e) => {
            if (e.textEditor === vscode.window.activeTextEditor) {
                await provider.updateVariableInfo(e.textEditor);
            }
        })
    );
}

class ProgrammingSupportViewProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;

    constructor(private readonly _extensionUri: vscode.Uri) { }

    public resolveWebviewView(webviewView: vscode.WebviewView) {
        this._view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };
        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);
    }

    public async updateVariableInfo(editor: vscode.TextEditor) {
        if (!this._view) {
            return;
        }

        const position = editor.selection.active;
        const lineText = editor.document.lineAt(position.line).text;
        const range = editor.document.getWordRangeAtPosition(position);

        let word = 'なし';
        let typeInfo = '情報なし';

        if (this._isComment(lineText, position.character, editor.document, position)) {
            word = (range ? editor.document.getText(range) : '') || 'コメント内';
            typeInfo = 'コメント';
        } else if (range) {
            word = editor.document.getText(range);

            const hoverData = await vscode.commands.executeCommand<vscode.Hover[]>(
                'vscode.executeHoverProvider',
                editor.document.uri,
                position
            );

            if (hoverData && hoverData.length > 0) {
                const contents = hoverData[0].contents.map(c => {
                    if (typeof c === 'string') {
                        return c;
                    }
                    return (c as vscode.MarkdownString).value;
                }).join('\n');

                typeInfo = this._parseTypeInfo(contents, word) ?? '情報なし';
            }
        }

        this._view.webview.postMessage({
            type: 'update',
            word,
            typeInfo,
            line: position.line + 1,
            character: position.character + 1
        });
    }

    private _isComment(lineText: string, character: number, document: vscode.TextDocument, position: vscode.Position): boolean {
        const trimmed = lineText.trim();
        // 行全体がコメント記号で始まる場合
        if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
            return true;
        }
        // カーソル位置より前に // がある場合
        const inlineCommentIdx = lineText.indexOf('//');
        if (inlineCommentIdx !== -1 && character >= inlineCommentIdx) {
            return true;
        }
        if (this._isInsideBlockComment(document, position)) {
            return true;
        }
        return false;
    }

private _isInsideBlockComment(document: vscode.TextDocument, position: vscode.Position): boolean {
    let inBlock = false;
    for (let i = 0; i <= position.line; i++) {
        const line = document.lineAt(i).text;
        const checkTo = i === position.line ? position.character : line.length;
        for (let j = 0; j < checkTo - 1; j++) {
            if (!inBlock && line[j] === '/' && line[j + 1] === '*') {
                inBlock = true;
                j++;
            } else if (inBlock && line[j] === '*' && line[j + 1] === '/') {
                inBlock = false;
                j++;
            }
        }
    }
    return inBlock;
}

    private _parseTypeInfo(contents: string, word: string): string | undefined {
        const normalized = contents.replace(/\r\n/g, '\n').trim();
        const codeBlockMatch = normalized.match(/```(?:[^\n]*)\n([\s\S]*?)```/);
        let targetText = codeBlockMatch ? codeBlockMatch[1].trim() : normalized;

        const castMatch = targetText.match(/^\(([^)]+)\)/);
        if (castMatch) {
            return castMatch[1].trim();
        }

        const escapedWord = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const typePattern = new RegExp(`^([\\s\\S]*?)\\s+${escapedWord}\\b`, 'i');
        const wordInCode = targetText.match(typePattern);
        if (wordInCode) {
            return wordInCode[1].trim();
        }

        return targetText.split('\n')[0].replace(/[`#*]/g, '').trim() || undefined;
    }

    private _getHtmlForWebview(webview: vscode.Webview): string {
        // mediaフォルダがプロジェクト直下にあることを想定
        const htmlPath = path.join(this._extensionUri.fsPath, 'media', 'webview.html');

        if (!fs.existsSync(htmlPath)) {
            return `<html><body>Error: HTML file not found at ${htmlPath}</body></html>`;
        }

        let html = fs.readFileSync(htmlPath, 'utf8');
        const nonce = this._getNonce();
        html = html.replace(/{{nonce}}/g, nonce);
        return html;
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