import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const supplied = name => {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} 缺少路径`);
  return path.resolve(value);
};
const packaged = supplied('--exe');
const executable = packaged ?? path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const output = supplied('--smoke-output') ?? path.join(root, 'test-results', packaged ? 'schedule-packaged.png' : 'schedule.png');
const args = [...(packaged ? [] : [root]), '--schedule-test', '--smoke-output', output];
await fs.access(executable);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(executable, args, { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '', stderr = '', timedOut = false;
const timer = setTimeout(() => { timedOut = true; child.kill(); }, 90_000);
const code = await new Promise((resolve, reject) => {
  child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-100_000); });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16_000); });
  child.on('error', reject);
  child.on('close', resolve);
}).finally(() => clearTimeout(timer));

const messages = stdout.trim().split(/\r?\n/).flatMap(line => {
  try { return [JSON.parse(line)]; } catch { return []; }
});
const directories = new Set(messages.flatMap(message => [message.smokeDirectory, message.smokeCleanup?.smokeDirectory]).filter(Boolean));
for (const directory of directories) {
  // Only this child's independently created profile may be removed after native exit.
  if (!path.isAbsolute(directory) || path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir())
    || !/^codex-sweatshop-smoke-[A-Za-z0-9]+$/.test(path.basename(directory))) throw new Error('日程检查临时目录校验失败');
  await fs.rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
if (stdout.trim()) console.log(stdout.trim());
const reports = messages.filter(message => message.smokeTest && message.scheduleTests);
const report = reports[0];
if (code !== 0 || timedOut || reports.length !== 1 || report.scheduleTests.passed.length < 28
  || report.schedulerEnabled !== true || report.codexAttempts !== 0 || report.rendererErrors.length !== 0
  || report.connected !== false || report.tasks !== 5) {
  if (stderr.trim()) console.error(stderr.trim());
  throw new Error(timedOut ? '日程界面检查超时' : `日程界面检查失败（退出码 ${code}）`);
}
