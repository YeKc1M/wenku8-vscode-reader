const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wenku8-live-'));
fs.mkdirSync(path.join(profile,'User'),{recursive:true});
fs.writeFileSync(path.join(profile,'User/settings.json'),JSON.stringify({'update.mode':'none','extensions.autoUpdate':false,'telemetry.telemetryLevel':'off','workbench.startupEditor':'none','chat.disableAIFeatures':true}));
const executable = process.env.VSCODE_EXECUTABLE || (process.platform === 'darwin' ? '/Applications/Visual Studio Code.app/Contents/MacOS/Code' : process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA, 'Programs/Microsoft VS Code/Code.exe') : 'code');
const child = spawn(executable, [
  `--user-data-dir=${profile}`, `--extensions-dir=${path.join(profile, 'extensions')}`,
  `--extensionDevelopmentPath=${root}`, `--extensionTestsPath=${path.join(root, 'test/nativeLiveHost.cjs')}`,
  '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--disable-extensions'
], { cwd: root, env: process.env });
let output = '';
child.stdout.on('data', chunk => { output += chunk; });
child.stderr.on('data', chunk => { output += chunk; });
child.on('error', error => { console.error(error.message); process.exitCode = 1; fs.rmSync(profile,{recursive:true,force:true}); });
child.on('close', code => {
  fs.mkdirSync(path.join(root, 'artifacts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'artifacts/native-live-0.5.0.log'), output);
  const passed = output.match(/NATIVE_LIVE_PASSED (.+)/);
  if (passed) console.log(passed[0]);
  else { console.error(`VS Code real-site test failed (${code}). See artifacts/native-live-0.5.0.log.`); process.exitCode = 1; }
  fs.rmSync(profile, { recursive: true, force: true });
});
