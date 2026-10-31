const { spawn } = require('child_process');
const readline = require('readline');
const { buildWindowsHelper } = require('./build-windows-helper');

// Persistent UI Automation worker: no shell interpolation, clipboard, or app IPC.
function createWindowsCodexDriver({ spawnProcess = spawn, build = buildWindowsHelper, cacheDirectory, timeoutMs = 6000 } = {}) {
  let child = null;
  let ready = null;
  let sequence = 0;
  let lifecycle = 0;
  const pending = new Map();

  function stop(message = 'Windows input helper stopped. Activate the whip again.') {
    lifecycle++;
    const old = child;
    child = null;
    ready = null;
    if (old) old.kill();
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(new Error(message));
    }
    pending.clear();
  }

  function request(command, params = {}) {
    return new Promise((resolve, reject) => {
      if (!child) return reject(new Error('Windows input helper is not running.'));
      const id = ++sequence;
      const timer = setTimeout(() => stop('Windows input timed out; delivery is unknown. Check the draft before reactivating.'), timeoutMs);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, command, ...params })}\n`, 'utf8', error => {
        if (error) stop('Could not contact the Windows input helper.');
      });
    });
  }

  function start() {
    if (ready) return ready;
    const current = ++lifecycle;
    ready = launch(current).catch(error => { if (lifecycle === current) ready = null; throw error; });
    return ready;
  }

  async function launch(current) {
    const executable = await build(cacheDirectory);
    if (current !== lifecycle) throw new Error('Windows input helper startup cancelled.');
    const worker = spawnProcess(executable, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child = worker;
    let stderr = '';
    worker.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-1600); });
    worker.on('error', () => { if (child === worker) stop('Unable to start Windows input helper.'); });
    worker.stdin.on('error', () => { if (child === worker) stop('Windows input helper disconnected.'); });
    worker.on('exit', () => {
      if (child === worker) stop(`Windows input helper exited. ${stderr.trim()}`);
    });
    const lines = readline.createInterface({ input: worker.stdout });
    lines.on('line', line => {
      if (child !== worker) return;
      let reply;
      try { reply = JSON.parse(line); } catch { stop('Invalid response from Windows input helper.'); return; }
      const entry = pending.get(reply.id);
      if (!entry) return;
      pending.delete(reply.id);
      clearTimeout(entry.timer);
      if (reply.ok) entry.resolve(reply.result);
      else {
        const error = new Error(reply.message || 'Windows input failed.');
        error.code = reply.code;
        entry.reject(error);
      }
    });
    return request('ping');
  }

  return {
    start,
    async bind() { await start(); return request('bind'); },
    // Do not restart a dead worker and attempt to reuse its target token.
    send(params) { return request('send', params); },
    stop,
  };
}

module.exports = { createWindowsCodexDriver };
