const MINUTE = 60_000;
const FIVE_HOURS = 300 * MINUTE;
const HORIZON = 14 * 24 * 60 * MINUTE;
const MAX_WINDOWS = 20_162;
const PENDING = new Set(['queued', 'scheduled', 'waiting_quota', 'waiting_session']);

/** A fresh anchor is generated for each new installation, rather than baked into the build. */
export function defaultSettings(now = Date.now()) {
  const time = milliseconds(now) ?? Date.now();
  return {
    schedulerEnabled: true,
    windowAnchor: iso(Math.floor(time / MINUTE) * MINUTE),
    windowMinutes: 300,
    tasksPerWindow: 1,
    graceMinutes: 15,
    quietHours: { enabled: false, start: '09:00', end: '18:00' },
    startingFrom: null,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    binary: '',
    codexHome: '',
  };
}

// Useful for callers that need to inspect the shape; new stores should call defaultSettings().
export const defaults = Object.freeze(defaultSettings());

function milliseconds(value) {
  if (value == null || value === '') return null;
  const number = value instanceof Date ? value.getTime()
    : typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(number) && Math.abs(number) <= 8.64e15 ? number : null;
}

function resetTime(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'string' && !/^\d+(\.\d+)?$/.test(value)) return milliseconds(value);
  const number = Number(value);
  return Number.isFinite(number) ? milliseconds(number < 1e12 ? number * 1000 : number) : null;
}

function iso(value) { return new Date(value).toISOString(); }
const integer = (value, fallback, min, max) => Number.isFinite(Number(value))
  ? Math.min(max, Math.max(min, Math.floor(Number(value)))) : fallback;

function config(settings, now) {
  const initial = defaultSettings(now);
  return {
    ...initial,
    ...settings,
    windowAnchor: iso(milliseconds(settings?.windowAnchor) ?? milliseconds(initial.windowAnchor)),
    windowMinutes: integer(settings?.windowMinutes, 300, 1, 20_160),
    tasksPerWindow: integer(settings?.tasksPerWindow, 1, 1, 100),
    quietHours: { ...initial.quietHours, ...settings?.quietHours },
  };
}

function buckets(limits) {
  if (!limits || typeof limits !== 'object') return [];
  const entries = Object.entries(limits.rateLimitsByLimitId ?? {})
    .filter(([, value]) => value && typeof value === 'object')
    .sort(([a], [b]) => a === 'codex' ? -1 : b === 'codex' ? 1 : a.localeCompare(b));
  if (limits.rateLimits && typeof limits.rateLimits === 'object') entries.push(['legacy', limits.rateLimits]);
  if (!entries.length && ('primary' in limits || 'secondary' in limits)) entries.push(['legacy', limits]);
  return entries;
}

function periods(bucket) {
  return Object.values(bucket ?? {}).filter(value => value && typeof value === 'object'
    && ('usedPercent' in value || 'windowDurationMins' in value));
}

function cadence(limits, settings, now) {
  const candidates = buckets(limits).flatMap(([, bucket]) => periods(bucket))
    .filter(period => Number(period.windowDurationMins) === 300 && resetTime(period.resetsAt) != null);
  // A model's weekly primary does not imply that there is no five-hour secondary.
  const live = candidates.find(period => {
    const reset = resetTime(period.resetsAt);
    return reset > now && reset - FIVE_HOURS <= now;
  });
  const period = live ?? candidates[0];
  const duration = period ? FIVE_HOURS : settings.windowMinutes * MINUTE;
  const anchor = period ? resetTime(period.resetsAt) - duration : milliseconds(settings.windowAnchor);
  const start = anchor + Math.floor((now - anchor) / duration) * duration;
  return { start, duration, source: live ? 'live' : period ? 'projected' : 'manual' };
}

function windowAt(start, duration, capacity, source = 'projected') {
  return { id: iso(start), start: iso(start), end: iso(start + duration), source, capacity };
}

/** The first window contains now. Only a fresh backend snapshot is labelled live. */
export function quotaWindows(limits, settings = {}, now = Date.now(), count = 10, options = {}) {
  now = milliseconds(now) ?? Date.now();
  settings = config(settings, now);
  const { start, duration, source } = cadence(limits, settings, now);
  count = integer(count, 10, 0, MAX_WINDOWS);
  const nodes=(options.nodes??[]).filter(node=>node.kind==='fiveHour'&&node.startWindow!==false&&milliseconds(node.time)>now)
    .sort((a,b)=>milliseconds(a.time)-milliseconds(b.time));
  if(nodes.length) {
    const starts=[Math.min(start,milliseconds(nodes[0].time)-duration),...nodes.map(node=>milliseconds(node.time))];
    while(starts.length<=count)starts.push(starts.at(-1)+duration);
    return Array.from({length:count},(_,index)=>windowAt(starts[index],starts[index+1]-starts[index],settings.tasksPerWindow,
      index===0&&nodes[0].certainty==='confirmed'?'live':'projected'));
  }
  return Array.from({ length: count }, (_, index) => windowAt(
    start + index * duration, duration, settings.tasksPerWindow, index ? 'projected' : source,
  ));
}

function clockMinutes(value) {
  if (typeof value !== 'string' || !/^\d{2}:\d{2}$/.test(value)) return null;
  const [hour, minute] = value.split(':').map(Number);
  return hour < 24 && minute < 60 ? hour * 60 + minute : null;
}

function quietClock(settings, warnings) {
  if (!settings.quietHours.enabled) return null;
  const start = clockMinutes(settings.quietHours.start);
  const end = clockMinutes(settings.quietHours.end);
  if (start == null || end == null) {
    warnings.push('Invalid reserved hours format; reserved hours are ignored for this plan.');
    return null;
  }
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: settings.timezone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit',
    });
  } catch {
    warnings.push(`Invalid time zone ${settings.timezone}; reserved hours use Asia/Shanghai.`);
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Shanghai', hourCycle: 'h23', hour: '2-digit', minute: '2-digit',
    });
  }
  return { start, end, formatter };
}

function nextAllowed(candidate, end, quiet) {
  if (!quiet) return candidate < end ? candidate : null;
  if (quiet.start === quiet.end) return null; // Equal endpoints reserve the whole day.
  // Walk real UTC minutes, so both missing and repeated daylight-saving clock hours work.
  for (let time = candidate; time < end; time = Math.floor(time / MINUTE) * MINUTE + MINUTE) {
    const parts = quiet.formatter.formatToParts(time);
    const hour = Number(parts.find(part => part.type === 'hour').value) % 24;
    const minute = Number(parts.find(part => part.type === 'minute').value);
    const local = hour * 60 + minute;
    const reserved = quiet.start < quiet.end
      ? local >= quiet.start && local < quiet.end : local >= quiet.start || local < quiet.end;
    if (!reserved) return time;
  }
  return null;
}

/** Check the real dispatch time, including delays spent connecting or resuming. */
export function automaticStartBlock(settings, now = Date.now()) {
  const quiet = quietClock(config(settings, now), []);
  const allowed = nextAllowed(now, now + HORIZON, quiet);
  return allowed === now ? null : {
    reason: 'Automatic tasks cannot start during reserved hours.',
    until: iso(allowed ?? now + HORIZON),
  };
}

function taskOrder(a, b) {
  const aAuto = a.task.schedule?.mode === 'auto';
  const bAuto = b.task.schedule?.mode === 'auto';
  if (aAuto !== bAuto) return aAuto ? 1 : -1;
  if (aAuto) {
    const aOrder = Number.isSafeInteger(a.task.autoOrder) && a.task.autoOrder >= 0 ? a.task.autoOrder : null;
    const bOrder = Number.isSafeInteger(b.task.autoOrder) && b.task.autoOrder >= 0 ? b.task.autoOrder : null;
    if (aOrder !== bOrder) return aOrder == null ? 1 : bOrder == null ? -1 : aOrder - bOrder;
  }
  return integer(b.task.priority, 0, 0, 100) - integer(a.task.priority, 0, 0, 100)
    || (milliseconds(a.task.createdAt) ?? 0) - (milliseconds(b.task.createdAt) ?? 0)
    || a.index - b.index;
}

/**
 * Explicit dates reserve capacity first; automatic tasks fill the following fourteen days.
 * The planner is pure. The store owns statuses, persisted dates, and retry transitions.
 */
export function planTasks(tasks, settings = {}, limits = null, now = Date.now(), options = {}) {
  now = milliseconds(now) ?? Date.now();
  settings = config(settings, now);
  const grid = cadence(limits, settings, now);
  const horizon = now + HORIZON;
  const windows = quotaWindows(limits, settings, now, Math.ceil(HORIZON / grid.duration) + 1, options)
    .filter(window => milliseconds(window.start) < horizon);
  const windowMap = new Map(windows.map(window => [window.id, window]));
  const warnings = [], issues = {};
  const warn = (task, message) => { warnings.push(message); issues[task.id] = message; };
  const quiet = quietClock(settings, warnings);
  const assignments = [];
  const allTasks = Array.isArray(tasks) ? tasks : [];
  // Actual dispatches keep consuming the window's user-defined capacity after a task
  // finishes. A pending retry consumes its old run's slot and its new assignment's slot.
  const assignmentTimes = [];
  for (const task of allTasks) {
    const seen = new Set();
    for (const run of Array.isArray(task?.runs) ? task.runs : []) {
      const started = milliseconds(run?.startedAt);
      const key = run?.id == null ? `time:${started}` : `id:${run.id}`;
      if (started == null || started < grid.start || seen.has(key)) continue;
      seen.add(key);
      assignmentTimes.push(started);
    }
  }
  const occupancy = new Map(windows.map(window => [window.id, assignmentTimes.filter(time =>
    time >= milliseconds(window.start) && time < milliseconds(window.end)).length]));
  const candidates = allTasks.map((task, index) => ({ task, index }))
    .filter(({ task }) => task && PENDING.has(task.status) && task.schedule?.mode && task.schedule.mode !== 'manual')
    .sort(taskOrder);
  const label = task => task.title || task.id || 'Untitled task';

  function obtainWindow(start, end = start + grid.duration) {
    const id = iso(start);
    if (!windowMap.has(id)) {
      const window = windowAt(start, end - start, settings.tasksPerWindow);
      windows.push(window);
      windowMap.set(id, window);
      occupancy.set(id, assignmentTimes.filter(time => time >= start && time < end).length);
    }
    return windowMap.get(id);
  }

  function containingWindow(time) {
    const forecast=windows.find(window=>time>=milliseconds(window.start)&&time<milliseconds(window.end));
    if(forecast)return forecast;
    return obtainWindow(grid.start + Math.floor((time - grid.start) / grid.duration) * grid.duration);
  }

  function assign(task, time, window) {
    assignments.push({
      taskId: task.id, scheduledAt: iso(time), windowStart: window.start, windowEnd: window.end,
    });
    assignmentTimes.push(time);
    for (const other of windows) {
      if (time >= milliseconds(other.start) && time < milliseconds(other.end)) {
        occupancy.set(other.id, occupancy.get(other.id) + 1);
      }
    }
  }

  // Once a persisted job is due, reconnecting or editing another job must not erase its
  // due date. Periodic refill also preserves future commitments to avoid endlessly moving
  // now + one minute forward. Explicit user planning may still reorder future jobs.
  const preserved = new Set();
  const shifted = [];
  for (const { task, index } of candidates) {
    const committed = milliseconds(task.scheduledAt);
    const notBefore = milliseconds(task.notBefore) ?? committed;
    const preserve = options.preserveCommitted === true || (committed <= now && notBefore <= now);
    if (task.status !== 'queued' && committed != null && preserve) {
      const time = Math.max(committed, notBefore);
      const start = milliseconds(task.windowStart);
      const end = milliseconds(task.windowEnd);
      preserved.add(index);
      let pinned = null;
      if (task.schedule?.mode === 'window') {
        const pinnedStart = milliseconds(task.schedule.windowStart);
        if (pinnedStart == null) {
          warn(task, `"${label(task)}" is missing a valid specified window.`);
          continue;
        }
        const pinnedEnd = start === pinnedStart && end != null && end > pinnedStart
          ? end : pinnedStart + grid.duration;
        pinned = obtainWindow(pinnedStart, pinnedEnd);
        const waiting = task.status === 'waiting_quota' || task.status === 'waiting_session';
        if (waiting && pinnedEnd <= now) {
          warn(task, `The specified window for "${label(task)}" has ended. Reschedule the task.`);
          continue;
        }
        if (time !== committed && time >= pinnedEnd) {
          warn(task, `The deferred time for "${label(task)}" is beyond the specified window; it was not moved to another window automatically.`);
          continue;
        }
      }
      // Only newly deferred future dates need another quiet-hour check. Unchanged due
      // dates must reach the runner intact, including its normal missed-job handling.
      if (task.schedule?.mode !== 'exact' && time !== committed && time > now) {
        shifted.push({ task, time, pinned });
        continue;
      }
      const window = start != null && end != null && start <= time && time < end
        ? obtainWindow(start, end) : containingWindow(time);
      assign(task, time, window);
    }
  }

  // Reserve unchanged commitments first so a shifted retry cannot take their slot.
  for (const { task, time, pinned } of shifted) {
    if (pinned) {
      const allowed = nextAllowed(Math.max(time, milliseconds(pinned.start)), milliseconds(pinned.end), null);
      if (occupancy.get(pinned.id) >= pinned.capacity || allowed == null) {
        warn(task, `The specified window for "${label(task)}" has no available start time; it was not moved to another window automatically.`);
      } else assign(task, allowed, pinned);
      continue;
    }
    const search = windows.filter(window => milliseconds(window.start) < horizon
      && milliseconds(window.end) > now)
      .sort((a, b) => milliseconds(a.start) - milliseconds(b.start));
    let planned = false;
    for (const window of search) {
      if (occupancy.get(window.id) >= window.capacity) continue;
      const allowed = nextAllowed(Math.max(time, milliseconds(window.start)),
        Math.min(milliseconds(window.end), horizon), quiet);
      if (allowed == null) continue;
      assign(task, allowed, window);
      planned = true;
      break;
    }
    if (!planned) warn(task, `"${label(task)}" has no available window in the next 14 days after deferral. Adjust its schedule.`);
  }

  const unplanned = candidates.filter(({ index }) => !preserved.has(index));
  const exact = unplanned.filter(({ task }) => task.schedule?.mode === 'exact');
  for (const { task } of exact) {
    const at = milliseconds(task.schedule.at);
    if (at == null) {
      warn(task, `"${label(task)}" is missing a valid exact start time.`);
      continue;
    }
    const time = Math.max(at, milliseconds(task.notBefore) ?? at);
    const window = containingWindow(time);
    if (occupancy.get(window.id) >= window.capacity) {
      warn(task, `The exact time for "${label(task)}" exceeds this window's task capacity; the specified time is preserved.`);
    }
    assign(task, time, window);
  }

  for (const { task } of unplanned.filter(({ task }) => task.schedule?.mode === 'window')) {
    const start = milliseconds(task.schedule.windowStart);
    if (start == null) {
      warn(task, `"${label(task)}" is missing a valid specified window.`);
      continue;
    }
    const window = obtainWindow(start);
    const end = milliseconds(window.end);
    if (end <= now) {
      warn(task, `The specified window for "${label(task)}" has ended. Reschedule the task.`);
      continue;
    }
    if (occupancy.get(window.id) >= window.capacity) {
      warn(task, `The specified window for "${label(task)}" is full; it was not moved to another window automatically.`);
      continue;
    }
    const earliest = Math.max(now + MINUTE, start, milliseconds(task.notBefore) ?? 0);
    const time = nextAllowed(earliest, end, null);
    if (time == null) {
      warn(task, `The specified window for "${label(task)}" has no available start time. Reschedule the task.`);
      continue;
    }
    assign(task, time, window);
  }

  const selectedStart = milliseconds(settings.startingFrom);
  const includeCurrent = settings.startingFrom === 'now' || (selectedStart != null && selectedStart <= now);
  const autoWindows = windows.filter(window => milliseconds(window.start) < horizon
    && (includeCurrent ? milliseconds(window.end) > now : milliseconds(window.start) > now)
    && (selectedStart == null || milliseconds(window.start) >= selectedStart || (includeCurrent && milliseconds(window.start) <= now && milliseconds(window.end) > now)))
    .sort((a, b) => milliseconds(a.start) - milliseconds(b.start));
  const available = new Map(autoWindows.map(window => [window.id, nextAllowed(
    Math.max(milliseconds(window.start), now + MINUTE), Math.min(milliseconds(window.end), horizon), quiet,
  )]));
  const deferredCache = new Map();
  for (const { task } of unplanned.filter(({ task }) => task.schedule?.mode === 'auto')) {
    let planned = false;
    const notBefore = milliseconds(task.notBefore) ?? 0;
    for (const window of autoWindows) {
      if (occupancy.get(window.id) >= window.capacity) continue;
      let time = available.get(window.id);
      if (time == null) continue;
      if (notBefore > time) {
        const key = `${window.id}:${notBefore}`;
        if (!deferredCache.has(key)) deferredCache.set(key, nextAllowed(
          notBefore, Math.min(milliseconds(window.end), horizon), quiet,
        ));
        time = deferredCache.get(key);
      }
      if (time == null) continue;
      assign(task, time, window);
      planned = true;
      break;
    }
    if (!planned) warn(task, `"${label(task)}" has no available window in the next 14 days. Increase capacity or adjust its schedule.`);
  }

  for (const { task } of candidates) {
    if (task.schedule?.mode && !['exact', 'window', 'auto'].includes(task.schedule.mode)) {
      warn(task, `Invalid scheduling mode for "${label(task)}".`);
    }
  }
  windows.sort((a, b) => milliseconds(a.start) - milliseconds(b.start));
  assignments.sort((a, b) => milliseconds(a.scheduledAt) - milliseconds(b.scheduledAt));
  return { assignments, windows, warnings, issues };
}

/** Select the model's own metered bucket before falling back to the general Codex bucket. */
export function quotaBucket(limits, model) {
  const entries = buckets(limits);
  return entries.find(([, value]) => model && value.normalModelSlug === model)
    ?? entries.find(([id, value]) => id === 'codex' || value.limitId === 'codex')
    ?? entries.find(([id]) => id === 'legacy') ?? null;
}

export function quotaBlock(limits, model, now = Date.now()) {
  if (!limits || typeof limits !== 'object') return null;
  now = milliseconds(now) ?? Date.now();
  const bucket = quotaBucket(limits, model)?.[1];
  if (!bucket) return limits.ordinaryUsageAllowed === false
    ? { reason: 'The server does not currently allow use of the quota included with this account.', until: null } : null;

  const allPeriods = periods(bucket);
  const exhausted = allPeriods.filter(period => Number(period.usedPercent) >= 100);
  const reached = bucket.rateLimitReachedType ?? bucket.reachedType;
  const remaining = bucket.individualLimit?.remainingPercent;
  const spend = bucket.spendControlReached === true
    || (remaining != null && Number.isFinite(Number(remaining)) && Number(remaining) <= 0);
  if (spend || (reached && reached !== 'rate_limit_reached')) {
    const reset = resetTime(bucket.individualLimit?.resetsAt);
    return {
      reason: reached ? `Account quota is restricted: ${reached}.` : 'The account has reached its spending limit.',
      until: reset == null ? null : iso(Math.max(now + MINUTE, reset + 5000)),
    };
  }
  if (exhausted.length) {
    const resets = exhausted.map(period => resetTime(period.resetsAt));
    const until = resets.some(reset => reset == null) ? null : Math.max(...resets) + 5000;
    const stale = until != null && until <= now;
    return {
      reason: stale ? 'Quota is exhausted and reset data is stale. Waiting for a fresh quota reading.'
        : 'The selected model has exhausted its quota. Waiting for all restricted periods to reset.',
      until: until == null ? null : iso(stale ? now + MINUTE : until),
    };
  }
  if (reached === 'rate_limit_reached' || limits.ordinaryUsageAllowed === false) {
    const resets = allPeriods.map(period => resetTime(period.resetsAt)).filter(reset => reset != null && reset > now);
    return {
      reason: reached ? 'The server reports that the account quota is exhausted.' : 'The server does not currently allow use of the quota included with this account.',
      until: resets.length ? iso(Math.min(...resets) + 5000) : null,
    };
  }
  return null;
}
