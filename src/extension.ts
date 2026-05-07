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
}

// このメソッドは拡張機能がデアクティベートされたときに呼ばれます
export function deactivate() {}
