import { compactTimelineLayout, taskDropSchedule, weeklyAppendix } from '/schedule-geometry.mjs';
import {createWhipUi} from '/wwwhip.js';
import {elicitationFields,elicitationUrl,elicitationResponse} from '/elicitation.mjs';
'use strict';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const E = escapeHtml;
const desktop = window.sweatshopDesktop || null;
const whipUi=createWhipUi({api,refresh,desktop});
const EDITABLE = new Set(['queued','scheduled','paused','waiting_quota','waiting_session','failed','missed','interrupted','uncertain','succeeded']);
const DRAGGABLE = new Set(['queued','scheduled','paused','waiting_quota','waiting_session','missed']);
const ENDED = new Set(['succeeded','failed','interrupted','uncertain','cancelled','canceled']);
const STATUS = {
  queued: ['Unscheduled', 'neutral'], scheduled: ['Scheduled', 'green'], running: ['Running', 'orange'],
  awaiting_approval: ['Awaiting approval', 'orange'], succeeded: ['Completed', 'green'], failed: ['Failed', 'red'],
  interrupted: ['Interrupted', 'red'], uncertain: ['Needs confirmation', 'orange'], missed: ['Missed', 'neutral'],
  waiting_quota: ['Waiting for quota', 'orange'], waiting_session: ['Waiting for conversation', 'blue'], paused: ['Paused', 'neutral'],
  cancelled: ['Cancelled', 'neutral'], canceled: ['Cancelled', 'neutral']
};
const ICON = {
  clock: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  model: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Zm0 0v18M4 7.5l8 4.5 8-4.5"/></svg>',
  chat: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 15a3 3 0 0 1-3 3H9l-6 3V6a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3Z"/></svg>',
  folder: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7V5h7l2 2h9v13H3Z"/></svg>',
  unlocked:'<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 7.5-2M12 14v3"/></svg>',
  locked:'<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/></svg>'
};

let state = {tasks: [], settings: {}, connection: {}, models: [], limits: null, quota:{periods:{},nodes:[],plans:[]}, windows: [], approvals: []};
const shownActivationErrors=new Set();
let activationErrorsInitialized=false;
let expandedTaskId = null;
let settingsPending = 0, settingsWrites = Promise.resolve(), fetchingState = false, fetchQueued = false;
let pendingConfirmation = null;
let composerModelsKey = '';
const threadPickers = {composer:{data:[],cursor:null,version:0,timer:null}};
const threadNames = new Map(), filePreviews = new Map(), fileReads = new Map();
let PX_PER_HOUR = 28, timelineAnchor = Math.floor(Date.now()/60000)*60000, timelineScale = null;
let viewportReady = false, interaction = null, scrollFrame = null, suppressClickUntil = 0, renderPending = false, composerDirty = false, composerSaving = false, editingTaskSnapshot = null, creationDraft = null;

function toast(message, error = false) {
  const element = document.createElement('div');
  element.className = `toast${error ? ' error' : ''}`;
  element.textContent = message;
  $('#toast-region').append(element);
  setTimeout(() => element.remove(), error ? 9000 : 4500);
}

async function api(path, {method = 'GET', body} = {}) {
  const response = await fetch(path, {
    method, credentials: 'same-origin',
    headers: body === undefined ? {'Accept': 'application/json'} : {'Accept': 'application/json', 'Content-Type': 'application/json'},
    ...(body === undefined ? {} : {body: JSON.stringify(body)})
  });
  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await response.json() : {error: await response.text()};
  if (!response.ok) {
    const message = typeof data.error === 'string' ? data.error : data.error?.message || data.message || `Request failed (${response.status})`;
    throw new Error(message);
  }
  return data;
}

async function refresh({quiet = true} = {}) {
  if (fetchingState) { fetchQueued = true; return; }
  fetchingState = true;
  try {
    const next = await api('/api/state');
    initializeActivationErrors(next.quota);
    state = {...state, ...next};
    state.tasks = Array.isArray(next.tasks) ? next.tasks : [];
    state.windows = Array.isArray(next.windows) ? next.windows : [];
    state.approvals = Array.isArray(next.approvals) ? next.approvals : [];
    state.models = Array.isArray(next.models) ? next.models : (next.models?.data || []);
    render();
  } catch (error) {
    state.connection = {...state.connection, connected:false, lastError:error.message};
    renderChrome();
    if (!quiet) toast(error.message, true);
  } finally {
    fetchingState = false;
    if (fetchQueued) { fetchQueued = false; refresh(); }
  }
}

function timeZone() {
  const zone = state.settings?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
  try { new Intl.DateTimeFormat('en-GB', {timeZone: zone}).format(); return zone; } catch { return 'Asia/Shanghai'; }
}
function asDate(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = new Date(typeof value === 'number' && Math.abs(value) < 1e11 ? value * 1000 : value);
  return Number.isNaN(date.getTime()) ? null : date;
}
function fmt(value, options = {}) {
  const date = asDate(value);
  return date ? new Intl.DateTimeFormat('en-GB', {timeZone: timeZone(), hour12: false, ...options}).format(date) : '—';
}
function time(value) { return fmt(value, {hour: '2-digit', minute: '2-digit'}); }
function dateTime(value) { return fmt(value, {month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'}); }
function fullDateTime(value) { return fmt(value, {year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'}); }
function partsAt(value) {
  const date = asDate(value);
  if (!date) return null;
  return Object.fromEntries(new Intl.DateTimeFormat('en-CA', {timeZone: timeZone(), year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'}).formatToParts(date).map(part => [part.type, part.value]));
}
function toInput(value) {
  const parts = partsAt(value);
  return parts ? `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}` : '';
}
function duration(start, end) {
  const a = asDate(start), b = asDate(end);
  if (!a || !b) return 'Still running';
  const seconds = Math.max(0, Math.round((b - a) / 1000));
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
  return `${Math.floor(seconds / 3600)} h ${Math.floor(seconds % 3600 / 60)} min`;
}
function badge(status) {
  const [label, color] = STATUS[status] || [status || 'Unconfirmed', 'neutral'];
  return `<span class="badge ${E(color)}"><span class="badge-dot" aria-hidden="true"></span>${E(label)}</span>`;
}
function modelId(model) { return model.model || model.id || ''; }
function modelName(value) {
  const model = state.models.find(entry => modelId(entry) === value || entry.id === value);
  return model?.displayName || model?.name || value || 'Codex default model';
}
function effortName(value) { return ({none:'None', minimal:'Minimal', low:'Low', medium:'Medium', high:'High', xhigh:'Extra high', max:'Max', ultra:'Ultra'})[value] || value || 'Default reasoning'; }
function speedName(value) { return ({default:'Standard', standard:'Standard', fast:'Fast', priority:'Fast', ultrafast:'Ultra Fast'})[value] || state.models.flatMap(model => model.serviceTiers || []).find(tier => tier?.id === value)?.name || value || 'Standard'; }
function taskById(id) { return state.tasks.find(task => task.id === id); }
function taskTint(task) {
  if (isAutoQueue(task)) return 'blue';
  if (task.status === 'queued' && !task.scheduledAt) return 'gray';
  if (['manual',undefined].includes(task.schedule?.mode) || ['missed','failed','uncertain','interrupted','succeeded','running','awaiting_approval'].includes(task.status)) return 'gray';
  if (task.schedule?.mode === 'exact' && plannedStart(task) !== null) return 'yellow';
  if (task.schedule?.mode === 'window' && plannedStart(task) !== null) return 'aqua';
  return 'gray';
}
function modelSummary(task) { return task.modelMode === 'inherit' ? task.target === 'existing' ? 'Conversation settings' : 'Codex defaults' : `${modelName(task.model)} · ${effortName(task.effort)} · ${speedName(task.speed)}`; }
function taskButton(action, label, id, extra = '') { return `<button type="button" class="text-button ${extra}" data-action="${E(action)}" data-task-id="${E(id)}"${action==='auto-task'?' title="Automatically fit the tasks into 5h quota windows by list order"':''}>${E(label)}</button>`; }

function empty(title, description, button = '') { return `<div class="empty-state"><h3>${E(title)}</h3>${description ? `<p>${E(description)}</p>` : ''}${button}</div>`; }
function getLimits() {
  const raw = state.limits?.result || state.limits;
  if (!raw) return [];
  const buckets = raw.rateLimitsByLimitId && Object.keys(raw.rateLimitsByLimitId).length ? raw.rateLimitsByLimitId : (raw.rateLimits ? {codex:raw.rateLimits} : {});
  const entries = Object.entries(buckets), general = entries.filter(([key,value]) => key === 'codex' || value?.limitId === 'codex');
  return (general.length ? general : entries).flatMap(([key,bucket]) => ['primary','secondary'].map(slot => bucket?.[slot] ? {...bucket[slot],limitId:bucket.limitId || key} : null).filter(Boolean));
}
const REORDERABLE = new Set(['queued','scheduled','waiting_quota','waiting_session']);
function isAutoQueue(task) { return task.schedule?.mode === 'auto' && REORDERABLE.has(task.status); }
function filterTasks() { return [...state.tasks].sort((a,b) => Number(isAutoQueue(a))-Number(isAutoQueue(b)) || (isAutoQueue(a) && isAutoQueue(b) ? (a.autoOrder ?? Infinity)-(b.autoOrder ?? Infinity) : 0) || b.priority-a.priority || asDate(a.createdAt)-asDate(b.createdAt)); }
function queueCard(task) {
  const editable = EDITABLE.has(task.status), draggable = DRAGGABLE.has(task.status) && editingTaskSnapshot?.task.id !== task.id, automatic = isAutoQueue(task), expanded = expandedTaskId === task.id;
  const scheduled = task.scheduledAt || (task.schedule?.mode === 'exact' ? task.schedule.at : null);
  const needsReview = state.approvals.some(approval => approval.taskId === task.id);
  const target = task.target === 'existing' ? task.threadTitle || threadNames.get(task.threadId) || `Existing conversation · ${String(task.threadId || '').slice(0,8)}` : task.cwd?.split(/[\\/]/).filter(Boolean).at(-1) || 'New conversation';
  const neutralState = !['queued','scheduled','paused','missed','waiting_quota','waiting_session'].includes(task.status);
  return `<article id="queue-task-${E(task.id)}" class="queue-task tint-${task.status === 'succeeded' ? 'green' : taskTint(task)}${draggable ? ' draggable-task' : ''}${expanded ? ' expanded' : ''}${ENDED.has(task.status) ? ' ended-task' : ''}${automatic ? ' auto-queue-task' : ''}${editingTaskSnapshot?.task.id === task.id ? ' is-editing' : ''}" data-task-id="${E(task.id)}" data-draggable="${draggable}" data-priority-draggable="${automatic}" tabindex="0" role="button" aria-expanded="${expanded}" aria-controls="queue-body-${E(task.id)}" aria-label="${E(task.title)}, ${E(STATUS[task.status]?.[0] || task.status)}, Press Enter to expand or collapse"><div class="queue-task-top"><h3>${E(task.title)}</h3>${neutralState ? badge(task.status) : ''}${editingTaskSnapshot?.task.id === task.id ? '<span class="badge blue editing" role="status"><span class="badge-dot" aria-hidden="true"></span>Editing</span>' : ''}<button class="icon-button expand-toggle" type="button" data-action="toggle-task" data-task-id="${E(task.id)}" aria-label="${expanded ? 'Collapse' : 'Expand'} ${E(task.title)}" aria-expanded="${expanded}" aria-controls="queue-body-${E(task.id)}"><svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg></button></div><div id="queue-body-${E(task.id)}" class="queue-task-body"${expanded ? '' : ' hidden'}><div class="task-facts"><div>${ICON.clock}<span>${scheduled ? relativeDateTime(scheduled) : 'Unscheduled'}</span></div><div>${ICON.chat}<span>${E(target)}</span></div><div>${ICON.model}<span>${E(modelSummary(task))}</span></div></div>${task.promptFile ? linkedTaskInfo(task) : ''}${task.planningError || task.lastError ? `<p class="task-error">${E(task.planningError || task.lastError)}</p>` : ''}<div class="task-actions">${editable ? taskButton('edit-task','Edit',task.id) : taskButton('view-task','View status',task.id)}${needsReview ? taskButton('open-approvals','Review request',task.id) : ''}${!['running','awaiting_approval'].includes(task.status) ? taskButton('delete-task','Delete',task.id,'danger-text') : ''}${ENDED.has(task.status) && editable ? taskButton('reschedule-task','Reschedule',task.id) : draggable && !automatic ? taskButton('auto-task','Auto-schedule',task.id) : ''}</div></div></article>`;
}
function relativeDateTime(value) {
  const date = asDate(value); if (!date) return '—';
  const day = toInput(date).slice(0,10), today = toInput(new Date()).slice(0,10);
  const [year,month,dateNumber] = today.split('-').map(Number);
  const tomorrow = new Date(Date.UTC(year,month-1,dateNumber+1)).toISOString().slice(0,10);
  return day === today ? `Today ${time(date)}` : day === tomorrow ? `Tomorrow ${time(date)}` : dateTime(date);
}
function periodName(kind) { return kind==='week'?'Weekly':'5-hour'; }
function nodeDescription(node) {return `${node.certainty === "confirmed" ? "Confirmed" : "Projected"} ${periodName(node.kind).toLowerCase()} reset${node.lock === "planned" ? " · Activation planned" : node.lock === "task" ? " · Task Scheduled" : ""}`;}
function resetControl(node) {
  const greeting=Date.parse(node.windowStart)<=Date.now()?'now':relativeDateTime(node.windowStart);
  const title=node.lock==='confirmed'||node.lock==='task'?node.disabledReason:node.lock==='planned'?(node.canCancel?`Cancel planned quota window anchoring`:node.disabledReason)
    :node.canPlan?`Anchor the ${periodName(node.kind).toLowerCase()} quota window ending here`:node.disabledReason;
  return `<button type="button" class="reset-lock${node.lock?' locked':''}" data-action="${node.lock==='planned'?'cancel-window-plan':'plan-window'}" data-node-id="${E(node.id)}" data-plan-id="${E(node.planId)}" title="${E(title)}" aria-label="${E(title)}"${node.canPlan||node.canCancel?'':' disabled'}>${node.lock?ICON.locked:ICON.unlocked}</button>`;
}
function markerMarkup(marker,byId,appendix=false) {
  const nodes=marker.resetNodes??[],confirmed=nodes.some(node=>node.certainty==='confirmed'),locked=nodes.some(node=>node.lock);
  const descriptions=[...(marker.kinds.includes('now')?['Current time']:[]),...nodes.map(nodeDescription)];
  const dragNode=nodes.find(node=>node.canDrag);
  const labels=nodes.length?nodes.map((node,index)=>`<time class="reset-node-label ${node.certainty==='projected'&&!node.lock?'node-time-projected':'node-time-fixed'}${nodes.length>1?index===0?' coincident-label-first':' coincident-label-second':''}"${node.canDrag?` data-reset-drag="${E(node.id)}"`:''} title="${E(nodeDescription(node))}">${E(relativeDateTime(marker.time))}${node.kind==='week'?'<span class="weekly-label">Week</span>':''}</time>`).join('')
    :`<time${descriptions.length?` title="${E(descriptions.join('\n'))}"`:''}>${E(relativeDateTime(marker.time))}</time>`;
  const dots=nodes.length>1?nodes.map((node,index)=>`<span class="timeline-dot dot-${node.kind==='week'?'week':'five-hour'} dot-${node.certainty} coincident-dot-${index}" title="${E(nodeDescription(node))}"${node.canDrag?` data-reset-drag="${E(node.id)}"`:''}></span>`).join('')
    :`<span class="timeline-dot"${descriptions.length?` title="${E(descriptions.join('\n'))}"`:''}${dragNode?` data-reset-drag="${E(dragNode.id)}"`:''}></span>`;
  return `<div class="timeline-marker${marker.kinds.includes('now')?' marker-now':''}${marker.kinds.includes('task')?' marker-task':''}${marker.kinds.includes('reset')?' marker-reset':''}${confirmed?' marker-confirmed':''}${nodes.some(node=>node.kind==='week')?' marker-week':''}${nodes.length&&!confirmed&&!locked?' marker-projected':''}${marker.taskIds.length?` marker-tint-${taskTint(byId.get(marker.taskIds[0])||{})}`:''}" data-time="${marker.time}" data-kinds="${E(marker.kinds.join(' '))}" data-node-ids="${E(nodes.map(node=>node.id).join(' '))}"${appendix?' data-appendix="true"':''}>${labels}${dots}<span class="reset-controls">${nodes.map(resetControl).join('')}</span><span class="timeline-rule"></span></div>`;
}
function plannedStart(task) { return asDate(task.scheduledAt || (task.schedule?.mode === 'exact' ? task.schedule.at : null))?.getTime() ?? null; }
function renderBoard() {
  const viewport = $('#schedule-board'), surface = $('#schedule-surface'), oldScrollTop = viewport.scrollTop;
  const previousTime = timelineScale?.yToTime(oldScrollTop), oldPadding = timelineScale?.points[0].y ?? 0;
  const boundaryOffset = timelineScale && previousTime !== undefined ? oldScrollTop-timelineScale.timeToY(previousTime) : 0;
  timelineAnchor = Math.floor(Date.now()/60000)*60000;
  const start=timelineAnchor,end=start+72*3600000,sameView=viewportReady;
  const nodes=state.quota?.nodes??[],now = Math.floor(Date.now()/60000)*60000;
  const tasks = state.tasks.map(task => ({id:task.id,start:plannedStart(task),task})).filter(item => item.start !== null);
  const layout = compactTimelineLayout(tasks,start,end,{nodes,now,pxPerHour:PX_PER_HOUR,minEventGap:60,cardHeight:42,cardGap:8});
  const extra=weeklyAppendix(nodes,start,end),height=layout.height+(extra.length?54+extra.length*86:0);
  timelineScale = layout.scale;
  const byId = new Map(tasks.map(item => [item.id,item.task]));
  surface.dataset.start = start; surface.dataset.end = end; surface.dataset.timelineSegments = JSON.stringify(layout.scale.segments);
  surface.dataset.pxPerHour = PX_PER_HOUR;surface.dataset.schedulingHeight=layout.height;surface.style.height = `${height}px`;
  surface.innerHTML = `<div class="timeline-axis"></div><div class="timeline-markers">${layout.markers.map(marker=>markerMarkup(marker,byId)).join('')}</div><div class="task-track">${layout.items.map(item => {
    const task = byId.get(item.id), draggable = DRAGGABLE.has(task.status) && editingTaskSnapshot?.task.id !== task.id;
    return `<article id="schedule-task-${E(task.id)}" class="schedule-task tint-${taskTint(task)}${draggable ? ' draggable-task' : ''}" data-task-id="${E(task.id)}" data-draggable="${draggable}" data-start="${plannedStart(task)}" data-column="${item.column}" data-columns="${item.columns}" tabindex="0" role="button" aria-label="${E(task.title)}, ${E(relativeDateTime(plannedStart(task)))}, ${E(STATUS[task.status]?.[0] || task.status)}, Press Enter to ${DRAGGABLE.has(task.status) ? 'Edit' : 'view'}"><div class="schedule-task-title">${E(task.title)}</div></article>`;
  }).join('')}<div id="drop-preview" class="drop-preview" hidden><strong id="drop-preview-title"></strong></div></div>`;
  if(extra.length) {
    surface.insertAdjacentHTML('beforeend','<div class="timeline-break" aria-hidden="true">⋮</div>'
      +extra.map(node=>markerMarkup({time:Date.parse(node.time),kinds:['reset'],taskIds:[],resetNodes:[node]},byId,true)).join(''));
    $('.timeline-break',surface).style.top=`${layout.height}px`;
    $$('.timeline-marker[data-appendix]',surface).forEach((element,index)=>element.style.top=`${layout.height+54+index*86}px`);
  }
  $('.timeline-axis',surface).style.height = `${height}px`;
  $$('.timeline-marker:not([data-appendix])',surface).forEach((element,index) => element.style.top = `${layout.markers[index].y}px`);
  for (const item of layout.items) {
    const element = document.getElementById(`schedule-task-${item.id}`);
    element.style.top = `${item.top}px`; element.style.height = `${item.height}px`;
    element.style.left = `calc(${item.left}% + 4px)`; element.style.width = `calc(${item.width}% - 8px)`;
  }
  $('#timeline-zoom').value = PX_PER_HOUR;
  if (sameView && oldScrollTop < oldPadding) viewport.scrollTop = oldScrollTop;
  else if (sameView && previousTime !== undefined) viewport.scrollTop = previousTime < start ? 0 : layout.scale.timeToY(previousTime)+boundaryOffset;
  else viewport.scrollTop = 0;
  viewportReady = true;
}
function renderQuota(id,minutes,label) {
  const element = document.getElementById(id), limit = getLimits().find(item => Number(item.windowDurationMins ?? item.windowMinutes) === minutes);
  const remaining = typeof limit?.usedPercent === 'number' ? Math.round(Math.max(0,Math.min(100,100-limit.usedPercent))*10)/10 : null;
  const resetDays = limit?.resetsAt ? Math.round((Date.parse(toInput(limit.resetsAt).slice(0,10))-Date.parse(toInput(new Date()).slice(0,10)))/86400000) : null;
  const window=state.quota?.periods?.[minutes===300?'fiveHour':'week'];
  const subtitle=window?.state==='floating'?'Window not anchored':window?.state==='unknown'?'Window unconfirmed':limit?.resetsAt?minutes===10080&&resetDays>=2?`In ${resetDays} days`:relativeDateTime(limit.resetsAt):'—';
  element.innerHTML = `<div><span>${E(label)}</span><strong>${remaining === null ? '—' : `${remaining}%`}</strong></div><small${['floating','unknown'].includes(window?.state)?' class="window-unanchored"':''}>${E(subtitle)}</small>`;
  element.classList.toggle('low-quota',remaining !== null && remaining < 20);
}
function renderChrome() {
  whipUi.render(state.whip);
  for(const plan of state.quota?.plans??[])if(activationErrorsInitialized&&plan.error&&!['scheduled','running'].includes(plan.status)&&!shownActivationErrors.has(activationErrorKey(plan))) {
    shownActivationErrors.add(activationErrorKey(plan));toast(plan.error,true);
  }
  const connected = Boolean(state.connection?.connected);
  $('#connection-dot').className = `status-dot${connected ? ' connected' : ''}`;
  $('#connection-label').textContent = connected ? 'Connected' : 'Disconnected';
  renderQuota('quota-five-hour',300,'5h'); renderQuota('quota-week',10080,'Week');
  const rawLimits = state.limits?.result || state.limits, summary = rawLimits?.rateLimitResetCredits;
  const count = Number.isInteger(summary?.availableCount) && summary.availableCount >= 0 ? summary.availableCount : null;
  const nearest = (Array.isArray(summary?.credits) ? summary.credits : []).filter(credit => credit.status === 'available' && asDate(credit.expiresAt)).sort((a,b) => asDate(a.expiresAt)-asDate(b.expiresAt))[0];
  $('#reset-credit-summary').innerHTML = `<div><strong>${count === null ? '—' : count}</strong><span>${count === 1 ? 'reset available' : 'resets available'}</span></div><small>${nearest ? `Expires ${E(relativeDateTime(nearest.expiresAt))}` : '—'}</small>`;
  const modelsKey = JSON.stringify(state.models);
  if (modelsKey !== composerModelsKey && !composerDirty && !composerSaving) { composerModelsKey = modelsKey; populateModels($('#composer-model').value,$('#composer-effort').value,$('#composer-speed').value,'composer'); toggleModelMode('composer'); }
}
function activationErrorKey(plan) {
  return JSON.stringify([plan.id,plan.status,plan.finishedAt??plan.cancelledAt??null,plan.error]);
}
function initializeActivationErrors(quota) {
  if(activationErrorsInitialized||!Array.isArray(quota?.plans))return;
  // The initial snapshot contains persisted history. Notify later transitions,
  // rather than replaying old failures on every launch or page reload.
  for(const plan of quota.plans)if(plan.error&&!['scheduled','running'].includes(plan.status))
    shownActivationErrors.add(activationErrorKey(plan));
  activationErrorsInitialized=true;
}
function preserveFormValues(container,markup) {
  const drafts = [...container.querySelectorAll('input[name],textarea[name],select[name]')].map(input => ({name:input.name,value:input.value,checked:input.checked,type:input.type,approvalId:input.closest('[data-approval-id]')?.dataset.approvalId}));
  container.innerHTML = markup;
  for (const saved of drafts) {
    const input = [...container.querySelectorAll('input[name],textarea[name],select[name]')].find(element => element.name === saved.name
      &&element.closest('[data-approval-id]')?.dataset.approvalId===saved.approvalId&&(!['radio','checkbox'].includes(saved.type)||element.value===saved.value));
    if (input) { if (saved.type === 'radio' || saved.type === 'checkbox') input.checked = saved.checked; else input.value = saved.value; }
  }
}
function render() {
  renderChrome();
  if (interaction) { renderPending = true; return; }
  renderPending = false;
  const viewport = $('#task-list'), scrollTop = viewport.scrollTop, tasks = filterTasks();
  viewport.innerHTML = tasks.length ? tasks.map(queueCard).join('') : empty(state.tasks.length ? 'No matching tasks' : 'No tasks yet','');
  viewport.scrollTop = scrollTop;
  renderBoard();
  if ($('#auto-settings-dialog').open && !settingsPending) {
    if(!$('#settings-form')?.contains(document.activeElement)) $('#auto-settings-content').innerHTML=renderAutoSettings();
    else if(document.activeElement!==$('#settings-starting-from')) $('#settings-starting-from').innerHTML=startingFromOptions();
  }
  if ($('#reset-credits-dialog').open) $('#reset-credits-content').innerHTML = resetCreditsCard();
  if ($('#approvals-dialog').open) preserveFormValues($('#approval-content'),approvalMarkup() || empty('No pending requests',''));
  refreshVisibleFiles();
}
function openAutoSettings() { $('#auto-settings-content').innerHTML = renderAutoSettings(); $('#auto-settings-dialog').showModal(); }
function openResetCredits() { $('#reset-credits-content').innerHTML = resetCreditsCard(); $('#reset-credits-dialog').showModal(); }
function openApprovals() { $('#approval-content').innerHTML = approvalMarkup() || empty('No pending requests',''); $('#approvals-dialog').showModal(); }
function pointerTime(event,offsetPixels=0) {
  const board = $('#schedule-board'), bounds = board.getBoundingClientRect();
  if (!timelineScale || event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) return null;
  if(event.clientY-bounds.top+board.scrollTop>Number($('#schedule-surface').dataset.schedulingHeight))return null;
  return timelineScale.yToTime(event.clientY-bounds.top+board.scrollTop-offsetPixels);
}
function setDragGhost(item,detail='') {
  const title = document.createElement('strong'), subtitle = document.createElement('span');
  title.textContent = item.task.title; subtitle.textContent = detail;
  item.ghost.replaceChildren(...(item.kind==='reset'?[title,subtitle]:[title]));
}
function clearDragTick() {
  $('#drag-time-tick')?.remove();
  $$('.drag-time-highlight').forEach(element=>element.classList.remove('drag-time-highlight'));
}
function showDragTick(time) {
  clearDragTick();
  const existing=$$('.timeline-marker:not([data-appendix])').find(marker=>Number(marker.dataset.time)===time);
  if(existing){existing.classList.add('drag-time-highlight');return;}
  const marker=document.createElement('div');marker.id='drag-time-tick';marker.className='timeline-marker drag-time-highlight';
  marker.dataset.time=time;
  marker.innerHTML='<time></time><span class="timeline-dot"></span><span class="timeline-rule"></span>';
  $('time',marker).textContent=relativeDateTime(time);marker.style.top=`${timelineScale.timeToY(time)}px`;
  $('#schedule-surface').append(marker);
}
function previewInteraction(event) {
  if (!interaction?.dragged) return;
  if(interaction.kind==='reset')return previewResetInteraction(event);
  const item = interaction, preview = $('#drop-preview');
  clearDragTick();
  item.ghost.className = `drag-ghost tint-${taskTint(item.task)}`;
  item.ghost.style.left = `${Math.min(innerWidth-260,event.clientX+15)}px`; item.ghost.style.top = `${Math.min(innerHeight-75,event.clientY+15)}px`;
  if (previewPriorityDrop(event,item)) { preview.hidden = true; return; }
  const marker = $('#priority-drop-marker'); if (marker) marker.hidden = true;
  const raw = pointerTime(event,item.offsetPixels); item.target = raw; item.dropKind = 'time';
  if (raw === null) { preview.hidden = true; item.ghost.classList.add('invalid-drop'); return; }
  item.ghost.classList.remove('invalid-drop');
  const schedule = taskDropSchedule(raw,item.snapNodes,{altKey:event.altKey,shiftKey:event.shiftKey}); item.previewSchedule = schedule;
  if(!schedule){preview.hidden=true;item.ghost.classList.add('invalid-drop');return;}
  const scheduledAt=schedule.at??schedule.windowStart,tint=schedule.mode==='window'?'aqua':'yellow';
  item.previewNodeId=event.altKey?null:item.snapNodes.find(node=>node.kind==='fiveHour'&&node.time===scheduledAt)?.id;
  const proposed = Date.parse(scheduledAt); preview.className = `drop-preview tint-${tint}`; item.ghost.className = `drag-ghost tint-${tint}`;
  preview.hidden = false; preview.style.top = `${timelineScale.timeToY(proposed)}px`; preview.style.height = '42px';
  $('#drop-preview-title').textContent = item.task.title;
  setDragGhost(item);
  if(event.altKey)showDragTick(proposed);
}
function startAutoScroll() {
  if (scrollFrame) return;
  const tick = () => {
    scrollFrame = null;
    if (!interaction?.dragged || !interaction.lastEvent) return;
    const event = interaction.lastEvent, board = $('#schedule-board'), bounds = board.getBoundingClientRect();
    if (event.clientX >= bounds.left && event.clientX <= bounds.right) {
      const edge = 54;
      const speed = event.clientY < bounds.top+edge ? -Math.max(0,Math.min(14,(bounds.top+edge-event.clientY)/4)) : event.clientY > bounds.bottom-edge ? Math.max(0,Math.min(14,(event.clientY-bounds.bottom+edge)/4)) : 0;
      if (speed) { board.scrollTop += speed; previewInteraction(event); }
    }
    if (interaction.canReorder && interaction.node.classList.contains('queue-task')) {
      const list = $('#task-list'), queueBounds = list.getBoundingClientRect(), edge = 42;
      if (event.clientX >= queueBounds.left && event.clientX <= queueBounds.right && event.clientY >= queueBounds.top && event.clientY <= queueBounds.bottom) {
        const speed = event.clientY < queueBounds.top+edge ? -Math.min(12,(queueBounds.top+edge-event.clientY)/4) : event.clientY > queueBounds.bottom-edge ? Math.min(12,(event.clientY-queueBounds.bottom+edge)/4) : 0;
        if (speed) { list.scrollTop += speed; previewInteraction(event); }
      }
    }
    scrollFrame = requestAnimationFrame(tick);
  };
  scrollFrame = requestAnimationFrame(tick);
}
function endInteraction(cancelled=false) {
  const item = interaction;
  if (!item) return null;
  interaction = null;
  if (scrollFrame) cancelAnimationFrame(scrollFrame); scrollFrame = null;
  item.ghost?.remove(); item.node?.classList.remove('is-dragging-card');
  clearDragTick();
  $$('.reset-shift-preview').forEach(element=>element.remove());$$('.reset-drag-original').forEach(element=>element.classList.remove('reset-drag-original'));
  document.body.classList.remove('is-dragging');
  if ($('#drop-preview')) $('#drop-preview').hidden = true; $('#priority-drop-marker')?.remove();
  if (item.dragged) suppressClickUntil = Date.now()+350;
  try { item.node?.releasePointerCapture(item.pointerId); } catch {}
  if (cancelled || !item.dragged) { if (item.dragged || renderPending) render(); return null; }
  return item;
}
async function commitInteraction(item) {
  if(item.kind==='reset') {
    if(item.target===null||!item.previewAt){render();return;}
    try {await api('/api/window-plans',{method:'POST',body:{nodeId:item.reset.id,at:item.previewAt}});await refresh();toast('Window activation planned');}
    catch(error){render();toast(error.message,true);await refresh();}return;
  }
  const current = taskById(item.task.id);
  if (!current) { render(); return; }
  if (!DRAGGABLE.has(current.status)) { render(); toast('The task status changed. Its schedule was left unchanged.',true); return; }
  const previous = structuredClone(current);
  if (item.dropKind === 'priority') return commitPriorityDrop(item);
  const body = item.target !== null && item.previewSchedule ? {schedule:item.previewSchedule,...(item.previewNodeId?{quotaNodeId:item.previewNodeId}:{})} : null;
  if (!body) { render(); return; }
  current.schedule = body.schedule; current.scheduledAt = body.schedule.at || body.schedule.windowStart; current.status = 'scheduled';
  render();
  try { const saved=await api(`/api/tasks/${encodeURIComponent(current.id)}`,{method:'PUT',body}); await refresh(); toast(saved.planningError || 'Schedule updated',Boolean(saved.planningError)); }
  catch (error) { Object.assign(taskById(current.id) || current,previous); render(); toast(error.message,true); await refresh(); }
}
function beginPointer(event) {
  if (event.button !== 0 || interaction || composerSaving || document.querySelector('dialog[open]')) return;
  const resetLabel=event.target.closest('[data-reset-drag]');
  if(resetLabel) {
    const reset=state.quota?.nodes?.find(node=>node.id===resetLabel.dataset.resetDrag);if(!reset?.canDrag)return;
    const marker=resetLabel.closest('.timeline-marker'),bounds=$('#schedule-board').getBoundingClientRect();
    interaction={kind:'reset',reset,task:{title:`${periodName(reset.kind)} window`},node:resetLabel,pointerId:event.pointerId,
      initialX:event.clientX,initialY:event.clientY,initialScroll:$('#schedule-board').scrollTop,appendix:marker.dataset.appendix==='true',start:Date.parse(reset.time),offsetPixels:event.clientY-bounds.top+$('#schedule-board').scrollTop-parseFloat(marker.style.top),dragged:false,target:null,lastEvent:event,snapNodes:structuredClone(state.quota?.nodes??[])};
    resetLabel.setPointerCapture(event.pointerId);return;
  }
  const card = event.target.closest('.schedule-task[data-draggable="true"],.queue-task[data-draggable="true"]');
  if (!card || event.target.closest('button,input,select,textarea,a')) return;
  const task = taskById(card.dataset.taskId);
  if (!task || !DRAGGABLE.has(task.status) || editingTaskSnapshot?.task.id === task.id) return;
  const start = plannedStart(task), onBoard = card.classList.contains('schedule-task');
  const offsetPixels = onBoard ? Math.max(0,event.clientY-card.getBoundingClientRect().top) : 0;
  interaction = {task,canReorder:isAutoQueue(task),node:card,pointerId:event.pointerId,initialX:event.clientX,initialY:event.clientY,start,offsetPixels,dragged:false,target:null,lastEvent:event,snapNodes:structuredClone(state.quota?.nodes??[])};
  card.setPointerCapture(event.pointerId);
}
function pointerMove(event) {
  if (!interaction || event.pointerId !== interaction.pointerId) return;
  const item = interaction;
  if (!item.dragged && Math.hypot(event.clientX-item.initialX,event.clientY-item.initialY) < 5) return;
  event.preventDefault();
  if (!item.dragged) {
    item.dragged = true; item.node.classList.add('is-dragging-card'); document.body.classList.add('is-dragging');
    item.ghost = document.createElement('div'); item.ghost.className = `drag-ghost tint-${taskTint(item.task)}`; setDragGhost(item); document.body.append(item.ghost);
    startAutoScroll();
  }
  item.lastEvent = {clientX:event.clientX,clientY:event.clientY,shiftKey:event.shiftKey,altKey:event.altKey};
  previewInteraction(item.lastEvent);
}
function previewResetInteraction(event) {
  const item=interaction,surface=$('#schedule-surface'),board=$('#schedule-board'),bounds=board.getBoundingClientRect();
  const within=event.clientX>=bounds.left&&event.clientX<=bounds.right&&event.clientY>=bounds.top&&event.clientY<=bounds.bottom;
  const raw=item.appendix?(within?item.start+(event.clientY-item.initialY+board.scrollTop-item.initialScroll)*3600000/PX_PER_HOUR:null):pointerTime(event,item.offsetPixels);
  item.ghost.className='drag-ghost reset-drag-ghost';item.ghost.style.left=`${Math.min(innerWidth-260,event.clientX+15)}px`;item.ghost.style.top=`${Math.min(innerHeight-75,event.clientY+15)}px`;
  $('#drop-preview').hidden=true;$$('.reset-shift-preview').forEach(element=>element.remove());
  if(raw===null){item.target=null;item.ghost.classList.add('invalid-drop');return;}
  const at=Math.max(item.start,Math.ceil(raw/60000)*60000),offset=at-item.start;
  item.target=at;item.previewAt=new Date(at).toISOString();setDragGhost(item,`${relativeDateTime(at)} · Greeting ${relativeDateTime(at-(item.reset.kind==='week'?168:5)*3600000)}`);
  const affected=item.snapNodes.filter(node=>node.kind===item.reset.kind&&node.index>=item.reset.index);
  for(const node of affected) {
    const time=Date.parse(node.time)+offset;
    const originals=$$('.timeline-marker[data-node-ids]',surface).filter(marker=>marker.dataset.nodeIds.split(' ').includes(node.id));
    originals.forEach(marker=>marker.classList.add('reset-drag-original'));
    const footer=originals.find(marker=>marker.dataset.appendix==='true');
    if(!footer&&time>Number(surface.dataset.end))continue;
    const preview=document.createElement('div');preview.className=`timeline-marker reset-shift-preview${node.id===item.reset.id?'':' marker-projected'}`;
    preview.innerHTML=`<time>${E(relativeDateTime(time))}${node.kind==='week'?'<span class="weekly-label">Week</span>':''}</time><span class="timeline-dot"></span>${node.id===item.reset.id?`<span class="reset-controls"><span class="reset-lock locked">${ICON.locked}</span></span>`:''}`;
    const y=footer?parseFloat(footer.style.top)+offset/3600000*PX_PER_HOUR:timelineScale.timeToY(time);
    preview.style.top=`${y}px`;surface.append(preview);
    if(footer)surface.style.height=`${Math.max(parseFloat(surface.style.height),y+48)}px`;
  }
}
function approvalMarkup() {
  if (!state.approvals.length) return '';
  return `<div class="section-heading"><h2>${state.approvals.length} requests need your attention</h2><span>Tasks wait for your decision</span></div>${state.approvals.map(approval => {
    const task = taskById(approval.taskId), params = approval.params || {};
    if(approval.method==='mcpServer/elicitation/request')return elicitationMarkup(approval,task);
    const questions = params.questions || params.request?.questions;
    if (Array.isArray(questions)) {
      return `<form class="approval-card" data-approval-id="${E(approval.id)}" data-approval-input><div class="approval-heading"><h3>${E(task?.title || 'Codex needs more information')}</h3><span class="badge orange">Input required</span></div>${questions.map((question, index) => `<fieldset class="fieldset"><legend>${E(question.header || `Question ${index + 1}`)}</legend><p>${E(question.question)}</p><div class="approval-options">${(question.options || []).map(option => `<label><input type="radio" name="answer-${E(question.id)}" value="${E(option.label)}"><span>${E(option.label)}${option.description ? `<span class="field-hint"> · ${E(option.description)}</span>` : ''}</span></label>`).join('')}</div><label class="field">Additional answer<textarea rows="2" name="free-${E(question.id)}" placeholder="Choose an option or enter your answer"></textarea></label></fieldset>`).join('')}<button type="submit" class="button button-small button-primary">Submit answer</button></form>`;
    }
    const method = String(approval.method || '');
    const canDecide = /(?:commandExecution|fileChange|permissions).*requestApproval|(?:execCommand|applyPatch)Approval/i.test(method);
    return `<article class="approval-card"><div class="approval-heading"><h3>${E(task?.title || 'Codex approval')}</h3><span class="badge orange">Awaiting approval</span></div><p>${E(method)}</p><pre>${E(JSON.stringify(params, null, 2))}</pre>${canDecide ? `<div class="action-group"><button type="button" class="button button-small button-primary" data-action="accept-approval" data-approval-id="${E(approval.id)}">Approve once</button><button type="button" class="button button-small button-secondary" data-action="decline-approval" data-approval-id="${E(approval.id)}">Decline</button></div>` : '<p>Handle this request in the Codex conversation. Scheduling will wait.</p>'}</article>`;
  }).join('')}`;
}

function elicitationMarkup(approval,task) {
  const params=approval.params;
  let fields='',supported=true;
  try {
    if(params.mode==='url')fields=`<p class="field-hint">Open this page, complete the request, then choose Continue.</p><p class="request-url">${E(elicitationUrl(params.url))}</p><button type="button" class="button button-secondary" data-action="open-request-url" data-approval-id="${E(approval.id)}">Open page</button>`;
    else fields=elicitationFields(params).map((field,index)=>{
      const name=`elicitation-${index}`,required=field.required?' required':'',value=field.default;
      let control;
      if(field.type==='array')control=`<div class="approval-options">${field.options.map(option=>`<label><input type="checkbox" name="${name}" value="${E(option.value)}"${value?.includes(option.value)?' checked':''}><span>${E(option.label)}</span></label>`).join('')}</div>`;
      else if(field.type==='boolean'||field.options) {
        const options=field.type==='boolean'?[{value:'true',label:'Yes'},{value:'false',label:'No'}]:field.options;
        control=`<select name="${name}"${required}><option value="">Select…</option>${options.map(option=>`<option value="${E(option.value)}"${value!=null&&String(value)===String(option.value)?' selected':''}>${E(option.label)}</option>`).join('')}</select>`;
      } else control=`<input name="${name}" type="${['number','integer'].includes(field.type)?'number':field.format==='email'?'email':field.format==='date'?'date':'text'}"${required}${field.type==='number'?' step="any"':field.type==='integer'?' step="1"':''}${field.minimum!=null?` min="${E(field.minimum)}"`:''}${field.maximum!=null?` max="${E(field.maximum)}"`:''} value="${E(value??'')}" autocomplete="off">`;
      return `<div class="field"><label for="${E(approval.id)}-${name}">${E(field.label)}${field.required?' *':''}</label>${control.replace(/<(input|select) /,`<$1 id="${E(approval.id)}-${name}" `)}${field.description?`<span class="field-hint">${E(field.description)}</span>`:''}</div>`;
    }).join('');
  } catch(error){supported=false;fields=`<p class="task-error">${E(error.message)} You can decline or cancel this request.</p>`;}
  return `<form class="approval-card" data-elicitation data-approval-id="${E(approval.id)}"><div class="approval-heading"><h3>${E(task?.title||'Information requested')}</h3><span class="badge orange">${E(params.serverName)}</span></div><p>${E(params.message??params.description)}</p>${fields}<div class="action-group">${supported?`<button class="button button-small button-primary" type="submit">${params.mode==='url'?'Continue':'Submit answer'}</button>`:''}<button type="button" class="button button-small button-secondary" data-action="decline-elicitation" data-approval-id="${E(approval.id)}">Decline</button><button type="button" class="button button-small button-secondary" data-action="cancel-elicitation" data-approval-id="${E(approval.id)}">Cancel</button></div></form>`;
}

function resetCreditsCard() {
  const raw = state.limits?.result || state.limits;
  const summary = raw?.rateLimitResetCredits;
  const count = Number.isInteger(summary?.availableCount) && summary.availableCount >= 0 ? summary.availableCount : null;
  const credits = Array.isArray(summary?.credits) ? [...summary.credits].sort((a,b) => (asDate(a.expiresAt)?.getTime() ?? Infinity) - (asDate(b.expiresAt)?.getTime() ?? Infinity)) : [];
  const labels = {available:'Available',redeeming:'Redeeming',redeemed:'Redeemed',unknown:'Unknown'};
  return `<section class="card reset-credits-card"><h3>Reset credits<span class="badge ${count ? 'green' : 'neutral'}">${count === null ? 'Unavailable' : `${count} available`}</span></h3>${credits.length ? `<div class="reset-credit-list">${credits.map(credit => `<div class="reset-credit"><div><strong>${E(credit.title || 'Codex quota reset')}</strong><span class="badge ${credit.status === 'available' ? 'green' : 'neutral'}">${E(labels[credit.status] || credit.status || 'Unknown')}</span></div><p>${credit.expiresAt === null ? 'No expiry' : credit.expiresAt ? `Expires ${fullDateTime(credit.expiresAt)}` : 'Expiry unavailable'}</p></div>`).join('')}</div>` : `<p>${count === null ? 'Reset credit information is not available from Codex yet.' : count > 0 ? 'Codex returned the available count without individual expiry dates.' : 'No reset credits available.'}</p>`}</section>`;
}

function startingFromOptions() {
  const settings=state.settings;
  const nodes=(state.quota?.nodes??[]).filter(node=>node.kind==='fiveHour'&&Date.parse(node.time)>timelineAnchor&&Date.parse(node.time)<=timelineAnchor+72*3600000);
  const selected=settings.startingFrom==='now'||Date.parse(settings.startingFrom)<=Date.now()?'now':nodes.find(node=>Date.parse(node.time)>=Date.parse(settings.startingFrom))?.time??nodes[0]?.time;
  const options=[{value:'now',label:'Now'},...nodes.map(node=>({value:node.time,label:relativeDateTime(node.time)}))];
  return options.map(option=>`<option value="${E(option.value)}"${option.value===selected?' selected':''}>${E(option.label)}</option>`).join('');
}
function renderAutoSettings() {
  const settings=state.settings,quiet=settings.quietHours||{};
  return `<form id="settings-form" class="card"><section class="settings-section"><h2>Five-hour windows</h2><label class="field">Starting from<select id="settings-starting-from" aria-describedby="starting-from-hint">${startingFromOptions()}</select><span id="starting-from-hint" class="field-hint">First window for automatic tasks.</span></label><label class="field">Tasks per five-hour window<input id="settings-capacity" type="number" min="1" max="20" required value="${E(settings.tasksPerWindow??1)}"></label></section><section class="settings-section"><h2>Reserved hours</h2><p id="reserved-hours-hint" class="field-hint settings-hint">Automatic tasks never start during these hours.</p><label class="switch-row"><input id="settings-quiet-enabled" type="checkbox" aria-describedby="reserved-hours-hint"${quiet.enabled?' checked':''}><span>Reserve time each day</span></label><div class="form-grid"><label class="field">Start<input id="settings-quiet-start" type="time" required value="${E(quiet.start||'09:00')}"></label><label class="field">End<input id="settings-quiet-end" type="time" required value="${E(quiet.end||'18:00')}"></label></div></section><p id="settings-form-error" class="form-error" role="alert" hidden></p></form>`;
}
function applySetting(input) {
  const form=input.closest('#settings-form');if(!form||!form.checkValidity())return;
  const body=input.id==='settings-starting-from'?{startingFrom:input.value}
    :input.id==='settings-capacity'?{tasksPerWindow:Number(input.value)}
    :{quietHours:{enabled:$('#settings-quiet-enabled').checked,start:$('#settings-quiet-start').value,end:$('#settings-quiet-end').value}};
  const errorElement=$('#settings-form-error');
  if(body.quietHours?.enabled&&body.quietHours.start===body.quietHours.end){errorElement.textContent='Start and end times must differ.';errorElement.hidden=false;return;}
  settingsPending++;
  settingsWrites=settingsWrites.then(async()=>{
    try{await api('/api/settings',{method:'POST',body});errorElement.hidden=true;await refresh();}
    catch(error){errorElement.textContent=error.message;errorElement.hidden=false;}
    finally{settingsPending--;}
  });
}
function populateModels(selectedModel = '', selectedEffort = '', selectedSpeed = 'default', prefix = 'composer') {
  const modelSelect = document.getElementById(`${prefix}-model`);
  modelSelect.innerHTML = '<option value="">Codex default model</option>' + state.models.map(model => `<option value="${E(modelId(model))}">${E(model.displayName || model.name || modelId(model))}</option>`).join('');
  if (selectedModel && !state.models.some(model => modelId(model) === selectedModel)) modelSelect.add(new Option(`${selectedModel} (not in the current list)`, selectedModel));
  modelSelect.value = selectedModel || '';
  populateCapabilities(selectedEffort, selectedSpeed, prefix);
}
function populateCapabilities(selectedEffort = '', selectedSpeed = 'default', prefix = 'composer') {
  const effortSelect = document.getElementById(`${prefix}-effort`), speedSelect = document.getElementById(`${prefix}-speed`);
  const model = state.models.find(entry => modelId(entry) === document.getElementById(`${prefix}-model`).value);
  const efforts = (model?.supportedReasoningEfforts || []).map(entry => typeof entry === 'string' ? entry : entry.reasoningEffort || entry.effort).filter(Boolean);
  effortSelect.innerHTML = '<option value="">Default reasoning</option>' + efforts.map(effort => `<option value="${E(effort)}">${E(effortName(effort))}</option>`).join('');
  if (selectedEffort && !efforts.includes(selectedEffort)) effortSelect.add(new Option(`${effortName(selectedEffort)} (previous setting)`, selectedEffort));
  effortSelect.value = selectedEffort || '';
  const tiers = model?.serviceTiers || [];
  const ids = new Set(['default']);
  const options = ['<option value="default">Standard</option>'];
  tiers.forEach(tier => {
    const id = typeof tier === 'string' ? tier : tier.id;
    if (!id || ids.has(id)) return;
    ids.add(id);
    options.push(`<option value="${E(id)}">${E(typeof tier === 'string' ? speedName(id) : tier.name || speedName(id))}</option>`);
  });
  speedSelect.innerHTML = options.join('');
  if (selectedSpeed && !ids.has(selectedSpeed)) speedSelect.add(new Option(`${speedName(selectedSpeed)} (previous setting; confirm availability)`, selectedSpeed));
  speedSelect.value = selectedSpeed || model?.defaultServiceTier || 'default';
}
function toggleModelMode(prefix='composer') {
  const inherit = $('input[name=composerConfig]:checked')?.value === 'inherit';
  const model = document.getElementById(`${prefix}-model`), effort = document.getElementById(`${prefix}-effort`), speed = document.getElementById(`${prefix}-speed`);
  if (inherit) { model.value = ''; populateCapabilities('','default',prefix); }
  const existing = $('input[name=composerTarget]:checked')?.value === 'existing';
  if (model.options[0]) model.options[0].textContent = inherit && existing ? 'Conversation model' : 'Codex default model';
  if (effort.options[0]) effort.options[0].textContent = inherit && existing ? 'Conversation reasoning' : 'Default reasoning';
  if (speed.options[0]) speed.options[0].textContent = inherit ? existing ? 'Conversation speed' : 'Default speed' : 'Standard';
  model.disabled = effort.disabled = speed.disabled = inherit;
}
function composerDraft() {
  return {target:$('input[name=composerTarget]:checked').value, config:$('input[name=composerConfig]:checked').value,
    cwd:$('#composer-cwd').value, thread:$('#composer-thread').value, threadLabel:$('#composer-thread-label').textContent,
    model:$('#composer-model').value, effort:$('#composer-effort').value, speed:$('#composer-speed').value,
    prompt:$('#composer-prompt').value, promptFile:$('#composer-prompt-file').value,
    error:$('#composer-error').textContent, errorHidden:$('#composer-error').hidden, dirty:composerDirty};
}
function restoreComposerDraft(draft) {
  if (!draft) return;
  $(`input[name=composerTarget][value=${draft.target}]`).checked = true;
  $(`input[name=composerConfig][value=${draft.config}]`).checked = true;
  $('#composer-cwd').value = draft.cwd; $('#composer-thread').value = draft.thread;
  $('#composer-thread-label').textContent = draft.threadLabel;
  populateModels(draft.model,draft.effort,draft.speed);
  setPromptLink('composer',draft.promptFile);
  if (!draft.promptFile) $('#composer-prompt').value = draft.prompt;
  $('#composer-error').textContent = draft.error; $('#composer-error').hidden = draft.errorHidden;
  composerDirty = draft.dirty; toggleComposerFields();
}
function updateComposerMode() {
  const editing = Boolean(editingTaskSnapshot);
  $('.composer-panel').classList.toggle('is-editing',editing);
  $('#composer-heading').textContent = editing ? 'Edit task' : 'Create a task';
  const cancel = $('#composer-cancel');
  cancel.classList.toggle('composer-cancel-idle',!editing);
  cancel.setAttribute('aria-hidden',String(!editing)); cancel.disabled = !editing || composerSaving; cancel.tabIndex = editing ? 0 : -1;
  $('#composer-submit').textContent = editing ? 'Save changes' : 'Create task';
  toggleComposerFields();
}
function toggleComposerFields() {
  const existing = $('input[name=composerTarget]:checked').value === 'existing';
  $('#composer-new-fields').hidden = existing;
  $('#composer-existing-fields').hidden = !existing; $('#composer-cwd').required = !existing;
  $('#composer-cwd').placeholder = 'Select a project folder';
  toggleModelMode();
}
function cancelEdit({focus=true}={}) {
  if (!editingTaskSnapshot || composerSaving) return;
  const draft = creationDraft;
  editingTaskSnapshot = null; creationDraft = null; closeThreadPickers();
  updateComposerMode(); restoreComposerDraft(draft); render();
  if (focus) $('#composer-prompt').focus({preventScroll:true});
}
function requestCancelEdit() {
  if(!editingTaskSnapshot||composerSaving)return;
  if(composerDirty)return confirmAction('Discard changes','You have unsaved task changes. Are you sure to discard?','Discard',()=>cancelEdit({focus:false}));
  cancelEdit({focus:false});
}
function openTask(task, {discard=false}={}) {
  if (!task || !EDITABLE.has(task.status) || composerSaving) return;
  if (editingTaskSnapshot && composerDirty && !discard) {
    if (editingTaskSnapshot.task.id === task.id) {
      $('#composer-prompt').focus({preventScroll:true}); return;
    }
    return confirmAction('Discard changes','You have unsaved task changes. Are you sure to discard?', 'Discard',()=>openTask(task,{discard:true}));
  }
  if (!editingTaskSnapshot) creationDraft = composerDraft();
  editingTaskSnapshot = {task:structuredClone(task)}; composerDirty = false;
  closeThreadPickers(); $('#composer-error').hidden = true;
  $('#composer-cwd').value = task.cwd || '';
  $('input[name=composerTarget][value='+(task.target === 'existing' ? 'existing' : 'new')+']').checked = true;
  $('input[name=composerConfig][value='+(task.modelMode === 'inherit' ? 'inherit' : 'custom')+']').checked = true;
  populateModels(task.model,task.effort,task.speed);
  $('#composer-thread').value = task.threadId || '';
  $('#composer-thread-label').textContent = task.threadTitle || threadNames.get(task.threadId) || (task.threadId ? 'Existing conversation · '+task.threadId.slice(0,8) : 'Select an existing chat');
  setPromptLink('composer',task.promptFile || '');
  if (!task.promptFile) $('#composer-prompt').value = task.prompt || '';
  expandedTaskId = task.id; updateComposerMode(); render();
  $('#composer-body').scrollTop = 0; $('#composer-prompt').focus({preventScroll:true});
}
function toggleQueueTask(task) { if (task) { expandedTaskId = expandedTaskId === task.id ? null : task.id; render(); } }
function openOutput(task) {
  if (!task) return;
  $('#output-title').textContent = task.title;
  const selected = (task.runs || []).at(-1);
  const controls = ['running','awaiting_approval'].includes(task.status) ? [taskButton('cancel-task','Stop',task.id,'danger-text')] : [];
  if (state.approvals.some(approval => approval.taskId === task.id)) controls.push(taskButton('open-approvals','Review request',task.id));
  const runMarkup = selected ? `<div class="output-meta">${badge(selected.status)}<span>Started ${fullDateTime(selected.startedAt)}</span><span>${E(duration(selected.startedAt, selected.finishedAt))}</span>${selected.threadId ? `<span>Conversation ${E(selected.threadId)}</span>` : ''}</div><h3 class="output-heading">Output</h3><pre class="output-block">${E(typeof selected.output === 'string' ? selected.output : selected.output ? JSON.stringify(selected.output, null, 2) : 'No output yet.')}</pre>${selected.error ? `<h3 class="output-heading">Details</h3><pre class="output-block">${E(selected.error)}</pre>` : ''}` : `<div class="output-meta">${badge(task.status)}<span>${task.scheduledAt ? `Scheduled ${fullDateTime(task.scheduledAt)}` : 'No start time scheduled'}</span><span>${E(modelSummary(task))}</span></div>${task.lastError ? `<p class="task-error">${E(task.lastError)}</p>` : ''}`;
  const promptMarkup = typeof selected?.prompt === 'string' ? `<pre class="output-block">${E(selected.prompt)}</pre>` : task.promptFile ? linkedTaskPreview(task) : `<pre class="output-block">${E(task.prompt)}</pre>`;
  $('#output-content').innerHTML = `${runMarkup}${controls.length ? `<div class="task-actions detail-task-actions">${controls.join('')}</div>` : ''}<h3 class="output-heading">Prompt</h3>${promptMarkup}${EDITABLE.has(task.status) ? `<div class="action-group output-actions"><button class="button button-small button-quiet" data-action="edit-from-output" data-task-id="${E(task.id)}">Edit task</button></div>` : ''}`;
  $('#output-dialog').showModal(); refreshVisibleFiles(true);
}
function confirmAction(title, description, label, callback) {
  $('#confirm-title').textContent = title;
  $('#confirm-description').textContent = description;
  $('#confirm-submit').textContent = label;
  pendingConfirmation = callback;
  $('#confirm-dialog').showModal();
}
async function buttonBusy(button, callback) {
  if (!button || button.disabled) return;
  button.disabled = true;
  try { await callback(); } catch (error) { toast(error.message, true); }
  finally { if (button.isConnected) button.disabled = false; }
}
async function taskAction(id, action) {
  await api(`/api/tasks/${encodeURIComponent(id)}/action`, {method:'POST', body:{action}});
  await refresh();
  toast('Task status updated');
}
function closeThreadPickers(except=null) {
  for (const prefix of ['composer']) if (prefix !== except) { const panel = document.getElementById(`${prefix}-thread-panel`); if (panel.matches(':popover-open')) panel.hidePopover(); panel.hidden = true; document.getElementById(`${prefix}-thread-toggle`).setAttribute('aria-expanded','false'); }
}
function positionThreadPicker(prefix) {
  const button = document.getElementById(`${prefix}-thread-toggle`), panel = document.getElementById(`${prefix}-thread-panel`), bounds = button.getBoundingClientRect();
  panel.style.width = `${bounds.width}px`; panel.style.left = `${bounds.left}px`; panel.style.maxHeight = `${Math.min(280,Math.max(bounds.top,innerHeight-bounds.bottom)-18)}px`;
  panel.style.top = `${innerHeight-bounds.bottom > 220 ? bounds.bottom+5 : Math.max(8,bounds.top-panel.getBoundingClientRect().height-5)}px`;
}
function threadProjectName(thread) {
  if (typeof thread.projectName === 'string' && thread.projectName.trim()) return thread.projectName.trim();
  const parts = String(thread.cwd || '').split(/[\\/]/).filter(Boolean), leaf = parts.at(-1) || '';
  // A managed worktree ID alone is not a project name.
  if (parts.at(-2)?.toLowerCase() === 'worktrees' && /^[a-f0-9]{4,}$/i.test(leaf)) return '';
  return /^[a-z]:$/i.test(leaf) || ['.','..'].includes(leaf) ? '' : leaf;
}
function threadOption(thread,selected) {
  const id = thread.id || thread.threadId, name = threadNames.get(id), project = threadProjectName(thread);
  return `<button type="button" class="thread-option" role="option" aria-selected="${id === selected}" aria-label="${E(project ? `${name}, ${project}` : name)}" data-action="choose-thread" data-prefix="composer" data-thread-id="${E(id)}"><span class="thread-option-title">${E(name)}</span>${project ? `<span class="thread-option-project">${ICON.folder}<span>${E(project)}</span></span>` : ''}</button>`;
}
async function searchPicker(prefix,more=false) {
  const picker = threadPickers[prefix], version = ++picker.version, input = document.getElementById(`${prefix}-thread-search`), list = document.getElementById(`${prefix}-thread-options`);
  const parameters = new URLSearchParams({search:input.value.trim()}); if (more && picker.cursor) parameters.set('cursor',picker.cursor);
  list.setAttribute('aria-busy','true');
  if (!more) list.textContent = 'Loading conversations…';
  try {
    const response = await api(`/api/threads?${parameters}`); if (version !== picker.version) return;
    picker.data = [...new Map((more ? [...picker.data,...response.data] : response.data || []).map(thread => [thread.id || thread.threadId,thread])).values()]; picker.cursor = response.nextCursor || null;
    for (const thread of picker.data) threadNames.set(thread.id || thread.threadId,thread.name || thread.title || thread.preview || `Untitled conversation · ${String(thread.id || thread.threadId).slice(0,8)}`);
    const selected = document.getElementById(`${prefix}-thread`).value;
    list.innerHTML = picker.data.length ? picker.data.map(thread => threadOption(thread,selected)).join('') : '<span class="thread-picker-message">No conversations found</span>';
    document.getElementById(`${prefix}-load-more`).hidden = !picker.cursor;
    if (selected && threadNames.has(selected)) document.getElementById(`${prefix}-thread-label`).textContent = threadNames.get(selected);
    if (!document.getElementById(`${prefix}-thread-panel`).hidden) positionThreadPicker(prefix);
  } catch (error) { if (version === picker.version) { list.textContent = error.message; picker.cursor = null; document.getElementById(`${prefix}-load-more`).hidden = true; } }
  finally { if (version === picker.version) list.removeAttribute('aria-busy'); }
}
function toggleThreadPicker(prefix) {
  const panel = document.getElementById(`${prefix}-thread-panel`), opening = panel.hidden; closeThreadPickers();
  if (opening) { panel.hidden = false; panel.showPopover(); positionThreadPicker(prefix); document.getElementById(`${prefix}-thread-toggle`).setAttribute('aria-expanded','true'); searchPicker(prefix); document.getElementById(`${prefix}-thread-search`).focus(); }
}
function filename(path) { return String(path || '').split(/[\\/]/).at(-1) || ''; }
function linkedTaskInfo(task) {
  const entry = filePreviews.get(task.promptFile);
  return `<div class="linked-task-info"><span>${E(entry?.name || filename(task.promptFile))}</span><p class="linked-file-error" data-prompt-error-path="${E(task.promptFile)}"${entry?.error ? '' : ' hidden'}>${E(entry?.error || '')}</p></div>`;
}
function linkedTaskPreview(task) {
  const entry = filePreviews.get(task.promptFile);
  return `<div class="linked-task-preview"><span>${E(entry?.name || filename(task.promptFile))}</span><pre data-prompt-preview-path="${E(task.promptFile)}">${E(entry?.text || '')}</pre><p class="linked-file-error" data-prompt-error-path="${E(task.promptFile)}"${entry?.error ? '' : ' hidden'}>${E(entry?.error || '')}</p></div>`;
}
function updateFilePreviews(path) {
  const entry = filePreviews.get(path); if (!entry) return;
  for (const prefix of ['composer']) if (document.getElementById(`${prefix}-prompt-file`).value === path) {
    document.getElementById(`${prefix}-prompt`).value = entry.error ? '' : entry.text;
    document.getElementById(`${prefix}-file-name`).textContent = entry.name || filename(path);
    const error = document.getElementById(`${prefix}-file-error`); error.textContent = entry.error || ''; error.hidden = !entry.error;
  }
  $$('[data-prompt-preview-path]').filter(element => element.dataset.promptPreviewPath === path).forEach(element => element.textContent = entry.error ? '' : entry.text);
  $$('[data-prompt-error-path]').filter(element => element.dataset.promptErrorPath === path).forEach(element => { element.textContent = entry.error || ''; element.hidden = !entry.error; });
}
async function readPromptFile(path) {
  if (fileReads.has(path)) return fileReads.get(path);
  const reading = (async () => {
    try { const result = await api(`/api/prompt-file?${new URLSearchParams({path})}`); filePreviews.set(path,{name:result.name,text:result.text,error:null,readAt:Date.now()}); updateFilePreviews(path); return result; }
    catch (error) { filePreviews.set(path,{name:filename(path),text:'',error:error.message,readAt:Date.now()}); updateFilePreviews(path); throw error; }
    finally { fileReads.delete(path); }
  })(); fileReads.set(path,reading); return reading;
}
function setPromptLink(prefix,path) {
  document.getElementById(`${prefix}-prompt-file`).value = path;
  const prompt = document.getElementById(`${prefix}-prompt`); prompt.readOnly = Boolean(path); prompt.required = !path;
  document.getElementById(`${prefix}-file-link`).hidden = !path;
  document.getElementById(`${prefix}-file-name`).textContent = filename(path);
  document.getElementById(`${prefix}-file-error`).hidden = true;
  if (path) { prompt.value = ''; readPromptFile(path).catch(() => {}); }
}
function refreshVisibleFiles(force=false) {
  const paths = new Set();
  const composerFile = $('#composer-prompt-file').value; if (composerFile) paths.add(composerFile);
  $$('.queue-task.expanded [data-prompt-error-path]').forEach(element => paths.add(element.dataset.promptErrorPath));
  $$('[data-prompt-preview-path]').filter(element => !element.closest('dialog') || element.closest('dialog').open).forEach(element => paths.add(element.dataset.promptPreviewPath));
  for (const path of paths) if (force || !filePreviews.has(path) || Date.now()-filePreviews.get(path).readAt >= 1500) readPromptFile(path).catch(() => {});
}
function previewPriorityDrop(event,item) {
  if (!item.canReorder || !item.node.classList.contains('queue-task')) return false;
  const list = $('#task-list'), bounds = list.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) return false;
  const cards = $$('.queue-task[data-priority-draggable="true"]',list).filter(card => card.dataset.taskId !== item.task.id);
  const ids = cards.map(card => card.dataset.taskId); let index = cards.findIndex(card => event.clientY < card.getBoundingClientRect().top+card.getBoundingClientRect().height/2); if (index < 0) index = ids.length;
  ids.splice(index,0,item.task.id); item.reorderIds = ids; item.dropKind = 'priority'; item.target = null;
  let marker = $('#priority-drop-marker'); if (!marker) { marker = document.createElement('div'); marker.id = 'priority-drop-marker'; list.append(marker); }
  marker.hidden = false;
  const target = cards[index], last = cards.at(-1), position = target ? target.getBoundingClientRect().top : last ? last.getBoundingClientRect().bottom : item.node.getBoundingClientRect().top;
  marker.style.top = `${position-bounds.top+list.scrollTop}px`; item.ghost.classList.remove('invalid-drop'); setDragGhost(item,'Reorder automatic tasks'); return true;
}
async function commitPriorityDrop(item) {
  try { await api('/api/tasks/reorder',{method:'POST',body:{taskIds:item.reorderIds}}); await refresh(); toast('Automatic task order updated'); }
  catch (error) { toast(error.message,true); await refresh(); }
}
document.addEventListener('pointerdown',beginPointer);
document.addEventListener('pointermove',pointerMove,{passive:false});
document.addEventListener('pointerup',event => { if (!interaction || event.pointerId !== interaction.pointerId) return; if (interaction.dragged) previewInteraction(event); const item = endInteraction(); if (item) commitInteraction(item); });
document.addEventListener('pointercancel',() => endInteraction(true));
function updateDragModifiers(event) {
  if(event.key!=='Alt'||!interaction?.dragged)return;
  interaction.lastEvent={clientX:interaction.lastEvent.clientX,clientY:interaction.lastEvent.clientY,altKey:event.type==='keydown',shiftKey:event.shiftKey};
  previewInteraction(interaction.lastEvent);
}
document.addEventListener('keyup',updateDragModifiers);
document.addEventListener('keydown',event => {
  updateDragModifiers(event);
  if (event.key === 'Escape') {
    if (interaction) { event.preventDefault(); endInteraction(true); return; }
    if (!$('#composer-thread-panel').hidden) { event.preventDefault(); closeThreadPickers(); return; }
    if (editingTaskSnapshot && !document.querySelector('dialog[open]')) { event.preventDefault(); requestCancelEdit(); return; }
  }
  if (interaction) return;
  if (!['Enter',' '].includes(event.key) || event.target.closest('button,input,textarea,select,a')) return;
  const card = event.target.closest('.schedule-task,.queue-task'); if (card) { event.preventDefault(); const task = taskById(card.dataset.taskId); if (task) card.classList.contains('queue-task') ? toggleQueueTask(task) : DRAGGABLE.has(task.status) ? openTask(task) : openOutput(task); }
});
document.addEventListener('click',event => {
  if (!event.target.closest('.thread-picker')) closeThreadPickers();
  if (Date.now() < suppressClickUntil && event.target.closest('.schedule-task,.queue-task,.timeline-marker')) { event.preventDefault(); return; }
  if(editingTaskSnapshot&&!composerSaving&&!interaction&&Date.now()>=suppressClickUntil&&!document.querySelector('dialog[open]')
    &&!event.target.closest('#composer-form,button,input,select,textarea,a,label,summary,[role="button"],[contenteditable],[data-reset-drag],.thread-picker'))requestCancelEdit();
  const close = event.target.closest('[data-close-dialog]'); if (close) return close.closest('dialog').close();
  const button = event.target.closest('[data-action]');
  if (!button) { const card = event.target.closest('.schedule-task,.queue-task'); if (card && !event.target.closest('.linked-task-preview')) { const task = taskById(card.dataset.taskId); if (task) card.classList.contains('queue-task') ? toggleQueueTask(task) : DRAGGABLE.has(task.status) ? openTask(task) : openOutput(task); } return; }
  const action = button.dataset.action, task = taskById(button.dataset.taskId), prefix = button.dataset.prefix;
  if(action==='open-request-url')return buttonBusy(button,async()=>{
    const approval=state.approvals.find(item=>item.id===button.dataset.approvalId);
    if(!approval)throw new Error('This request has ended.');
    if(desktop?.openRequestUrl)await desktop.openRequestUrl(approval.id);
    else {await navigator.clipboard.writeText(elicitationUrl(approval.params.url));toast('Link copied. Open it in your browser, then return here.');}
  });
  if(action==='decline-elicitation'||action==='cancel-elicitation')return buttonBusy(button,async()=>{
    await api(`/api/approvals/${encodeURIComponent(button.dataset.approvalId)}`,{method:'POST',body:{action:action==='decline-elicitation'?'decline':'cancel'}});await refresh();
  });
  if(action==='plan-window'||action==='cancel-window-plan')return buttonBusy(button,async()=>{
    if(action==='plan-window')await api('/api/window-plans',{method:'POST',body:{nodeId:button.dataset.nodeId}});
    else await api(`/api/window-plans/${encodeURIComponent(button.dataset.planId)}`,{method:'DELETE',body:{}});
    await refresh();toast(action==='plan-window'?'Window activation planned':'Window activation cancelled');
  });
  if (action === 'open-auto-settings') return openAutoSettings();
  if (action === 'open-reset-credits') return openResetCredits();
  if (action === 'open-approvals') return openApprovals();
  if (action === 'toggle-task') return toggleQueueTask(task);
  if (action === 'edit-task' && task) return openTask(task);
  if (action === 'reschedule-task' && task && ENDED.has(task.status) && EDITABLE.has(task.status) && !composerSaving) return buttonBusy(button,async () => {
    await api(`/api/tasks/${encodeURIComponent(task.id)}`,{method:'PUT',body:{reschedule:true,schedule:{mode:'manual'}}});
    await refresh(); toast('Task ready to schedule');
  });
  if (action === 'cancel-edit') return requestCancelEdit();
  if (action === 'edit-from-output' && task) { $('#output-dialog').close(); return openTask(task); }
  if (action === 'view-task' && task) return openOutput(task);
  if (action === 'auto-task' && task && !composerSaving && editingTaskSnapshot?.task.id !== task.id) return buttonBusy(button,async () => { await api(`/api/tasks/${encodeURIComponent(task.id)}`,{method:'PUT',body:{schedule:{mode:'auto'}}}); await refresh(); });
  if (action === 'toggle-thread-picker') return toggleThreadPicker(prefix);
  if (action === 'more-threads') return buttonBusy(button,() => searchPicker(prefix,true));
  if (action === 'choose-thread') { document.getElementById(`${prefix}-thread`).value = button.dataset.threadId; document.getElementById(`${prefix}-thread-label`).textContent = threadNames.get(button.dataset.threadId); closeThreadPickers(); composerDirty = true; return; }
  if (action === 'link-prompt-file') return buttonBusy(button,async () => { if (!desktop?.choosePromptFile) throw new Error('Use the desktop app to link a Markdown file.'); const selected = await desktop.choosePromptFile(); if (!selected) return; setPromptLink(prefix,selected.path); composerDirty = true; await readPromptFile(selected.path); });
  if (action === 'unlink-prompt-file') { setPromptLink(prefix,''); composerDirty = true; return; }
  if (action === 'choose-directory' && desktop?.chooseDirectory) return buttonBusy(button,async () => { const directory = await desktop.chooseDirectory(); if (directory) { document.getElementById(button.dataset.inputId).value = directory; document.getElementById(button.dataset.inputId).dispatchEvent(new Event('input',{bubbles:true})); } });
  if (action === 'delete-task' && task) return confirmAction('Delete task',`Delete “${task.title}” and its local data?`,'Delete',async () => { await api(`/api/tasks/${encodeURIComponent(task.id)}`,{method:'DELETE',body:{}}); if (editingTaskSnapshot?.task.id === task.id) cancelEdit({focus:false}); await refresh(); });
  if (action === 'cancel-task' && task) return confirmAction('Stop task',`Stop “${task.title}” now?`,'Stop',() => taskAction(task.id,'cancel'));
  if (action === 'accept-approval' || action === 'decline-approval') return buttonBusy(button,async () => { await api(`/api/approvals/${encodeURIComponent(button.dataset.approvalId)}`,{method:'POST',body:{decision:action === 'accept-approval' ? 'accept' : 'decline'}}); await refresh(); });
});
document.addEventListener('input',event => {
  if (event.target.id === 'timeline-zoom') { if (interaction) endInteraction(true); PX_PER_HOUR = Number(event.target.value); render(); }
  for (const prefix of ['composer']) if (event.target.id === `${prefix}-thread-search`) { const picker = threadPickers[prefix]; clearTimeout(picker.timer); picker.timer = setTimeout(() => searchPicker(prefix),250); }
  if (event.target.closest('#composer-form') && event.target.id !== 'composer-thread-search') composerDirty = true;
  if (event.target.closest('#settings-form')) applySetting(event.target);
});
document.addEventListener('change',event => {
  if (event.target.closest('#composer-form') && event.target.id !== 'composer-thread-search') composerDirty = true;
  if (event.target.name === 'composerTarget') toggleComposerFields();
  if (event.target.name === 'composerConfig') toggleModelMode('composer');
  if (event.target.id === 'composer-model') populateCapabilities('','default','composer');
});
$('#composer-form').addEventListener('submit',async event => {
  event.preventDefault(); if (composerSaving) return;
  const button = $('#composer-submit'), errorElement = $('#composer-error'), edit = editingTaskSnapshot;
  composerSaving = true; button.disabled = true; $('#composer-cancel').disabled = true; errorElement.hidden = true;
  closeThreadPickers(); $('#composer-body').inert = true;
  try {
    const target = $('input[name=composerTarget]:checked').value, modelMode = $('input[name=composerConfig]:checked').value, promptFile = $('#composer-prompt-file').value || null;
    const file = promptFile ? await readPromptFile(promptFile) : null, prompt = promptFile ? '' : $('#composer-prompt').value;
    const firstLine = prompt.split(/\r?\n/).find(line => line.trim()) || '';
    const title = edit ? edit.task.title : file ? file.name.replace(/\.(md|markdown)$/i,'') : firstLine.replace(/^\s*#{1,6}\s*|^\s*[-*+]\s*/,'').trim().slice(0,80);
    if (!title || (!promptFile && !prompt.trim())) throw new Error('Enter text.');
    const threadId = target === 'existing' ? $('#composer-thread').value : '';
    const cwd = target === 'new' ? $('#composer-cwd').value.trim() : edit?.task.target === 'existing' && edit.task.threadId === threadId ? edit.task.cwd || '' : '';
    const body = {title,prompt,promptFile,target,modelMode,model:modelMode === 'custom' ? $('#composer-model').value : '',effort:modelMode === 'custom' ? $('#composer-effort').value : '',speed:modelMode === 'custom' ? $('#composer-speed').value : 'default',cwd};
    if (target === 'new' && !body.cwd) throw new Error('Select a project directory.');
    if (target === 'existing') { body.threadId = threadId; if (!body.threadId) throw new Error('Select an existing conversation.'); }
    if (!edit) { body.priority = 50; body.schedule = {mode:'manual'}; }
    await api(edit ? '/api/tasks/'+encodeURIComponent(edit.task.id) : '/api/tasks',{method:edit ? 'PUT' : 'POST',body});
    composerSaving = false;
    if (edit) cancelEdit({focus:false}); else { setPromptLink('composer',''); $('#composer-prompt').value = ''; composerDirty = false; }
    await refresh(); toast(edit ? 'Task changes saved' : 'Task created');
  } catch (error) { errorElement.textContent = error.message; errorElement.hidden = false; }
  finally { composerSaving = false; button.disabled = false; $('#composer-body').inert = false; updateComposerMode(); }
});
$('#confirm-form').addEventListener('submit', async event => {
  event.preventDefault();
  const callback = pendingConfirmation; pendingConfirmation = null;
  $('#confirm-dialog').close();
  try { if (callback) await callback(); } catch (error) { toast(error.message,true); }
});
document.addEventListener('submit', async event => {
  if (event.target.id === 'settings-form') event.preventDefault();
  if(event.target.matches('[data-elicitation]')) {
    event.preventDefault();const form=event.target,approval=state.approvals.find(item=>item.id===form.dataset.approvalId);
    if(!approval)return;
    return buttonBusy($('button[type=submit]',form),async()=>{
      const content={};
      if(approval.params.mode!=='url')elicitationFields(approval.params).forEach((field,index)=>{
        const inputs=[...form.elements].filter(input=>input.name===`elicitation-${index}`);
        const value=field.type==='array'?inputs.filter(input=>input.checked).map(input=>input.value):inputs[0]?.value;
        if(value===''&&!field.required)return;
        Object.defineProperty(content,field.name,{enumerable:true,value:field.type==='boolean'?value==='true':['number','integer'].includes(field.type)?value===''?null:Number(value):value});
      });
      const body=elicitationResponse(approval.params,{action:'accept',content});
      await api(`/api/approvals/${encodeURIComponent(approval.id)}`,{method:'POST',body});await refresh();
    });
  }
  if (event.target.matches('[data-approval-input]')) {
    event.preventDefault();
    const form = event.target, approval = state.approvals.find(item => item.id === form.dataset.approvalId);
    if (!approval) return;
    const questions = approval.params.questions || approval.params.request?.questions || [];
    await buttonBusy($('button[type=submit]',form),async () => {
      const answers = {};
      for (const question of questions) {
        const selected = [...form.elements].find(input => input.name === `answer-${question.id}` && input.checked)?.value;
        const free = [...form.elements].find(input => input.name === `free-${question.id}`)?.value.trim();
        if (!selected && !free) throw new Error(`Please answer “${question.header || question.question}”.`);
        answers[question.id] = {answers:[...(selected ? [selected] : []),...(free ? [free] : [])]};
      }
      await api(`/api/approvals/${encodeURIComponent(approval.id)}`,{method:'POST',body:{answers}}); await refresh(); toast('Answer submitted');
    });
  }
});
$$('dialog').forEach(dialog => {
  dialog.addEventListener('close', () => { if (renderPending) render(); });
  dialog.addEventListener('click', event => {
  if (event.target !== dialog || dialog.dataset.busy === 'true') return;
  const rect = dialog.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  });
});
window.addEventListener('beforeunload', event => { if (editingTaskSnapshot && composerDirty) { event.preventDefault(); event.returnValue = ''; } });

if (desktop) { $$('[data-native-only]').forEach(element => element.hidden = false); }
updateComposerMode();
refresh();
const stream = new EventSource('/api/events');
stream.addEventListener('change', () => refresh());
stream.addEventListener('state', event => {
  try { const next = JSON.parse(event.data); initializeActivationErrors(next.quota); state = {...state,...next}; render(); } catch { refresh(); }
});
setInterval(() => { if (!document.hidden) refresh(); },15000);
setInterval(() => { if (!document.hidden) refreshVisibleFiles(); },2000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { refresh(); refreshVisibleFiles(true); } });
window.addEventListener('focus',() => refreshVisibleFiles(true));
