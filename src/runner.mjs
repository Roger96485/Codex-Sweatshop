import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { activeStatuses } from './store.mjs';
import { quotaBlock, quotaBucket, automaticStartBlock } from './planner.mjs';
import { activationModel, observeQuota, currentQuotaWindows, meteredPeriods, PERIODS, expireActivationConfirmations } from './quota-windows.mjs';
import { elicitationResponse } from '../public/elicitation.mjs';

const iso = () => new Date().toISOString();
const busyError = error => /locked|lock held|writer|already running|active turn|in.progress|owned by|busy/i.test(error.message);
const transientError = error => ['CODEX_TIMEOUT','CODEX_DISCONNECTED','CODEX_PROCESS_ERROR','ECONNRESET','ECONNREFUSED','ETIMEDOUT','EPIPE','EAI_AGAIN'].includes(error?.code)
  || /timed?\s*out|timeout|temporarily unavailable|connection (?:closed|reset|refused)|service unavailable/i.test(error?.message??'');

export class Runner extends EventEmitter {
  constructor(store,client) {
    super();this.store=store;this.client=client;this.models=[];this.limits=null;this.account=null;this.approvals=[];this.active=null;this.ticking=false;this.suspended=false;this.taskModelCache=new Map();
    this.attachClient(client);
  }
  attachClient(client) {
    this.client=client;
    client.on('notification',message=>this.onNotification(message));
    client.on('serverRequest',message=>this.onRequest(message));
    client.on('disconnect',error=>{
      if(this.active&&!this.retryPreflight(Object.assign(new Error(error?.message??'Codex disconnected'),{code:'CODEX_DISCONNECTED'})))
        this.finish('uncertain',`The Codex connection was interrupted. Check the execution result: ${error?.message??'process exited'}`);
      this.emit('change');
    });
  }
  changed() {this.store.save();this.emit('change');}
  taskModelKey(task) {return JSON.stringify([this.store.data.quota.accountId,task.target,task.threadId,task.cwd,task.modelMode,task.model]);}
  quotaTaskModels() {
    return new Map(this.store.data.tasks.flatMap(task=>{
      const cached=this.taskModelCache.get(task.id);
      return cached&&cached.key===this.taskModelKey(task)&&Date.now()-cached.at<120_000?[[task.id,cached.identity]]:[];
    }));
  }
  async inspectTaskModels({force=false,tasks=this.store.data.tasks}={}) {
    if(!this.client.status.connected||this.suspended)return;
    const configs=new Map();
    const config=cwd=>{
      if(!configs.has(cwd))configs.set(cwd,this.client.request('config/read',{includeLayers:false,cwd:cwd||null},5000));
      return configs.get(cwd);
    };
    const pending=tasks.filter(task=>['queued','scheduled','waiting_quota','waiting_session'].includes(task.status)&&task.schedule?.mode!=='manual');
    let next=0;
    const inspect=async task=>{
      const key=this.taskModelKey(task);
      const cached=this.taskModelCache.get(task.id);
      if(!force&&cached?.key===key&&Date.now()-cached.at<60_000)return;
      try {
        const thread=task.target==='existing'?(await this.client.request('thread/read',{threadId:task.threadId,includeTurns:false},5000)).thread:null;
        const result=await config(task.cwd||thread?.cwd);
        if(this.suspended||key!==this.taskModelKey(task))return;
        if(!result?.config){this.taskModelCache.delete(task.id);return;}
        const defaults=result.config,inherit=task.modelMode==='inherit';
        const fallback=this.models.find(model=>model.isDefault)??this.models[0];
        const model=inherit?(task.target==='existing'?thread?.model:defaults.model??fallback?.model??fallback?.id):(task.model||fallback?.model||fallback?.id);
        const modelProvider=thread?.modelProvider??defaults.model_provider??defaults.modelProvider??'openai';
        this.taskModelCache.set(task.id,{key,at:Date.now(),identity:{model,modelProvider}});
      } catch {this.taskModelCache.delete(task.id);}
    };
    await Promise.all(Array.from({length:Math.min(4,pending.length)},async()=>{
      while(next<pending.length&&!this.suspended)await inspect(pending[next++]);
    }));
    const ids=new Set(this.store.data.tasks.map(task=>task.id));
    for(const id of this.taskModelCache.keys())if(!ids.has(id))this.taskModelCache.delete(id);
  }
  expireConfirmations(now=Date.now()) {
    if(!this.suspended&&expireActivationConfirmations(this.store.data.quota,now))this.changed();
  }
  updateQuota(limits) {
    const now=Date.now();this.limits=limits;observeQuota(this.store.data.quota,limits,now);
    const periods=currentQuotaWindows(limits,this.store.data.quota,now);
    for(const plan of this.store.data.quota.plans)if(plan.status==='scheduled'
      && plan.error==='Waiting for the previous window to reset.'&&Date.parse(plan.activationAt)<=now
      && Date.parse(plan.notBefore)>now && periods[plan.kind]?.canActivate && periods[plan.kind].state!=='anchored') {
      // Recover an unsent plan deferred by the former unknown-means-busy rule.
      plan.notBefore=null;plan.error=null;
    }
    this.changed();
  }
  async refresh() {
    if(this.refreshing)return this.refreshing;
    const operation=(async()=>{
      await this.client.connect();
      // Serialize complete reads so an older lightweight response cannot replace
      // the newer connection snapshot during a preflight or account refresh.
      await this.refreshingQuota?.catch(()=>{});
      // Never return credentials; only account type/plan is needed by this product.
      const [models,account,limits]=await Promise.all([this.client.listModels(),this.client.readAccount(),this.client.readLimits()]);
      if(this.suspended)return;
      this.models=Array.isArray(models)?models:models.data??[];
      this.account=account.account?{type:account.account.type,planType:account.account.planType??null}:null;
      this.updateQuota(limits);
    })();
    this.refreshing=operation;
    try{return await operation;}finally{if(this.refreshing===operation)this.refreshing=null;}
  }
  async refreshQuota() {
    if(this.suspended)return;
    if(this.refreshing)return this.refreshing;
    if(this.refreshingQuota)return this.refreshingQuota;
    const operation=(async()=>{
      const limits=await this.client.readLimits();
      if(this.suspended)return;
      this.updateQuota(limits);
    })();
    this.refreshingQuota=operation;
    try{return await operation;}finally{if(this.refreshingQuota===operation)this.refreshingQuota=null;}
  }
  async tick(now=Date.now()) {
    if(this.suspended||this.ticking||this.active||!this.store.data.settings.schedulerEnabled) return;
    this.ticking=true;
    try {
      for(const task of this.store.data.tasks)if(['queued','scheduled','waiting_quota','waiting_session'].includes(task.status)
        &&task.preflightRetry&&Date.parse(task.preflightRetry.deadline)<=now) {
        task.status='missed';task.lastError='The connection did not recover within the start-time grace period. Reschedule the task.';this.changed();
      }
      const tasks=this.store.data.tasks.filter(t=>['auto','exact','window'].includes(t.schedule?.mode)&&['scheduled','waiting_quota','waiting_session'].includes(t.status)&&t.scheduledAt&&Date.parse(t.scheduledAt)<=now&&(!t.notBefore||Date.parse(t.notBefore)<=now));
      tasks.sort((a,b)=>{
        const time=Date.parse(a.scheduledAt)-Date.parse(b.scheduledAt);if(time)return time;
        const aAuto=a.schedule?.mode==='auto',bAuto=b.schedule?.mode==='auto';
        if(aAuto!==bAuto)return aAuto?1:-1;
        if(aAuto){
          const aOrder=Number.isSafeInteger(a.autoOrder)&&a.autoOrder>=0?a.autoOrder:null;
          const bOrder=Number.isSafeInteger(b.autoOrder)&&b.autoOrder>=0?b.autoOrder:null;
          if(aOrder!==bOrder)return aOrder==null?1:bOrder==null?-1:aOrder-bOrder;
        }
        return b.priority-a.priority||Date.parse(a.createdAt)-Date.parse(b.createdAt);
      });
      for(const task of tasks) {
        const overdue=now-Date.parse(task.scheduledAt);
        if(task.status==='scheduled'&&overdue>this.store.data.settings.graceMinutes*60000) {
          task.status='missed';task.lastError='The start time is beyond the grace period. Reschedule or run the task manually.';this.changed();continue;
        }
        await this.launch(task);return;
      }
      const plan=this.store.data.quota.plans.filter(plan=>plan.status==='scheduled'&&Date.parse(plan.activationAt)<=now
        &&(!plan.notBefore||Date.parse(plan.notBefore)<=now)).sort((a,b)=>Date.parse(a.activationAt)-Date.parse(b.activationAt))[0];
      if(plan) {
        if(now-Date.parse(plan.activationAt)>this.store.data.settings.graceMinutes*60000) {
          plan.status='missed';plan.error='The activation time was missed. Plan a new window.';this.changed();
        } else await this.launchActivation(plan);
      }
    } finally {this.ticking=false;}
  }
  defer(task,status,message,until) {
    const plan=task.activationPlanId&&this.store.data.quota.plans.find(plan=>plan.id===task.activationPlanId);
    if(plan) {
      plan.status='scheduled';plan.error=message;plan.notBefore=until??new Date(Date.now()+5000).toISOString();
      task.status=status;task.lastError=message;this.changed();return;
    }
    task.status=status;task.lastError=message;task.notBefore=until??new Date(Date.now()+60000).toISOString();
    this.changed();this.emit('deferred');
  }
  retryPreflight(error) {
    const active=this.active;
    if(!active||active.run||active.stage!=='preflight'||this.suspended||!transientError(error))return false;
    const {task,threadId}=active,now=Date.now();
    const plan=task.activationPlanId&&this.store.data.quota.plans.find(item=>item.id===task.activationPlanId);
    const owner=plan||task;
    owner.preflightRetry??={attempts:0,deadline:new Date((Date.parse(plan?.activationAt??task.scheduledAt)||now)+this.store.data.settings.graceMinutes*60000).toISOString()};
    const deadline=Date.parse(owner.preflightRetry.deadline);
    if(now>=deadline) {this.finish('missed','The connection did not recover within the start-time grace period. Reschedule the task.');return true;}
    const delay=Math.min(60_000,5000*2**Math.min(owner.preflightRetry.attempts++,4));
    clearTimeout(active.timer);
    this.active=null;
    this.defer(task,'scheduled',`Connection temporarily unavailable; retrying before the grace period ends: ${error.message}`,new Date(Math.min(now+delay,deadline)).toISOString());
    if(threadId)this.releaseThread(threadId,task);
    return true;
  }
  async launchActivation(plan) {
    if(this.active||this.suspended||plan.status!=='scheduled')return;
    if(plan.accountId && this.store.data.quota.accountId && plan.accountId!==this.store.data.quota.accountId) {
      plan.status='cancelled';plan.error='The signed-in account changed.';this.changed();return;
    }
    const cwd=path.join(path.dirname(this.store.file),'activation-workspace');fs.mkdirSync(cwd,{recursive:true});
    const task={id:`activation-${plan.id}`,activationPlanId:plan.id,title:'Window activation',prompt:'你好',
      target:'new',cwd,modelMode:'custom',speed:'default',status:'queued',runs:[],createdAt:iso()};
    plan.task=task;plan.status='running';plan.error=null;
    await this.launch(task);
  }
  async launch(task) {
    if(this.suspended)throw new Error('The service is closing or changing the Codex connection');
    if(this.active) throw new Error('Another task is already running; the queue runs tasks sequentially');
    const windowExpired=()=>task.schedule?.mode==='window'&&Date.now()>=Date.parse(task.windowEnd??new Date(Date.parse(task.schedule.windowStart)+PERIODS.fiveHour).toISOString());
    if(windowExpired()){task.status='missed';task.lastError='The specified window has ended. Reschedule the task.';this.changed();return;}
    const reserveStart = (block = null) => {
      if(task.schedule?.mode!=='auto')return false;
      block ??= automaticStartBlock(this.store.data.settings);
      if(!block)return false;
      const threadId=this.active?.threadId;
      this.active=null;
      this.defer(task,'scheduled',block.reason,block.until);
      if(threadId)this.releaseThread(threadId,task);
      return true;
    };
    if(reserveStart())return;
    // Reserve the runner before any awaits so manual clicks and scheduler ticks cannot race.
    const lease={task,run:null,stage:'preflight',threadId:null,turnId:null,completion:null};
    this.active=lease;task.status='running';this.changed();
    const activation=task.activationPlanId?this.store.data.quota.plans.find(plan=>plan.id===task.activationPlanId):null;
    try {
      if(activation&&this.account&&this.models.length&&this.client.status.connected)await this.refreshQuota();
      else await this.refresh();
      if(this.active!==lease)return;
      if(this.account?.type!=='chatgpt') throw new Error('Sign in to a ChatGPT account through the Codex CLI first. This version uses subscription quota.');
      if(activation) {
        if(activation.status!=='running') {this.finish('cancelled',activation.error);return;}
        if(activation.accountId && this.store.data.quota.accountId!==activation.accountId)throw new Error('The signed-in account changed. Activation was not sent.');
        const period=currentQuotaWindows(this.limits,this.store.data.quota)[activation.kind];
        activation.lastQuotaCheck={at:iso(),state:period?.state??'unknown',usedPercent:period?.usedPercent??null,
          bucketId:period?.bucketId??null,meteredResetAt:period?.meteredResetAt??null,
          forecastResetAt:period?.resetAt??null,projectedReset:period?.projectedReset??false};
        if(!period?.resetAt) {
          this.active=null;this.defer(task,'waiting_quota','Waiting for quota readings to refresh after reset.',new Date(Date.now()+2000).toISOString());return;
        }
        const activationBase=Date.parse(activation.activationAt);
        const completed=!period.projectedReset && this.store.data.tasks.flatMap(task=>task.runs??[]).find(run=>run.status==='succeeded'&&run.modelProvider==='openai'
          &&run.meteredBucketId===period.bucketId&&Date.parse(run.startedAt)>=activationBase-5000
          &&Date.parse(run.startedAt)<=Date.now()&&Math.abs(Date.parse(period.resetAt)-PERIODS[activation.kind]-Date.parse(run.startedAt))<=30_000);
        if(completed){this.finish('skipped');activation.confirmed=true;activation.skippedReason='A scheduled task already activated this window.';this.changed();return;}
        const start=Date.parse(period.resetAt)-PERIODS[activation.kind];
        if(period.state==='anchored') {
          if(start>=activationBase-5000) {
            this.finish('skipped');activation.confirmed=true;activation.skippedReason='This window was already activated.';this.changed();return;
          }
        }
        // A fresh floating window is already available; its old forecast is not a
        // previous-window deadline. Rounded-zero anchored/unknown windows still wait.
        const recent=this.store.data.quota.plans.find(other=>{
          const run=other.task?.runs?.at(-1);
          return other.id!==activation.id && run && run.delivery!=='not_sent'
            &&(!other.accountId||!activation.accountId||other.accountId===activation.accountId)
            &&run.meteredBucketId===period.bucketId && run.modelProvider==='openai'
            &&Date.parse(run.startedAt)>=activationBase-5000
            &&Math.abs(Date.parse(other.activationAt)-Date.parse(activation.activationAt))<=5000;
        });
        if(recent) {
          if(recent.status!=='succeeded') {
            this.finish('uncertain','A greeting was already dispatched at this boundary and its result needs confirmation. No duplicate greeting was sent.');return;
          }
          if(Date.now()-Date.parse(recent.finishedAt)<65_000) {
            this.active=null;this.defer(task,'waiting_quota','Waiting for confirmation of the greeting already sent.',new Date(Date.parse(recent.finishedAt)+65_000).toISOString());return;
          }
          this.finish('uncertain','A greeting was already sent at this boundary, but this window could not be confirmed. No duplicate greeting was sent.');return;
        }
        const zeroUsage=period.usedPercent!=null&&Number(period.usedPercent)===0;
        if((period.state==='anchored'||!zeroUsage) && start<activationBase-5000 && Date.parse(period.resetAt)>Date.now()+1000) {
          this.active=null;this.defer(task,'waiting_quota','Waiting for the previous window to reset.',period.resetAt);return;
        }
        Object.assign(task,activationModel(this.models));
        if(period.model && period.model!==task.model)throw new Error('The low-cost model uses a different quota bucket. Activation was not sent.');
        const ownBucket=Object.entries(this.limits.rateLimitsByLimitId??{}).find(([,bucket])=>bucket?.normalModelSlug===task.model);
        if(ownBucket && ownBucket[0]!==period.bucketId)throw new Error('The low-cost model uses a different quota bucket. Activation was not sent.');
      }
      const inherit=task.modelMode==='inherit';
      let model=inherit ? null : this.models.find(m=>(m.model??m.id)===task.model)||(!task.model?this.models.find(m=>m.isDefault)||this.models[0]:null);
      if(!inherit) {
        if(!model) throw new Error('This model is not in the current Codex model catalog. Refresh and select it again');
        const efforts=(model.supportedReasoningEfforts??[]).map(e=>typeof e==='string'?e:e.reasoningEffort);
        if(task.effort&& !efforts.includes(task.effort)) throw new Error('The model does not support the selected reasoning effort. Edit the task');
        const speeds=['default',...(model.serviceTiers??[]).map(s=>typeof s==='string'?s:s.id)];
        if(!speeds.includes(task.speed)) throw new Error('The model does not offer this speed mode. Select standard speed or refresh the model catalog');
      }
      if(!this.limits||typeof this.limits!=='object'||!('rateLimits' in this.limits||'rateLimitsByLimitId' in this.limits||'ordinaryUsageAllowed' in this.limits)) throw new Error('Cannot confirm the current account quota. The task was not sent. Reconnect to Codex.');
      const block=inherit
        ? (this.limits.ordinaryUsageAllowed===false ? quotaBlock(this.limits,null,Date.now()) : null)
        : quotaBlock(this.limits,model.model??model.id,Date.now());
      if(block) {this.active=null;this.defer(task,'waiting_quota',block.reason,block.until);return;}
      let cwd=task.cwd;
      if(task.target==='existing') {
        const existing=await this.client.request('thread/read',{threadId:task.threadId,includeTurns:false});
        if(this.active!==lease)return;
        const thread=existing.thread;
        if(thread?.status?.type==='active'||thread?.status?.activeFlags?.length) {
          this.active=null;this.defer(task,'waiting_session','The existing conversation is working. Waiting for it to become idle before starting',new Date(Date.now()+60000).toISOString());return;
        }
        cwd ||= thread?.cwd;
      }
      if(!cwd||!fs.existsSync(cwd)||!fs.statSync(cwd).isDirectory()) throw new Error('The conversation working directory is inaccessible. Edit the task and select a valid directory');
      const common={cwd,approvalPolicy:activation?'never':'on-request',approvalsReviewer:'user',sandbox:activation?'read-only':'workspace-write',...(!inherit?{model:model.model??model.id,serviceTier:task.speed}:{}),
        ...(activation?{modelProvider:'openai',ephemeral:true,allowProviderModelFallback:false,environments:[],baseInstructions:'Reply with one short greeting. Do not use tools.',developerInstructions:'',
          config:{project_doc_max_bytes:0,mcp_servers:{},web_search:'disabled'}}:{})};
      let result;
      // A resume response can be lost after this client acquired the writer.
      // Keep its known ID so a preflight failure can release our subscription.
      if(task.target==='existing') lease.threadId=task.threadId;
      try {
        result=await this.client.request(task.target==='existing'?'thread/resume':'thread/start',task.target==='existing'?{...common,threadId:task.threadId}:common);
      } catch(error) {
        if(this.active!==lease)return;
        if(busyError(error)) {this.active=null;this.defer(task,'waiting_session','Desktop or another client is using this conversation. It will be retried automatically when released.',new Date(Date.now()+60000).toISOString());return;}
        throw error;
      }
      if(this.active!==lease)return;
      const threadId=result.thread.id;
      lease.threadId=threadId;
      if(activation&&(result.model!==common.model||result.modelProvider!=='openai'))throw new Error('Codex did not confirm the requested low-cost model and provider. Activation was not sent.');
      if(inherit) {
        // Resume/start reports the actual inherited model. Check its own quota
        // before dispatch, without changing the thread's model, effort or tier.
        model=this.models.find(m=>(m.model??m.id)===result.model);
        if(!model) throw new Error('Cannot confirm the model in the inherited configuration. The prompt was not sent. Change the configuration and retry.');
        const inheritedBlock=quotaBlock(this.limits,result.model,Date.now());
        if(inheritedBlock) {
          this.active=null;this.defer(task,'waiting_quota',inheritedBlock.reason,inheritedBlock.until);
          this.releaseThread(threadId,task);
          return;
        }
      }
      // Read linked Markdown at the last pre-dispatch point, after all awaits.
      const prompt=this.store.resolvePrompt(task);
      if(reserveStart())return;
      if(windowExpired()){this.finish('missed','The specified window ended before dispatch. Reschedule the task.');return;}
      const actualModel=model.model??model.id;
      const meteredBucketId=quotaBucket(this.limits,actualModel)?.[0]??null;
      const run={id:randomUUID(),status:'running',startedAt:iso(),finishedAt:null,threadId,turnId:null,prompt,output:'',error:null,
        model:actualModel,modelProvider:result.modelProvider??null,meteredBucketId,delivery:'pending'};
      task.runs??=[];task.runs.push(run);task.status='running';task.lastError=null;task.notBefore=null;
      Object.assign(lease,{run,stage:'dispatch',threadId,turnId:null,completion:null});this.changed();
      if(activation)lease.timer=setTimeout(()=>{
        if(this.active!==lease)return;
        if(lease.turnId)void this.client.request('turn/interrupt',{threadId,turnId:lease.turnId}).catch(()=>{});
        this.finish('uncertain','Window activation timed out. It will not be repeated automatically.');
      },60_000);
      // Persist dispatch intent BEFORE writing turn/start. A crash here is treated as uncertain.
      let started;
      try {
        // Saving intent can itself cross the reserved-hours boundary. This turn is
        // still definitely unsent, so remove its provisional run before deferring.
        const lastBlock=task.schedule?.mode==='auto'&&automaticStartBlock(this.store.data.settings);
        if(lastBlock){task.runs.pop();lease.run=null;reserveStart(lastBlock);return;}
        if(windowExpired()){task.runs.pop();lease.run=null;this.finish('missed','The specified window ended before dispatch. Reschedule the task.');return;}
        started=await this.client.request('turn/start',{threadId,input:[{type:'text',text:prompt}],...(!inherit?{model:common.model,effort:task.effort||model.defaultReasoningEffort,serviceTier:task.speed}:{}),cwd,approvalPolicy:common.approvalPolicy,approvalsReviewer:'user',sandboxPolicy:activation?{type:'readOnly',networkAccess:false}:{type:'workspaceWrite',writableRoots:[cwd],networkAccess:false},...(activation?{environments:[]}:{} )});
      } catch(error) {
        if(this.active===lease&&error.sent===false) {
          run.delivery='not_sent';
          if(transientError(error)) {
            task.runs.pop();lease.run=null;lease.stage='preflight';
            if(this.retryPreflight(error))return;
          }
        }
        if(this.active===lease) this.finish(error.uncertain===false||error.sent===false?'failed':'uncertain',`Failed to send the prompt${error.uncertain===false||error.sent===false?'':'; check the execution result'}: ${error.message}`);
        return;
      }
      if(this.active!==lease)return;
      run.delivery='accepted';delete task.preflightRetry;if(activation)delete activation.preflightRetry;
      this.active.turnId=started.turn.id;run.turnId=started.turn.id;this.active.stage='running';this.changed();
      if(this.active.completion) this.completeTurn(this.active.completion);
      else if(['completed','failed','interrupted'].includes(started.turn.status)) this.completeTurn(started.turn);
    } catch(error) {
      if(this.active!==lease)return;
      if(this.retryPreflight(error))return;
      this.finish('failed',error.message);
    }
  }
  finish(status,error=null) {
    const active=this.active;if(!active) return;
    clearTimeout(active.timer);
    const {task,run}=active;task.status=status;task.lastError=error;task.updatedAt=iso();
    const activation=task.activationPlanId&&this.store.data.quota.plans.find(plan=>plan.id===task.activationPlanId);
    if(activation) {activation.status=status;activation.error=error;activation.finishedAt=iso();activation.notBefore=null;}
    if(run) {
      run.status=status;run.error=error;run.finishedAt=iso();
      if(status==='succeeded'||run.turnId)run.delivery='accepted';
      delete task.preflightRetry;if(activation)delete activation.preflightRetry;
    }
    this.approvals=this.approvals.filter(a=>a.taskId!==task.id);this.active=null;this.changed();
    // Release this sidecar's writer ownership so Desktop can resume this thread.
    this.releaseThread(active.threadId,task);
    if(activation&&status==='succeeded')this.emit('activationFinished',activation);
    if(run&&status==='succeeded')this.emit('turnFinished');
  }
  releaseThread(threadId,task) {
    if(!threadId||!this.client.status.connected) return;
    const status=task.status,updatedAt=task.updatedAt;
    void this.client.request('thread/unsubscribe',{threadId}).catch(()=>{
      if(task.status!==status||task.updatedAt!==updatedAt) return;
      const message='Could not release the conversation. Reconnect to Codex before continuing.';
      task.lastError=task.lastError?`${task.lastError}\n${message}`:message;
      this.changed();
    });
  }
  completeTurn(turn) {
    if(!this.active?.turnId) {if(this.active) this.active.completion=turn;return;}
    if(turn.id!==this.active.turnId) return;
    if(turn.status==='completed'&&this.active.desktopToolError){this.finish('uncertain',this.active.desktopToolError);return;}
    this.finish(turn.status==='completed'?'succeeded':turn.status==='interrupted'?'interrupted':'failed',turn.error?.message??(turn.status==='failed'?'Codex execution failed':null));
  }
  onNotification({method,params={}}) {
    if(method==='account/rateLimits/updated') {
      // Notifications can be partial. Never erase the complete multi-bucket snapshot.
      const merge=(old,value)=>{
        if(value==null)return old;
        if(typeof value!=='object'||Array.isArray(value))return value;
        const result={...old};for(const[key,item]of Object.entries(value))if(item!=null)result[key]=merge(old?.[key],item);
        if(value.resetsAt!=null&&value.resetsAt!==old?.resetsAt&&value.usedPercent==null)delete result.usedPercent;
        return result;
      };
      this.limits=merge(this.limits??{},params);
      const bucket=params.rateLimits;
      if(bucket?.limitId) {
        this.limits.rateLimitsByLimitId??={};
        this.limits.rateLimitsByLimitId[bucket.limitId]=merge(this.limits.rateLimitsByLimitId[bucket.limitId]??{},bucket);
      }
      const periods=currentQuotaWindows(this.limits,this.store.data.quota);
      let skipped=false;
      for(const plan of this.store.data.quota.plans.filter(plan=>plan.status==='scheduled')) {
        const period=periods[plan.kind];
        if(period?.state==='anchored'&&Date.parse(period.resetAt)-PERIODS[plan.kind]>=Date.parse(plan.activationAt)-5000) {
          plan.status='skipped';plan.confirmed=true;plan.skippedReason='This window was already activated.';skipped=true;
        }
      }
      if(skipped)this.changed();else this.emit('change');
      this.emit('quotaUpdated');
    }
    const active=this.active;if(!active||params.threadId!==active.threadId) return;
    if(method==='thread/tokenUsage/updated'&&active.run) {
      const usage=params.tokenUsage;
      if(usage?.total)active.run.tokenUsage=structuredClone(usage);
    }
    if(method==='item/agentMessage/delta' && active.run) {
      active.run.output=(active.run.output+String(params.delta??'')).slice(-2_000_000);
      // Throttle durable output writes but keep the visible stream responsive.
      if(Date.now()-(this.lastOutputSave??0)>1000) {this.lastOutputSave=Date.now();this.changed();}
    }
    if(method==='turn/started'&&params.turn?.id) {active.turnId=params.turn.id;if(active.run)active.run.turnId=params.turn.id;}
    if(method==='turn/completed') this.completeTurn(params.turn);
    if(method==='serverRequest/resolved') {
      this.approvals=this.approvals.filter(a=>a.rpcId!==params.requestId);
      active.task.status=this.approvals.some(a=>a.taskId===active.task.id)?'awaiting_approval':'running';this.changed();
    }
  }
  onRequest({id,method,params}) {
    const active=this.active;
    if(!active||params?.threadId!==active.threadId) {
      this.client.respond(id,undefined,{code:-32601,message:'Sweatshop has no active task for this server request'});return;
    }
    if(active.task.activationPlanId) {
      if(['item/commandExecution/requestApproval','item/fileChange/requestApproval'].includes(method))this.client.respond(id,{decision:'decline'});
      else if(method==='item/permissions/requestApproval')this.client.respond(id,{permissions:{},scope:'turn'});
      else if(method==='mcpServer/elicitation/request')this.client.respond(id,{action:'decline',content:null});
      else if(method==='item/tool/call')this.client.respond(id,{success:false,contentItems:[{type:'inputText',text:'Window activation only permits a greeting.'}]});
      else this.client.respond(id,undefined,{code:-32601,message:'Window activation only permits a greeting.'});
      return;
    }
    if(method==='item/tool/call') {
      // Dynamic tools belong to the client that registered them. There is no
      // public Desktop RPC that lets this sidecar execute that client's tools.
      const message=`The tool “${params.namespace?params.namespace+'.':''}${params.tool}” requires Codex Desktop. It was not executed by Sweatshop. Check this conversation in Desktop before continuing.`;
      this.client.respond(id,{success:false,contentItems:[{type:'inputText',text:message}]});
      active.desktopToolError=message;active.task.lastError=message;if(active.run)active.run.desktopToolError=message;this.changed();return;
    }
    const supported=['item/commandExecution/requestApproval','item/fileChange/requestApproval','item/permissions/requestApproval','item/tool/requestUserInput','tool/requestUserInput','mcpServer/elicitation/request'];
    if(!supported.includes(method)) {
      this.client.respond(id,undefined,{code:-32601,message:`Unsupported interactive request: ${method}`});
      active.task.lastError=`Unsupported interactive request: ${method}. Check the conversation`;this.changed();return;
    }
    this.approvals.push({id:randomUUID(),rpcId:id,taskId:active.task.id,method,params});active.task.status='awaiting_approval';this.changed();
  }
  approve(id,input) {
    const approval=this.approvals.find(a=>a.id===id);if(!approval) throw new Error('This request has ended');
    let result;
    if(approval.method==='mcpServer/elicitation/request') {
      result=elicitationResponse(approval.params,input);
    } else if(['item/tool/requestUserInput','tool/requestUserInput'].includes(approval.method)) {
      const answers={};
      for(const q of approval.params.questions??[]) {
        const entry=input.answers?.[q.id];const list=Array.isArray(entry)?entry:entry?.answers;
        if(!Array.isArray(list)||!list.length||!list.every(s=>typeof s==='string'&&s.length<=10000)) throw new Error('Answer all questions');
        answers[q.id]={answers:list};
      }
      result={answers};
    } else {
      if(!['accept','decline'].includes(input.decision)) throw new Error('Invalid approval decision');
      result=approval.method==='item/permissions/requestApproval'?{permissions:input.decision==='accept'?approval.params.permissions:{},scope:'turn'}:{decision:input.decision};
    }
    this.client.respond(approval.rpcId,result);this.approvals=this.approvals.filter(a=>a.id!==id);
    if(this.active) this.active.task.status=this.approvals.length?'awaiting_approval':'running';this.changed();
  }
  async cancel(task) {
    if(this.active?.task.id===task.id) {
      if(!this.active.turnId) throw new Error('The task is starting. Wait before stopping it');
      await this.client.request('turn/interrupt',{threadId:this.active.threadId,turnId:this.active.turnId});
      // Wait for turn/completed; successful interrupt RPC is not completion.
      task.lastError='Stop requested. Waiting for Codex to confirm';this.changed();
    } else {task.status='paused';this.changed();}
  }
  suspendForShutdown() {
    this.suspended=true;
    if(this.active) this.finish(this.active.run?'uncertain':'interrupted',this.active.run?'The service closed. Check the conversation for the execution result first.':'The service closed before the task was sent.');
  }
}
