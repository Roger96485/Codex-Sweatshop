import { app, BrowserWindow, Menu, Tray, nativeTheme, dialog, ipcMain, clipboard, shell } from 'electron';
import {elicitationUrl} from '../public/elicitation.mjs';
import fs from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server.mjs';
import { redact } from '../src/codex.mjs';
import { readPromptFile } from '../src/prompt-files.mjs';
import {createWhipRuntime} from './wwwhip.mjs';
import {readCodexSubmitShortcut} from '../src/whip-submit.mjs';
import {loadAppIcon} from './app-icon.mjs';

const desktopDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.dirname(desktopDirectory);
const quitRequested = process.argv.includes('--quit');
const scheduleTest = !quitRequested && process.argv.includes('--schedule-test');
const smokeTest = !quitRequested && (process.argv.includes('--smoke-test') || scheduleTest);

let mainWindow = null;
let tray = null;
let service = null;
let origin = null;
let dataDirectory = null;
let runtimeCwd = null;
let smokeDirectory = null;
let quitting = false;
let shutdownPromise = null;
let quitNotice = null;
let backgroundNoticeShown = false;
let fatalErrorShown = false;
let smokeCodexAttempts = 0;
let smokePromptFile = null;
const smokeWhip={sent:[],starts:0,stops:0,shortcuts:new Map(),submitMode:'ctrl-enter',settingsReads:0};
const rendererErrors = [];

app.setName('Codex Sweatshop');
nativeTheme.themeSource = 'system';
if (process.platform === 'win32') app.setAppUserModelId('com.codex-sweatshop.app');
const normalUserData = app.isPackaged ? path.join(app.getPath('appData'), 'Codex Sweatshop') : path.join(projectRoot, 'data', 'electron-profile');
const normalDataDirectory = app.isPackaged ? path.join(normalUserData, 'plans') : path.join(projectRoot, 'data');
if (smokeTest) {
  // Isolate Chromium before the single-instance lock, including for packaged builds.
  smokeDirectory = fs.mkdtempSync(path.join(tmpdir(), 'codex-sweatshop-smoke-'));
  const profile = path.join(smokeDirectory, 'chromium');
  fs.mkdirSync(profile);
  app.setPath('userData', profile);
  app.setPath('sessionData', profile);
  app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
} else {
  fs.mkdirSync(normalUserData, { recursive: true });
  app.setPath('userData', normalUserData);
  app.setPath('sessionData', normalUserData);
}

class SmokeClient extends EventEmitter {
  status = { connected: false, binary: null, home: null, lastError: null };
  async stop() {}
  async connect() { return this.request(); }
  async listModels() { return this.request(); }
  async listThreads() { return this.request(); }
  async readAccount() { return this.request(); }
  async readLimits() { return this.request(); }
  async request() { smokeCodexAttempts++; throw new Error('Desktop test mode prohibits Codex connections and inference'); }
}

function smokeOutputPath() {
  const workspace = app.isPackaged ? path.resolve(process.cwd()) : projectRoot;
  const index = process.argv.indexOf('--smoke-output');
  const supplied = index === -1 ? path.join(workspace, 'test-results', 'desktop.png') : process.argv[index + 1];
  if (!supplied || !path.isAbsolute(supplied) || path.extname(supplied).toLowerCase() !== '.png') throw new Error('--smoke-output requires an absolute PNG path inside the workspace');
  const output = path.resolve(supplied);
  const relative = path.relative(workspace, output);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Desktop screenshots must be saved inside the current workspace');
  return output;
}

async function bounded(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); })]);
  } finally { clearTimeout(timer); }
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function allowedPage(url) {
  try {
    const parsed = new URL(url);
    return parsed.origin === origin && ['/', '/index.html'].includes(parsed.pathname);
  } catch { return false; }
}

function validateSender(event) {
  if (quitting || !mainWindow || mainWindow.isDestroyed()
    || event.sender !== mainWindow.webContents
    || event.senderFrame !== mainWindow.webContents.mainFrame
    || !allowedPage(event.senderFrame?.url)
    || !allowedPage(mainWindow.webContents.getURL())) throw new Error('This operation is only available to the main application window');
}

function registerIpc() {
  const handle = (channel, callback) => ipcMain.handle(channel, async (event, ...args) => {
    validateSender(event);
    return await callback(...args);
  });
  handle('sweatshop:choose-directory', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose task project directory', defaultPath: runtimeCwd, buttonLabel: 'Choose directory', properties: ['openDirectory'],
    });
    if (result.canceled || !result.filePaths.length) return null;
    const selected = path.resolve(result.filePaths[0]);
    if (!fs.statSync(selected).isDirectory()) throw new Error('Choose a local directory');
    return selected;
  });
  handle('sweatshop:choose-prompt-file', async () => {
    let selected;
    if (smokeTest) {
      // The isolated harness supplies one temporary fixture; never open an OS picker in tests.
      if (!smokePromptFile) throw new Error('Desktop test mode has no temporary prompt file');
      selected = smokePromptFile;
    } else {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Link Markdown prompt file', defaultPath: runtimeCwd, buttonLabel: 'Link file',
        filters: [{ name: 'Markdown files', extensions: ['md', 'markdown'] }], properties: ['openFile'],
      });
      if (result.canceled || !result.filePaths.length) return null;
      selected = path.resolve(result.filePaths[0]);
    }
    if (!['.md', '.markdown'].includes(path.extname(selected).toLowerCase())) throw new Error('Only .md and .markdown files are supported');
    return readPromptFile(selected);
  });
  handle('sweatshop:copy-text', text => {
    if (typeof text !== 'string' || text.length > 1_000_000) throw new Error('Clipboard content is too long or has an invalid format');
    clipboard.writeText(text);
    return true;
  });
  handle('sweatshop:open-request-url', async id => {
    const approval=service?.runner.approvals.find(item=>item.id===id&&item.method==='mcpServer/elicitation/request'&&item.params.mode==='url');
    if(!approval)throw new Error('This request has ended.');
    const url=elicitationUrl(approval.params.url);
    if(smokeTest)return {url,opened:false};
    await shell.openExternal(url);return {opened:true};
  });
}

async function shutdown(exitCode = 0) {
  if (shutdownPromise) return shutdownPromise;
  quitting = true;
  shutdownPromise = (async () => {
    try {
      if (service) await service.close();
      tray?.destroy();
      if (smokeDirectory) {
        if (mainWindow && !mainWindow.isDestroyed()) {
          const window = mainWindow;
          const destroyed = new Promise(resolve => window.once('closed', resolve));
          window.destroy();
          await bounded(destroyed, 2000, 'Desktop test window did not close');
        }
        const temporaryRoot = path.resolve(tmpdir());
        const relative = path.relative(temporaryRoot, smokeDirectory);
        if (!relative || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)
          || !path.basename(smokeDirectory).startsWith('codex-sweatshop-smoke-')) throw new Error('Temporary directory validation failed');
        await rm(path.join(smokeDirectory, 'plans'), { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
        // Chromium owns profile databases until native app exit. The parent smoke wrapper
        // removes this validated isolation directory only after all process handles close.
        console.log(JSON.stringify({ smokeCleanup: { plansRemoved: true, profileCleanupAfterExit: true, smokeDirectory } }));
      }
    } catch (error) {
      console.error(redact(error.message));
      if (!smokeTest) dialog.showErrorBox('Unable to close Codex Sweatshop', redact(error.message));
      exitCode = 1;
    } finally { app.exit(exitCode); }
  })();
  return shutdownPromise;
}

async function requestQuit() {
  if (quitting) return;
  if(service?.runner.active?.task.activationPlanId) {await shutdown();return;}
  if (service?.runner.active) {
    showWindow();
    if (!quitNotice) {
      quitNotice = dialog.showMessageBox(mainWindow, {
        type: 'info', title: 'Stop the task first', message: 'A task is still running',
        detail: 'Stop the task in the app and wait for Codex to confirm it has ended, then quit from the tray menu. Closing the window keeps scheduling in the background.',
        buttons: ['Return to app'], defaultId: 0, cancelId: 0,
      });
      try { await quitNotice; } finally { quitNotice = null; }
    }
    return;
  }
  await shutdown();
}

async function reportFatal(error) {
  if (fatalErrorShown) return;
  fatalErrorShown = true;
  const message = redact(error?.message ?? error).slice(0, 4096);
  console.error(message);
  if (!smokeTest) dialog.showErrorBox('Codex Sweatshop error', message);
  await shutdown(1);
}

function hideToTray() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.hide();
  if (backgroundNoticeShown || !tray || process.platform !== 'win32') return;
  backgroundNoticeShown = true;
  tray.displayBalloon({
    title: 'Codex Sweatshop is running in the background',
    content: 'Scheduling continues. Click the tray icon to return to the app, or use the tray menu to quit.',
    respectQuietTime: true,
  });
}

function createMenus(icon) {
  Menu.setApplicationMenu(null);
  mainWindow.setMenu(null);
  if (smokeTest) return;
  tray = new Tray(icon.resize({ width: 32, height: 32 }));
  tray.setToolTip('Codex Sweatshop');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Codex Sweatshop', click: showWindow },
    { type: 'separator' },
    { label: 'Quit', click: () => { void requestQuit(); } },
  ]));
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
}

async function start() {
  await app.whenReady();
  const fallbackDirectory = smokeTest ? smokeDirectory : ['documents', 'home'].map(name => app.getPath(name))
    .find(directory => fs.existsSync(directory) && fs.statSync(directory).isDirectory());
  runtimeCwd = smokeTest ? smokeDirectory : app.isPackaged ? fallbackDirectory : projectRoot;
  if (!runtimeCwd) throw new Error('No valid local project directory was found');
  dataDirectory = app.isPackaged ? path.join(app.getPath('userData'), 'plans') : path.join(projectRoot, 'data');
  if (smokeTest) {
    dataDirectory = path.join(smokeDirectory, 'plans');
  }
  service = await createApp({ dataDirectory, runtimeCwd, autoConnect: !smokeTest, ...(smokeTest ? { clientFactory: () => new SmokeClient() } : {}),
    whipRuntimeFactory:({onError})=>createWhipRuntime({cacheDirectory:path.join(dataDirectory,'wwwhip-native'),
      onError:message=>{onError(message);if(!smokeTest)tray?.displayBalloon({title:'Whip',content:message,iconType:'warning'});},
      readSubmitShortcut:smokeTest?async()=>{smokeWhip.settingsReads++;if(smokeWhip.settingsError)throw new Error(smokeWhip.settingsError);return smokeWhip.submitMode;}:
        text=>readCodexSubmitShortcut(service.runner.client,text),
      ...(smokeTest?{driver:{start:async()=>{smokeWhip.starts++;await smokeWhip.startBarrier;return {ready:true};},bind:async()=>({token:'isolated-whip'}),
        stop:()=>{smokeWhip.stops++;},send:async value=>{smokeWhip.sent.push(value);return {status:'submitted'};}},
        shortcuts:{register:(key,callback)=>{if(smokeWhip.shortcuts.has(key))return false;smokeWhip.shortcuts.set(key,callback);return true;},
          unregister:key=>smokeWhip.shortcuts.delete(key)}}:{})}),
  });
  await new Promise((resolve, reject) => {
    service.server.once('error', reject);
    service.server.listen(0, '127.0.0.1', () => { service.server.removeListener('error', reject); resolve(); });
  });
  service.server.on('error', error => { void reportFatal(error); });
  origin = `http://127.0.0.1:${service.server.address().port}`;
  const icon = loadAppIcon();
  mainWindow = new BrowserWindow({
    title: 'Codex Sweatshop', width: 1280, height: 900, minWidth: 900, minHeight: 650,
    show: false, backgroundColor: '#ffffff', icon,
    webPreferences: {
      preload: path.join(desktopDirectory, 'preload.cjs'),
      nodeIntegration: false, contextIsolation: true, sandbox: true,
      webSecurity: true, allowRunningInsecureContent: false, webviewTag: false,
      devTools: !app.isPackaged, partition: 'sweatshop-desktop',
      backgroundThrottling: !smokeTest,
      additionalArguments: [`--sweatshop-version=${app.getVersion()}`],
    },
  });
  const contents = mainWindow.webContents;
  contents.on('console-message', (event, level, message) => {
    if ([3, 'error'].includes(event.level ?? level)) rendererErrors.push(redact(event.message ?? message).slice(0, 2000));
  });
  contents.on('preload-error', (_event, _preload, error) => rendererErrors.push(`preload: ${redact(error.message).slice(0, 2000)}`));
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event, url) => { if (!allowedPage(event.url ?? url)) event.preventDefault(); });
  contents.on('will-redirect', (event, url) => { if (!allowedPage(event.url ?? url)) event.preventDefault(); });
  contents.on('will-frame-navigate', event => { if (!allowedPage(event.url)) event.preventDefault(); });
  contents.on('will-attach-webview', event => event.preventDefault());
  contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  contents.session.setPermissionCheckHandler(() => false);
  mainWindow.on('close', event => { if (!quitting) { event.preventDefault(); hideToTray(); } });
  mainWindow.on('page-title-updated', event => event.preventDefault());
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.once('ready-to-show', () => { if (!smokeTest) showWindow(); });
  registerIpc();
  createMenus(icon);
  await mainWindow.loadURL(origin + '/');
  if (smokeTest) {
    const renderer = await contents.executeJavaScript(`new Promise((resolve,reject)=>{
      const deadline=Date.now()+15000;
      function inspect(){
        const surface=document.querySelector('#schedule-surface');
        let segments=[];try{segments=JSON.parse(surface?.dataset.timelineSegments||'[]');}catch{}
        const ready=!!document.querySelector('#schedule-board') && !!document.querySelector('#task-list')
          && !!document.querySelector('#composer-form') && segments.length>0
          && Number(surface?.dataset.start)>0
          && !document.querySelector('.loading-state');
        if(ready){document.fonts.ready.then(()=>resolve({title:document.title,
          bridgeKeys:Object.keys(window.sweatshopDesktop||{}),version:window.sweatshopDesktop?.version,
          rendererNode:typeof window.require,rendererProcess:typeof window.process,
          heading:document.querySelector('.queue-heading h1')?.textContent,
          scheduleBoard:!!document.querySelector('#schedule-board'),taskList:!!document.querySelector('#task-list'),
          composer:!!document.querySelector('#composer-form'),timelineSegments:segments.length}));return;}
        if(Date.now()>deadline){reject(new Error('Schedule and task list did not render within 15 seconds'));return;}
        setTimeout(inspect,50);
      }inspect();
    })`).catch(async error => {
      let view;
      try {
        view = await bounded(contents.executeJavaScript(`({title:document.title,
          text:document.body?.innerText.slice(0,2400),
          surface:document.querySelector('#schedule-surface')?.dataset.start})`), 2000, 'Unable to read test diagnostics');
      } catch (diagnosticError) { view = { error: redact(diagnosticError.message) }; }
      console.error(JSON.stringify({ smokeDiagnostics: { rendererErrors, codexAttempts: smokeCodexAttempts, view }, error: redact(error.message) }));
      throw error;
    });
    const expectedBridge = ['chooseDirectory', 'choosePromptFile', 'copyText'];
    if (!expectedBridge.every(key => renderer.bridgeKeys.includes(key)) || renderer.rendererNode !== 'undefined'
      || renderer.rendererProcess !== 'undefined'
      || renderer.bridgeKeys.includes('chooseMarkdownFiles') || renderer.bridgeKeys.includes('openDataDirectory')
      || service.store.data.settings.schedulerEnabled !== true || service.store.data.tasks.length || smokeCodexAttempts || rendererErrors.length) {
      console.error(JSON.stringify({ rendererErrors, smokeCodexAttempts }));
      throw new Error('Desktop entry check failed');
    }
    const scheduleTests = scheduleTest
      ? await bounded(import('./schedule-test.mjs').then(module => module.testScheduleUi({ contents, window: mainWindow, service, runtimeCwd,whipFixture:smokeWhip,
        choosePromptFile: file => {
          const selected = path.resolve(file), relative = path.relative(runtimeCwd, selected);
          if (!relative || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Tests can only select prompt files inside the isolated directory');
          smokePromptFile = selected;
        },
      })), 70_000, 'Schedule interaction check timed out')
      : null;
    if (service.store.data.settings.schedulerEnabled !== true || service.runner.active || smokeCodexAttempts || rendererErrors.length) {
      console.error(JSON.stringify({ rendererErrors, smokeCodexAttempts }));
      throw new Error('Schedule checks encountered an unexpected connection, execution or renderer error');
    }
    // A hidden native window can retain its initial compositor frame after the DOM changes.
    // Briefly paint without taking focus, then wait two frames before capturing the actual UI.
    mainWindow.showInactive();
    await bounded(contents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'), 5000, 'Desktop test window did not finish painting');
    await new Promise(resolve => setTimeout(resolve, 250));
    const screenshot = await bounded(contents.capturePage(undefined, { stayAwake: true }), 5000, 'Desktop screenshot timed out');
    mainWindow.hide();
    if (screenshot.isEmpty()) throw new Error('Desktop screenshot is empty');
    const screenshotPath = smokeOutputPath();
    fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
    await writeFile(screenshotPath, screenshot.toPNG());
    console.log(JSON.stringify({ smokeTest: true, packaged: app.isPackaged, renderer, schedulerEnabled: service.store.data.settings.schedulerEnabled, tasks: service.store.data.tasks.length,
      connected: service.runner.client.status.connected, codexAttempts: smokeCodexAttempts, rendererErrors,
      ...(scheduleTests ? { scheduleTests } : {}),
      screenshot: screenshotPath, screenshotSize: screenshot.getSize(), smokeDirectory,
      paths: { normalUserData, normalPlans: normalDataDirectory, smokeTemporary: smokeDirectory } }));
    await shutdown();
  }
}

if (!app.requestSingleInstanceLock()) app.exit(0);
else if (quitRequested) app.exit(0);
else {
  process.on('uncaughtException', error => { void reportFatal(error); });
  process.on('unhandledRejection', error => { void reportFatal(error); });
  app.on('second-instance', (_event, argv) => { if (argv.includes('--quit')) void requestQuit(); else showWindow(); });
  app.on('activate', showWindow);
  app.on('before-quit', event => { if (!quitting) { event.preventDefault(); void requestQuit(); } });
  app.on('window-all-closed', () => { /* Closing the window retains the tray scheduler. */ });
  void start().catch(error => { void reportFatal(error); });
}
