import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {createRequire} from 'node:module';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const require=createRequire(import.meta.url);
const {buildWindowsHelper}=require('../vendor/wwwhip/lib/build-windows-helper.js');

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const metadata = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const electron = JSON.parse(await fs.readFile(path.join(root, 'node_modules', 'electron', 'package.json'), 'utf8'));
const runtime = path.join(root, 'node_modules', 'electron', 'dist');
const dist = path.join(root, 'dist');
const output = path.join(dist, 'Codex-Sweatshop');
const installedVersion = (await fs.readFile(path.join(runtime, 'version'), 'utf8')).trim().replace(/^v/, '');
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('此发布脚本需要 Windows x64');
if (installedVersion !== electron.version) throw new Error('Electron 运行库版本不符，请运行 npm run setup:desktop');
await fs.access(path.join(runtime, 'electron.exe'));
const whipHelper=await buildWindowsHelper(path.join(root,'test-results','wwwhip-build-cache'));
// Only replace this named build directory, after verifying it stays inside dist.
if (path.relative(dist, output) !== 'Codex-Sweatshop') throw new Error('无效的发布路径');
await fs.mkdir(dist, { recursive: true });
await fs.rm(output, { recursive: true, force: true });
await fs.cp(runtime, output, { recursive: true });
const resources = path.join(output, 'resources');
await fs.rm(path.join(resources, 'default_app.asar'), { force: true });
const application = path.join(resources, 'app');
await fs.mkdir(application, { recursive: true });
for (const directory of ['desktop', 'src', 'public']) {
  await fs.cp(path.join(root, directory), path.join(application, directory), { recursive: true,
    filter:entry=>!['icon-source.png','icon-rounded.png'].includes(path.basename(entry)) });
}
const vendor=path.join(root,'vendor');
await fs.cp(vendor,path.join(application,'vendor'),{recursive:true,filter:entry=>!path.relative(vendor,entry).split(path.sep).some(part=>['test','test-output'].includes(part))});
await fs.copyFile(whipHelper,path.join(application,'vendor','wwwhip','native','OpenWhip.Input.exe'));
await fs.writeFile(path.join(application, 'package.json'), JSON.stringify({
  name: metadata.name, productName: metadata.productName, version: metadata.version,
  description: metadata.description, author: metadata.author, license:metadata.license, repository:metadata.repository, type: 'module', main: metadata.main,
}, null, 2) + '\n');
await fs.rename(path.join(output, 'electron.exe'), path.join(output, 'Codex Sweatshop.exe'));
for(const executable of [path.join(output,'Codex Sweatshop.exe'),path.join(application,'vendor/wwwhip/native/OpenWhip.Input.exe')]) {
  const result=await promisify(execFile)('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',
    path.join(root,'scripts/stamp-windows-icon.ps1'),'-Executable',executable,'-Icon',path.join(root,'desktop/icon.ico')],
    {cwd:root,windowsHide:true,timeout:30000});
  process.stdout.write(result.stdout);
}
try {
  await fs.rename(path.join(output, 'electron_wer.dll'), path.join(output, 'Codex Sweatshop_wer.dll'));
} catch (error) { if (error.code !== 'ENOENT') throw error; }
await fs.copyFile(path.join(root, 'README.md'), path.join(output, 'README.md'));
await fs.copyFile(path.join(runtime,'LICENSE'),path.join(output,'LICENSE.electron.txt'));
await fs.copyFile(path.join(root, 'LICENSE'), path.join(output, 'LICENSE'));
await fs.writeFile(path.join(output, '使用说明.txt'), '双击 Codex Sweatshop.exe 启动。请保留整个目录，不要单独移动 exe。\r\n关闭窗口后在系统托盘继续运行；从托盘菜单退出。\r\n自动连接本机已登录的 Codex，新任务先待编排，安排后到期自动执行。\r\nMarkdown 文件关联持续跟随原文件修改，执行前读取最新内容。\r\n机器需保持开机、唤醒和联网。\r\n');
console.log(`已生成桌面应用：${path.join(output, 'Codex Sweatshop.exe')}`);
