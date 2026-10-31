import { randomUUID } from 'node:crypto';
import { quotaBucket } from './planner.mjs';

export const PERIODS = Object.freeze({fiveHour:300 * 60_000, week:10080 * 60_000});
const PENDING = new Set(['queued','scheduled','waiting_quota','waiting_session']);
const iso = value => new Date(value).toISOString();
const instant = value => value == null ? null : typeof value === 'number' ? value : Date.parse(value);
const activePlans = quota => (quota?.plans ?? []).filter(plan => ['scheduled','running'].includes(plan.status));
const expiredUnused = (period,reset,now) => Number.isFinite(reset) && reset>0 && reset<=now
  && period?.usedPercent!=null && Number(period.usedPercent)===0;
const CONFIRMATION_ERROR='The greeting completed, but this quota window could not be confirmed. It will not be repeated automatically.';

/** Prefer the account-wide bucket. A separate model allowance must not masquerade as it. */
export function meteredPeriods(limits) {
  const entries = Object.entries(limits?.rateLimitsByLimitId ?? {});
  const bucket = entries.find(([id,value]) => id === 'codex' || value?.limitId === 'codex')
    ?? (limits?.rateLimits ? ['legacy',limits.rateLimits] : entries[0]);
  const result = {};
  for (const [kind,duration] of Object.entries(PERIODS)) {
    const period = Object.values(bucket?.[1] ?? {}).find(value => value && typeof value === 'object'
      && Number(value.windowDurationMins) * 60_000 === duration);
    if (period) result[kind] = {...period,bucketId:bucket[0],model:bucket[1].normalModelSlug ?? null};
  }
  return result;
}

export function emptyQuotaState() { return {accountId:null,observations:{},plans:[]}; }

// Positive use in a shorter period of the same bucket also establishes use in
// a containing period, even when that longer period rounds down to zero.
function usageEvidence(periods,kind,reset,now) {
  if(Number(periods[kind]?.usedPercent)>0)return 'usage';
  const start=reset-PERIODS[kind];
  for(const [other,duration] of Object.entries(PERIODS)) {
    if(other===kind)continue;
    const period=periods[other],end=Number(period?.resetsAt)*1000;
    if(Number(period?.usedPercent)>0 && period.bucketId===periods[kind]?.bucketId
      && end>now && end<=now+duration+5000 && end-duration>=start-5000 && end-duration<=now+5000)
      return 'shared_usage';
  }
  return null;
}

export function expireActivationConfirmations(quota,now=Date.now()) {
  let changed=false;
  for(const plan of quota.plans??[])if(plan.status==='succeeded'&&plan.confirmed==null
    && now-instant(plan.finishedAt)>120_000) {
    plan.confirmed=false;
    plan.error=CONFIRMATION_ERROR;
    changed=true;
  }
  return changed;
}

/** Only fresh reads are samples. A merged notification may contain an old reset timestamp. */
export function observeQuota(quota,limits,now = Date.now()) {
  const accountId = limits?.accountId ?? null;
  if (accountId && quota.accountId && accountId !== quota.accountId) {
    quota.observations = {};
    for (const plan of activePlans(quota)) { plan.status='cancelled';plan.error='The signed-in account changed.'; }
  }
  if (accountId) quota.accountId=accountId;
  quota.observations ??= {};
  const periods = meteredPeriods(limits);
  for (const [kind,duration] of Object.entries(PERIODS)) {
    const period=periods[kind],reset=period?.resetsAt == null ? null : Number(period.resetsAt)*1000;
    const unused=expiredUnused(period,reset,now);
    if (!Number.isFinite(reset) || reset<=0 || (reset<=now&&!unused) || reset > now+duration+5000) {
      quota.observations[kind]={state:'unknown',reason:period?'stale_reset':'unavailable',sampledAt:now,resetsAt:reset};
      continue;
    }
    const previous=quota.observations[kind],comparison=previous?.comparison??previous;
    const elapsed=now-(comparison?.sampledAt??now),difference=reset-(comparison?.resetsAt??reset);
    const compatible=comparison?.bucketId===period.bucketId && elapsed>=0 && elapsed<=180_000;
    const comparable=compatible && elapsed>=15_000;
    const sampleDifference=reset-(previous?.resetsAt??reset);
    const usage=usageEvidence(periods,kind,reset,now);
    let state='unknown',reason='zero_usage';
    if (unused) {state='floating';reason='expired_unused_reset';}
    else if (usage) {state='anchored';reason=usage;}
    else if (comparable && difference>=10_000 && Math.abs(difference-elapsed)<=5000) {state='floating';reason='moving_reset';}
    else if (compatible && previous?.resetsAt===reset && previous.state==='anchored'
      && ['usage','shared_usage','metered_activation'].includes(previous.reason)) {state='anchored';reason=previous.reason;}
    else if (compatible && previous?.state==='floating' && reset>=previous.resetsAt-1000) {
      // Cached forecasts can advance by only a few seconds or remain unchanged.
      // Neither observation retracts prior drift evidence or proves anchoring.
      state='floating';reason='moving_reset';
    }
    const stableSince=Math.abs(sampleDifference)<=1000 ? (previous?.stableSince??previous?.sampledAt??now) : now;
    // Keep an older comparison sample when polling faster than the inference
    // interval. Comparing only adjacent two-second reads would never detect drift.
    const nextComparison=compatible&&!comparable?comparison:{sampledAt:now,resetsAt:reset,bucketId:period.bucketId};
    quota.observations[kind]={state,reason,sampledAt:now,stableSince,resetsAt:reset,bucketId:period.bucketId,
      usedPercent:period.usedPercent,comparison:nextComparison};
    for(const plan of quota.plans.filter(plan=>plan.status==='succeeded'
      && (!plan.accountId || plan.accountId===quota.accountId))) {
      const run=plan.task?.runs?.at(-1),started=instant(run?.startedAt);
      const finished=instant(run?.finishedAt??plan.finishedAt)??started,cycleStart=reset-duration;
      const newlyStarted=started!=null&&cycleStart>=started-5000&&cycleStart<=Math.max(started+15_000,finished+5000);
      // The server clock and cached preflight reset need not match local dispatch
      // time. Real same-bucket usage inside the returned cycle is the evidence.
      const meteredCycle=Number.isFinite(started)&&Number.isFinite(finished)&&started<=finished&&now>=finished
        && started>=cycleStart-5000&&reset>finished&&run?.status==='succeeded'
        && run.meteredBucketId===period.bucketId&&run.modelProvider==='openai'
        && Number(run.tokenUsage?.total?.totalTokens)>0;
      if(reset>now && (meteredCycle || (plan.confirmed!==false && usage && newlyStarted && now>=finished))) {
        plan.verification??={};
        let sample=plan.verification[kind];
        if(!sample || sample.reset!==reset || sample.sampledAt<finished || sample.sampledAt>now) {
          // Persisted post-greeting observations can recover a timed-out check
          // on restart, without issuing another greeting or restarting polling.
          const stableAt=compatible&&previous?.resetsAt===reset&&previous.sampledAt>=finished
            ? Math.max(previous.stableSince??previous.sampledAt,finished) : now;
          sample=plan.verification[kind]={reset,sampledAt:stableAt};
        }
        if(usage || now-sample.sampledAt>=60_000) {
          if(plan.kind===kind){
            plan.confirmed=true;plan.confirmedResetAt=iso(reset);
            if(plan.error===CONFIRMATION_ERROR)plan.error=null;
          }
          quota.observations[kind].state='anchored';quota.observations[kind].reason='metered_activation';
        }
      }
    }
    if(quota.observations[kind].state==='anchored') {
      for(const plan of quota.plans.filter(plan=>plan.kind===kind&&plan.status==='scheduled'&&instant(plan.originAt)!==reset)) {
        const base=instant(plan.baseAt)+(plan.inheritedOffset??0),cycleStart=reset-duration;
        const index=Math.round((base-reset)/duration);
        if(cycleStart>=instant(plan.activationAt)-5000) {
          plan.status='skipped';plan.confirmed=true;plan.skippedReason='Another task already activated this window.';
        } else if(index>=1 && Math.abs(reset+index*duration-base)<=30_000) {
          const aligned=reset+index*duration;
          plan.activationAt=iso(instant(plan.activationAt)+aligned-base);
          plan.endAt=iso(instant(plan.activationAt)+duration);
          plan.originAt=iso(reset);plan.baseAt=iso(aligned);plan.index=index;plan.inheritedOffset=0;
        } else if(now<instant(plan.activationAt)) {
          plan.status='cancelled';plan.error='The quota reset changed after new usage. This obsolete activation plan was cancelled.';
        }
      }
    }
  }
  // Confirmation must finish even if subsequent readings are absent or expired.
  expireActivationConfirmations(quota,now);
}

export function currentQuotaWindows(limits,quota,now = Date.now()) {
  const result={},periods=meteredPeriods(limits);
  for (const [kind,duration] of Object.entries(PERIODS)) {
    const period=periods[kind];if(!period)continue;
    const reset=period.resetsAt==null?null:Number(period.resetsAt)*1000;
    const observation=quota?.observations?.[kind];
    const fresh=observation?.resetsAt===reset && now>=observation.sampledAt && now-observation.sampledAt<=180_000;
    // Some fresh zero-use readings keep the just-ended reset until first usage.
    // Forecast from the sampled time; it is never evidence of a metered reset.
    const projectedReset=expiredUnused(period,reset,now) && fresh && observation.state==='floating'
      && observation.reason==='expired_unused_reset';
    const valid=Number.isFinite(reset)&&reset>now&&reset<=now+duration+5000;
    const usage=valid?usageEvidence(periods,kind,reset,now):null;
    const state=projectedReset?'floating':!valid?'unknown':usage?'anchored'
      :fresh ? observation.state : 'unknown';
    result[kind]={...period,state,reason:usage??observation?.reason??'awaiting_samples',
      resetAt:projectedReset?iso(observation.sampledAt+duration):valid?iso(reset):null,
      meteredResetAt:Number.isFinite(reset)&&reset>0?iso(reset):null,projectedReset,
      canActivate:fresh&&(valid||projectedReset)&&period.usedPercent!=null&&Number(period.usedPercent)===0};
  }
  return result;
}

function taskStarts(task) {
  return PENDING.has(task.status) && ['auto','exact','window'].includes(task.schedule?.mode)
    ? instant(task.scheduledAt ?? (task.schedule.mode==='exact'?task.schedule.at:null)) : null;
}

/** Every reset node represents the window END. Its greeting belongs one period earlier. */
export function quotaTimeline(limits,quota,settings={},tasks=[],now=Date.now(),count=72,{taskModels}={}) {
  const periods=currentQuotaWindows(limits,quota,now),nodes=[];
  const sharesBucket=(task,period)=>{
    // Production callers supply freshly inspected identities. Pure callers can
    // supply an explicit model; unknown/inherited models never promise a lock.
    const identity=taskModels?taskModels.get(task.id):task.modelMode!=='inherit'&&task.model
      ?{model:task.model,modelProvider:task.modelProvider??'openai'}:null;
    return !!period&&identity?.modelProvider==='openai'&&!!identity.model
      &&quotaBucket(limits,identity.model)?.[0]===period.bucketId;
  };
  for (const [kind,duration] of Object.entries(PERIODS)) {
    const current=periods[kind];
    if (!current && kind==='week') continue;
    const fallback=instant(settings.windowAnchor)??now;
    let origin=current?.resetAt?instant(current.resetAt):fallback+(Math.floor((now-fallback)/duration)+1)*duration;
    const plans=(quota?.plans??[]).filter(plan=>['scheduled','running'].includes(plan.status)
      || (plan.status==='succeeded'&&plan.confirmed==null)).filter(plan=>plan.kind===kind
      && (!quota.accountId || !plan.accountId || plan.accountId===quota.accountId));
    // A deliberate appointment stops an idle window's forecast drifting with the clock.
    const pin=plans.find(plan=>instant(plan.endAt)>now && current?.state!=='anchored');
    if(pin)origin=instant(pin.originAt);
    else if(current?.state!=='anchored') {
      const taskPin=tasks.find(task=>taskStarts(task)>now && task.quotaNode?.kind===kind && task.quotaNode.index===0
        && instant(task.quotaNode.time)===taskStarts(task));
      if(taskPin)origin=instant(taskPin.quotaNode.originAt);
    }
    let offset=0,predecessorsFixed=true;
    for(let index=0;index<count;index++) {
      const base=origin+index*duration;
      const plan=plans.find(plan=>Math.abs(instant(plan.baseAt)-base)<1000 && instant(plan.originAt)===origin);
      if(plan)offset=instant(plan.endAt)-base;
      const time=base+offset;
      if(time<=now)continue;
      const certainty=index===0 && current?.state==='anchored' && time===instant(current.resetAt) ? 'confirmed':'projected';
      const windowStart=time-duration;
      const taskIds=tasks.filter(task=>taskStarts(task)===windowStart&&sharesBucket(task,current)).map(task=>task.id);
      const lock=certainty==='confirmed'?'confirmed':taskIds.length?'task':plan?'planned':null;
      const available=Boolean(current?.resetAt) && (current.state!=='unknown'||current.canActivate);
      const eligible=available && predecessorsFixed;
      const id=`${kind}:${base}`;
      nodes.push({id,kind,time:iso(time),windowStart:iso(windowStart),baseAt:iso(base),originAt:iso(origin),index,certainty,lock,
        planId:plan?.id??null,taskIds,canPlan:eligible&&!lock,canCancel:lock==='planned'&&plan.status==='scheduled',
        canDrag:eligible && certainty==='projected' && !lock,
        disabledReason:certainty==='confirmed'?'Quota window already anchored':taskIds.length?'A scheduled task will anchor this quota window':plan?.status==='running'?'Quota window anchoring...'
          :plan?.status==='succeeded'?'Waiting for quota confirmation'
          :!available?'Wait for a fresh quota reading:(':!predecessorsFixed?'Anchor the preceding quota window first!':null});
      if(certainty!=='confirmed' && !lock)predecessorsFixed=false;
    }
  }
  return {periods,nodes:nodes.sort((a,b)=>Date.parse(a.time)-Date.parse(b.time)||a.kind.localeCompare(b.kind)),
    plans:(quota?.plans??[]).filter(plan=>plan.status==='scheduled'||plan.status==='running'||(plan.status==='succeeded'&&plan.confirmed==null)||plan.error)
      .map(({task,verification,accountId,...plan})=>({...plan,model:task?.model??null}))};
}

export function planWindowActivation(quota,timeline,input,now=Date.now()) {
  let node=timeline.nodes.find(node=>node.id===input.nodeId);
  // A read can advance the idle forecast between render and click. Only resolve
  // the nearest unlocked forecast, never a later node or an existing lock.
  if(!node) {
    const match=/^(fiveHour|week):(\d+)$/.exec(input.nodeId??'');
    const first=match&&timeline.nodes.find(node=>node.kind===match[1]);
    if(first?.index===0 && first.canPlan && timeline.periods?.[first.kind]?.canActivate
      && Math.abs(instant(first.baseAt)-Number(match[2]))<=120_000)node=first;
  }
  if(!node||!node.canPlan)throw new Error(node?.disabledReason??'This window can no longer be planned. Refresh the timeline.');
  const at=input.at==null?Date.parse(node.time):Date.parse(input.at);
  if(!Number.isFinite(at)||at<Date.parse(node.time)||at<=now||at>8.64e15-73*PERIODS[node.kind])
    throw new Error('Choose a valid future time at or after this node.');
  if(at!==Date.parse(node.time) && !node.canDrag)throw new Error('Only projected unlocked nodes can be moved.');
  const immediate=node.index===0 && timeline.periods?.[node.kind]?.state!=='anchored' && at===Date.parse(node.time);
  const activationAt=immediate?now:Math.max(now,at-PERIODS[node.kind]);
  const plan={id:randomUUID(),kind:node.kind,baseAt:node.baseAt,originAt:node.originAt,index:node.index,
    activationAt:iso(activationAt),endAt:iso(activationAt+PERIODS[node.kind]),windowRelation:'ending',
    inheritedOffset:Date.parse(node.time)-Date.parse(node.baseAt),accountId:quota.accountId,status:'scheduled',createdAt:iso(now),error:null,task:null};
  quota.plans.push(plan);return plan;
}

export function cancelWindowActivation(quota,id) {
  const plan=quota.plans.find(plan=>plan.id===id);
  if(!plan||plan.status!=='scheduled')throw new Error('This activation is no longer pending. Refresh the timeline.');
  // Descendants rely on this appointment's shifted cadence. Revoke them as well.
  for(const other of activePlans(quota))if(other.kind===plan.kind && other.originAt===plan.originAt && other.index>=plan.index) {
    if(other.status==='running')throw new Error('A dependent activation is already running.');
  }
  for(const other of activePlans(quota))if(other.kind===plan.kind && other.originAt===plan.originAt && other.index>=plan.index) {
    other.status='cancelled';other.error=null;other.cancelledAt=new Date().toISOString();
  }
}

/** Known efficient subscription models only; never silently fall back to an expensive default. */
export function activationModel(models) {
  for(const name of ['gpt-6-luna','gpt-5.6-luna']) {
    const model=models.find(model=>!model.hidden&&(model.model??model.id)===name);
    if(!model)continue;
    const efforts=(model.supportedReasoningEfforts??[]).map(e=>typeof e==='string'?e:e.reasoningEffort);
    const effort=['none','minimal','low'].find(e=>efforts.includes(e));
    if(effort)return {model:name,effort,speed:'default'};
  }
  throw new Error('No supported low-cost Luna model is available. Window activation was not sent.');
}
