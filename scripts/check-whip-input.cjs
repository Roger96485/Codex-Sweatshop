// Adapted from WWWhip at 54dc557091bf95ac09b18c3447a5974382258c4c.
// MIT; see vendor/wwwhip/LICENSE and NOTICE. Runs only against an owned test window.
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const assert = require('assert/strict');
const { promisify } = require('util');
const { execFile, spawn } = require('child_process');
const { createWindowsCodexDriver } = require('../vendor/wwwhip/lib/windows-codex.js');
const execute = promisify(execFile);
const root = path.join(__dirname, '..');
const output = path.resolve(process.argv[process.argv.indexOf('--fixture-output') + 1]);
const vendored = path.join(root, 'vendor', 'wwwhip');
app.setPath('userData', path.join(output, 'fixture-user-data'));
app.commandLine.appendSwitch('force-renderer-accessibility','complete');
let driver;
let fixture;

async function main() {
  await app.whenReady();
  app.setAccessibilitySupportEnabled(true);
  fs.mkdirSync(output, { recursive: true });
  const framework = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
  const executable = path.join(output, 'FixtureWorker.exe');
  await execute(path.join(framework, 'csc.exe'), [
    '/nologo', '/target:exe', `/out:${executable}`, '/reference:System.Web.Extensions.dll',
    ...['UIAutomationClient.dll', 'UIAutomationTypes.dll', 'WindowsBase.dll'].map(name => `/reference:${path.join(framework, 'WPF', name)}`),
    path.join(vendored, 'native', 'CodexInput.cs'), path.join(vendored, 'test', 'FixtureWorker.cs'),
  ], { windowsHide: true });
  fixture = new BrowserWindow({ width: 640, height: 400, title: 'OpenWhip input fixture', webPreferences: { contextIsolation: true, nodeIntegration: false } });
  fixture.on('page-title-updated', event => event.preventDefault());
  await fixture.loadFile(path.join(vendored, 'test', 'fixture.html'));
  fixture.show();
  fixture.focus();
  fixture.webContents.focus();
  const evaluate = code => fixture.webContents.executeJavaScript(code);
  await evaluate('resetComposer()');
  const handle = fixture.getNativeWindowHandle().readBigUInt64LE().toString();
  console.log('Fixture window:', handle);
  if (process.argv.includes('--observe')) {
    await new Promise(resolve => setTimeout(resolve, 60000));
    return;
  }
  driver = createWindowsCodexDriver({ build: async () => executable,
    spawnProcess: (file, _args, options) => spawn(file, [handle, String(process.pid)], options) });
  await driver.start();
  fixture.setAlwaysOnTop(true);
  fixture.show();
  fixture.focus();
  fixture.webContents.focus();
  await evaluate('document.getElementById("composer").focus()');
  await new Promise(resolve => setTimeout(resolve, 150));
  if (process.argv.includes('--wait-for-focus')) {
    await evaluate('document.querySelector("p").textContent = "Click the message input below to begin the native input test."');
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { clearInterval(interval); reject(new Error('Waiting for fixture focus timed out.')); }, 60000);
      const interval = setInterval(async () => {
        if (await evaluate('document.hasFocus() && document.activeElement.id === "composer"')) {
          clearInterval(interval); clearTimeout(timeout); resolve();
        }
      }, 250);
    });
  }
  console.log('Checking English placeholder and Enter');
  await evaluate('window.submissionBlurMs = 200; window.remountOnSubmit = true');
  await driver.bind();
  assert.equal((await driver.send({ token: 'fixture-only', text: 'FASTER', mode: 'enter' })).status, 'submitted');
  assert.deepEqual(await evaluate('window.submissions'), [{ text: 'FASTER', control: false }]);
  assert.equal((await driver.send({ token: 'fixture-only', text: '继续处理 🙂', mode: 'ctrl-enter' })).status, 'submitted');
  assert.deepEqual((await evaluate('window.submissions'))[1], { text: '继续处理 🙂', control: true });
  await evaluate('window.submissionBlurMs = 0; window.remountOnSubmit = false');
  assert.equal(await evaluate('document.getElementById("other-composer").innerText'), 'Protected neighbouring draft');
  for (const label of ['随心输入', '想做什麼都可以', 'Do anything', '给 ChatGPT 发消息', 'Message ChatGPT', '使用 ChatGPT Work']) {
    console.log('Checking placeholder:', label);
    await evaluate(`resetComposer(${JSON.stringify(label)})`);
    await new Promise(resolve => setTimeout(resolve, 150));
    await driver.bind();
    assert.equal((await driver.send({ token: 'fixture-only', text: label, mode: 'fill' })).status, 'filled');
    // Literal text identical to the placeholder must remain a protected draft.
    await assert.rejects(driver.bind(), { code: 'draft' });
  }
  for (const draft of [' ', '\nDo anything', '\u200b', 'first\nsecond']) {
    console.log('Checking protected draft:', JSON.stringify(draft));
    await evaluate(`composer.textContent = ${JSON.stringify(draft)}; composer.focus()`);
    await new Promise(resolve => setTimeout(resolve, 150));
    await assert.rejects(driver.bind(), { code: 'draft' });
  }
  await evaluate('resetComposer()');
  await new Promise(resolve => setTimeout(resolve, 150));
  await driver.bind();
  await evaluate('document.getElementById("composer").textContent = "existing draft"');
  await new Promise(resolve => setTimeout(resolve, 150));
  await assert.rejects(driver.send({ token: 'fixture-only', text: 'FASTER', mode: 'enter' }), { code: 'draft' });
  assert.equal(await evaluate('document.getElementById("composer").innerText'), 'existing draft');
  await evaluate('resetComposer()');
  await new Promise(resolve => setTimeout(resolve, 150));
  await driver.bind();
  assert.equal((await driver.send({ token: 'fixture-only', text: '只填入 👋', mode: 'fill' })).status, 'filled');
  assert.equal(await evaluate('document.getElementById("composer").innerText'), '只填入 👋');
  assert.equal((await evaluate('window.submissions')).length, 2);
  // The panel side chat and main task use the same accessible label. An empty
  // neighbouring editor must not make a rejected submission look successful.
  await evaluate('resetComposer(); document.getElementById("other-composer").textContent = ""; window.ignoreSubmit = true');
  await new Promise(resolve => setTimeout(resolve, 150));
  await driver.bind();
  assert.equal((await driver.send({ token: 'fixture-only', text: 'Submission not accepted', mode: 'ctrl-enter' })).status, 'unconfirmed');
  assert.equal(await evaluate('composer.innerText'), 'Submission not accepted');
  assert.equal(await evaluate('document.getElementById("other-composer").innerText'), '');
  await evaluate('window.ignoreSubmit = false; document.getElementById("other-composer").textContent = "Protected neighbouring draft"');
  await evaluate('resetComposer()');
  await new Promise(resolve => setTimeout(resolve, 150));
  await driver.bind();
  await evaluate('document.getElementById("search").focus()');
  await new Promise(resolve => setTimeout(resolve, 150));
  await assert.rejects(driver.send({ token: 'fixture-only', text: 'FASTER', mode: 'enter' }), { code: 'composer' });
  assert.equal(await evaluate('document.getElementById("search").value'), '');
  await evaluate('resetComposer()');
  await new Promise(resolve => setTimeout(resolve, 150));
  await driver.bind();
  await evaluate('document.getElementById("other-composer").focus()');
  await new Promise(resolve => setTimeout(resolve, 150));
  await assert.rejects(driver.send({ token: 'fixture-only', text: 'Wrong pane', mode: 'enter' }), { code: 'focus' });
  assert.equal(await evaluate('document.getElementById("other-composer").innerText'), 'Protected neighbouring draft');
  await evaluate('resetComposer()');
  await new Promise(resolve => setTimeout(resolve, 150));
  await driver.bind();
  await evaluate('composer.setAttribute("aria-label", "使用 ChatGPT Work")');
  await new Promise(resolve => setTimeout(resolve, 150));
  await assert.rejects(driver.send({ token: 'fixture-only', text: 'Changed mode', mode: 'enter' }), { code: 'focus' });
  await evaluate('resetComposer(); window.renameOnSubmit = "Named conversation"');
  await new Promise(resolve => setTimeout(resolve, 150));
  await driver.bind();
  const renamed = await driver.send({ token: 'fixture-only', text: 'First message', mode: 'ctrl-enter' });
  assert.equal(renamed.status, 'submitted');
  assert.equal(renamed.requiresRebind, true);
  await evaluate('window.renameOnSubmit = null');
  // First Work submission replaces the whole composer and names the page.
  // Confirmation requires this exact posted message, not merely an empty editor.
  for (const wrongMessage of [true, false]) {
    await evaluate(`document.title = 'ChatGPT'; resetComposer('使用 ChatGPT Work'); document.getElementById('other-composer').style.display = 'none'; window.replaceConversation = true; window.renameOnSubmit = 'New Work task'; window.postedTextOverride = ${wrongMessage ? "'Unrelated message'" : 'null'}`);
    await new Promise(resolve => setTimeout(resolve, 150));
    await driver.bind();
    const first = await driver.send({ token: 'fixture-only', text: 'New Work first message', mode: 'ctrl-enter' });
    assert.equal(first.status, wrongMessage ? 'unconfirmed' : 'submitted');
    assert.equal(first.requiresRebind, true);
  }
  await evaluate('window.replaceConversation = false; window.renameOnSubmit = null; window.postedTextOverride = null; document.getElementById("other-composer").style.display = ""');
  await evaluate('resetComposer()');
  await new Promise(resolve => setTimeout(resolve, 150));
  await driver.bind();
  await evaluate('document.title = "Another task"');
  fixture.setTitle('OpenWhip input fixture');
  await new Promise(resolve => setTimeout(resolve, 150));
  await assert.rejects(driver.send({ token: 'fixture-only', text: 'FASTER', mode: 'enter' }), { code: 'focus' });
  driver.stop();
  fixture.close();

  console.log(JSON.stringify({nativeFixturePassed:true,isolatedFixtureOnly:true,realCodexInputSent:false}));
  console.log('Desktop fixture passed: native Unicode/emoji and Ctrl+Enter, placeholder/draft protection, neighbouring composer isolation, new Work conversation confirmation with correct/wrong message, task and mode changes.');
}

// The fixture closes its windows during assertions, so delay app quit until
// the explicit completion path. No background app or input process is left.
app.on('window-all-closed', () => {});
main().then(() => app.exit(0), error => { console.error(error); driver?.stop(); fixture?.destroy(); app.exit(1); });
