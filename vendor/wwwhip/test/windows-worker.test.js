const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { createWindowsCodexDriver } = require('../lib/windows-codex');

function fixture(handle, timeoutMs = 1000) {
  const commands = [];
  let worker;
  const driver = createWindowsCodexDriver({
    build: async () => 'fixture.exe', timeoutMs,
    spawnProcess(executable, args, options) {
      assert.equal(executable, 'fixture.exe');
      assert.deepEqual(args, []);
      assert.equal(options.windowsHide, true);
      worker = new EventEmitter();
      worker.stdout = new PassThrough();
      worker.stderr = new PassThrough();
      worker.kill = () => { worker.stdout.end(); queueMicrotask(() => worker.emit('exit', 0)); };
      worker.stdin = new Writable({ write(chunk, _encoding, done) {
        const request = JSON.parse(chunk.toString());
        commands.push(request);
        const reply = response => worker.stdout.write(JSON.stringify({ id: request.id, ...response }) + '\n');
        if (request.command === 'ping') reply({ ok: true, result: { ready: true } });
        else handle(request, reply, worker);
        done();
      } });
      return worker;
    },
  });
  return { driver, commands };
}

test('worker receives messages as literal JSON data, without shell interpretation', async t => {
  const { driver, commands } = fixture((_request, reply) => reply({ ok: true, result: { status: 'filled' } }));
  t.after(() => driver.stop());
  await driver.start();
  const text = '中文 🙂 " \\ $() `literal`';
  await driver.send({ token: 'test', text, mode: 'fill' });
  assert.equal(commands[1].text, text);
});

test('a rejected draft check is returned to the caller without a second send', async t => {
  const { driver, commands } = fixture((_request, reply) => reply({ ok: false, code: 'draft', message: 'Draft is not empty' }));
  t.after(() => driver.stop());
  await driver.start();
  await assert.rejects(driver.send({ token: 'test', text: 'FASTER', mode: 'enter' }), { code: 'draft' });
  assert.equal(commands.filter(command => command.command === 'send').length, 1);
});

test('timeout kills the helper and does not replay an uncertain submission', async t => {
  const { driver, commands } = fixture(() => {}, 30);
  t.after(() => driver.stop());
  await driver.start();
  await assert.rejects(driver.send({ token: 'test', text: 'FASTER', mode: 'enter' }), /delivery is unknown/);
  await assert.rejects(driver.send({ token: 'test', text: 'FASTER', mode: 'enter' }), /not running/);
  assert.equal(commands.filter(command => command.command === 'send').length, 1);
});

test('helper crash invalidates transport and rejects the pending call', async t => {
  const { driver } = fixture((_request, _reply, worker) => queueMicrotask(() => worker.emit('exit', 1)));
  t.after(() => driver.stop());
  await driver.start();
  await assert.rejects(driver.bind(), /helper exited/);
  await assert.rejects(driver.send({}), /not running/);
});

test('quitting while compiling does not launch an orphan helper', async () => {
  let compiled;
  let spawned = false;
  const driver = createWindowsCodexDriver({
    build: () => new Promise(resolve => { compiled = resolve; }),
    spawnProcess: () => { spawned = true; throw new Error('Must not start'); },
  });
  const starting = driver.start();
  driver.stop();
  compiled('fixture.exe');
  await assert.rejects(starting, /cancelled/);
  assert.equal(spawned, false);
});
