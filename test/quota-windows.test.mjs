import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyQuotaState,observeQuota,currentQuotaWindows,quotaTimeline,planWindowActivation,cancelWindowActivation,activationModel,PERIODS} from '../src/quota-windows.mjs';
import {planTasks,defaultSettings} from '../src/planner.mjs';
import {taskDropSchedule,compactTimelineLayout,weeklyAppendix} from '../public/schedule-geometry.mjs';

const NOW=Date.parse('2026-10-05T00:00:00Z'),HOUR=3600_000;
const iso=time=>new Date(time).toISOString();
const limits=(at=NOW,used=0,reset=at+PERIODS.fiveHour)=>({accountId:'fixture-account',rateLimitsByLimitId:{codex:{
  primary:{usedPercent:used,windowDurationMins:300,resetsAt:reset/1000},
  secondary:{usedPercent:used,windowDurationMins:10080,resetsAt:(at+PERIODS.week)/1000}}}});
function floating() {
  const quota=emptyQuotaState();observeQuota(quota,limits(NOW-60000),NOW-60000);observeQuota(quota,limits(),NOW);return quota;
}
const view=(quota,tasks=[],data=limits())=>quotaTimeline(data,quota,defaultSettings(NOW),tasks,NOW,20);

for(const kind of ['fiveHour','week'])test(`${kind} fresh expired zero-use reading predicts an idle window without inventing a metered reset`,()=>{
  const quota=emptyQuotaState(),data=limits(NOW,0,NOW-1000);
  data.rateLimitsByLimitId.codex.secondary.resetsAt=(NOW-1000)/1000;
  observeQuota(quota,data,NOW);
  const period=currentQuotaWindows(data,quota,NOW)[kind],timeline=view(quota,[],data);
  assert.equal(period.state,'floating');assert.equal(period.projectedReset,true);
  assert.equal(period.meteredResetAt,iso(NOW-1000));assert.equal(period.resetAt,iso(NOW+PERIODS[kind]));
  const node=timeline.nodes.find(node=>node.kind===kind);assert.equal(node.canPlan,true);assert.equal(node.certainty,'projected');
  // Rendering/POST at different milliseconds keeps the same sampled node identity.
  assert.equal(quotaTimeline(data,quota,defaultSettings(NOW),[],NOW+2000).nodes.find(node=>node.kind===kind).id,node.id);
  const plan=planWindowActivation(quota,timeline,{nodeId:node.id},NOW+2000);
  assert.equal(plan.activationAt,iso(NOW+2000));assert.equal(plan.endAt,iso(NOW+2000+PERIODS[kind]));
  observeQuota(quota,data,NOW+60000);
  assert.equal(currentQuotaWindows(data,quota,NOW+60000)[kind].state,'floating');
  assert.equal(plan.confirmed,undefined);
  assert.equal(currentQuotaWindows(data,quota,NOW+5*60000)[kind].state,'unknown');
});

test('expired readings with old nonzero usage or missing usage are unknown and cannot claim a new anchored cycle',()=>{
  for(const used of [10,null,undefined]){
    const data=limits(NOW,used,NOW-1000),quota=emptyQuotaState();data.rateLimitsByLimitId.codex.primary.usedPercent=used;
    observeQuota(quota,data,NOW);
    const period=currentQuotaWindows(data,quota,NOW).fiveHour;
    assert.equal(period.state,'unknown');assert.equal(period.resetAt,null);assert.equal(period.projectedReset,false);
  }
});

test('a replied greeting remains locked awaiting actual quota confirmation; idle projections never confirm it',()=>{
  const quota=emptyQuotaState(),data=limits(NOW,0,NOW-1000);observeQuota(quota,data,NOW);
  const timeline=view(quota,[],data),node=timeline.nodes.find(node=>node.kind==='fiveHour');
  const plan=planWindowActivation(quota,timeline,{nodeId:node.id},NOW);
  plan.status='succeeded';plan.finishedAt=iso(NOW+3000);plan.task={runs:[{startedAt:iso(NOW),finishedAt:plan.finishedAt}]};
  observeQuota(quota,data,NOW+10000);
  const after=quotaTimeline(data,quota,defaultSettings(NOW),[],NOW+10000);
  const pending=after.nodes.find(node=>node.planId===plan.id);
  assert.equal(pending.lock,'planned');assert.equal(pending.canPlan,false);assert.equal(pending.canCancel,false);
  assert.equal(pending.certainty,'projected');assert.equal(pending.disabledReason,'Waiting for quota confirmation');
  assert.equal(after.plans[0].status,'succeeded');assert.equal(plan.confirmed,undefined);
  observeQuota(quota,data,NOW+130000);
  assert.equal(plan.confirmed,false);assert.match(plan.error,/could not be confirmed/);
});

test('metered activation confirmation accommodates actual server acceptance later in the greeting run',()=>{
  const quota=emptyQuotaState();quota.plans.push({kind:'fiveHour',status:'succeeded',finishedAt:iso(NOW+40000),
    task:{runs:[{startedAt:iso(NOW),finishedAt:iso(NOW+40000)}]}});
  observeQuota(quota,limits(NOW+41000,1,NOW+30000+PERIODS.fiveHour),NOW+41000);
  assert.equal(quota.plans[0].confirmed,true);assert.equal(quota.plans[0].confirmedResetAt,iso(NOW+30000+PERIODS.fiveHour));
});

test('greetings are scheduled one full period before the selected ending node for both quotas',()=>{
  const quota=floating();
  for(const kind of ['fiveHour','week']) {
    const node=view(quota).nodes.find(node=>node.kind===kind);
    const plan=planWindowActivation(quota,view(quota),{nodeId:node.id,at:iso(Date.parse(node.time)+HOUR)},NOW);
    assert.equal(plan.endAt,iso(Date.parse(node.time)+HOUR));assert.equal(plan.activationAt,iso(NOW+HOUR));
    assert.equal(Date.parse(plan.endAt)-Date.parse(plan.activationAt),PERIODS[kind]);
    assert.equal(plan.windowRelation,'ending');
  }
});
test('planning the floating current window dispatches now and adjusts its stale forecast to end one period later',()=>{
  const quota=floating(),timeline=view(quota),node=timeline.nodes.find(node=>node.kind==='fiveHour');
  const plan=planWindowActivation(quota,timeline,{nodeId:node.id},NOW+23000);
  assert.equal(plan.activationAt,iso(NOW+23000));assert.equal(plan.endAt,iso(NOW+23000+PERIODS.fiveHour));
});

test('the nearest floating endpoint anchors immediately even when its forecast is rounded ahead',()=>{
  const quota=floating(),timeline=view(quota),node=timeline.nodes.find(node=>node.kind==='fiveHour');
  node.time=iso(Date.parse(node.time)+2000);
  const plan=planWindowActivation(quota,timeline,{nodeId:node.id},NOW);
  assert.equal(plan.activationAt,iso(NOW));assert.equal(plan.endAt,iso(NOW+PERIODS.fiveHour));
});
test('a task starting at a node locks the following ending node, without locking the preceding window',()=>{
  const quota=floating(),nodes=view(quota).nodes.filter(node=>node.kind==='fiveHour');
  const task={id:'boundary-task',model:'test-model',status:'scheduled',schedule:{mode:'exact',at:nodes[0].time},scheduledAt:nodes[0].time};
  const after=view(quota,[task]).nodes.filter(node=>node.kind==='fiveHour');
  assert.equal(after[0].lock,null);assert.equal(after[1].lock,'task');assert.equal(after[1].windowStart,task.scheduledAt);
  assert.equal(after[1].canCancel,false);
});
test('weekly appendix includes two nearest out-of-range nodes when none are in range, otherwise one',()=>{
  const data=limits(NOW,10),quota=emptyQuotaState();observeQuota(quota,data,NOW);
  let nodes=view(quota,[],data).nodes,extra=weeklyAppendix(nodes,NOW,NOW+72*HOUR);
  assert.equal(extra.length,2);assert.equal(extra[0].time,iso(NOW+PERIODS.week));
  assert.equal(extra[0].lock,'confirmed');assert.equal(extra[1].canPlan,true);
  const plan=planWindowActivation(quota,{nodes}, {nodeId:extra[1].id},NOW);
  assert.equal(plan.activationAt,extra[0].time);assert.equal(plan.endAt,extra[1].time);
  cancelWindowActivation(quota,plan.id);
  data.rateLimitsByLimitId.codex.secondary.resetsAt=(NOW+2*HOUR)/1000;observeQuota(quota,data,NOW);
  nodes=view(quota,[],data).nodes;extra=weeklyAppendix(nodes,NOW,NOW+72*HOUR);
  assert.equal(extra.length,1);assert.equal(extra[0].time,iso(NOW+2*HOUR+PERIODS.week));
});

test('a later planned node stays pinned when the preceding confirmed reset passes without usage',()=>{
  const quota=emptyQuotaState(),anchored=limits(NOW,1,NOW+HOUR);observeQuota(quota,anchored,NOW);
  const nodes=view(quota,[],anchored).nodes.filter(node=>node.kind==='fiveHour');
  const plan=planWindowActivation(quota,view(quota,[],anchored),{nodeId:nodes[1].id,at:iso(Date.parse(nodes[1].time)+HOUR)},NOW);
  const later=NOW+2*HOUR,data=limits(later);observeQuota(quota,data,later);observeQuota(quota,limits(later+60000),later+60000);
  const timeline=quotaTimeline(limits(later+60000),quota,defaultSettings(NOW),[],later+60000,20);
  const planned=timeline.nodes.find(node=>node.planId===plan.id);
  assert.equal(planned.time,plan.endAt);assert.equal(planned.lock,'planned');
  assert.equal(timeline.nodes.find(node=>node.kind==='fiveHour'&&node.index===2).time,iso(Date.parse(plan.endAt)+PERIODS.fiveHour));
});

test('zero usage alone is unknown; a moving reset establishes an unanchored window',()=>{
  const quota=emptyQuotaState();observeQuota(quota,limits(),NOW);
  assert.equal(currentQuotaWindows(limits(),quota,NOW).fiveHour.state,'unknown');
  observeQuota(quota,limits(NOW+60000),NOW+60000);
  assert.equal(currentQuotaWindows(limits(NOW+60000),quota,NOW+60000).fiveHour.state,'floating');
  assert.equal(quota.observations.week.state,'floating');
});

for(const kind of Object.keys(PERIODS))test(`${kind} first zero-use reading permits one current-window activation without waiting for drift samples`,()=>{
  const quota=emptyQuotaState(),data=limits();observeQuota(quota,data,NOW);
  const timeline=view(quota,[],data),nodes=timeline.nodes.filter(node=>node.kind===kind);
  assert.equal(timeline.periods[kind].state,'unknown');assert.equal(nodes[0].canPlan,true);
  assert.equal(nodes[1].canPlan,false);
  const plan=planWindowActivation(quota,timeline,{nodeId:nodes[0].id},NOW);
  assert.equal(plan.activationAt,iso(NOW));assert.equal(plan.endAt,iso(NOW+PERIODS[kind]));
  const after=view(quota,[],data).nodes.filter(node=>node.kind===kind);
  assert.equal(after[0].lock,'planned');assert.equal(after[0].canPlan,false);
});

test('a cached forecast advancing three seconds retains previously established floating evidence',()=>{
  const quota=floating(),data=limits(NOW+3000);
  observeQuota(quota,data,NOW+14000);
  for(const kind of Object.keys(PERIODS))assert.equal(currentQuotaWindows(data,quota,NOW+14000)[kind].state,'floating');
  observeQuota(quota,data,NOW+74000);
  for(const kind of Object.keys(PERIODS))assert.equal(currentQuotaWindows(data,quota,NOW+74000)[kind].state,'floating');
});

test('positive five-hour use establishes a containing weekly window with rounded-zero usage',()=>{
  const data=limits(NOW,0);data.rateLimitsByLimitId.codex.primary.usedPercent=1;
  const quota=emptyQuotaState();observeQuota(quota,data,NOW);
  assert.equal(currentQuotaWindows(data,quota,NOW).week.state,'anchored');
  assert.equal(currentQuotaWindows(data,quota,NOW).week.reason,'shared_usage');
  const idle=limits(NOW,0);idle.rateLimitsByLimitId.codex.secondary.usedPercent=1;
  idle.rateLimitsByLimitId.codex.secondary.resetsAt=(NOW-HOUR+PERIODS.week)/1000;
  const other=emptyQuotaState();observeQuota(other,idle,NOW);
  assert.equal(currentQuotaWindows(idle,other,NOW).fiveHour.state,'unknown');
});

test('confirmation expires even when all fresh quota readings are unavailable',()=>{
  const quota=emptyQuotaState();quota.plans.push({kind:'fiveHour',status:'succeeded',finishedAt:iso(NOW),task:{runs:[{startedAt:iso(NOW)}]}});
  observeQuota(quota,{},NOW+120001);
  assert.equal(quota.plans[0].confirmed,false);assert.match(quota.plans[0].error,/could not be confirmed/);
});

test('a metered greeting into an already existing rounded-zero cycle confirms the actual stable reset, not an invented five-hour endpoint',()=>{
  const reset=NOW+2*HOUR,data=limits(NOW,0,reset),quota=emptyQuotaState();
  quota.plans.push({kind:'fiveHour',status:'succeeded',finishedAt:iso(NOW+3000),lastQuotaCheck:{meteredResetAt:iso(reset)},
    task:{runs:[{status:'succeeded',startedAt:iso(NOW),finishedAt:iso(NOW+3000),modelProvider:'openai',meteredBucketId:'codex',tokenUsage:{total:{totalTokens:56}}}]}});
  observeQuota(quota,data,NOW+4000);assert.equal(quota.plans[0].confirmed,undefined);
  observeQuota(quota,data,NOW+64000);
  assert.equal(quota.plans[0].confirmed,true);assert.equal(quota.plans[0].confirmedResetAt,iso(reset));
  assert.equal(currentQuotaWindows(data,quota,NOW+64000).fiveHour.state,'anchored');
});

test('zero-use stable cache does not confirm an older cycle from an unmetered or different-bucket reply',()=>{
  for(const bucket of ['codex','other']) {
    const reset=NOW+2*HOUR,data=limits(NOW,0,reset),quota=emptyQuotaState();
    quota.plans.push({kind:'fiveHour',status:'succeeded',finishedAt:iso(NOW+3000),lastQuotaCheck:{meteredResetAt:iso(reset)},
      task:{runs:[{status:'succeeded',startedAt:iso(NOW),finishedAt:iso(NOW+3000),modelProvider:'openai',meteredBucketId:bucket,
        tokenUsage:{total:{totalTokens:bucket==='codex'?0:56}}}]}});
    observeQuota(quota,data,NOW+4000);observeQuota(quota,data,NOW+64000);
    assert.equal(quota.plans[0].confirmed,undefined);assert.equal(currentQuotaWindows(data,quota,NOW+64000).fiveHour.state,'unknown');
  }
});

function meteredGreeting(extra={}) {
  return {id:'metered-greeting',kind:'fiveHour',status:'succeeded',accountId:'fixture-account',finishedAt:iso(NOW+6218),
    lastQuotaCheck:{meteredResetAt:iso(NOW-15940+PERIODS.fiveHour)},
    task:{runs:[{status:'succeeded',startedAt:iso(NOW),finishedAt:iso(NOW+6218),modelProvider:'openai',
      meteredBucketId:'codex',tokenUsage:{total:{totalTokens:9123,outputTokens:8}}}]},...extra};
}

test('the real rounded-zero greeting shape confirms despite a nine-second earlier server cycle and a changed preflight reset',()=>{
  const quota=emptyQuotaState(),plan=meteredGreeting(),reset=NOW-8940+PERIODS.fiveHour,data=limits(NOW,0,reset);
  quota.plans.push(plan);observeQuota(quota,data,NOW+7756);
  assert.equal(plan.confirmed,undefined);assert.equal(quota.observations.fiveHour.state,'unknown');
  observeQuota(quota,data,NOW+67756);
  assert.equal(plan.confirmed,true);assert.equal(plan.confirmedResetAt,iso(reset));
  const timeline=quotaTimeline(data,quota,defaultSettings(NOW),[],NOW+67756);
  assert.equal(timeline.periods.fiveHour.state,'anchored');assert.equal(timeline.nodes[0].certainty,'confirmed');
  assert.equal(timeline.nodes[0].canPlan,false);
});

test('a timed-out real greeting recovers from persisted stable post-greeting observations on the next read',()=>{
  const quota=emptyQuotaState(),plan=meteredGreeting(),reset=NOW-8940+PERIODS.fiveHour,data=limits(NOW,0,reset);
  quota.plans.push(plan);observeQuota(quota,data,NOW+7756);
  delete plan.verification;Object.assign(plan,{confirmed:false,error:'The greeting completed, but this quota window could not be confirmed. It will not be repeated automatically.'});
  // These are the old version's actual persisted unknown observations.
  quota.observations.fiveHour.sampledAt=NOW+50*60000;
  quota.observations.fiveHour.comparison.sampledAt=NOW+50*60000;
  const restored=JSON.parse(JSON.stringify(quota));observeQuota(restored,data,NOW+51*60000);
  assert.equal(restored.plans[0].confirmed,true);assert.equal(restored.plans[0].error,null);
  assert.equal(restored.plans[0].task.runs.length,1);assert.equal(restored.observations.fiveHour.reason,'metered_activation');
  assert.equal(currentQuotaWindows(data,restored,NOW+51*60000).fiveHour.state,'anchored');
});

test('a timed-out check with late fresh evidence recovers after a minute without restarting the fast confirmation wait',()=>{
  const quota=emptyQuotaState(),plan=meteredGreeting({confirmed:false,error:'The greeting completed, but this quota window could not be confirmed. It will not be repeated automatically.'});
  const reset=NOW-8940+PERIODS.fiveHour,data=limits(NOW,0,reset);quota.plans.push(plan);
  observeQuota(quota,data,NOW+180000);assert.equal(plan.confirmed,false);
  observeQuota(quota,data,NOW+240000);assert.equal(plan.confirmed,true);assert.equal(plan.error,null);
});

test('zero-use recovery rejects replies from a different account, bucket, provider, incomplete run or missing token usage',()=>{
  for(const change of ['account','bucket','provider','running','tokens']) {
    const quota=emptyQuotaState(),plan=meteredGreeting({confirmed:false}),run=plan.task.runs[0];quota.plans.push(plan);
    if(change==='account')plan.accountId='other-account';
    if(change==='bucket')run.meteredBucketId='other';
    if(change==='provider')run.modelProvider='other';
    if(change==='running')run.status='running';
    if(change==='tokens')delete run.tokenUsage;
    const data=limits(NOW,0,NOW-8940+PERIODS.fiveHour);
    observeQuota(quota,data,NOW+10000);observeQuota(quota,data,NOW+70000);
    assert.equal(plan.confirmed,false,change);assert.equal(currentQuotaWindows(data,quota,NOW+70000).fiveHour.state,'unknown',change);
  }
});

test('a moving zero-use forecast and a new later cycle cannot be confirmed by an earlier completed greeting',()=>{
  const quota=emptyQuotaState(),plan=meteredGreeting({confirmed:false});quota.plans.push(plan);
  observeQuota(quota,limits(NOW,0,NOW-8940+PERIODS.fiveHour),NOW+10000);
  const moving=limits(NOW+70000);observeQuota(quota,moving,NOW+70000);
  assert.equal(plan.confirmed,false);assert.notEqual(currentQuotaWindows(moving,quota,NOW+70000).fiveHour.state,'anchored');
  observeQuota(quota,moving,NOW+130000);assert.equal(plan.confirmed,false);
});

test('an expired zero-use reset remains projected and never reuses metered evidence from its ended window',()=>{
  const quota=emptyQuotaState(),plan=meteredGreeting({confirmed:false}),reset=NOW-8940+PERIODS.fiveHour;
  quota.plans.push(plan);observeQuota(quota,limits(NOW,0,reset),reset+10000);
  observeQuota(quota,limits(NOW,0,reset),reset+70000);
  const period=currentQuotaWindows(limits(NOW,0,reset),quota,reset+70000).fiveHour;
  assert.equal(period.state,'floating');assert.equal(period.projectedReset,true);assert.equal(plan.confirmed,false);
});

test('an unmetered reply at a matching cycle start still cannot turn unchanged zero-use reads into confirmation',()=>{
  const quota=emptyQuotaState(),plan=meteredGreeting();delete plan.task.runs[0].tokenUsage;quota.plans.push(plan);
  const data=limits(NOW,0,NOW+PERIODS.fiveHour);
  observeQuota(quota,data,NOW+10000);observeQuota(quota,data,NOW+70000);
  assert.equal(plan.confirmed,undefined);assert.equal(currentQuotaWindows(data,quota,NOW+70000).fiveHour.state,'unknown');
});

test('a slightly stale first-node click resolves drift without allowing duplicate or later-window activation',()=>{
  const quota=emptyQuotaState();observeQuota(quota,limits(),NOW);
  const old=view(quota).nodes.find(node=>node.kind==='fiveHour');
  const data=limits(NOW+3000);observeQuota(quota,data,NOW+14000);
  const timeline=quotaTimeline(data,quota,defaultSettings(NOW),[],NOW+14000,20);
  const plan=planWindowActivation(quota,timeline,{nodeId:old.id},NOW+14000);
  assert.equal(plan.activationAt,iso(NOW+14000));
  const after=quotaTimeline(data,quota,defaultSettings(NOW),[],NOW+14000,20);
  assert.throws(()=>planWindowActivation(quota,after,{nodeId:old.id},NOW+14000));
  assert.throws(()=>planWindowActivation(quota,after,{nodeId:`fiveHour:${NOW+2*PERIODS.fiveHour+1000}`},NOW+14000));
});

test('two-second fresh polling still detects a moving window from a sufficiently separated sample',()=>{
  const quota=emptyQuotaState();
  for(let elapsed=0;elapsed<=14000;elapsed+=2000) {
    observeQuota(quota,limits(NOW+elapsed),NOW+elapsed);
    assert.equal(quota.observations.fiveHour.state,'unknown');
  }
  for(let elapsed=16000;elapsed<=120000;elapsed+=2000) {
    const data=limits(NOW+elapsed);observeQuota(quota,data,NOW+elapsed);
    for(const kind of Object.keys(PERIODS))assert.equal(currentQuotaWindows(data,quota,NOW+elapsed)[kind].state,'floating');
  }
});

test('cached zero-use checks never prove anchoring or let expired forecasts confirm a greeting',()=>{
  const quota=emptyQuotaState(),data=limits();
  for(let elapsed=0;elapsed<60000;elapsed+=2000) {
    observeQuota(quota,data,NOW+elapsed);
    assert.equal(quota.observations.fiveHour.state,'unknown');
  }
  observeQuota(quota,data,NOW+60000);assert.equal(quota.observations.fiveHour.state,'unknown');
  data.rateLimitsByLimitId.codex.primary.resetsAt=(NOW-1000)/1000;
  quota.plans.push({kind:'fiveHour',status:'succeeded',finishedAt:iso(NOW),task:{runs:[{startedAt:iso(NOW),finishedAt:iso(NOW)}]}});
  for(let elapsed=62000;elapsed<=100000;elapsed+=2000) {
    observeQuota(quota,data,NOW+elapsed);
    assert.equal(quota.observations.fiveHour.state,'floating');assert.equal(quota.plans[0].confirmed,undefined);
  }
});

test('a cached floating forecast retains drift evidence instead of claiming anchoring after a minute',()=>{
  const quota=floating(),data=limits();
  observeQuota(quota,data,NOW+23000);
  assert.equal(currentQuotaWindows(data,quota,NOW+23000).fiveHour.state,'floating');
  observeQuota(quota,data,NOW+60000);
  assert.equal(currentQuotaWindows(data,quota,NOW+60000).fiveHour.state,'floating');
});
test('nonzero metered usage anchors both periods and only the first observed resets are confirmed',()=>{
  const quota=emptyQuotaState(),data=limits(NOW,1);observeQuota(quota,data,NOW);
  const timeline=view(quota,[],data);
  for(const kind of Object.keys(PERIODS)) {
    const nodes=timeline.nodes.filter(node=>node.kind===kind);
    assert.equal(timeline.periods[kind].state,'anchored');assert.equal(nodes[0].certainty,'confirmed');
    assert.equal(nodes[0].lock,'confirmed');assert.equal(nodes[0].canPlan,false);assert.equal(nodes[0].canCancel,false);
    assert.equal(nodes[1].certainty,'projected');assert.equal(nodes[1].canPlan,true);assert.equal(nodes[2].canPlan,false);
  }
});
test('stable zero-use readings remain unconfirmed and expire after disconnect',()=>{
  const quota=emptyQuotaState(),data=limits(NOW,0,NOW+2*HOUR);observeQuota(quota,data,NOW);
  observeQuota(quota,data,NOW+60000);assert.equal(currentQuotaWindows(data,quota,NOW+60000).fiveHour.state,'unknown');
  assert.equal(currentQuotaWindows(data,quota,NOW+5*60000).fiveHour.state,'unknown');
  assert.equal(currentQuotaWindows(data,quota,NOW+3*HOUR).fiveHour.state,'unknown');
});
test('an account switch discards quota evidence and revokes pending activations',()=>{
  const quota=floating(),node=view(quota).nodes.find(node=>node.kind==='fiveHour');
  const plan=planWindowActivation(quota,view(quota),{nodeId:node.id},NOW);
  const other={...limits(),accountId:'other-account'};observeQuota(quota,other,NOW+60000);
  assert.equal(plan.status,'cancelled');assert.equal(quota.accountId,'other-account');
});
test('only the first floating boundary is legal until a predecessor has a task or activation plan',()=>{
  const quota=floating(),nodes=view(quota).nodes.filter(node=>node.kind==='fiveHour');
  assert.equal(nodes[0].canPlan,true);assert.equal(nodes[1].canPlan,false);
  assert.throws(()=>planWindowActivation(quota,view(quota),{nodeId:nodes[1].id},NOW),/preceding/);
  planWindowActivation(quota,view(quota),{nodeId:nodes[0].id},NOW);
  const after=view(quota).nodes.filter(node=>node.kind==='fiveHour');
  assert.equal(after[0].lock,'planned');assert.equal(after[0].certainty,'projected');
  assert.equal(after[1].canPlan,true);assert.equal(after[1].lock,null);
});
test('delaying a floating node moves only its own later cadence, and cancellation restores both types',()=>{
  const quota=floating(),before=view(quota),first=before.nodes.find(node=>node.kind==='fiveHour');
  const at=Date.parse(first.time)+2*HOUR,plan=planWindowActivation(quota,before,{nodeId:first.id,at:iso(at)},NOW);
  const after=view(quota);
  assert.deepEqual(after.nodes.filter(node=>node.kind==='fiveHour').map(node=>Date.parse(node.time)),
    before.nodes.filter(node=>node.kind==='fiveHour').map(node=>Date.parse(node.time)+2*HOUR));
  assert.deepEqual(after.nodes.filter(node=>node.kind==='week'),before.nodes.filter(node=>node.kind==='week'));
  const next=after.nodes.filter(node=>node.kind==='fiveHour')[1];
  const dependent=planWindowActivation(quota,after,{nodeId:next.id},NOW);
  cancelWindowActivation(quota,plan.id);assert.equal(dependent.status,'cancelled');
  assert.deepEqual(view(quota).nodes,before.nodes);
});
test('nodes can never be dragged earlier or to an invalid timestamp',()=>{
  const quota=floating(),timeline=view(quota),node=timeline.nodes.find(node=>node.kind==='fiveHour');
  for(const at of [Date.parse(node.time)-1,NOW-1])
    assert.throws(()=>planWindowActivation(quota,timeline,{nodeId:node.id,at:iso(at)},NOW),/future time/);
  assert.throws(()=>planWindowActivation(quota,timeline,{nodeId:node.id,at:'not-a-date'},NOW),/future time/);
  const anchored=limits(NOW,10),actual=view(quota,[],anchored).nodes.find(node=>node.kind==='fiveHour');
  assert.throws(()=>planWindowActivation(quota,view(quota,[],anchored),{nodeId:actual.id,at:iso(Date.parse(actual.time)+HOUR)},NOW),/anchored/);
});
test('a task activates a boundary only at its exact timestamp; a one-second difference does not lock it',()=>{
  const quota=floating(),node=view(quota).nodes.find(node=>node.kind==='fiveHour');
  const task={id:'task',model:'test-model',status:'scheduled',schedule:{mode:'exact',at:node.windowStart},scheduledAt:node.windowStart};
  const locked=view(quota,[task]).nodes.find(item=>item.id===node.id);
  assert.equal(locked.lock,'task');assert.equal(locked.canPlan,false);assert.equal(locked.canCancel,false);
  assert.equal(locked.canDrag,false);assert.match(locked.disabledReason,/scheduled task/);
  task.scheduledAt=iso(Date.parse(node.windowStart)+1000);assert.equal(view(quota,[task]).nodes.find(item=>item.id===node.id).lock,null);
  task.status='succeeded';assert.equal(view(quota,[task]).nodes.find(item=>item.id===node.id).lock,null);
});

test('both period endings accept only tasks in the same metered bucket with a known OpenAI model',()=>{
  const data=limits(NOW,1,NOW+HOUR),quota=emptyQuotaState();data.rateLimitsByLimitId.codex.secondary.resetsAt=(NOW+HOUR)/1000;
  data.rateLimitsByLimitId.premium={normalModelSlug:'premium-model',primary:{usedPercent:0,windowDurationMins:300,resetsAt:(NOW+5*HOUR)/1000}};
  observeQuota(quota,data,NOW);
  for(const kind of ['fiveHour','week']) {
    const task={id:'boundary',model:'premium-model',modelMode:'custom',status:'scheduled',schedule:{mode:'exact',at:iso(NOW+HOUR)},scheduledAt:iso(NOW+HOUR)};
    const ending=()=>view(quota,[task],data).nodes.find(node=>node.kind===kind&&node.index===1);
    assert.equal(ending().lock,null);assert.equal(ending().canPlan,true);
    task.model='common-model';assert.equal(ending().lock,'task');assert.equal(ending().canPlan,false);
    task.modelProvider='other';assert.equal(ending().lock,null);
    task.modelMode='inherit';task.modelProvider='openai';assert.equal(ending().lock,null);
    const identities=new Map([[task.id,{model:'common-model',modelProvider:'openai'}]]);
    const resolved=quotaTimeline(data,quota,defaultSettings(NOW),[task],NOW,20,{taskModels:identities});
    assert.equal(resolved.nodes.find(node=>node.kind===kind&&node.index===1).lock,'task');
  }
});
test('an appointment pins a moving forecast across fresh reads without pretending the real window is anchored',()=>{
  const quota=floating(),before=view(quota),node=before.nodes.find(node=>node.kind==='fiveHour');
  planWindowActivation(quota,before,{nodeId:node.id},NOW);
  const later=NOW+60000,data=limits(later);observeQuota(quota,data,later);
  const after=quotaTimeline(data,quota,defaultSettings(NOW),[],later,20);
  assert.equal(after.nodes.find(node=>node.kind==='fiveHour').time,node.time);assert.equal(after.periods.fiveHour.state,'floating');
});
test('an automatic task also pins an idle forecast rather than being postponed on each refresh',()=>{
  const quota=floating(),node=view(quota).nodes.find(node=>node.kind==='fiveHour');
  const task={id:'auto',model:'test-model',status:'scheduled',schedule:{mode:'auto'},scheduledAt:node.time,
    quotaNode:{kind:node.kind,index:0,originAt:node.originAt,time:node.time}};
  const later=NOW+60000,data=limits(later);observeQuota(quota,data,later);
  const after=quotaTimeline(data,quota,defaultSettings(NOW),[task],later,20);
  assert.equal(after.nodes.find(node=>node.kind==='fiveHour').time,node.time);
  assert.equal(after.nodes.find(node=>node.kind==='fiveHour').lock,null);
  assert.equal(after.nodes.filter(node=>node.kind==='fiveHour')[1].lock,'task');
});
test('automatic tasks start at the first future node and follow deliberately delayed future nodes',()=>{
  const quota=floating(),node=view(quota).nodes.find(node=>node.kind==='fiveHour');
  planWindowActivation(quota,view(quota),{nodeId:node.id,at:iso(Date.parse(node.time)+HOUR)},NOW);
  const nodes=view(quota).nodes;
  const tasks=[{id:'a',status:'queued',schedule:{mode:'auto'}},{id:'b',status:'queued',schedule:{mode:'auto'}}];
  const planned=planTasks(tasks,defaultSettings(NOW),limits(),NOW,{nodes});
  assert.equal(planned.assignments[0].scheduledAt,iso(NOW+6*HOUR));assert.equal(planned.assignments[1].scheduledAt,iso(NOW+11*HOUR));
  assert.equal(planned.assignments[0].windowStart,planned.assignments[0].scheduledAt);
});
test('task dragging snaps exactly to quota seconds; Alt restores free placement and only five-hour nodes attract drops',()=>{
  const nodes=[{kind:'fiveHour',time:iso(NOW+2*HOUR+17000)},{kind:'week',time:iso(NOW+3*HOUR)},
    {kind:'fiveHour',time:iso(NOW+7*HOUR+17000)}];
  assert.deepEqual(taskDropSchedule(NOW+3*HOUR,nodes,{now:NOW}),{mode:'window',windowStart:nodes[0].time});
  assert.equal(taskDropSchedule(NOW+3*HOUR+8*60000,nodes,{now:NOW,altKey:true}).at,iso(NOW+3*HOUR+15*60000));
  assert.equal(taskDropSchedule(NOW+3*HOUR+8*60000,nodes,{now:NOW,altKey:true,shiftKey:true}).at,iso(NOW+3*HOUR+10*60000));
  assert.equal(taskDropSchedule(NOW,nodes,{now:NOW+10*HOUR}),null);
});
test('a three-day axis includes a real weekly reset and preserves both quota nodes when they coincide',()=>{
  const data=limits(NOW,10,NOW+2*HOUR);data.rateLimitsByLimitId.codex.secondary.resetsAt=(NOW+2*HOUR)/1000;
  const quota=emptyQuotaState();observeQuota(quota,data,NOW);const nodes=view(quota,[],data).nodes;
  const layout=compactTimelineLayout([],NOW,NOW+72*HOUR,{nodes,now:NOW});
  const marker=layout.markers.find(marker=>marker.time===NOW+2*HOUR);
  assert.deepEqual(marker.resetNodes.map(node=>node.kind).sort(),['fiveHour','week']);
  assert.equal(marker.resetNodes.every(node=>node.certainty==='confirmed'),true);
  assert.ok(layout.markers.every(marker=>marker.time<=NOW+72*HOUR));
});
test('activation model selection uses the lowest advertised effort and standard speed without an expensive fallback',()=>{
  const model=name=>({model:name,supportedReasoningEfforts:['medium','low'],serviceTiers:['priority']});
  assert.deepEqual(activationModel([model('gpt-6-astra'),model('gpt-5.6-luna'),model('gpt-6-luna')]),{model:'gpt-6-luna',effort:'low',speed:'default'});
  assert.equal(activationModel([{...model('gpt-6-luna'),supportedReasoningEfforts:['none','low']}]).effort,'none');
  assert.throws(()=>activationModel([model('gpt-6-astra')]),/low-cost/);
  assert.throws(()=>activationModel([{...model('gpt-6-luna'),hidden:true}]),/low-cost/);
});
test('a completed activation needs a matching new metered reset before it is reported as confirmed',()=>{
  const quota=floating();quota.plans.push({id:'p',kind:'fiveHour',status:'succeeded',confirmed:null,finishedAt:iso(NOW),
    task:{runs:[{status:'succeeded',startedAt:iso(NOW),finishedAt:iso(NOW),modelProvider:'openai',meteredBucketId:'codex',
      tokenUsage:{total:{totalTokens:56}}}]}});
  observeQuota(quota,limits(NOW+1000,0,NOW+PERIODS.fiveHour),NOW+1000);
  assert.equal(quota.plans[0].confirmed,null);
  observeQuota(quota,limits(NOW+61000,0,NOW+PERIODS.fiveHour),NOW+61000);
  assert.equal(quota.plans[0].confirmed,true);assert.equal(quota.observations.fiveHour.reason,'metered_activation');
  const unconfirmed={id:'u',kind:'week',status:'succeeded',confirmed:null,finishedAt:iso(NOW),task:{runs:[{startedAt:iso(NOW)}]}};
  quota.plans.push(unconfirmed);observeQuota(quota,limits(NOW+180000),NOW+180000);
  assert.equal(unconfirmed.confirmed,false);assert.match(unconfirmed.error,/could not be confirmed/);
});

test('a naturally advancing anchored window rebases a later appointment without changing its time',()=>{
  const quota=floating(),nodes=view(quota).nodes.filter(node=>node.kind==='fiveHour');
  planWindowActivation(quota,view(quota),{nodeId:nodes[0].id},NOW);
  const next=view(quota).nodes.filter(node=>node.kind==='fiveHour')[1];
  planWindowActivation(quota,view(quota),{nodeId:next.id},NOW);
  const third=view(quota).nodes.filter(node=>node.kind==='fiveHour')[2];
  const plan=planWindowActivation(quota,view(quota),{nodeId:third.id},NOW);
  const time=Date.parse(nodes[0].time)+1000,data=limits(time,10,Date.parse(nodes[1].time));
  observeQuota(quota,data,time);
  assert.equal(plan.status,'scheduled');assert.equal(plan.originAt,nodes[1].time);assert.equal(plan.index,1);
  assert.equal(plan.activationAt,nodes[1].time);
  const after=quotaTimeline(data,quota,defaultSettings(NOW),[],time,20);
  assert.equal(after.nodes.filter(node=>node.kind==='fiveHour')[1].lock,'planned');
});
test('an unexpectedly shifted live reset cancels an obsolete appointment rather than leaving an invisible greeting',()=>{
  const quota=floating(),node=view(quota).nodes.find(node=>node.kind==='fiveHour');
  const plan=planWindowActivation(quota,view(quota),{nodeId:node.id,at:iso(Date.parse(node.time)+3*HOUR)},NOW);
  observeQuota(quota,limits(NOW+HOUR,10,NOW+6*HOUR),NOW+HOUR);
  assert.equal(plan.status,'cancelled');assert.match(plan.error,/quota reset changed/);
});
test('a delayed descendant retains the preceding confirmed endpoint after its predecessor activates',()=>{
  const quota=floating(),first=view(quota).nodes.find(node=>node.kind==='fiveHour');
  const one=planWindowActivation(quota,view(quota),{nodeId:first.id,at:iso(NOW+6*HOUR)},NOW);
  const second=view(quota).nodes.filter(node=>node.kind==='fiveHour')[1];
  const two=planWindowActivation(quota,view(quota),{nodeId:second.id,at:iso(NOW+12*HOUR)},NOW);
  one.status='succeeded';one.confirmed=true;
  const later=NOW+HOUR+1000,data=limits(later,10,NOW+6*HOUR);observeQuota(quota,data,later);
  assert.equal(two.status,'scheduled');assert.equal(two.index,1);assert.equal(two.baseAt,iso(NOW+11*HOUR));
  const after=quotaTimeline(data,quota,defaultSettings(NOW),[],later,20),nodes=after.nodes.filter(node=>node.kind==='fiveHour');
  assert.equal(nodes[0].time,iso(NOW+6*HOUR));assert.equal(nodes[0].certainty,'confirmed');assert.equal(nodes[0].lock,'confirmed');
  assert.equal(nodes[1].time,iso(NOW+12*HOUR));assert.equal(nodes[1].lock,'planned');assert.equal(nodes[1].certainty,'projected');
  const planned=planTasks([{id:'a',status:'queued',schedule:{mode:'auto'}}],defaultSettings(NOW),data,later,{nodes:after.nodes});
  assert.equal(planned.assignments[0].scheduledAt,iso(NOW+6*HOUR));
});
test('weekly node delay and cancellation shift exactly seven days while five-hour nodes stay unchanged',()=>{
  const quota=floating(),before=view(quota),node=before.nodes.find(node=>node.kind==='week');
  const plan=planWindowActivation(quota,before,{nodeId:node.id,at:iso(Date.parse(node.time)+HOUR)},NOW);
  const after=view(quota),week=after.nodes.filter(node=>node.kind==='week');
  assert.equal(week[0].time,iso(Date.parse(node.time)+HOUR));assert.equal(Date.parse(week[1].time)-Date.parse(week[0].time),PERIODS.week);
  assert.deepEqual(after.nodes.filter(node=>node.kind==='fiveHour'),before.nodes.filter(node=>node.kind==='fiveHour'));
  cancelWindowActivation(quota,plan.id);assert.deepEqual(view(quota).nodes,before.nodes);
});
