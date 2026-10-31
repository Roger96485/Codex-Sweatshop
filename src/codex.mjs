import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { access, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

const MAX_LINE_BYTES = 32 * 1024 * 1024;
const STDERR_LIMIT = 4096;

export function redact(value) {
  return String(value ?? '')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|sess)-[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]')
    .replace(/((?:access_token|refresh_token|id_token|api_key|authorization|password|secret)\s*["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, '$1[REDACTED]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED EMAIL]');
}

function failure(message, code, extra = {}) {
  return Object.assign(new Error(redact(message)), { code, sent: false, ...extra });
}

async function exists(file) {
  try { await access(file, constants.F_OK); return true; } catch { return false; }
}

function invocation(binary) {
  return /\.(?:mjs|cjs|js)$/i.test(binary)
    ? { binary, command: process.execPath, args: [binary] }
    : { binary, command: binary, args: [] };
}

async function versionOf(candidate) {
  return await new Promise(resolve => {
    let stdout = '';
    let finished = false;
    const child = spawn(candidate.command, [...candidate.args, '--version'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
    const done = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(stdout.match(/codex(?:-cli)?\s+(\d+\.\d+\.\d+(?:[^\s]*)?)/i)?.[1] ?? null);
    };
    const timer = setTimeout(() => { child.kill(); done(); }, 3000);
    child.stdout.on('data', chunk => { stdout = (stdout + chunk.toString()).slice(-1024); });
    child.on('error', done);
    child.on('close', done);
  });
}

function versionParts(version) {
  return String(version ?? '0.0.0').split(/[.-]/).slice(0, 3).map(part => Number(part) || 0);
}

function compareVersions(left, right) {
  const a = versionParts(left); const b = versionParts(right);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return b[i] - a[i];
  return 0;
}

/** Resolve a native executable or the npm JavaScript entry point, never a shell shim. */
export async function discoverCodex({ binary } = {}) {
  const candidates = [];
  const seen = new Set();
  const add = async (file, source) => {
    const key = process.platform === 'win32' ? file.toLowerCase() : file;
    if (seen.has(key) || !await exists(file)) return;
    seen.add(key);
    if (/\.(?:cmd|bat|ps1)$/i.test(file)) {
      const entry = path.join(path.dirname(file), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
      if (!await exists(entry)) return;
      candidates.push({ ...invocation(entry), source });
      return;
    }
    candidates.push({ ...invocation(file), source });
  };
  if (binary) {
    if (path.isAbsolute(binary) || binary.includes('/') || binary.includes('\\')) await add(path.resolve(binary), 'explicit');
    else {
      for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
        await add(path.join(dir.replace(/^"|"$/g, ''), binary), 'explicit');
        if (process.platform === 'win32' && !path.extname(binary)) await add(path.join(dir.replace(/^"|"$/g, ''), `${binary}.exe`), 'explicit');
      }
    }
    if (!candidates.length) throw failure('The configured Codex executable was not found. Use codex.exe or the npm codex.js entry point.', 'CODEX_NOT_FOUND');
    const selected = candidates[0];
    return { ...selected, version: await versionOf(selected) };
  }

  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA ?? path.join(process.env.USERPROFILE ?? homedir(), 'AppData', 'Local');
    const desktopBin = path.join(localAppData, 'OpenAI', 'Codex', 'bin');
    await add(path.join(desktopBin, 'codex.exe'), 'desktop');
    try {
      for (const entry of await readdir(desktopBin, { withFileTypes: true })) {
        if (entry.isDirectory()) await add(path.join(desktopBin, entry.name, 'codex.exe'), 'desktop');
      }
    } catch { /* Desktop may not be installed. */ }
  }
  for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const cleanDir = dir.replace(/^"|"$/g, '');
    if (process.platform === 'win32') await add(path.join(cleanDir, 'codex.exe'), 'path');
    else await add(path.join(cleanDir, 'codex'), 'path');
    await add(path.join(cleanDir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'), 'npm');
    await add(path.join(cleanDir, '..', 'lib', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'), 'npm');
  }
  if (!candidates.length) throw failure('Codex was not found. Install the Codex CLI or configure its native executable path.', 'CODEX_NOT_FOUND');
  const inspected = await Promise.all(candidates.map(async candidate => ({ ...candidate, version: await versionOf(candidate) })));
  const working = inspected.filter(candidate => candidate.version);
  const rank = { desktop: 0, path: 1, npm: 2 };
  (working.length ? working : inspected).sort((a, b) => compareVersions(a.version, b.version) || rank[a.source] - rank[b.source]);
  return (working.length ? working : inspected)[0];
}

/** Owns one app-server stdio connection. Approval requests are always forwarded to its caller. */
export class CodexClient extends EventEmitter {
  #options;
  #child = null;
  #connected = false;
  #connecting = null;
  #stopping = null;
  #pending = new Map();
  #nextId = 0;
  #lastError = null;
  #stderr = '';
  #disconnected = new WeakSet();
  #closingChildren = new WeakMap();
  #generation = 0;
  #binary = null;
  #home;
  #projectsCache = null;
  #projectsLoading = null;

  constructor({ binary, home, cwd } = {}) {
    super();
    this.#options = { binary, cwd: cwd ?? process.cwd() };
    this.#home = path.resolve(home ?? process.env.CODEX_HOME ?? path.join(process.env.USERPROFILE ?? homedir(), '.codex'));
  }

  get status() {
    return { connected: this.#connected, binary: this.#binary ?? this.#options.binary ?? null, home: this.#home, lastError: this.#lastError };
  }

  async connect() {
    if (this.#connected) return this.status;
    if (this.#connecting) return this.#connecting;
    this.#connecting = this.#connect(this.#generation);
    try { return await this.#connecting; }
    finally { this.#connecting = null; }
  }

  async #connect(generation) {
    let child = null;
    if (this.#stopping) await this.#stopping;
    try {
      if (generation !== this.#generation) throw failure('Codex connection was stopped before launch.', 'CODEX_STOPPED');
      const found = await discoverCodex({ binary: this.#options.binary });
      // Executable/version discovery may be asynchronous. stop() invalidates its generation.
      if (generation !== this.#generation) throw failure('Codex connection was stopped before launch.', 'CODEX_STOPPED');
      this.#binary = found.binary;
      this.#stderr = '';
      child = spawn(found.command, [...found.args, 'app-server', '--stdio'], {
        cwd: this.#options.cwd, env: { ...process.env, CODEX_HOME: this.#home, ELECTRON_RUN_AS_NODE: '1' },
        windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.#child = child;
      const decoder = new StringDecoder('utf8');
      let buffer = '';
      child.stdout.on('data', chunk => {
        buffer += decoder.write(chunk);
        if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) {
          this.#disconnect(child, failure('Codex sent an oversized protocol message.', 'CODEX_PROTOCOL_ERROR'));
          child.kill(); return;
        }
        let newline;
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
          if (!line) continue;
          let message;
          try { message = JSON.parse(line); }
          catch {
            this.#disconnect(child, failure('Codex sent invalid JSON protocol data.', 'CODEX_PROTOCOL_ERROR'));
            child.kill(); return;
          }
          this.#receive(message);
        }
      });
      child.stderr.on('data', chunk => { this.#stderr = (this.#stderr + chunk.toString()).slice(-STDERR_LIMIT); });
      child.stdin.on('error', error => this.#disconnect(child, failure(`Codex input closed: ${error.code ?? 'stream error'}`, 'CODEX_DISCONNECTED')));
      child.on('error', error => this.#disconnect(child, failure(`Could not launch Codex: ${error.code ?? error.message}`, 'CODEX_PROCESS_ERROR')));
      child.on('close', (code, signal) => {
        this.#disconnect(child, failure(`Codex app-server closed (${signal ?? code ?? 'unknown'}).`, 'CODEX_DISCONNECTED'));
        if (this.#child === child) this.#child = null;
      });
      await this.#sendRequest('initialize', {
        clientInfo: { name: 'codex_sweatshop', title: 'Codex Sweatshop', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      }, 30_000);
      this.#write({ method: 'initialized', params: {} });
      this.#connected = true;
      this.#lastError = null;
      return this.status;
    } catch (error) {
      if (this.#stderr) error.stderr = redact(this.#stderr);
      if (error.code !== 'CODEX_STOPPED') this.#lastError = redact(error.message + (this.#stderr ? `\n${this.#stderr}` : '')).slice(-STDERR_LIMIT);
      // Do not call public stop() here: an external stop may already await this connect.
      if (child) await this.#stopChild(child);
      throw error;
    }
  }

  async request(method, params = {}, timeoutMs = 30_000) {
    if (!this.#connected) {
      try { await this.connect(); }
      catch (error) {
        // A failed initialize cannot have dispatched the caller's requested mutation.
        throw failure(error.message, error.code, { sent: false, uncertain: false, cause: error });
      }
    }
    return await this.#sendRequest(method, params, timeoutMs);
  }

  #sendRequest(method, params, timeoutMs) {
    if (!this.#child || this.#disconnected.has(this.#child)) return Promise.reject(failure('Codex is disconnected.', 'CODEX_DISCONNECTED'));
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(failure('RPC timeout must be a positive number.', 'CODEX_INVALID_TIMEOUT'));
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      const pending = { resolve, reject, sent: false, timer: null };
      pending.timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(failure(`Codex request timed out: ${method}. Its result is unknown; do not automatically repeat a mutation.`, 'CODEX_TIMEOUT', { sent: pending.sent, uncertain: pending.sent }));
      }, timeoutMs);
      this.#pending.set(id, pending);
      try {
        // Once writing begins, a transport failure cannot prove the server did not receive it.
        const payload = JSON.stringify({ id, method, params }) + '\n';
        pending.sent = true;
        this.#writeRaw(payload);
      } catch (error) {
        clearTimeout(pending.timer); this.#pending.delete(id);
        reject(failure(error.message, error.code ?? 'CODEX_WRITE_ERROR', { sent: pending.sent, uncertain: pending.sent }));
      }
    });
  }

  #writeRaw(payload) {
    if (!this.#child?.stdin.writable || this.#disconnected.has(this.#child)) throw failure('Codex is disconnected.', 'CODEX_DISCONNECTED');
    this.#child.stdin.write(payload);
  }

  #write(message) { this.#writeRaw(JSON.stringify(message) + '\n'); }

  #receive(message) {
    if (message && typeof message.method === 'string') {
      if (message.id !== undefined && message.id !== null) this.emit('serverRequest', { id: message.id, method: message.method, params: message.params });
      else this.emit('notification', { method: message.method, params: message.params });
      return;
    }
    const pending = this.#pending.get(message?.id);
    if (!pending) return; // Late responses to timed-out requests are deliberately not replayed.
    clearTimeout(pending.timer); this.#pending.delete(message.id);
    if (message.error) {
      pending.reject(failure(message.error.message ?? 'Codex RPC error.', message.error.code ?? 'CODEX_RPC_ERROR', { sent: pending.sent, uncertain: false, rpcCode: message.error.code, data: message.error.data }));
    } else pending.resolve(message.result);
  }

  respond(id, result, error) {
    if (!this.#connected) throw failure('Codex is disconnected.', 'CODEX_DISCONNECTED');
    this.#write(error !== undefined ? { id, error } : { id, result });
  }

  #disconnect(child, error) {
    if (this.#child !== child || this.#disconnected.has(child)) return;
    this.#disconnected.add(child);
    this.#connected = false;
    this.#projectsCache = null;
    this.#projectsLoading = null;
    if (error.code !== 'CODEX_STOPPED') this.#lastError = redact(error.message).slice(-STDERR_LIMIT);
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(failure(error.message, error.code, { sent: pending.sent, uncertain: pending.sent }));
    }
    this.#pending.clear();
    this.emit('disconnect', error);
  }

  async stop() {
    if (this.#stopping) return this.#stopping;
    this.#generation++;
    this.#connected = false;
    this.#projectsCache = null;
    this.#projectsLoading = null;
    const connecting = this.#connecting;
    const child = this.#child;
    this.#stopping = (async () => {
      if (child) await this.#stopChild(child);
      // Discovery cannot spawn a child after this stop has resolved.
      if (connecting) { try { await connecting; } catch { /* Cancellation is expected. */ } }
    })();
    try { await this.#stopping; } finally { this.#stopping = null; }
  }

  #stopChild(child) {
    if (this.#closingChildren.has(child)) return this.#closingChildren.get(child);
    const closing = new Promise(resolve => {
      this.#disconnect(child, failure('Codex connection was stopped.', 'CODEX_STOPPED'));
      const timer = setTimeout(() => child.kill(), 1500);
      const forceTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
      const finish = () => {
        clearTimeout(timer);
        clearTimeout(forceTimer);
        if (this.#child === child) this.#child = null;
        resolve();
      };
      child.once('close', finish);
      if (child.exitCode !== null || child.signalCode !== null) finish();
      else child.stdin.end();
    });
    this.#closingChildren.set(child, closing);
    return closing;
  }

  async listThreads({ search, cursor } = {}) {
    const page = await this.request('thread/list', {
      limit: 50, sortKey: 'updated_at', archived: false,
      modelProviders: [], useStateDbOnly: true,
      ...(search ? { searchTerm: search } : {}), ...(cursor ? { cursor } : {}),
    });
    if (!Array.isArray(page?.data) || !page.data.some(thread => typeof thread?.projectId === 'string' && thread.projectId)) return page;
    const names = await this.#projectNames();
    if (!names.size) return page;
    return { ...page, data: page.data.map(thread => names.has(thread?.projectId) ? { ...thread, projectName: names.get(thread.projectId) } : thread) };
  }

  async #projectNames() {
    if (this.#projectsCache?.expiresAt > Date.now()) return this.#projectsCache.names;
    if (this.#projectsLoading) return this.#projectsLoading.promise;
    const child = this.#child, generation = this.#generation;
    const operation = (async () => {
      const names = new Map(), cursors = new Set(), deadline = Date.now() + 5000;
      let cursor;
      for (let index = 0; index < 20; index++) {
        // Optional labels must neither restart a stopped connection nor hold up the picker indefinitely.
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw failure('Codex project metadata timed out.', 'CODEX_TIMEOUT');
        const page = await this.#sendRequest('project/list', { limit: 100, ...(cursor ? { cursor } : {}) }, remaining);
        if (!Array.isArray(page?.data)) throw failure('Codex returned invalid project metadata.', 'CODEX_PROTOCOL_ERROR');
        for (const project of page.data) if (typeof project?.id === 'string' && project.id && typeof project.name === 'string' && project.name.trim()) names.set(project.id, project.name.trim());
        cursor = page.nextCursor;
        if (cursor == null || cursor === '') {
          if (this.#connected && this.#child === child && this.#generation === generation) {
            this.#projectsCache = { names, expiresAt: Date.now() + 60000 };
            return names;
          }
          return new Map();
        }
        if (typeof cursor !== 'string' || cursors.has(cursor)) throw failure('Codex returned a repeated or invalid project pagination cursor.', 'CODEX_PROTOCOL_ERROR');
        cursors.add(cursor);
      }
      throw failure('Codex project metadata exceeded the pagination limit.', 'CODEX_PROTOCOL_ERROR');
    })().catch(() => new Map()); // Older app-server versions may not support project/list.
    this.#projectsLoading = { promise: operation };
    try { return await operation; }
    finally { if (this.#projectsLoading?.promise === operation) this.#projectsLoading = null; }
  }

  async listModels() {
    const models = []; const cursors = new Set();
    let cursor;
    do {
      const page = await this.request('model/list', { limit: 100, ...(cursor ? { cursor } : {}) });
      models.push(...(page.data ?? []));
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw failure('Codex returned a repeated model pagination cursor.', 'CODEX_PROTOCOL_ERROR');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return models;
  }

  async readAccount() { return await this.request('account/read', { refreshToken: false }); }
  async readLimits() { return await this.request('account/rateLimits/read', {}, 5000); }
}
