import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

interface WordDefinition {
    description?: string;
    example?: string;
    notes?: string;
    warning?: string;
    category?: string;
}

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

    // エラー（Diagnostics）が更新されたときもパネルを更新する
    context.subscriptions.push(
        vscode.languages.onDidChangeDiagnostics(async () => {
            if (vscode.window.activeTextEditor) {
                await provider.updateVariableInfo(vscode.window.activeTextEditor);
            }
        })
    );
}

class ProgrammingSupportViewProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private _definitions: Record<string, WordDefinition> = {};

    // 型キーワード自体を選択したときに、そのままキーとして扱う基本型の一覧
    private static readonly BASE_TYPE_KEYWORDS = new Set([
        'char', 'int', 'float', 'double', 'long', 'short',
        'unsigned', 'signed', 'void', 'bool', '_Bool'
    ]);

    constructor(private readonly _extensionUri: vscode.Uri) {
        this._loadDefinitions();
    }

    private _loadDefinitions(): void {
        const jsonPath = path.join(this._extensionUri.fsPath, 'keywords', 'c.json');

        // ← まずここをVSCodeの出力パネルで確認
        console.log('[ProgrammingSupport] c.json path:', jsonPath);
        console.log('[ProgrammingSupport] file exists:', fs.existsSync(jsonPath));

        if (fs.existsSync(jsonPath)) {
            try {
                const raw = fs.readFileSync(jsonPath, 'utf8');
                this._definitions = JSON.parse(raw);
                console.log('[ProgrammingSupport] loaded keys:', Object.keys(this._definitions));
            } catch (e) {
                console.error('[ProgrammingSupport] JSON parse error:', e);
                this._definitions = {};
            }
        } else {
            console.warn('[ProgrammingSupport] c.json not found');
        }
    }

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
        let definition: WordDefinition | null = null;

        if (this._isComment(lineText, position.character, editor.document, position)) {
            const trimmed = lineText.trim();
            const cleaned = trimmed
                .replace(/^\/\/\s*/, '')
                .replace(/^\/\*\s*/, '')
                .replace(/^\*\s*/, '')
                .replace(/\s*\*\/$/, '');
            word = cleaned.trim() || 'コメント内';
            typeInfo = 'コメント';
        } else if (range) {
            word = editor.document.getText(range);

            if (ProgrammingSupportViewProvider.BASE_TYPE_KEYWORDS.has(word)) {
                // "char" や "int" などの型キーワード自体を選択した場合は、
                // ホバー解析を経由せず単語そのものを型として扱う。
                // （ホバー内容の解析結果が declaration 全体になったりして
                // 　誤認識されるのを防ぐため）
                // ただし同じ行が「型 変数名[...]」の配列宣言になっている場合は
                // char[] のように配列であることが分かる形にする。
                const arrayDeclPattern = new RegExp(`\\b${word}\\b\\s+\\w+\\s*\\[`);
                typeInfo = arrayDeclPattern.test(lineText) ? `${word}[]` : word;
            } else {
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
        }

        console.log('[ProgrammingSupport] cursor word:', JSON.stringify(word));
        console.log('[ProgrammingSupport] typeInfo:', JSON.stringify(typeInfo));

        if (this._definitions[word]) {
            definition = this._definitions[word];
            console.log('[ProgrammingSupport] definition found by word:', definition);
        } 

        else if (typeInfo !== '情報なし') {
            let baseType = typeInfo.trim();

            if (baseType.includes('[') || baseType.includes(']')) {
                if (baseType.startsWith('char')) {
                    baseType = 'char[]';
                } else {
                    baseType = baseType.replace(/\s*\[\d*\]/g, '[]').trim();
                }
            } else {
                baseType = baseType.trim();
            }
            
            console.log('[ProgrammingSupport] normalized baseType for search:', JSON.stringify(baseType));

            if (this._definitions[baseType]) {
                definition = this._definitions[baseType];
                console.log('[ProgrammingSupport] definition found by type:', definition);
            }
        }

        if (!definition) {
            console.log('[ProgrammingSupport] no definition for word/type:', word, typeInfo);
        }

        const errorHint = this._checkMissingSemicolon(editor.document, position);

        this._view.webview.postMessage({
            type: 'update',
            word,
            typeInfo,
            line: position.line + 1,
            character: position.character + 1,
            definition,
            errorHint
        });
    }

    private _checkMissingSemicolon(document: vscode.TextDocument, position: vscode.Position): string | null {
        // 1. VS Code の Diagnostics (C/C++拡張機能などのエラー) から検出
        const diagnostics = vscode.languages.getDiagnostics(document.uri);
        for (const diag of diagnostics) {
            // カーソルがある行、またはその前後1行以内のエラーを対象にする
            if (Math.abs(diag.range.start.line - position.line) <= 1) {
                const msg = diag.message;
                if (
                    msg.includes("expected ';'") ||
                    msg.includes("expected a ';'") ||
                    msg.includes("';' が必要です")
                ) {
                    const errorLine = diag.range.start.line + 1;
                    const errorLineText = document.lineAt(diag.range.start.line).text.split('//')[0].trim();
                    if (errorLineText.endsWith(':')) {
                        return `${errorLine}行目の末尾がコロン（:）になっています。セミコロン（;）の間違いではありませんか？`;
                    }
                    return `${errorLine}行目付近でエラーが出ています。この行、または「1つ前の行」の末尾にセミコロン（;）を忘れていませんか？`;
                }
            }
        }

        // 2. 簡易的な静的解析（C/C++拡張機能が入っていない環境や、入力直後向けの補助チェック）
        const lineText = document.lineAt(position.line).text;
        const currentError = this._checkLineSemicolonError(lineText, document, position.line);
        if (currentError === 'colon') {
            return `${position.line + 1}行目の末尾がコロン（:）になっています。セミコロン（;）の間違いではありませんか？`;
        } else if (currentError === 'missing') {
            return `${position.line + 1}行目の末尾にセミコロン（;）がない可能性があります。`;
        }

        // カーソル行に問題がなくても、1つ前の行にミスがある可能性がある場合
        if (position.line > 0) {
            const prevLineText = document.lineAt(position.line - 1).text;
            const prevError = this._checkLineSemicolonError(prevLineText, document, position.line - 1);
            if (prevError === 'colon') {
                return `1つ上の行（${position.line}行目）の末尾がコロン（:）になっています。セミコロン（;）の間違いではありませんか？`;
            } else if (prevError === 'missing') {
                return `1つ上の行（${position.line}行目）の末尾にセミコロン（;）を忘れていませんか？`;
            }
        }

        return null;
    }

    private _checkLineSemicolonError(lineText: string, document: vscode.TextDocument, lineNumber: number): 'missing' | 'colon' | null {
        // 行末コメントを除去してトリム
        const withoutInlineComment = lineText.split('//')[0].trim();

        if (!withoutInlineComment) {
            return null; // 空行やコメントのみの行はスキップ
        }

        // ブロックコメント内ならスキップ
        if (this._isInsideBlockComment(document, new vscode.Position(lineNumber, withoutInlineComment.length))) {
            return null;
        }

        // プリプロセッサ指令 (#include, #define など) はセミコロン不要
        if (withoutInlineComment.startsWith('#')) {
            return null;
        }

        // すでにセミコロン、波括弧、カンマ、行継続バックスラッシュで終わっている場合はOK
        if (/[;{},\\]$/.test(withoutInlineComment)) {
            return null;
        }

        // case文、default文、ラベル宣言（識別子:）はコロンで終わるのが正常構文なので除外
        if (/^(case\s+[^:]+|default|[A-Za-z_]\w*)\s*:$/.test(withoutInlineComment)) {
            return null;
        }

        // if, for, while, switch, else などの制御構文は除外
        if (/^(if|for|while|switch)\s*\(.*\)$/.test(withoutInlineComment) || /^else\b/.test(withoutInlineComment)) {
            return null;
        }

        // 次の行が '{' で始まっていれば関数定義や制御構文とみなす
        if (lineNumber + 1 < document.lineCount) {
            const nextLine = document.lineAt(lineNumber + 1).text.trim();
            if (nextLine.startsWith('{')) {
                return null;
            }
        }

        // 代入文、関数呼び出し、return、break、変数宣言っぽい行であれば判定
        const statementPattern = /^(\b(return|break|continue)\b|.*\b(printf|scanf)\s*\(|.*=.*|\b(int|char|float|double|long|short|unsigned|signed|bool|_Bool)\b\s+\w+)/;
        if (!statementPattern.test(withoutInlineComment)) {
            return null;
        }

        // 末尾がコロン（:）で終わっている場合は「セミコロンの代わりにコロンが入力されている」ミス
        if (withoutInlineComment.endsWith(':')) {
            return 'colon';
        }

        return 'missing';
    }

    private _isComment(lineText: string, character: number, document: vscode.TextDocument, position: vscode.Position): boolean {
        const trimmed = lineText.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
            return true;
        }
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
        // 変数名の直後に配列の角括弧（例: message[14] や message[]）が
        // 続く場合も検出できるように、末尾のグループを追加でキャプチャする
        const typePattern = new RegExp(`^([\\s\\S]*?)\\s+${escapedWord}\\b\\s*(\\[[^\\]]*\\])?`, 'i');
        const wordInCode = targetText.match(typePattern);
        if (wordInCode) {
            let type = wordInCode[1].trim();
            if (wordInCode[2]) {
                // 配列として宣言されている場合は [] を付与して char と char[] を区別する
                type += '[]';
            }
            return type;
        }

        return targetText.split('\n')[0].replace(/[`#*]/g, '').trim() || undefined;
    }

    private _getHtmlForWebview(webview: vscode.Webview): string {
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