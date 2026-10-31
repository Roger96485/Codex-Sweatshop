import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const supplied = name => {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  if (!process.argv[index + 1] || process.argv[index + 1].startsWith('--')) throw new Error(`${name} 缺少路径`);
  return path.resolve(process.argv[index + 1]);
};
const packaged = supplied('--exe');
const executable = packaged ?? path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const output = supplied('--smoke-output') ?? path.join(root, 'test-results', packaged ? 'desktop-packaged.png' : 'desktop.png');
const args = [...(packaged ? [] : [root]), '--smoke-test', '--smoke-output', output];
await fs.access(executable);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(executable, args, { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '', stderr = '', timedOut = false;
const timer = setTimeout(() => { timedOut = true; child.kill(); }, 45_000);
const result = await new Promise((resolve, reject) => {
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16000); });
  child.on('error', reject);
  child.on('close', code => resolve(code));
}).finally(() => clearTimeout(timer));
const messages = stdout.trim().split(/\r?\n/).flatMap(line => {
  try { return [JSON.parse(line)]; } catch { return []; }
});
const reports = messages.filter(report => report.smokeTest);
const directories = new Set(messages.flatMap(report => [report.smokeDirectory,report.smokeCleanup?.smokeDirectory]).filter(Boolean));
for (const directory of directories) {
  // Chromium holds its profile open until Electron exits; cleanup belongs to this parent.
  if (directory && path.isAbsolute(directory)
    && path.dirname(path.resolve(directory)) === path.resolve(os.tmpdir())
    && /^codex-sweatshop-smoke-[A-Za-z0-9]+$/.test(path.basename(directory))) {
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}
if (stdout.trim()) console.log(stdout.trim());
const report = reports[0];
if (result !== 0 || timedOut || reports.length !== 1 || report.schedulerEnabled !== true
  || report.codexAttempts !== 0 || report.rendererErrors.length !== 0 || report.connected !== false || report.tasks !== 0) {
  if (stderr.trim()) console.error(stderr.trim());
  throw new Error(timedOut ? '桌面检查超时' : `桌面检查失败（退出码 ${result}）`);
}
