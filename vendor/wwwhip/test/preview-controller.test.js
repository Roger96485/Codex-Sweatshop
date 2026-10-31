const test = require('node:test');
const assert = require('node:assert/strict');
const { createPreviewController } = require('../lib/preview-controller');
const entries = [{ question: 'A?', message: '甲' }, { question: 'B?', message: '乙' }, { question: 'C?', message: '丙' }];
function setup(onCommit) {
  let now = 0; let serial = 0; const jobs = new Map(); const previews = []; const sends = []; let cancelled = 0;
  const controller = createPreviewController({ now:()=>now,
    schedule: (fn, ms) => { const id=++serial; jobs.set(id,{fn, at:now+ms}); return id; },
    unschedule: id=>jobs.delete(id), onPreview: value=>previews.push(value),
    onCommit: onCommit || (value=>sends.push(value.message)), onCancel: ()=>cancelled++,
  });
  controller.configure(entries);
  return { controller, previews, sends, jobs, get cancelled(){return cancelled;},
    async advance(ms) { now+=ms; for(const [id,job] of [...jobs]) if(job.at<=now) { jobs.delete(id); await job.fn(); } },
  };
}
test('first gesture previews without input, then sends its paired message after 3 seconds', async () => {
  const s=setup(); s.controller.trigger();
  assert.equal(s.previews[0].item.question,'A?');
  await s.advance(2999); assert.deepEqual(s.sends,[]);
  await s.advance(1); assert.deepEqual(s.sends,['甲']);
  await s.advance(3000); assert.deepEqual(s.sends,['甲']);
});
test('another gesture cycles in order, restarts 3 seconds, and invalidates even a queued old callback', async () => {
  const s=setup(); s.controller.trigger(); const old=[...s.jobs.values()][0].fn;
  await s.advance(2900); s.controller.trigger();
  assert.equal(s.previews.at(-1).item.question,'B?');
  await old(); await s.advance(2999); assert.deepEqual(s.sends,[]);
  await s.advance(1); assert.deepEqual(s.sends,['乙']);
  s.controller.trigger(); s.controller.trigger(); assert.equal(s.previews.at(-1).item.question,'A?');
});
test('Escape at the last millisecond cancels input and an old timer cannot revive it', async () => {
  const s=setup(); s.controller.trigger(); const old=[...s.jobs.values()][0].fn;
  await s.advance(2999); s.controller.cancel(); await old(); await s.advance(10000);
  assert.deepEqual(s.sends,[]); assert.equal(s.cancelled,1);
  s.controller.trigger(); await s.advance(3000); assert.deepEqual(s.sends,['乙']);
});
test('reload/hide invalidate pending previews and messages are snapshotted', async () => {
  const s=setup(); const rows=[{question:'original',message:'original'}]; s.controller.configure(rows);
  s.controller.trigger(); rows[0].message='changed'; await s.advance(3000); assert.deepEqual(s.sends,['original']);
  s.controller.trigger(); s.controller.configure(entries); await s.advance(3000); assert.deepEqual(s.sends,['original']);
});
test('automatic strike and submission cannot start another countdown recursively', async () => {
  let finish; const s=setup(()=>new Promise(resolve=>{finish=resolve;})); s.controller.trigger();
  const completing=s.advance(3000); assert.equal(s.controller.phase,'committing');
  assert.equal(s.controller.trigger(),false); finish(); await completing;
  assert.equal(s.controller.phase,'idle');
});
