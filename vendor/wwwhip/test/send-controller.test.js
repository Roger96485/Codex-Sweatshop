const test = require('node:test');
const assert = require('node:assert/strict');
const { createSendController } = require('../lib/send-controller');

function setup(overrides = {}) {
  let time = 10000;
  const calls = [];
  const driver = {
    bind: async () => ({ token: 'bound-composer', title: 'Codex' }),
    send: async request => { calls.push(request); return { status: 'submitted' }; },
    ...overrides,
  };
  const controller = createSendController({ driver, now: () => time, choose: () => 'Continue 请继续 🙂' });
  return { controller, calls, advance: ms => { time += ms; } };
}

test('never sends until an empty composer has been bound', async () => {
  const { controller, calls } = setup();
  assert.equal((await controller.send()).status, 'unbound');
  assert.equal(calls.length, 0);
});

test('passes literal Unicode text and the chosen submission mode', async () => {
  const { controller, calls } = setup();
  await controller.arm();
  await controller.send('ctrl-enter');
  assert.deepEqual(calls, [{ token: 'bound-composer', text: 'Continue 请继续 🙂', mode: 'ctrl-enter' }]);
});

test('drops overlapping whip cracks instead of buffering them', async () => {
  let complete;
  let count = 0;
  const { controller, advance } = setup({ send: () => { count++; return new Promise(resolve => { complete = resolve; }); } });
  await controller.arm();
  const first = controller.send();
  advance(5000);
  assert.equal((await controller.send()).status, 'cooldown');
  complete({ status: 'submitted' });
  await first;
  assert.equal(count, 1);
  assert.equal((await controller.send()).status, 'cooldown');
});

test('enforces cooldown after completion and then accepts another message', async () => {
  const { controller, calls, advance } = setup();
  await controller.arm();
  await controller.send();
  advance(1499);
  assert.equal((await controller.send()).status, 'cooldown');
  advance(1);
  assert.equal((await controller.send()).status, 'submitted');
  assert.equal(calls.length, 2);
});

test('focus failure invalidates binding and is never retried', async () => {
  let count = 0;
  const { controller, advance } = setup({ send: async () => { count++; throw new Error('Focus changed'); } });
  await controller.arm();
  await assert.rejects(controller.send(), /Focus changed/);
  advance(5000);
  assert.equal((await controller.send()).status, 'unbound');
  assert.equal(count, 1);
});

test('fill-only and unconfirmed submission both require reactivation', async () => {
  for (const [mode, status] of [['fill', 'filled'], ['enter', 'unconfirmed']]) {
    const { controller, advance } = setup({ send: async () => ({ status }) });
    await controller.arm();
    assert.equal((await controller.send(mode)).status, status);
    advance(5000);
    assert.equal((await controller.send()).status, 'unbound');
  }
});

test('hiding during asynchronous binding cannot arm a hidden overlay', async () => {
  let complete;
  const { controller } = setup({ bind: () => new Promise(resolve => { complete = resolve; }) });
  const binding = controller.arm();
  controller.disarm();
  complete({ token: 'late' });
  assert.equal(await binding, null);
  assert.equal((await controller.send()).status, 'unbound');
});

test('failed reactivation discards the previous target', async () => {
  let count = 0;
  const { controller } = setup({ bind: async () => { if (++count > 1) throw new Error('Draft present'); return { token: 'old' }; } });
  await controller.arm();
  await assert.rejects(controller.arm(), /Draft present/);
  assert.equal((await controller.send()).status, 'unbound');
});

test('invalid mode produces no input', async () => {
  const { controller, calls } = setup();
  await controller.arm();
  await assert.rejects(controller.send('interrupt'), /Invalid submit mode/);
  assert.equal(calls.length, 0);
});

test('a confirmed submission with changed focus disarms without pretending it failed', async () => {
  const { controller, advance } = setup({ send: async () => ({status:'submitted', requiresRebind:true}) });
  await controller.arm();
  assert.equal((await controller.send()).status,'submitted');
  assert.equal(controller.state.armed,false);
  advance(5000);
  assert.equal((await controller.send()).status,'unbound');
});

test('hiding while input is pending cancels the worker and suppresses late success', async () => {
  let complete;
  let stopped = 0;
  const { controller } = setup({
    send: () => new Promise(resolve => { complete = resolve; }),
    stop: () => { stopped++; },
  });
  await controller.arm();
  const sending = controller.send();
  controller.disarm();
  complete({ status: 'submitted' });
  assert.equal((await sending).status, 'cancelled');
  assert.equal(stopped, 1);
  assert.equal(controller.state.armed, false);
});

test('quickly rebinding does not bypass the send cooldown', async () => {
  const { controller, advance } = setup();
  await controller.arm();
  await controller.send();
  controller.disarm();
  await controller.arm();
  assert.equal((await controller.send()).status, 'cooldown');
  advance(1500);
  assert.equal((await controller.send()).status, 'submitted');
});
