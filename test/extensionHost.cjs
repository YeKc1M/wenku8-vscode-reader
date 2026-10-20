const assert = require('node:assert/strict');
const vscode = require('vscode');
exports.run = async () => {
 const ext = vscode.extensions.getExtension('local-reader.wenku8-vscode-reader');
 assert.ok(ext, 'extension discovered');
 await vscode.commands.executeCommand('wenku8.open');
 assert.equal(ext.isActive, true, 'command automatically activates extension');
 const api = ext.exports;
 const commands = await vscode.commands.getCommands(true);
 for (const id of ['wenku8.open','wenku8.addBook','wenku8.connectBrowser','wenku8.hide']) assert.ok(commands.includes(id), id);
 await vscode.commands.executeCommand('wenku8.open');
 assert.equal(api.isOpen(), true);
 await vscode.commands.executeCommand('wenku8.hide');
 await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
 assert.equal(api.isOpen(), false);
 console.log('WENKU8_EXTENSION_HOST_SMOKE_PASSED');
};
