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

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(async (editor) => {
            if (editor) {
                await provider.updateVariableInfo(editor);
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
    private _updateRequestId = 0;

    // 型キーワード自体を選択したときに、そのままキーとして扱う基本型の一覧
    private static readonly BASE_TYPE_KEYWORDS = new Set([
        'char', 'int', 'float', 'double', 'long', 'short',
        'unsigned', 'signed', 'void', 'bool', '_Bool'
    ]);

    // 辞書検索時に除去する型修飾子・記憶クラス指定子
    private static readonly QUALIFIERS = new Set([
        'const', 'volatile', 'static', 'extern', 'register', 'restrict', 'inline'
    ]);

    // ローカル宣言フォールバック時に型名として誤認しないための制御・予約キーワード
    private static readonly NON_TYPE_KEYWORDS = new Set([
        'return', 'if', 'else', 'while', 'for', 'switch', 'case', 'default',
        'break', 'continue', 'goto', 'sizeof', 'do', 'typedef'
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

        webviewView.webview.onDidReceiveMessage(async (message) => {
            if (message?.type === 'ready' && vscode.window.activeTextEditor) {
                await this.updateVariableInfo(vscode.window.activeTextEditor);
            }
        });

        webviewView.onDidChangeVisibility(async () => {
            if (webviewView.visible && vscode.window.activeTextEditor) {
                await this.updateVariableInfo(vscode.window.activeTextEditor);
            }
        });

        webviewView.onDidDispose(() => {
            if (this._view === webviewView) {
                this._view = undefined;
            }
        });

        if (vscode.window.activeTextEditor) {
            void this.updateVariableInfo(vscode.window.activeTextEditor);
        }
    }

    public async updateVariableInfo(editor: vscode.TextEditor) {
        if (!this._view) {
            return;
        }

        const requestId = ++this._updateRequestId;
        const position = editor.selection.active;
        const document = editor.document;
        const lineText = document.lineAt(position.line).text;
        const range = document.getWordRangeAtPosition(position);

        let word = 'なし';
        let typeInfo = '情報なし';
        let definition: WordDefinition | null = null;

        const commentInfo = this._getCommentInfo(document, position);
        if (commentInfo.isComment) {
            word = commentInfo.text || 'コメント内';
            typeInfo = 'コメント';
        } else if (range) {
            word = document.getText(range);

            if (ProgrammingSupportViewProvider.BASE_TYPE_KEYWORDS.has(word)) {
                // "char" や "int" などの型キーワード自体を選択した場合は、
                // ホバー解析を経由せず複合型（unsigned int / long long 等）や配列宣言を判定する。
                typeInfo = this._resolveTypeKeywordAtPosition(lineText, position, word);
            } else {
                const hoverData = await vscode.commands.executeCommand<vscode.Hover[]>(
                    'vscode.executeHoverProvider',
                    document.uri,
                    position
                );

                // 後続のカーソル移動等で新しいリクエストが発行されていたら古い結果を破棄
                if (requestId !== this._updateRequestId) {
                    return;
                }

                if (hoverData && hoverData.length > 0) {
                    for (const hover of hoverData) {
                        const contents = hover.contents.map(c => {
                            if (typeof c === 'string') {
                                return c;
                            }
                            if ('language' in c && typeof c.value === 'string') {
                                return `\`\`\`${c.language}\n${c.value}\n\`\`\``;
                            }
                            return c.value;
                        }).join('\n');

                        const parsed = this._parseTypeInfo(contents, word);
                        if (parsed) {
                            typeInfo = parsed;
                            break;
                        }
                    }
                }

                // ホバーから取得できない場合（言語サーバー未準備・未導入時など）の簡易フォールバック
                if (typeInfo === '情報なし') {
                    typeInfo = this._findLocalDeclarationType(document, position, word) ?? '情報なし';
                }
            }
        }

        console.log('[ProgrammingSupport] cursor word:', JSON.stringify(word));
        console.log('[ProgrammingSupport] typeInfo:', JSON.stringify(typeInfo));

        // 型キーワード自体を選択した場合（例: char[]）は typeInfo 側を優先して辞書検索する
        const isTypeKeyword = ProgrammingSupportViewProvider.BASE_TYPE_KEYWORDS.has(word);
        if (!isTypeKeyword && this._definitions[word]) {
            definition = this._definitions[word];
            console.log('[ProgrammingSupport] definition found by word:', definition);
        } else if (typeInfo !== '情報なし') {
            const baseType = this._normalizeTypeForLookup(typeInfo);

            console.log('[ProgrammingSupport] normalized baseType for search:', JSON.stringify(baseType));

            if (this._definitions[baseType]) {
                definition = this._definitions[baseType];
                console.log('[ProgrammingSupport] definition found by type:', definition);
            }
        } else if (this._definitions[word]) {
            definition = this._definitions[word];
            console.log('[ProgrammingSupport] definition found by word:', definition);
        }

        if (!definition) {
            console.log('[ProgrammingSupport] no definition for word/type:', word, typeInfo);
        }

        const errorHint = this._checkMissingSemicolon(document, position);

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

    private _getCommentInfo(
        document: vscode.TextDocument,
        position: vscode.Position
    ): { isComment: boolean; text?: string } {
        const scan = this._scanUpToPosition(document, position);
        if (!scan.inBlockComment && !scan.inLineComment) {
            return { isComment: false };
        }

        const lineText = document.lineAt(position.line).text;
        if (scan.inLineComment && scan.lineCommentStartInLine !== null) {
            const text = lineText
                .slice(scan.lineCommentStartInLine)
                .replace(/^\/\/\s*/, '')
                .trim();
            return { isComment: true, text: text || 'コメント内' };
        }

        const start = scan.blockCommentStartInLine ?? 0;
        let segment = lineText.slice(start);
        if (segment.trimStart().startsWith('/*')) {
            segment = segment.trimStart().replace(/^\/\*\s*/, '');
        } else {
            segment = segment.replace(/^\s*\*\s?/, '');
        }

        const endIdx = segment.indexOf('*/');
        if (endIdx !== -1) {
            segment = segment.slice(0, endIdx);
        }

        return { isComment: true, text: segment.trim() || 'コメント内' };
    }

    private _isInsideBlockComment(document: vscode.TextDocument, position: vscode.Position): boolean {
        return this._scanUpToPosition(document, position).inBlockComment;
    }

    private _scanUpToPosition(
        document: vscode.TextDocument,
        position: vscode.Position
    ): {
        inBlockComment: boolean;
        inLineComment: boolean;
        blockCommentStartInLine: number | null;
        lineCommentStartInLine: number | null;
    } {
        let inBlockComment = false;

        for (let i = 0; i <= position.line; i++) {
            const line = document.lineAt(i).text;
            const isTargetLine = i === position.line;
            const limit = isTargetLine ? position.character : line.length;

            let inString = false;
            let inChar = false;
            let inLineComment = false;
            let blockCommentStartInLine: number | null = inBlockComment ? 0 : null;
            let lineCommentStartInLine: number | null = null;

            for (let j = 0; j < line.length; j++) {
                const ch = line[j];
                const next = line[j + 1];

                if (inBlockComment) {
                    if (ch === '*' && next === '/') {
                        if (isTargetLine && limit <= j + 1) {
                            return {
                                inBlockComment: true,
                                inLineComment: false,
                                blockCommentStartInLine,
                                lineCommentStartInLine: null
                            };
                        }
                        inBlockComment = false;
                        blockCommentStartInLine = null;
                        j++;
                        continue;
                    }
                    if (isTargetLine && j >= limit) {
                        return {
                            inBlockComment: true,
                            inLineComment: false,
                            blockCommentStartInLine,
                            lineCommentStartInLine: null
                        };
                    }
                    continue;
                }

                if (inLineComment) {
                    if (isTargetLine) {
                        return {
                            inBlockComment: false,
                            inLineComment: true,
                            blockCommentStartInLine: null,
                            lineCommentStartInLine
                        };
                    }
                    break;
                }

                if (inString) {
                    if (ch === '\\') {
                        j++;
                    } else if (ch === '"') {
                        inString = false;
                    }
                    if (isTargetLine && j >= limit) {
                        return {
                            inBlockComment: false,
                            inLineComment: false,
                            blockCommentStartInLine: null,
                            lineCommentStartInLine: null
                        };
                    }
                    continue;
                }

                if (inChar) {
                    if (ch === '\\') {
                        j++;
                    } else if (ch === '\'') {
                        inChar = false;
                    }
                    if (isTargetLine && j >= limit) {
                        return {
                            inBlockComment: false,
                            inLineComment: false,
                            blockCommentStartInLine: null,
                            lineCommentStartInLine: null
                        };
                    }
                    continue;
                }

                if (ch === '/' && next === '/') {
                    inLineComment = true;
                    lineCommentStartInLine = j;
                    if (isTargetLine && limit >= j) {
                        return {
                            inBlockComment: false,
                            inLineComment: true,
                            blockCommentStartInLine: null,
                            lineCommentStartInLine
                        };
                    }
                    break;
                }

                if (ch === '/' && next === '*') {
                    inBlockComment = true;
                    blockCommentStartInLine = j;
                    if (isTargetLine && limit === j) {
                        return {
                            inBlockComment: true,
                            inLineComment: false,
                            blockCommentStartInLine,
                            lineCommentStartInLine: null
                        };
                    }
                    j++;
                    continue;
                }

                if (isTargetLine && j >= limit) {
                    return {
                        inBlockComment: false,
                        inLineComment: false,
                        blockCommentStartInLine: null,
                        lineCommentStartInLine: null
                    };
                }

                if (ch === '"') {
                    inString = true;
                } else if (ch === '\'') {
                    inChar = true;
                }
            }

            if (isTargetLine) {
                return {
                    inBlockComment,
                    inLineComment,
                    blockCommentStartInLine,
                    lineCommentStartInLine
                };
            }
        }

        return {
            inBlockComment: false,
            inLineComment: false,
            blockCommentStartInLine: null,
            lineCommentStartInLine: null
        };
    }

    private _resolveTypeKeywordAtPosition(
        lineText: string,
        position: vscode.Position,
        word: string
    ): string {
        // コメントを除去してトークン位置を抽出する（文字列・ブロックコメント開始手前まで）
        const codePart = this._stripLineCommentsAndStrings(lineText);
        const tokenRegex = /[A-Za-z_]\w*/g;
        const tokens: Array<{ text: string; start: number; end: number }> = [];
        let m: RegExpExecArray | null;
        while ((m = tokenRegex.exec(codePart)) !== null) {
            tokens.push({ text: m[0], start: m.index, end: m.index + m[0].length });
        }

        const currentIdx = tokens.findIndex(
            t => position.character >= t.start && position.character <= t.end
        );
        if (currentIdx === -1) {
            return word;
        }

        // 前後に隣接する基本型キーワードを連結して複合型（unsigned int / long long 等）を組み立てる
        let left = currentIdx;
        while (left > 0 && ProgrammingSupportViewProvider.BASE_TYPE_KEYWORDS.has(tokens[left - 1].text)) {
            left--;
        }
        let right = currentIdx;
        while (right + 1 < tokens.length && ProgrammingSupportViewProvider.BASE_TYPE_KEYWORDS.has(tokens[right + 1].text)) {
            right++;
        }

        const compositeType = tokens.slice(left, right + 1).map(t => t.text).join(' ');
        const afterType = codePart.slice(tokens[right].end);

        // 型直後の宣言子が「識別子[...]」の場合のみ配列宣言とみなす（配列アクセス式やコメントでの誤爆を防止）
        if (/^\s*(?:\*\s*)*[A-Za-z_]\w*\s*\[/.test(afterType)) {
            return `${compositeType}[]`;
        }
        return compositeType;
    }

    private _stripLineCommentsAndStrings(lineText: string): string {
        let out = '';
        let inString = false;
        let inChar = false;
        for (let i = 0; i < lineText.length; i++) {
            const ch = lineText[i];
            const next = lineText[i + 1];
            if (inString) {
                out += ' ';
                if (ch === '\\') {
                    out += ' ';
                    i++;
                } else if (ch === '"') {
                    inString = false;
                }
                continue;
            }
            if (inChar) {
                out += ' ';
                if (ch === '\\') {
                    out += ' ';
                    i++;
                } else if (ch === '\'') {
                    inChar = false;
                }
                continue;
            }
            if (ch === '/' && next === '/') {
                break;
            }
            if (ch === '/' && next === '*') {
                const closeIdx = lineText.indexOf('*/', i + 2);
                if (closeIdx === -1) {
                    break;
                }
                out += ' '.repeat(closeIdx + 2 - i);
                i = closeIdx + 1;
                continue;
            }
            if (ch === '"') {
                inString = true;
                out += ' ';
                continue;
            }
            if (ch === '\'') {
                inChar = true;
                out += ' ';
                continue;
            }
            out += ch;
        }
        return out;
    }

    private _parseTypeInfo(contents: string, word: string): string | undefined {
        const normalized = contents.replace(/\r\n/g, '\n').trim();
        const escapedWord = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

        // すべてのコードブロックを順番に抽出し、ブロックがない場合は全文を対象にする
        const blocks: string[] = [];
        const blockRegex = /```(?:[^\n]*)\n([\s\S]*?)```/g;
        let matchBlock: RegExpExecArray | null;
        while ((matchBlock = blockRegex.exec(normalized)) !== null) {
            blocks.push(matchBlock[1].trim());
        }
        if (blocks.length === 0) {
            blocks.push(normalized);
        }

        // 関数ポインタ宣言: 例 `int (*fp)(int, int)`
        const funcPtrRegex = new RegExp(
            `^(.+?)\\(\\s*\\*\\s*\\b${escapedWord}\\b(?:\\s*\\[[^\\]]*\\])*\\s*\\)\\s*\\(([^)]*)\\)`
        );
        // 関数シグネチャ: 先頭が型・修飾子（または関数名のみ）で `word(...)` の形式
        const funcSigRegex = new RegExp(
            `^(?:(?:[A-Za-z_][\\w\\s\\*]*?)\\s+)?\\b${escapedWord}\\s*\\([^)]*\\)`
        );
        const declPattern = new RegExp(
            `^(.+?)\\s*(\\**)\\s*\\b${escapedWord}\\b\\s*(\\[[^\\]]*\\](?:\\s*\\[[^\\]]*\\])*)?`
        );

        for (const block of blocks) {
            for (const rawLine of block.split('\n')) {
                // C/C++拡張機能のホバー先頭に付く種別ラベルを除去
                const line = rawLine
                    .trim()
                    .replace(/^\((?:local variable|parameter|global variable|field|static|struct|enum)\)\s*/i, '');

                if (!line || line.startsWith('//') || line.startsWith('/*')) {
                    continue;
                }

                const funcPtrMatch = line.match(funcPtrRegex);
                if (funcPtrMatch) {
                    const retType = this._normalizePointerSpacing(funcPtrMatch[1].trim());
                    const params = funcPtrMatch[2].trim();
                    return `${retType} (*)(${params})`;
                }

                // 説明文中の `word(` 誤認を防ぐため、Cの関数シグネチャ構文のみを関数と判定
                if (funcSigRegex.test(line)) {
                    const prefix = line.slice(0, line.search(new RegExp(`\\b${escapedWord}\\s*\\(`))).trim();
                    const looksLikeDeclaration = !prefix || /^[A-Za-z_][\w\s\*]*$/.test(prefix);
                    if (looksLikeDeclaration) {
                        return '関数';
                    }
                }

                const match = line.match(declPattern);
                if (match) {
                    let type = this._normalizePointerSpacing(match[1].trim());
                    const stars = match[2] ?? '';
                    const brackets = match[3] ?? '';
                    if (stars) {
                        type += stars;
                    }
                    if (brackets) {
                        type += this._normalizeBrackets(brackets);
                    }
                    if (type) {
                        return type;
                    }
                }
            }
        }

        // clangd などの "Type: `int`" 形式に対応
        const typeLineMatch = normalized.match(/^Type:\s*`([^`]+)`/m);
        if (typeLineMatch) {
            return typeLineMatch[1].trim();
        }

        return undefined;
    }

    private _normalizePointerSpacing(typeText: string): string {
        return typeText.replace(/\s*(\*+)\s*/g, '$1').trim();
    }

    private _normalizeBrackets(bracketsText: string): string {
        const dims = bracketsText.match(/\[[^\]]*\]/g);
        return dims ? dims.map(() => '[]').join('') : '';
    }

    private _normalizeTypeForLookup(typeInfo: string): string {
        let base = typeInfo.trim();
        const isArray = base.includes('[') || base.includes(']');
        base = base.replace(/\s*\[[^\]]*\]/g, '').trim();

        const tokens = base
            .split(/\s+/)
            .filter(t => t.length > 0 && !ProgrammingSupportViewProvider.QUALIFIERS.has(t));
        const cleaned = tokens.join(' ');

        if (isArray) {
            return cleaned === 'char' ? 'char[]' : `${cleaned}[]`;
        }
        return cleaned;
    }

    private _findLocalDeclarationType(
        document: vscode.TextDocument,
        position: vscode.Position,
        word: string
    ): string | undefined {
        const cleanLines = this._stripCommentsAndStrings(document, position.line);
        const candidates = this._collectVisibleStatementsAndParams(cleanLines, position.line);

        for (const candidate of candidates) {
            const found = this._extractTypeFromDeclaration(candidate, word);
            if (found) {
                return found;
            }
        }
        return undefined;
    }

    private _stripCommentsAndStrings(document: vscode.TextDocument, maxLine: number): string[] {
        const result: string[] = [];
        let inBlockComment = false;

        for (let i = 0; i <= maxLine; i++) {
            const line = document.lineAt(i).text;
            let out = '';
            let inString = false;
            let inChar = false;

            for (let j = 0; j < line.length; j++) {
                const ch = line[j];
                const next = line[j + 1];

                if (inBlockComment) {
                    out += ' ';
                    if (ch === '*' && next === '/') {
                        out += ' ';
                        inBlockComment = false;
                        j++;
                    }
                    continue;
                }
                if (inString) {
                    out += ' ';
                    if (ch === '\\' && j + 1 < line.length) {
                        out += ' ';
                        j++;
                    } else if (ch === '"') {
                        inString = false;
                    }
                    continue;
                }
                if (inChar) {
                    out += ' ';
                    if (ch === '\\' && j + 1 < line.length) {
                        out += ' ';
                        j++;
                    } else if (ch === '\'') {
                        inChar = false;
                    }
                    continue;
                }
                if (ch === '/' && next === '/') {
                    break;
                }
                if (ch === '/' && next === '*') {
                    out += '  ';
                    inBlockComment = true;
                    j++;
                    continue;
                }
                if (ch === '"') {
                    inString = true;
                    out += ' ';
                    continue;
                }
                if (ch === '\'') {
                    inChar = true;
                    out += ' ';
                    continue;
                }
                out += ch;
            }
            result.push(out);
        }

        return result;
    }

    private _collectVisibleStatementsAndParams(cleanLines: string[], currentLine: number): string[] {
        // カーソル位置から先頭へ向かって {} の深さを追跡し、
        // 兄弟ブロックをスキップしながら現在のスコープ・親スコープ・関数仮引数を収集する
        const collected: string[] = [];
        let braceDepth = 0;
        let parenDepth = 0;
        let stmtChars: string[] = [];
        let expectParamList = false;
        let paramChars: string[] = [];
        let paramParenDepth = 0;

        const flushStmt = () => {
            const stmt = stmtChars.reverse().join('').trim();
            stmtChars = [];
            if (stmt) {
                collected.push(stmt);
            }
        };

        for (let lineIdx = currentLine; lineIdx >= 0; lineIdx--) {
            const line = cleanLines[lineIdx];
            for (let charIdx = line.length - 1; charIdx >= 0; charIdx--) {
                const ch = line[charIdx];

                if (expectParamList) {
                    if (/\s/.test(ch) && paramParenDepth === 0) {
                        continue;
                    }
                    if (ch === ')' && paramParenDepth === 0) {
                        paramParenDepth = 1;
                        continue;
                    }
                    if (paramParenDepth > 0) {
                        if (ch === ')') {
                            paramParenDepth++;
                        } else if (ch === '(') {
                            paramParenDepth--;
                            if (paramParenDepth === 0) {
                                const paramList = paramChars.reverse().join('').trim();
                                paramChars = [];
                                expectParamList = false;
                                for (const param of this._splitTopLevel(paramList, ',')) {
                                    if (param.trim()) {
                                        collected.push(param.trim());
                                    }
                                }
                                continue;
                            }
                        }
                        paramChars.push(ch);
                        continue;
                    }
                    // '{' の直前が ')' でなければ仮引数リストではない
                    expectParamList = false;
                }

                if (ch === '}') {
                    if (braceDepth === 0) {
                        flushStmt();
                    }
                    braceDepth++;
                    continue;
                }

                if (ch === '{') {
                    if (braceDepth > 0) {
                        braceDepth--;
                    } else {
                        // 外側のスコープへ抜ける: 直前にある仮引数リスト `(...)` を検査対象にする
                        flushStmt();
                        expectParamList = true;
                        paramChars = [];
                        paramParenDepth = 0;
                    }
                    continue;
                }

                if (braceDepth > 0) {
                    continue;
                }

                if (ch === ')') {
                    parenDepth++;
                } else if (ch === '(' && parenDepth > 0) {
                    parenDepth--;
                }

                if (ch === ';' && parenDepth === 0) {
                    flushStmt();
                    continue;
                }

                stmtChars.push(ch);
            }
            if (braceDepth === 0 && !expectParamList) {
                stmtChars.push(' ');
            } else if (expectParamList && paramParenDepth > 0) {
                paramChars.push(' ');
            }
        }

        flushStmt();
        return collected;
    }

    private _extractTypeFromDeclaration(declText: string, word: string): string | undefined {
        const escapedWord = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (!new RegExp(`\\b${escapedWord}\\b`).test(declText)) {
            return undefined;
        }

        // プリプロセッサ行は除外
        const trimmed = declText.trim();
        if (!trimmed || trimmed.startsWith('#')) {
            return undefined;
        }

        // 先頭の型指定子（修飾子・struct/enum/union・複合型・typedef名）を抽出
        const typeHeadRegex = new RegExp(
            `^((?:(?:const|volatile|static|extern|register|restrict|inline)\\s+)*` +
            `(?:(?:struct|enum|union)\\s+[A-Za-z_]\\w*` +
            `|(?:(?:unsigned|signed|long|short)\\s+)*(?:char|int|float|double|long|short|void|bool|_Bool)` +
            `|(?:unsigned|signed|long|short)` +
            `|[A-Za-z_]\\w*))` +
            `(?:\\s+|(?=\\*))([\\s\\S]+)$`
        );

        const headMatch = trimmed.match(typeHeadRegex);
        if (!headMatch) {
            return undefined;
        }

        const rawType = headMatch[1].replace(/\s+/g, ' ').trim();
        if (ProgrammingSupportViewProvider.NON_TYPE_KEYWORDS.has(rawType)) {
            return undefined;
        }

        const declaratorsPart = headMatch[2].trim();
        const declarators = this._splitTopLevel(declaratorsPart, ',');

        const funcPtrDeclRegex = new RegExp(
            `^\\(\\s*\\*\\s*\\b${escapedWord}\\b(?:\\s*\\[[^\\]]*\\])*\\s*\\)\\s*\\(([^)]*)\\)$`
        );
        const normalDeclRegex = new RegExp(
            `^(\\**)\\s*\\b${escapedWord}\\b\\s*(\\[[^\\]]*\\](?:\\s*\\[[^\\]]*\\])*)?$`
        );

        for (const decl of declarators) {
            const beforeInit = this._splitTopLevel(decl, '=')[0].trim();
            if (!beforeInit) {
                continue;
            }

            const funcPtrMatch = beforeInit.match(funcPtrDeclRegex);
            if (funcPtrMatch) {
                return `${rawType} (*)(${funcPtrMatch[1].trim()})`;
            }

            const normalMatch = beforeInit.match(normalDeclRegex);
            if (normalMatch) {
                let type = rawType;
                if (normalMatch[1]) {
                    type += normalMatch[1];
                }
                if (normalMatch[2]) {
                    type += this._normalizeBrackets(normalMatch[2]);
                }
                return type;
            }
        }

        return undefined;
    }

    private _splitTopLevel(text: string, delimiter: ',' | '='): string[] {
        const parts: string[] = [];
        let current = '';
        let parenDepth = 0;
        let bracketDepth = 0;
        let braceDepth = 0;

        for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            if (ch === '(') {
                parenDepth++;
            } else if (ch === ')' && parenDepth > 0) {
                parenDepth--;
            } else if (ch === '[') {
                bracketDepth++;
            } else if (ch === ']' && bracketDepth > 0) {
                bracketDepth--;
            } else if (ch === '{') {
                braceDepth++;
            } else if (ch === '}' && braceDepth > 0) {
                braceDepth--;
            } else if (ch === delimiter && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
                parts.push(current);
                current = '';
                if (delimiter === '=') {
                    // '=' は最初のトップレベル出現だけ分割すればよい
                    parts.push(text.slice(i + 1));
                    return parts;
                }
                continue;
            }
            current += ch;
        }
        parts.push(current);
        return parts;
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