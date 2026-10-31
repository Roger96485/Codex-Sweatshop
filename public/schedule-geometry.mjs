const MINUTE = 60_000;
const FIVE_HOURS = 300 * MINUTE;
const DATE_LIMIT = 8.64e15;

function timeValue(value) {
  if (value == null || value === '') return null;
  const time = value instanceof Date ? value.getTime()
    : typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(time) && Math.abs(time) <= DATE_LIMIT ? time : null;
}

function requireTime(value, label = 'Time') {
  const time = timeValue(value);
  if (time == null) throw new TypeError(`${label} must be an epoch timestamp or valid date.`);
  return time;
}

function viewport(start, end) {
  start = requireTime(start, 'Viewport start');
  end = requireTime(end, 'Viewport end');
  if (end <= start || !Number.isSafeInteger(end - start)) {
    throw new RangeError('Viewport end must follow its start within a safe timestamp range.');
  }
  return { start, end };
}

function numberOption(value, fallback, name, positive = false) {
  const number = value == null ? fallback : Number(value);
  if (!Number.isFinite(number) || (positive ? number <= 0 : number < 0)) {
    throw new RangeError(`${name} must be ${positive ? 'positive' : 'nonnegative'} and finite.`);
  }
  return number;
}

function packCards(ordered) {
  const groups = [];
  let group = [];
  let groupBottom = -Infinity;
  for (const item of ordered) {
    if (group.length && item.top >= groupBottom) {
      groups.push(group);
      group = [];
    }
    group.push(item);
    groupBottom = group.length === 1 ? item.bottom : Math.max(groupBottom, item.bottom);
  }
  if (group.length) groups.push(group);
  return groups.flatMap(cards => {
    const laneBottoms = [];
    const packed = cards.map(item => {
      let column = laneBottoms.findIndex(bottom => bottom <= item.top);
      if (column < 0) column = laneBottoms.length;
      laneBottoms[column] = item.bottom;
      return { ...item, column };
    });
    return packed.map(item => ({ ...item, columns: laneBottoms.length }));
  });
}

/** Round absolute UTC time to the nearest step. Ties round toward the later instant. */
export function snapTime(instant, incrementMinutes = 15) {
  const time = requireTime(instant);
  const step = numberOption(incrementMinutes, 15, 'incrementMinutes', true) * MINUTE;
  if (!Number.isSafeInteger(step)) throw new RangeError('Snap increment must be an exact millisecond duration.');
  const snapped = Math.round(time / step) * step;
  if (!Number.isSafeInteger(snapped) || Math.abs(snapped) > DATE_LIMIT) {
    throw new RangeError('Snapped time is outside the supported timestamp range.');
  }
  return Object.is(snapped, -0) ? 0 : snapped;
}

/** Dragging sets a snapped startup time. */
export function dropSchedule(instant, incrementMinutes = 15) {
  return { mode: 'exact', at: new Date(snapTime(instant, incrementMinutes)).toISOString() };
}

/** Node drops select a window; Alt selects an exact time. Both preserve their own scheduling semantics. */
export function taskDropSchedule(instant,nodes,{altKey=false,shiftKey=false,now=Date.now()}={}) {
  const time=requireTime(instant);
  if(altKey)return dropSchedule(time,shiftKey?5:15);
  const future=(Array.isArray(nodes)?nodes:[]).filter(node=>node.kind==='fiveHour'&&node.startWindow!==false&&timeValue(node.time)>now);
  if(!future.length)return null;
  const closest=future.reduce((best,node)=>Math.abs(timeValue(node.time)-time)<Math.abs(timeValue(best.time)-time)?node:best);
  return {mode:'window',windowStart:new Date(requireTime(closest.time)).toISOString()};
}

/** Extra weekly endpoints are controls, outside the task scheduling coordinate range. */
export function weeklyAppendix(nodes,start,end) {
  ({start,end}=viewport(start,end));
  const weekly=(Array.isArray(nodes)?nodes:[]).filter(node=>node.kind==='week'&&timeValue(node.time)>=start)
    .sort((a,b)=>timeValue(a.time)-timeValue(b.time));
  const count=weekly.some(node=>timeValue(node.time)<=end)?1:2;
  return weekly.filter(node=>timeValue(node.time)>end).slice(0,count);
}

/** True five-hour bands intersecting a viewport, aligned to any live or manual anchor. */
export function fiveHourWindows(anchor, start, end) {
  anchor = requireTime(anchor, 'Window anchor');
  ({ start, end } = viewport(start, end));
  const first = anchor + Math.floor((start - anchor) / FIVE_HOURS) * FIVE_HOURS;
  const count = Math.ceil((end - first) / FIVE_HOURS);
  if (count > 10_000) throw new RangeError('Window viewport is too large.');
  return Array.from({ length: count }, (_, index) => {
    const time = first + index * FIVE_HOURS;
    if (Math.abs(time) > DATE_LIMIT || Math.abs(time + FIVE_HOURS) > DATE_LIMIT) {
      throw new RangeError('Window boundary is outside the supported timestamp range.');
    }
    const start = new Date(time).toISOString();
    return { id: start, start, end: new Date(time + FIVE_HOURS).toISOString() };
  });
}

/**
 * Build a monotonic piecewise timeline. Only supplied event times receive minimum
 * spacing; the viewport endpoints are mapping knots, rather than extra event labels.
 * Serializable points/segments let a renderer or test locate times without guessing a
 * global pixels-per-minute ratio. Mapping clamps outside the requested time range.
 */
export function createTimelineScale(start, end, eventTimes = [], options = {}) {
  ({ start, end } = viewport(start, end));
  const pxPerHour = numberOption(options.pxPerHour, 28, 'pxPerHour', true);
  const minEventGap = numberOption(options.minEventGap, 60, 'minEventGap');
  const paddingTop = numberOption(options.paddingTop, 24, 'paddingTop');
  const paddingBottom = numberOption(options.paddingBottom, 24, 'paddingBottom');
  const eventSet = new Set((Array.isArray(eventTimes) ? eventTimes : [])
    .map(event => timeValue(event && typeof event === 'object' && !(event instanceof Date) ? event.time : event))
    .filter(time => time != null && time >= start && time <= end));
  const times = [...new Set([start, end, ...eventSet])].sort((a, b) => a - b);
  const points = [];
  let y = paddingTop;
  for (let index = 0; index < times.length; index++) {
    if (index) {
      const previous = times[index - 1];
      const natural = (times[index] - previous) / (60 * MINUTE) * pxPerHour;
      const minimum = eventSet.has(previous) && eventSet.has(times[index]) ? minEventGap : 0;
      y += Math.max(natural, minimum);
    }
    if (!Number.isFinite(y)) throw new RangeError('Timeline pixel height is too large.');
    points.push({ time: times[index], y });
  }
  const segments = points.slice(1).map((point, index) => ({
    start: points[index].time, end: point.time, yStart: points[index].y, yEnd: point.y,
  }));
  const height = points.at(-1).y + paddingBottom;
  if (!Number.isFinite(height)) throw new RangeError('Timeline pixel height is too large.');

  function segmentAt(value, key) {
    let lower = 0;
    let upper = segments.length - 1;
    while (lower < upper) {
      const middle = Math.floor((lower + upper) / 2);
      if (value < segments[middle][key]) upper = middle;
      else lower = middle + 1;
    }
    return segments[lower];
  }

  function timeToY(instant) {
    const time = Math.max(start, Math.min(end, requireTime(instant)));
    const segment = segmentAt(time, 'end');
    return segment.yStart + (time - segment.start) / (segment.end - segment.start)
      * (segment.yEnd - segment.yStart);
  }

  function yToTime(position) {
    position = Number(position);
    if (!Number.isFinite(position)) throw new RangeError('Timeline position must be finite.');
    const pixel = Math.max(points[0].y, Math.min(points.at(-1).y, position));
    const segment = segmentAt(pixel, 'yEnd');
    return Math.round(segment.start + (pixel - segment.yStart) / (segment.yEnd - segment.yStart)
      * (segment.end - segment.start));
  }

  return { start, end, height, points, segments, timeToY, yToTime };
}

/**
 * A compact start-event timeline: fixed-height cards, real five-hour reset markers, and
 * no hourly labels. Only card rectangles reserve lanes.
 * Items need only {id,start}; cards appear in the requested half-open viewport.
 */
export function compactTimelineLayout(items, start, end, options = {}) {
  ({ start, end } = viewport(start, end));
  const cardHeight = numberOption(options.cardHeight, 42, 'cardHeight', true);
  const cardGap = numberOption(options.cardGap, 8, 'cardGap');
  const paddingBottom = numberOption(options.paddingBottom, 24, 'paddingBottom');
  const visible = (Array.isArray(items) ? items : []).map(item => ({
    id: item?.id, start: timeValue(item?.start),
  })).filter(item => item.start != null && item.start >= start && item.start < end);
  const markerMap = new Map();
  function mark(time, kind, taskId, source, node) {
    if (time == null || time < start || time > end) return;
    if (!markerMap.has(time)) markerMap.set(time, { time, kinds: new Set(), taskIds: new Set(), sources: new Set(),resetNodes:[] });
    const marker = markerMap.get(time);
    marker.kinds.add(kind);
    if (taskId != null) marker.taskIds.add(taskId);
    if (source) marker.sources.add(source);
    if (node)marker.resetNodes.push(node);
  }
  const now = options.now === null ? null : timeValue(options.now ?? Date.now());
  mark(now, 'now');
  for(const node of Array.isArray(options.nodes)?options.nodes:[])mark(timeValue(node.time),'reset',null,node.certainty,node);
  for (const window of options.nodes ? [] : Array.isArray(options.windows) ? options.windows : []) {
    const from = timeValue(window?.start);
    const to = timeValue(window?.end);
    // The compact axis never invents a non-five-hour reset period from a display label.
    if (from == null || to == null || to - from !== FIVE_HOURS) continue;
    mark(from, 'reset', null, window.source);
    mark(to, 'reset', null, window.source);
  }
  for (const item of visible) mark(item.start, 'task', item.id);
  const scale = createTimelineScale(start, end, [...markerMap.keys()], options);
  const markers = [...markerMap.values()].sort((a, b) => a.time - b.time).map(marker => ({
    time: marker.time, y: scale.timeToY(marker.time),
    kinds: ['now', 'reset', 'task'].filter(kind => marker.kinds.has(kind)),
    taskIds: [...marker.taskIds].sort((a, b) => String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0),
    sources: [...marker.sources].sort(),
    ...(options.nodes?{resetNodes:marker.resetNodes}:{}),
  }));

  const positions = new Map(visible.map(item => [item.id, {
    top: scale.timeToY(item.start),
    bottom: scale.timeToY(item.start) + cardHeight + cardGap,
  }]));
  const height = [...positions.values()].reduce((height, item) => Math.max(height, item.top + cardHeight + paddingBottom), scale.height);
  const packed = packCards(visible.map(item => ({
    id: item.id, top: positions.get(item.id).top, bottom: positions.get(item.id).bottom,
  })).sort((a, b) => a.top - b.top
    || (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0)));
  return {
    items: packed.map(item => ({
      id: item.id, top: positions.get(item.id).top, height: cardHeight,
      column: item.column, columns: item.columns, left: item.column * 100 / item.columns, width: 100 / item.columns,
    })),
    markers, scale, height,
  };
}
