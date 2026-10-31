import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { defaultSettings } from './planner.mjs';
import { readPromptFile } from './prompt-files.mjs';
import { emptyQuotaState } from './quota-windows.mjs';

export const activeStatuses = new Set(['running', 'awaiting_approval']);
const editableStatuses = new Set(['queued','scheduled','waiting_quota','waiting_session','paused','missed','failed','interrupted','uncertain','succeeded']);
const textField = (value, name, max, required = false) => {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw new Error(`${name} must not be empty or exceed ${max} characters`);
  return value;
};
const dateField = (value, name) => {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error(`${name} requires a valid date`);
  return new Date(value).toISOString();
};
export function validateTask(input, previous = {}) {
  const merged = { ...previous, ...input };
  const target = merged.target ?? 'new';
  if (!['new','existing'].includes(target)) throw new Error('Invalid conversation type');
  const schedule = merged.schedule ?? { mode:'manual' };
  if (!['manual','auto','exact','window'].includes(schedule.mode)) throw new Error('Invalid scheduling mode');
  const priority = Number(merged.priority ?? 50);
  if (!Number.isInteger(priority) || priority < 0 || priority > 100) throw new Error('Priority must be between 0 and 100');
  const modelMode = merged.modelMode ?? 'custom';
  if (!['inherit','custom'].includes(modelMode)) throw new Error('Invalid model configuration mode');
  const cwd = textField(merged.cwd ?? '', 'Working directory', 4096);
  if (target === 'new' && !cwd.trim()) throw new Error('A new conversation requires a working directory');
  if (cwd && (!path.isAbsolute(cwd) || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory())) throw new Error('The working directory must be an existing absolute local directory');
  const promptFile = merged.promptFile == null || merged.promptFile === '' ? null : textField(merged.promptFile,'Markdown link',4096,true);
  const linked = promptFile ? readPromptFile(promptFile) : null;
  return {
    title: textField(merged.title ?? '', 'Task name', 200, true).trim(),
    prompt: linked ? linked.text : textField(merged.prompt ?? '', 'Prompt', 1_000_000, true), promptFile:linked?.path??null, promptFileError:null, target,
    threadId: target === 'existing' ? textField(merged.threadId ?? '', 'Thread ID', 200, true) : null,
    cwd, model:textField(merged.model ?? '', 'Model', 200), effort:textField(merged.effort ?? '', 'Reasoning effort', 40),
    speed:textField(merged.speed ?? 'default', 'Speed', 40), modelMode, priority,
    schedule: {mode:schedule.mode, ...(schedule.mode === 'exact' ? {at:dateField(schedule.at,'Start time')} : {}), ...(schedule.mode === 'window' ? {windowStart:dateField(schedule.windowStart,'Window start')} : {})},
  };
}

export function validateSettings(input, current) {
  const result = { ...current };
  // Connection and scheduler enablement are managed automatically.
  for (const key of ['tasksPerWindow','windowMinutes','graceMinutes']) {
    if (key in input) {
      const ranges = {tasksPerWindow:[1,20],windowMinutes:[300,300],graceMinutes:[1,1440]};
      const value = Number(input[key]);
      if (!Number.isInteger(value) || value < ranges[key][0] || value > ranges[key][1]) throw new Error(`${key} is out of range`);
      result[key] = value;
    }
  }
  if ('windowAnchor' in input) result.windowAnchor = dateField(input.windowAnchor,'Window anchor');
  if ('startingFrom' in input) result.startingFrom = input.startingFrom == null || input.startingFrom === 'now'
    ? input.startingFrom : dateField(input.startingFrom, 'Starting from');
  if ('timezone' in input) {
    textField(input.timezone,'Time zone',100,true);
    try { new Intl.DateTimeFormat('en',{timeZone:input.timezone}); } catch { throw new Error('Invalid time zone'); }
    result.timezone=input.timezone;
  }
  if ('quietHours' in input) {
    const q=input.quietHours;
    if (!q || typeof q.enabled !== 'boolean' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(q.start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(q.end) || (q.enabled && q.start === q.end)) throw new Error('Invalid reserved hours; start and end times must differ');
    result.quietHours={enabled:q.enabled,start:q.start,end:q.end};
  }
  return result;
}

export class Store {
  constructor(directory) {
    this.ownsLock=false;
    fs.mkdirSync(directory,{recursive:true});
    this.file=path.join(directory,'state.json');
    this.lock=path.join(directory,'service.lock');
    this.acquireLock();
    try {
      if (fs.existsSync(this.file)) {
        this.data=JSON.parse(fs.readFileSync(this.file,'utf8'));
        if (this.data.version !== 1 || !Array.isArray(this.data.tasks) || !this.data.settings) throw new Error('Incompatible data structure');
      } else this.data={version:1,settings:defaultSettings(),tasks:[]};
      this.data.settings.schedulerEnabled=true;
      this.data.quota ??= emptyQuotaState();
      this.data.quota.observations ??= {};this.data.quota.plans ??= [];
      for(const plan of this.data.quota.plans)if(plan.status==='scheduled'&&plan.windowRelation!=='ending') {
        plan.status='cancelled';plan.error='Window activation now targets the window ending at the node. Please plan this legacy activation again.';
      }
      for(const plan of this.data.quota.plans)if(plan.status==='running') {
        plan.status=plan.task?.runs?.length?'uncertain':'failed';
        plan.error=plan.task?.runs?.length?'The service stopped during activation. It will not be repeated automatically.':'The service stopped before activation was sent.';
        if(plan.task)plan.task.status=plan.status;
      }
      for (const task of this.data.tasks) { delete task.plannedMinutes; task.modelMode ??= 'custom'; }
      // A crash after dispatch may have started work. Never repeat it automatically.
      for (const task of this.data.tasks) if (activeStatuses.has(task.status)) {
        task.status='uncertain'; task.lastError='The service stopped during execution. Check the conversation result before deciding whether to retry.';
        const run=task.runs?.at(-1); if(run && !run.finishedAt) {run.status='uncertain';run.error=task.lastError;run.finishedAt=new Date().toISOString();}
      }
      this.save();
    } catch(error) { this.close(); throw new Error(`Cannot read task data. The original file and backup have been preserved: ${error.message}`); }
  }
  acquireLock() {
    try { const fd=fs.openSync(this.lock,'wx'); fs.writeFileSync(fd,String(process.pid));fs.closeSync(fd);this.ownsLock=true; }
    catch(error) {
      if(error.code !== 'EEXIST') throw error;
      const pid=Number(fs.readFileSync(this.lock,'utf8'));
      let alive=false;
      if(Number.isInteger(pid)&&pid>0) {try{process.kill(pid,0);alive=true;}catch(e){alive=e.code !== 'ESRCH';}}
      if(alive) throw new Error('Another Sweatshop service is already using this data directory');
      const reclaim=`${this.lock}.reclaim`;
      let guard;
      try {guard=fs.openSync(reclaim,'wx');}
      catch {throw new Error('Another instance is recovering the service lock. If recovery stopped unexpectedly, confirm that all services have stopped before removing service.lock.reclaim.');}
      try {
        // Recheck AFTER acquiring the exclusive recovery guard: another process
        // may have replaced the stale lock since our first read.
        if(fs.existsSync(this.lock)) {
          const currentPid=Number(fs.readFileSync(this.lock,'utf8'));
          if(Number.isInteger(currentPid)&&currentPid>0) {
            try {process.kill(currentPid,0);throw new Error('Another Sweatshop service is already using this data directory');}
            catch(e) {if(e.code!=='ESRCH')throw e;}
          }
          fs.unlinkSync(this.lock);
        }
        const fd=fs.openSync(this.lock,'wx');fs.writeFileSync(fd,String(process.pid));fs.closeSync(fd);this.ownsLock=true;
      } finally {fs.closeSync(guard);fs.unlinkSync(reclaim);}
    }
  }
  save() {
    const temporary=`${this.file}.${process.pid}.tmp`;
    const fd=fs.openSync(temporary,'w');
    try {fs.writeFileSync(fd,JSON.stringify(this.data,null,2));fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
    if(fs.existsSync(this.file)) fs.copyFileSync(this.file,`${this.file}.bak`);
    fs.renameSync(temporary,this.file);
  }
  get(id) {const task=this.data.tasks.find(t=>t.id===id);if(!task) throw new Error('Task not found');return task;}
  resolvePrompt(task) {
    if (!task.promptFile) return textField(task.prompt,'Prompt',1_000_000,true);
    const source = readPromptFile(task.promptFile);
    task.prompt=source.text;task.promptFileError=null;
    return source.text;
  }
  refreshPromptFiles() {
    let changed=false;
    for (const task of this.data.tasks) {
      if (!task.promptFile) continue;
      try {
        const text=readPromptFile(task.promptFile).text;
        if (task.prompt!==text || task.promptFileError) {task.prompt=text;task.promptFileError=null;changed=true;}
      } catch (error) {
        // A missing source is visible, and must never silently become a literal prompt.
        if (task.prompt!=='' || task.promptFileError!==error.message) {task.prompt='';task.promptFileError=error.message;changed=true;}
      }
    }
    if (changed) this.save();
    return changed;
  }
  reorderAuto(taskIds) {
    const tasks=this.data.tasks.filter(task=>task.schedule?.mode==='auto'&&['queued','scheduled','waiting_quota','waiting_session'].includes(task.status));
    if (!Array.isArray(taskIds)||taskIds.length!==tasks.length||new Set(taskIds).size!==taskIds.length
      || taskIds.some(id=>!tasks.some(task=>task.id===id))) throw new Error('The automatic task queue has changed. Refresh before reordering');
    const updatedAt=new Date().toISOString();
    const byId=new Map(tasks.map(task=>[task.id,task]));
    taskIds.forEach((id,index)=>{const task=byId.get(id);task.autoOrder=index;task.updatedAt=updatedAt;});
    this.save();return tasks;
  }
  create(input) {
    const task={...validateTask(input),id:randomUUID(),status:'queued',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),runs:[]};
    this.data.tasks.push(task);this.save();return task;
  }
  update(id,input) {
    const task=this.get(id); if(!editableStatuses.has(task.status)) throw new Error('A running task cannot be edited');
    if (Object.keys(input).length === 1 && 'plannedMinutes' in input) throw new Error('Tasks have only a start time; planned duration is not supported');
    if ('reschedule' in input && typeof input.reschedule !== 'boolean') throw new Error('Reschedule must be a boolean');
    if (input.reschedule === true && !Object.hasOwn(input,'schedule')) throw new Error('Rescheduling requires an explicit schedule');
    const previousMode=task.schedule?.mode;
    // Content edits retain execution state and committed dates. Only an explicit
    // schedule change resets pending work; completed work also requires rescheduling intent.
    const preserveExecution=input.reschedule!==true && (!Object.hasOwn(input,'schedule') || task.status==='succeeded');
    Object.assign(task,validateTask(input,task),{updatedAt:new Date().toISOString()},preserveExecution?{}:{status:'queued',scheduledAt:null,windowStart:null,windowEnd:null,notBefore:null,lastError:null});
    if (!preserveExecution && (input.reschedule===true || task.schedule.mode!=='auto' || previousMode!=='auto')) delete task.autoOrder;
    if (!preserveExecution) delete task.preflightRetry;
    this.save();return task;
  }
  delete(id) { const task=this.get(id);if(activeStatuses.has(task.status)) throw new Error('Stop the running task first');this.data.tasks=this.data.tasks.filter(t=>t.id!==id);this.save(); }
  close() {if(this.ownsLock&&fs.existsSync(this.lock)&&fs.readFileSync(this.lock,'utf8')===String(process.pid)) fs.unlinkSync(this.lock);this.ownsLock=false;}
}
