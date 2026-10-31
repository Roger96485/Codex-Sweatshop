const test = require('node:test');
const assert = require('node:assert/strict');
const { createGestureDetector } = require('../lib/gesture-detector');
const settings = require('../openwhip.config.json').gesture;
test('requires both large displacement and high speed; jitter and slow motion do not trigger', () => {
  for (const [distance,time] of [[200,40],[400,160],[20,9]]) {
    const d=createGestureDetector(settings); d.sample(0,0,0); assert.equal(d.sample(distance,0,time),false);
  }
  const d=createGestureDetector(settings); d.sample(0,0,0); assert.equal(d.sample(360,0,90),true);
});
test('gesture cooldown prevents one continued movement from cycling multiple entries', () => {
  const d=createGestureDetector(settings); d.sample(0,0,0); assert.equal(d.sample(360,0,90),true);
  assert.equal(d.sample(0,0,120),false); assert.equal(d.sample(1000,0,200),false);
  d.sample(0,0,1000); assert.equal(d.sample(360,0,1090),true);
});
