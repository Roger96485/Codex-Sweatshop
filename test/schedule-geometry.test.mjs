import test from 'node:test';
import assert from 'node:assert/strict';
import { snapTime, dropSchedule, fiveHourWindows, createTimelineScale, compactTimelineLayout } from '../public/schedule-geometry.mjs';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const START = Date.parse('2026-10-03T00:00:00.000Z');
const iso = time => new Date(time).toISOString();

test('UTC snapping rounds to a chosen increment, with ties toward later time', () => {
  assert.equal(snapTime(START + 7 * MINUTE), START);
  assert.equal(snapTime(START + 7.5 * MINUTE), START + 15 * MINUTE);
  assert.equal(snapTime(iso(START + 8 * MINUTE), 5), START + 10 * MINUTE);
  assert.equal(snapTime(-7.5 * MINUTE, 15), 0);
  assert.throws(() => snapTime('invalid'), TypeError);
  assert.throws(() => snapTime(START, 0), RangeError);
});

test('startup drops produce exact ISO schedules at the selected snap step', () => {
  assert.deepEqual(dropSchedule(START + 8 * MINUTE), { mode: 'exact', at: iso(START + 15 * MINUTE) });
  assert.deepEqual(dropSchedule(START + 8 * MINUTE, 5), { mode: 'exact', at: iso(START + 10 * MINUTE) });
});

test('five-hour bands honor a non-midnight live anchor and span viewport boundaries', () => {
  const anchor = START - 2 * HOUR;
  const windows = fiveHourWindows(iso(anchor), START, START + 24 * HOUR);
  assert.equal(windows[0].start, iso(anchor));
  assert.equal(windows.at(-1).end, iso(START + 28 * HOUR));
  assert.equal(windows.length, 6);
  assert.ok(windows.every(window => Date.parse(window.end) - Date.parse(window.start) === 5 * HOUR));
  const aligned = fiveHourWindows(START + 15 * HOUR, START, START + 5 * HOUR);
  assert.deepEqual(aligned, [{ id: iso(START), start: iso(START), end: iso(START + 5 * HOUR) }]);
});


test('compact scale keeps natural five-hour spacing and expands nearby real event labels', () => {
  const scale = createTimelineScale(START, START + 10 * HOUR,
    [START, START + 5 * HOUR, START + 5 * HOUR + MINUTE]);
  assert.equal(scale.timeToY(START + 5 * HOUR) - scale.timeToY(START), 140);
  assert.equal(scale.timeToY(START + 5 * HOUR + MINUTE) - scale.timeToY(START + 5 * HOUR), 60);
  assert.deepEqual(scale.points.map(point => point.time), [START, START + 5 * HOUR, START + 5 * HOUR + MINUTE, START + 10 * HOUR]);
  assert.deepEqual(Object.keys(scale.segments[0]), ['start', 'end', 'yStart', 'yEnd']);
  assert.deepEqual(JSON.parse(JSON.stringify(scale.segments)), scale.segments);
});

test('piecewise mapping roundtrips densely sampled times and supports inverse drag snapping', () => {
  const scale = createTimelineScale(START, START + 30 * HOUR,
    [START, START + 2 * HOUR, START + 2 * HOUR + MINUTE, START + 7 * HOUR]);
  let previous = -Infinity;
  for (let minute = 0; minute <= 30 * 60; minute++) {
    const time = START + minute * MINUTE;
    const y = scale.timeToY(time);
    assert.ok(y > previous);
    assert.ok(Math.abs(scale.yToTime(y) - time) <= 1);
    previous = y;
  }
  const shortSegmentTime = START + 2 * HOUR + 20_000;
  assert.equal(snapTime(scale.yToTime(scale.timeToY(shortSegmentTime)), 15), START + 2 * HOUR);
  assert.equal(scale.yToTime(-100), START);
  assert.equal(scale.yToTime(scale.height + 100), START + 30 * HOUR);
});

test('compact markers merge coincident now/reset/task times without hourly labels', () => {
  const windows = fiveHourWindows(START, START, START + 30 * HOUR).map(window => ({ ...window, source: 'projected' }));
  const result = compactTimelineLayout([
    { id: 'a', start: START + 5 * HOUR }, { id: 'b', start: START + 5 * HOUR },
  ], START, START + 30 * HOUR, { windows, now: START + 5 * HOUR });
  const combined = result.markers.find(marker => marker.time === START + 5 * HOUR);
  assert.deepEqual(combined.kinds, ['now', 'reset', 'task']);
  assert.deepEqual(combined.taskIds, ['a', 'b']);
  assert.deepEqual(combined.sources, ['projected']);
  assert.equal(result.markers.length, 7);
  assert.ok(result.markers.every(marker => marker.y === result.scale.timeToY(marker.time)));
  assert.ok(result.items.every(item => item.height === 42 && item.columns === 2 && item.width === 50));
});

test('startup cards have a fixed height independent of spacing between starts', () => {
  const result = compactTimelineLayout([
    { id: 'first', start: iso(START + HOUR) },
    { id: 'later', start: START + 29 * HOUR },
  ], START, START + 30 * HOUR, { now: null });
  assert.ok(result.items.every(item => item.height === 42 && item.columns === 1));
  assert.equal(result.items.find(item => item.id === 'later').column, 0);
});

test('nearby startup cards use separate lanes only when their visual rectangles overlap', () => {
  const tasks = [{ id: 'first', start: START }, { id: 'second', start: START + 5 * MINUTE }];
  const expanded = compactTimelineLayout(tasks, START, START + HOUR, { now: null });
  assert.ok(expanded.items.every(item => item.columns === 1));
  assert.equal(expanded.items[1].top - expanded.items[0].top, 60);
  const dense = compactTimelineLayout(tasks, START, START + HOUR, { now: null, minEventGap: 0 });
  assert.ok(dense.items.every(item => item.columns === 2));
  assert.equal(dense.items[1].column, 1);
});

test('a connected group of visual card overlaps keeps stable widths and reuses free lanes', () => {
  const result = compactTimelineLayout([
    { id: 'first', start: START }, { id: 'middle', start: START + 40 * MINUTE },
    { id: 'last', start: START + 80 * MINUTE }, { id: 'separate', start: START + 3 * HOUR },
  ], START, START + 4 * HOUR, { now: null, pxPerHour: 60, minEventGap: 0 });
  assert.deepEqual(result.items.map(item => [item.id,item.column,item.columns,item.width]), [
    ['first',0,2,50], ['middle',1,2,50], ['last',0,2,50], ['separate',0,1,100],
  ]);
});

test('compact cards exclude old start times and endpoints while preserving a middle now marker', () => {
  const result = compactTimelineLayout([
    { id: 'old', start: START - HOUR }, { id: 'visible', start: START + HOUR },
    { id: 'at-end', start: START + 3 * HOUR },
  ], START, START + 3 * HOUR, { now: START + 2 * HOUR });
  assert.deepEqual(result.items.map(item => item.id), ['visible']);
  assert.equal(result.items[0].columns, 1);
  assert.deepEqual(result.markers.map(marker => [marker.time, marker.kinds]), [
    [START + HOUR, ['task']], [START + 2 * HOUR, ['now']],
  ]);
  assert.equal(result.scale.timeToY(START + HOUR) - result.scale.timeToY(START), 28);
});

test('compact endpoint cards fit within returned surface height, even with fractional timestamps', () => {
  const from = START + 17;
  const end = from + 30 * HOUR;
  const tasks = [{ id: 'tail', start: end - 30_005 }];
  const result = compactTimelineLayout(tasks, from, end, { now: from + 7_123 });
  assert.equal(result.items[0].height, 42);
  assert.ok(result.items[0].top + result.items[0].height <= result.height);
  assert.ok(Math.abs(result.scale.yToTime(result.scale.timeToY(tasks[0].start)) - tasks[0].start) <= 1);
});

test('compact start-event layout assigns deterministic columns without time estimates', () => {
  const tasks = [
    { id: 'z', start: START }, { id: 'a', start: START }, { id: 'later', start: START + 2 * HOUR },
  ];
  const options = { now: null };
  assert.deepEqual(compactTimelineLayout(tasks, START, START + 5 * HOUR, options).items,
    compactTimelineLayout([...tasks].reverse(), START, START + 5 * HOUR, options).items);
  const later = compactTimelineLayout(tasks, START, START + 5 * HOUR, options).items.find(item => item.id === 'later');
  assert.equal(later.columns, 1);
});

test('compact reset markers reject fabricated non-five-hour windows and maintain DST absolute cadence', () => {
  const beforeJump = Date.parse('2026-03-08T01:55:00-05:00');
  const afterJump = Date.parse('2026-03-08T03:05:00-04:00');
  assert.equal(snapTime(beforeJump, 15), Date.parse('2026-03-08T07:00:00Z'));
  const windows = fiveHourWindows(beforeJump, beforeJump, beforeJump + 30 * HOUR);
  windows.push({ start: beforeJump + HOUR, end: beforeJump + 7 * HOUR });
  const result = compactTimelineLayout([], beforeJump, beforeJump + 30 * HOUR, { windows, now: null });
  assert.equal(result.markers.length, 7);
  assert.ok(Math.abs(result.scale.timeToY(afterJump) - result.scale.timeToY(beforeJump) - 10 / 60 * 28) < 1e-10);
  assert.equal(result.scale.timeToY(beforeJump + 5 * HOUR) - result.scale.timeToY(beforeJump), 140);
});
