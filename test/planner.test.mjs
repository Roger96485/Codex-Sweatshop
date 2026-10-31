import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultSettings, quotaWindows, planTasks, quotaBlock, automaticStartBlock } from '../src/planner.mjs';

const NOW = Date.parse('2026-10-03T00:00:00.000Z');
const HOUR = 3_600_000;
const MINUTE = 60_000;
const stamp = value => new Date(value).toISOString();
const settings = changes => ({ ...defaultSettings(NOW), ...changes });
const period = (minutes, reset, usedPercent = 20) => ({
  windowDurationMins: minutes, resetsAt: reset / 1000, usedPercent,
});
const task = (id, priority = 0, schedule = { mode: 'auto' }, overrides = {}) => ({
  id, title: id, status: 'queued', priority, createdAt: stamp(NOW), schedule, ...overrides,
});

test('starting from uses exact shifted reset nodes and optionally the current window',()=>{
  const nodes=[1,6,11].map(hour=>({kind:'fiveHour',time:stamp(NOW+hour*HOUR+17_000)}));
  const chosen=nodes[1].time;
  const future=planTasks([task('a'),task('b')],settings({startingFrom:chosen}),null,NOW,{nodes});
  assert.deepEqual(future.assignments.map(a=>a.scheduledAt),[chosen,nodes[2].time]);
  const current=planTasks([task('a')],settings({startingFrom:'now'}),null,NOW,{nodes});
  assert.equal(current.assignments[0].scheduledAt,stamp(NOW+MINUTE));
  const standard=planTasks([task('a')],settings(),null,NOW,{nodes});
  assert.equal(standard.assignments[0].scheduledAt,nodes[0].time);
});

test('reserved hours block actual automatic starts with inclusive start and exclusive end',()=>{
  const cfg=settings({timezone:'UTC',quietHours:{enabled:true,start:'09:00',end:'18:00'}});
  assert.equal(automaticStartBlock(cfg,NOW+9*HOUR).until,stamp(NOW+18*HOUR));
  assert.equal(automaticStartBlock(cfg,NOW+18*HOUR),null);
  assert.equal(automaticStartBlock(cfg,NOW+8*HOUR+59*MINUTE),null);
  cfg.quietHours={enabled:true,start:'22:00',end:'07:00'};
  assert.equal(automaticStartBlock(cfg,NOW+23*HOUR).until,stamp(NOW+31*HOUR));
  assert.equal(automaticStartBlock(cfg,NOW+6*HOUR).until,stamp(NOW+7*HOUR));
});

test('new settings enable scheduled dispatch and have a dynamic minute-rounded anchor', () => {
  const defaults = defaultSettings(NOW + 35_000);
  assert.equal(defaults.schedulerEnabled, true);
  assert.equal(defaults.windowAnchor, stamp(NOW));
  assert.equal(defaults.tasksPerWindow, 1);
  assert.equal(defaults.windowMinutes, 300);
  assert.equal(defaults.timezone, Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  assert.notEqual(defaultSettings(NOW).quietHours, defaultSettings(NOW).quietHours);
});

test('finds the actual five-hour secondary across model buckets before legacy', () => {
  const limits = {
    rateLimitsByLimitId: {
      codex: { primary: period(10_080, NOW + 100 * HOUR) },
      premium: { primary: period(10_080, NOW + 120 * HOUR), secondary: period(300, NOW + 2 * HOUR) },
    },
    rateLimits: { primary: period(300, NOW + 4 * HOUR) },
  };
  const windows = quotaWindows(limits, settings(), NOW, 3);
  assert.deepEqual(windows[0], {
    id: stamp(NOW - 3 * HOUR), start: stamp(NOW - 3 * HOUR), end: stamp(NOW + 2 * HOUR),
    source: 'live', capacity: 1,
  });
  assert.equal(windows[1].start, windows[0].end);
  assert.equal(windows[1].source, 'projected');
  assert.equal(windows[2].end, stamp(NOW + 12 * HOUR));
});

test('missing limits use manual anchors, including anchors in the future', () => {
  const windows = quotaWindows(null, settings({ windowAnchor: stamp(NOW + 12 * HOUR) }), NOW, 2);
  assert.equal(windows[0].start, stamp(NOW - 3 * HOUR));
  assert.equal(windows[0].source, 'manual');
  assert.equal(windows[1].source, 'projected');
  assert.equal(quotaWindows({}, settings(), NOW, 0).length, 0);
});

test('expired live data preserves the cadence but is labelled projected', () => {
  const limits = { rateLimits: { primary: period(300, NOW - 2 * HOUR) } };
  const windows = quotaWindows(limits, settings(), NOW, 1);
  assert.equal(windows[0].start, stamp(NOW - 2 * HOUR));
  assert.equal(windows[0].end, stamp(NOW + 3 * HOUR));
  assert.equal(windows[0].source, 'projected');
  const invalid = quotaWindows({ rateLimits: { primary: period(300, null) } }, settings(), NOW, 1);
  assert.equal(invalid[0].source, 'projected'); // A Unix epoch reset is still a cadence, not live data.
});

test('automatic order is priority descending, then FIFO', () => {
  const tasks = [
    task('low', 10),
    task('new-high', 90, undefined, { createdAt: stamp(NOW - 1 * MINUTE) }),
    task('old-high', 90, undefined, { createdAt: stamp(NOW - 2 * MINUTE) }),
    task('done', 100, undefined, { status: 'completed' }),
  ];
  const result = planTasks(tasks, settings(), null, NOW);
  assert.deepEqual(result.assignments.map(item => item.taskId), ['old-high', 'new-high', 'low']);
  assert.equal(result.assignments[0].scheduledAt, stamp(NOW + 5 * HOUR));
  assert.equal(result.assignments[1].scheduledAt, stamp(NOW + 10 * HOUR));
  assert.equal(result.assignments[2].scheduledAt, stamp(NOW + 15 * HOUR));
  assert.deepEqual(result.warnings, []);
});

test('manual pending tasks neither receive assignments nor reserve committed capacity', () => {
  const result = planTasks([
    task('manual', 100, { mode: 'manual' }, {
      status: 'scheduled', scheduledAt: stamp(NOW + MINUTE),
      windowStart: stamp(NOW), windowEnd: stamp(NOW + 5 * HOUR),
    }),
    task('implicit-manual', 100, null, { status: 'scheduled', scheduledAt: stamp(NOW + MINUTE) }),
    task('auto', 0),
  ], settings(), null, NOW, { preserveCommitted: true });
  assert.deepEqual(result.assignments.map(item => item.taskId), ['auto']);
  assert.equal(result.assignments[0].scheduledAt, stamp(NOW + 5 * HOUR));
  assert.deepEqual(result.warnings, []);
});

test('explicit automatic order takes precedence, with priority FIFO retained for legacy entries', () => {
  const result = planTasks([
    task('legacy-low', 1),
    task('second', 100, { mode: 'auto' }, { autoOrder: 1 }),
    task('legacy-high', 90),
    task('first', 0, { mode: 'auto' }, { autoOrder: 0 }),
  ], settings(), null, NOW);
  assert.deepEqual(result.assignments.map(item => item.taskId), ['first', 'second', 'legacy-high', 'legacy-low']);
});

test('exact and fixed windows consume capacity before automatic tasks', () => {
  const result = planTasks([
    task('auto', 100),
    task('fixed', 0, { mode: 'window', windowStart: stamp(NOW + 5 * HOUR) }),
    task('exact', 0, { mode: 'exact', at: stamp(NOW + HOUR) }),
  ], settings(), null, NOW);
  const map = new Map(result.assignments.map(item => [item.taskId, item]));
  assert.equal(map.get('exact').scheduledAt, stamp(NOW + HOUR));
  assert.equal(map.get('fixed').scheduledAt, stamp(NOW + 5 * HOUR));
  assert.equal(map.get('auto').scheduledAt, stamp(NOW + 10 * HOUR));
});

test('executed tasks retain current-window capacity after completion or interruption', () => {
  for (const status of ['running', 'awaiting_approval', 'succeeded', 'failed', 'interrupted', 'uncertain']) {
    const result = planTasks([
      task('executed', 100, undefined, { status, runs: [{ id: 'run-1', status, startedAt: stamp(NOW + 10 * MINUTE) }] }),
      task('next'),
    ], settings(), null, NOW + HOUR);
    assert.deepEqual(result.assignments.map(item => item.taskId), ['next']);
    assert.equal(result.assignments[0].scheduledAt, stamp(NOW + 5 * HOUR), status);
  }
});

test('old actual runs and unstarted preflight failures do not reserve current capacity', () => {
  const result = planTasks([
    task('old', 100, undefined, { status: 'succeeded', runs: [{ id: 'old', startedAt: stamp(NOW - MINUTE) }] }),
    task('failed-before-dispatch', 100, undefined, { status: 'failed', runs: [] }),
    task('next'),
  ], settings(), null, NOW + HOUR);
  assert.equal(result.assignments[0].scheduledAt, stamp(NOW + 5 * HOUR));
});

test('distinct retries reserve distinct slots and duplicate run records count once', () => {
  const first = { id: 'run-1', status: 'failed', startedAt: stamp(NOW + MINUTE) };
  const second = { id: 'run-2', status: 'succeeded', startedAt: stamp(NOW + 2 * MINUTE) };
  const result = planTasks([
    task('executed', 0, undefined, { status: 'succeeded', runs: [first, { ...first }, second] }),
    task('next'),
  ], settings({ tasksPerWindow: 2 }), null, NOW + HOUR);
  assert.equal(result.assignments[0].scheduledAt, stamp(NOW + 5 * HOUR));
});

test('pending retries consume previous actual capacity and exactly one new reservation', () => {
  const result = planTasks([
    task('retry', 100, undefined, { runs: [{ id: 'old', startedAt: stamp(NOW + MINUTE), status: 'failed' }] }),
    task('next'),
  ], settings({ tasksPerWindow: 2 }), null, NOW + HOUR);
  assert.equal(result.assignments[0].taskId, 'retry');
  assert.equal(result.assignments[0].scheduledAt, stamp(NOW + 5 * HOUR));
  assert.equal(result.assignments[1].scheduledAt, stamp(NOW + 5 * HOUR));
});

test('full fixed windows and past fixed windows are never silently migrated', () => {
  const result = planTasks([
    task('high', 100, { mode: 'window', windowStart: stamp(NOW) }),
    task('low', 10, { mode: 'window', windowStart: stamp(NOW) }),
    task('past', 100, { mode: 'window', windowStart: stamp(NOW - 5 * HOUR) }),
  ], settings(), null, NOW);
  assert.deepEqual(result.assignments.map(item => item.taskId), ['high']);
  assert.ok(result.warnings.some(message => message.includes('low') && message.includes('is full')));
  assert.ok(result.warnings.some(message => message.includes('past') && message.includes('has ended')));
});

test('exact overbooking preserves user dates and produces a warning', () => {
  const exact = at => ({ mode: 'exact', at: stamp(at) });
  const result = planTasks([task('one', 0, exact(NOW + HOUR)), task('two', 0, exact(NOW + 2 * HOUR))], settings(), null, NOW);
  assert.equal(result.assignments.length, 2);
  assert.equal(result.warnings.length, 1);
  assert.equal(result.assignments[1].scheduledAt, stamp(NOW + 2 * HOUR));
});

test('quiet hours use the selected IANA timezone and exact times remain user-controlled', () => {
  const cfg = settings({ quietHours: { enabled: true, start: '12:00', end: '14:00' } });
  const result = planTasks([
    task('auto'),
    task('exact', 0, { mode: 'exact', at: stamp(NOW + 30 * MINUTE) }),
  ], { ...cfg, tasksPerWindow: 2 }, null, NOW);
  const map = new Map(result.assignments.map(item => [item.taskId, item]));
  assert.equal(map.get('auto').scheduledAt, stamp(NOW + 6 * HOUR));
  assert.equal(map.get('exact').scheduledAt, stamp(NOW + 30 * MINUTE));
});

test('overnight quiet hours do not skip the first free minute', () => {
  const now = Date.parse('2026-10-03T15:30:12.000Z'); // 23:30 in Shanghai.
  const result = planTasks([task('night')], settings({
    windowAnchor: stamp(now), quietHours: { enabled: true, start: '22:00', end: '07:00' },
  }), null, now);
  assert.equal(result.assignments[0].scheduledAt, '2026-10-03T23:00:00.000Z');
  assert.ok(Date.parse(result.assignments[0].windowStart) > now);
});

test('quiet hours walk actual UTC minutes across a daylight-saving jump', () => {
  const now = Date.parse('2026-03-08T06:50:00.000Z'); // New York 01:50, then jumps to 03:00.
  const result = planTasks([task('dst')], settings({
    windowAnchor: '2026-03-08T02:00:00.000Z', timezone: 'America/New_York',
    quietHours: { enabled: true, start: '01:00', end: '03:30' },
  }), null, now);
  assert.equal(result.assignments[0].scheduledAt, '2026-03-08T07:30:00.000Z');
});

test('retry notBefore is respected in automatic, fixed and exact schedules', () => {
  const deferred = stamp(NOW + 4 * HOUR);
  for (const mode of ['auto', 'window', 'exact']) {
    const schedule = { mode, at: stamp(NOW + HOUR), windowStart: stamp(NOW) };
    const result = planTasks([task(mode, 0, schedule, { notBefore: deferred, status: 'waiting_quota' })], settings(), null, NOW);
    assert.equal(result.assignments[0].scheduledAt, mode==='auto'?stamp(NOW+5*HOUR):deferred);
  }
  const fullDelay = planTasks([task('fixed-delay', 0, {
    mode: 'window', windowStart: stamp(NOW),
  }, { notBefore: stamp(NOW + 6 * HOUR) })], settings(), null, NOW);
  assert.equal(fullDelay.assignments.length, 0);
  assert.equal(fullDelay.warnings.length, 1);
});

test('persisted due dates survive reconnect and replan so the runner can mark missed jobs', () => {
  const yesterday = NOW - 24 * HOUR;
  const result = planTasks([
    task('overdue-auto', 0, { mode: 'auto' }, { status: 'scheduled', scheduledAt: stamp(yesterday) }),
    task('overdue-fixed', 0, { mode: 'window', windowStart: stamp(yesterday - HOUR) }, {
      status: 'scheduled', scheduledAt: stamp(yesterday + HOUR),
    }),
    task('quota-ready', 0, { mode: 'auto' }, {
      status: 'waiting_quota', scheduledAt: stamp(yesterday), notBefore: stamp(NOW - MINUTE),
    }),
  ], settings(), null, NOW);
  const dates = new Map(result.assignments.map(item => [item.taskId, item.scheduledAt]));
  assert.equal(dates.get('overdue-auto'), stamp(yesterday));
  assert.equal(dates.get('overdue-fixed'), stamp(yesterday + HOUR));
  assert.equal(dates.get('quota-ready'), stamp(NOW - MINUTE));
});

test('rolling refill preserves future committed dates while the clock advances', () => {
  const committed = stamp(NOW + MINUTE);
  const pending = task('committed', 0, { mode: 'auto' }, {
    status: 'scheduled', scheduledAt: committed, windowStart: stamp(NOW), windowEnd: stamp(NOW + 5 * HOUR),
  });
  for (const later of [NOW + 5000, NOW + 30_000, NOW + 55_000]) {
    const result = planTasks([pending, task('new-high-priority', 100)], settings(), null, later, { preserveCommitted: true });
    assert.equal(result.assignments[0].taskId, 'committed');
    assert.equal(result.assignments[0].scheduledAt, committed);
    assert.equal(result.assignments[0].windowStart, pending.windowStart);
    assert.equal(result.assignments[0].windowEnd, pending.windowEnd);
    assert.equal(result.assignments[1].scheduledAt, stamp(NOW + 5 * HOUR));
  }
  const explicit = planTasks([pending, task('new-high-priority', 100)], settings(), null, NOW + 5000);
  assert.equal(explicit.assignments[0].taskId, 'new-high-priority');
});

test('rolling refill keeps waiting jobs deferred instead of moving before notBefore', () => {
  const result = planTasks([task('waiting', 0, undefined, {
    status: 'waiting_quota', scheduledAt: stamp(NOW + MINUTE), notBefore: stamp(NOW + 2 * HOUR),
    windowStart: stamp(NOW), windowEnd: stamp(NOW + 5 * HOUR),
  })], settings(), null, NOW + 5000, { preserveCommitted: true });
  assert.equal(result.assignments[0].scheduledAt, stamp(NOW + 2 * HOUR));
  assert.equal(result.assignments[0].windowStart, stamp(NOW));
});

test('preserved automatic quota retries skip quiet hours and continue into later windows', () => {
  const result = planTasks([task('waiting', 0, undefined, {
    status: 'waiting_quota', scheduledAt: stamp(NOW + MINUTE), notBefore: stamp(NOW + 2 * HOUR),
    windowStart: stamp(NOW), windowEnd: stamp(NOW + 5 * HOUR),
  })], settings({ quietHours: { enabled: true, start: '09:00', end: '18:00' } }), null, NOW,
  { preserveCommitted: true });
  assert.equal(result.assignments[0].scheduledAt, stamp(NOW + 10 * HOUR));
  assert.equal(result.assignments[0].windowStart, stamp(NOW + 10 * HOUR));
});

test('specified windows ignore automatic reserved hours but retain their pinned window', () => {
  const waiting = task('fixed-waiting', 0, { mode: 'window', windowStart: stamp(NOW) }, {
    status: 'waiting_quota', scheduledAt: stamp(NOW + MINUTE), notBefore: stamp(NOW + 2 * HOUR),
    windowStart: stamp(NOW), windowEnd: stamp(NOW + 5 * HOUR),
  });
  const fits = planTasks([waiting], settings({ quietHours: { enabled: true, start: '09:00', end: '11:00' } }),
    null, NOW, { preserveCommitted: true });
  assert.equal(fits.assignments[0].scheduledAt, stamp(NOW + 2 * HOUR));
  assert.equal(fits.assignments[0].windowStart, waiting.schedule.windowStart);
  const doesNotFit = planTasks([waiting], settings({ quietHours: { enabled: true, start: '09:00', end: '18:00' } }),
    null, NOW, { preserveCommitted: true });
  assert.equal(doesNotFit.assignments[0].scheduledAt, stamp(NOW + 2 * HOUR));
  assert.equal(doesNotFit.assignments[0].windowStart, waiting.schedule.windowStart);
});

test('preserved waiting fixed jobs cannot migrate after their pinned window expires', () => {
  const waiting = task('fixed-waiting', 0, { mode: 'window', windowStart: stamp(NOW) }, {
    status: 'waiting_session', scheduledAt: stamp(NOW + MINUTE), notBefore: stamp(NOW + 3 * HOUR),
    windowStart: stamp(NOW), windowEnd: stamp(NOW + 5 * HOUR),
  });
  const expired = planTasks([waiting], settings(), null, NOW + 6 * HOUR, { preserveCommitted: true });
  assert.deepEqual(expired.assignments, []);
  assert.ok(expired.warnings[0].includes('has ended'));
  const deferredBeyondEnd = planTasks([{ ...waiting, notBefore: stamp(NOW + 6 * HOUR) }], settings(),
    null, NOW, { preserveCommitted: true });
  assert.deepEqual(deferredBeyondEnd.assignments, []);
  assert.ok(deferredBeyondEnd.warnings[0].includes('beyond the specified window'));
});

test('shifting a preserved auto retry respects other unchanged future commitments', () => {
  const result = planTasks([
    task('waiting', 100, undefined, {
      status: 'waiting_quota', scheduledAt: stamp(NOW + MINUTE), notBefore: stamp(NOW + 2 * HOUR),
    }),
    task('committed', 0, undefined, { status: 'scheduled', scheduledAt: stamp(NOW + 3 * HOUR) }),
  ], settings(), null, NOW, { preserveCommitted: true });
  const dates = new Map(result.assignments.map(item => [item.taskId, item.scheduledAt]));
  assert.equal(dates.get('committed'), stamp(NOW + 3 * HOUR));
  assert.equal(dates.get('waiting'), stamp(NOW + 5 * HOUR));
});

test('quiet hours leave unchanged due commitments and exact deferred dates intact', () => {
  const cfg = settings({ quietHours: { enabled: true, start: '08:00', end: '18:00' } });
  const due = task('due', 0, undefined, { status: 'scheduled', scheduledAt: stamp(NOW + MINUTE) });
  const exact = task('exact', 0, { mode: 'exact', at: stamp(NOW + MINUTE) }, {
    status: 'waiting_quota', scheduledAt: stamp(NOW + MINUTE), notBefore: stamp(NOW + 2 * HOUR),
  });
  const result = planTasks([due, exact], cfg, null, NOW + 2 * MINUTE, { preserveCommitted: true });
  const dates = new Map(result.assignments.map(item => [item.taskId, item.scheduledAt]));
  assert.equal(dates.get('due'), due.scheduledAt);
  assert.equal(dates.get('exact'), exact.notBefore);
});

test('rolling refill schedules previously queued jobs when the fourteen-day horizon advances', () => {
  const tasks = Array.from({ length: 70 }, (_, index) => task(`task-${index}`));
  const initial = planTasks(tasks, settings(), null, NOW);
  const committed = new Map(initial.assignments.map(item => [item.taskId, item]));
  const stored = tasks.map(item => committed.has(item.id)
    ? { ...item, ...committed.get(item.id), status: 'scheduled' } : item);
  assert.equal(committed.has('task-67'), false);
  const refilled = planTasks(stored, settings(), null, NOW + 5 * HOUR, { preserveCommitted: true });
  const dates = new Map(refilled.assignments.map(item => [item.taskId, item.scheduledAt]));
  assert.equal(dates.get('task-1'), committed.get('task-1').scheduledAt);
  assert.equal(dates.get('task-67'), stamp(NOW + 340 * HOUR));
  assert.equal(dates.has('task-68'), false);
});

test('automatic planning stops at fourteen days, but preserves explicitly distant dates', () => {
  const many = Array.from({ length: 100 }, (_, index) => task(`task-${index}`));
  const result = planTasks(many, settings(), null, NOW);
  assert.equal(result.assignments.length, 67);
  assert.equal(result.warnings.length, 33);
  assert.ok(result.assignments.every(item => Date.parse(item.scheduledAt) < NOW + 14 * 24 * HOUR));
  const far = NOW + 80 * 24 * HOUR;
  const explicit = planTasks([
    task('exact', 0, { mode: 'exact', at: stamp(far) }),
    task('window', 0, { mode: 'window', windowStart: stamp(far + 5 * HOUR) }),
  ], settings(), null, NOW);
  assert.equal(explicit.assignments.length, 2);
  assert.equal(explicit.assignments[0].scheduledAt, stamp(far));
});

test('full-day reservation and enormous notBefore values terminate with useful warnings', () => {
  const tasks = Array.from({ length: 200 }, (_, index) => task(`task-${index}`));
  const result = planTasks(tasks, settings({ quietHours: { enabled: true, start: '09:00', end: '09:00' } }), null, NOW);
  assert.equal(result.assignments.length, 0);
  assert.equal(result.warnings.length, 200);
  const deferred = planTasks([task('future', 0, undefined, { notBefore: stamp(NOW + 1000 * 24 * HOUR) })], settings(), null, NOW);
  assert.equal(deferred.assignments.length, 0);
});

test('model bucket selection checks weekly exhaustion even if five-hour quota is available', () => {
  const limits = {
    rateLimitsByLimitId: {
      codex: { primary: period(300, NOW + 2 * HOUR, 10) },
      premium: {
        normalModelSlug: 'gpt-premium', primary: period(300, NOW + HOUR, 50),
        secondary: period(10_080, NOW + 80 * HOUR, 100),
      },
    },
  };
  assert.equal(quotaBlock(limits, 'other-model', NOW), null);
  const block = quotaBlock(limits, 'gpt-premium', NOW);
  assert.equal(block.until, stamp(NOW + 80 * HOUR + 5000));
});

test('quota block waits for the latest exhausted reset and handles stale/missing reset data', () => {
  const limits = { rateLimits: {
    primary: period(300, NOW + HOUR, 100), secondary: period(10_080, NOW + 100 * HOUR, 100),
  } };
  assert.equal(quotaBlock(limits, null, NOW).until, stamp(NOW + 100 * HOUR + 5000));
  assert.equal(quotaBlock({ rateLimits: { primary: { usedPercent: 100, resetsAt: null } } }, null, NOW).until, null);
  const stale = quotaBlock({ rateLimits: { primary: period(300, NOW - HOUR, 100) } }, null, NOW);
  assert.equal(stale.until, stamp(NOW + MINUTE));
  assert.ok(stale.reason.includes('reset data is stale'));
  assert.equal(quotaBlock(null, null, NOW), null);
});

test('backend administrative restrictions stay blocked without inventing a reset', () => {
  const limits = { rateLimits: { primary: period(300, NOW + HOUR, 10), spendControlReached: true } };
  assert.equal(quotaBlock(limits, null, NOW).until, null);
  const reached = quotaBlock({ rateLimits: { rateLimitReachedType: 'workspace_owner_credits_depleted' } }, null, NOW);
  assert.equal(reached.until, null);
  assert.ok(reached.reason.includes('workspace_owner_credits_depleted'));
  assert.equal(quotaBlock({ ordinaryUsageAllowed: false, rateLimits: {} }, null, NOW).until, null);
  const individual = quotaBlock({ rateLimits: {
    individualLimit: { remainingPercent: 0, resetsAt: (NOW + 24 * HOUR) / 1000 },
  } }, null, NOW);
  assert.equal(individual.until, stamp(NOW + 24 * HOUR + 5000));
});

test('planning never mutates tasks or settings', () => {
  const cfg = settings();
  const tasks = [task('first'), task('second', 50)];
  const saved = JSON.stringify({ cfg, tasks });
  planTasks(tasks, cfg, null, NOW);
  assert.equal(JSON.stringify({ cfg, tasks }), saved);
});
