import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { createApp } from '../src/server.mjs';
import { observeQuota } from '../src/quota-windows.mjs';

class Fake extends EventEmitter {
  status={connected:false};
  connectCount=0;
  async connect(){this.connectCount++;this.status.connected=true;}
  async stop(){this.status.connected=false;}
  async listModels(){return [{model:'test',isDefault:true}];}
  async readAccount(){return {account:{type:'chatgpt',planType:'plus'}};}
  async readLimits(){return {rateLimits:{primary:{usedPercent:0,windowDurationMins:300,resetsAt:Math.floor(Date.now()/1000)+15000}}};}
  async listThreads(){return {data:[{id:'thread1',name:'测试会话'}],nextCursor:null};}
  async request(method) {
    if(method==='config/read')return {config:{model:'test',model_provider:'openai'}};
    if(method==='thread/read')return {thread:{id:'thread1',model:'test',modelProvider:'openai',cwd:process.cwd()}};
    throw new Error(`Unexpected mock request: ${method}`);
  }
}
async function setup(t,options={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sweatshop-server-'));
  const app=await createApp({dataDirectory:dir,clientFactory:()=>new Fake(),autoConnect:false,...options});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const root=await fetch(base);const cookie=root.headers.get('set-cookie').split(';')[0];await root.text();
  t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true});});
  const api=async(route,method='GET',body)=>{const response=await fetch(base+route,{method,headers:{cookie,'Content-Type':'application/json'},...(method!=='GET'?{body:JSON.stringify(body??{})}:{})});return {status:response.status,data:await response.json()};};
  return {app,base,api,cookie,dir};
}
async function waitFor(predicate,timeout=1000) {
  const end=Date.now()+timeout;
  while(!predicate()){if(Date.now()>end)throw new Error('mock operation did not settle');await new Promise(resolve=>setTimeout(resolve,10));}
}
test('WWWhip API requires confirmation and updates only its own preferences',async t=>{
  const calls=[];
  const {app,api}=await setup(t,{whipRuntimeFactory:()=>({start:async config=>calls.push(config),stop:()=>calls.push('stop')})});
  const created=(await api('/api/tasks','POST',{title:'Keep this task',prompt:'untouched',cwd:process.cwd()})).data;
  const baseline=JSON.stringify(app.store.data);
  assert.equal((await api('/api/whip','POST',{enabled:true})).status,400);assert.equal(calls.length,0);
  const configuration=app.whip.snapshot().configuration;
  configuration.messages=[{question:'Continue?',message:'Continue this task.'}];
  const on=await api('/api/whip','POST',{enabled:true,confirmed:true,configuration});
  assert.equal(on.status,200);assert.equal(on.data.enabled,true);assert.equal(on.data.busy,false);assert.deepEqual(calls[0],configuration);
  assert.equal((await api('/api/state')).data.whip.enabled,true);
  const off=await api('/api/whip','POST',{enabled:false});assert.equal(off.data.enabled,false);
  assert.equal(JSON.stringify(app.store.data),baseline);assert.equal(app.store.get(created.id).prompt,'untouched');
});

test('Whip settings API saves while off and requires separate consent to enable',async t=>{
  let starts=0;const {app,api}=await setup(t,{whipRuntimeFactory:()=>({start:async()=>{starts++;},stop:()=>{}})});
  const baseline=JSON.stringify(app.store.data),configuration=app.whip.snapshot().configuration;
  configuration.messages=[{question:'Immediate?',message:'Saved immediately.'}];
  const settings=await api('/api/whip','POST',{configuration});
  assert.equal(settings.status,200);assert.equal(settings.data.enabled,false);assert.equal(starts,0);
  assert.equal(JSON.parse(fs.readFileSync(app.whip.file)).configuration.messages[0].message,'Saved immediately.');
  assert.equal((await api('/api/whip','POST',{enabled:true})).status,400);assert.equal(starts,0);
  assert.equal((await api('/api/whip','POST',{enabled:true,confirmed:true})).status,200);assert.equal(starts,1);
  assert.equal(JSON.stringify(app.store.data),baseline);
});
test('settings replan automatic commitments immediately using available nodes and system time zone',async t=>{
  const {app,api}=await setup(t);
  const created=(await api('/api/tasks','POST',{title:'Automatic',prompt:'test',cwd:process.cwd(),schedule:{mode:'auto'}})).data;
  const before=app.store.get(created.id).scheduledAt;
  const selected=app.snapshot().quota.nodes.filter(node=>node.kind==='fiveHour')[2].time;
  const updated=await api('/api/settings','POST',{startingFrom:selected,timezone:'Mars/Olympus'});
  assert.equal(updated.status,200);assert.equal(updated.data.settings.timezone,Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC');
  assert.equal(app.store.get(created.id).scheduledAt,selected);assert.notEqual(selected,before);
  assert.equal((await api('/api/settings','POST',{startingFrom:new Date(Date.now()+12345).toISOString()})).status,400);
  const manual=(await api('/api/tasks','POST',{title:'Explicit',prompt:'test',cwd:process.cwd(),schedule:{mode:'exact',at:new Date(Date.now()+3600000).toISOString()}})).data;
  const reserved=await api('/api/settings','POST',{quietHours:{enabled:true,start:'00:00',end:'23:59'}});
  const local=new Intl.DateTimeFormat('en',{timeZone:reserved.data.settings.timezone,hourCycle:'h23',hour:'2-digit',minute:'2-digit'}).format(new Date(app.store.get(created.id).scheduledAt));
  assert.equal(local,'23:59');assert.equal(app.store.get(manual.id).scheduledAt,manual.schedule.at);
});
test('new manual tasks stay unplanned while CRUD and automatic settings work without dispatch',async t=>{
  const {api,app}=await setup(t);
  const created=await api('/api/tasks','POST',{title:'任务',prompt:'# Markdown',target:'new',cwd:process.cwd(),priority:90});
  assert.equal(created.status,201);assert.equal(created.data.status,'queued');assert.equal(created.data.schedule.mode,'manual');assert.equal(created.data.scheduledAt,null);assert.equal(app.runner.active,null);
  const state=await api('/api/state');assert.equal(state.data.settings.schedulerEnabled,true);assert.equal(state.data.tasks.length,1);
  const settings=await api('/api/settings','POST',{tasksPerWindow:2,schedulerEnabled:false,binary:'ignored',codexHome:'ignored'});
  assert.equal(settings.data.settings.schedulerEnabled,true);assert.equal(settings.data.settings.binary,'');assert.equal(settings.data.settings.codexHome,'');
  assert.equal((await api(`/api/tasks/${created.data.id}`,'PUT',{title:'修改'})).data.title,'修改');
  assert.equal((await api(`/api/tasks/${created.data.id}`,'DELETE')).status,200);
});
test('cross-origin requests, missing sessions and malformed origin are rejected',async t=>{
  const {base,cookie}=await setup(t);
  assert.equal((await fetch(base+'/api/state')).status,401);
  for(const origin of ['https://evil.example','null','http://127.0.0.1:1'])assert.equal((await fetch(base+'/api/tasks',{method:'POST',headers:{cookie,origin,'Content-Type':'application/json'},body:'{}'})).status,403);
  const rejected=await new Promise((resolve,reject)=>{const request=http.get(base+'/app.js',{headers:{Host:'evil.example'}},response=>{response.resume();resolve(response.statusCode);});request.on('error',reject);});
  assert.equal(rejected,403);
});
test('obsolete connect, scheduler and JSON transfer APIs are removed',async t=>{
  const {api,app}=await setup(t);
  for(const [route,method] of [['/api/export','GET'],['/api/import','POST'],['/api/connect','POST'],['/api/scheduler','POST']])assert.equal((await api(route,method,{tasks:[],enabled:true})).status,404,route);
  assert.equal(app.store.data.tasks.length,0);assert.equal(app.runner.client.connectCount,0);
});
test('startup automatically reads capabilities and account without a connect action',async t=>{
  const {api,app}=await setup(t,{autoConnect:true});await app.refreshConnection();
  const connected=await api('/api/state');assert.equal(connected.data.connection.account.type,'chatgpt');assert.equal(connected.data.settings.schedulerEnabled,true);assert.equal(connected.data.models.length,1);assert.equal((await api('/api/threads')).data.data.length,1);
});

test('shutdown closes a live event stream without waiting for the window to exit',async t=>{
  const {app,base,cookie}=await setup(t);
  const stream=await fetch(base+'/api/events',{headers:{cookie}});
  const reader=stream.body.getReader();
  assert.equal(stream.status,200);assert.ok((await reader.read()).value.length);
  await app.close();
  // The stream is either ended or its socket is closed; it cannot keep the process alive.
  try { assert.equal((await reader.read()).done,true); } catch(error) { assert.match(error.message,/terminated|closed|socket/i); }
  assert.ok(!fs.existsSync(app.store.lock));
});

test('reserved-hour dispatch guard replans immediately before another scheduler tick',async t=>{
  const {app,api}=await setup(t);
  await api('/api/settings','POST',{timezone:'UTC',quietHours:{enabled:true,start:'00:00',end:'23:59'}});
  const created=await api('/api/tasks','POST',{title:'额度延期',prompt:'test',cwd:process.cwd(),schedule:{mode:'auto'}});
  const task=app.store.get(created.data.id);
  task.scheduledAt=new Date(Date.now()-1000).toISOString();task.status='scheduled';
  app.runner.client.readLimits=async()=>({rateLimits:{primary:{usedPercent:100,windowDurationMins:300,resetsAt:Math.floor(Date.now()/1000)+1}}});
  await app.runner.launch(task);
  assert.equal(task.status,'scheduled');assert.equal(task.runs.length,0);
  const planned=new Date(task.scheduledAt);
  const parts=new Intl.DateTimeFormat('en',{timeZone:app.store.data.settings.timezone,hourCycle:'h23',hour:'2-digit',minute:'2-digit'}).formatToParts(planned);
  assert.equal(parts.find(part=>part.type==='hour').value,'23');assert.equal(parts.find(part=>part.type==='minute').value,'59');
  assert.ok(Date.parse(task.scheduledAt)>=Date.parse(task.notBefore));
});

test('obsolete estimate updates are rejected without changing startup dates or paused state',async t=>{
  const {app,api}=await setup(t);
  const body={title:'时间块',prompt:'test',cwd:process.cwd(),schedule:{mode:'auto'}};
  const created=await api('/api/tasks','POST',body);await api('/api/tasks','POST',{...body,title:'其他任务'});
  await api(`/api/tasks/${created.data.id}/action`,'POST',{action:'pause'});
  const commitments=()=>app.store.data.tasks.map(({id,status,scheduledAt,windowStart,windowEnd,schedule})=>({id,status,scheduledAt,windowStart,windowEnd,schedule}));
  const before=structuredClone(commitments());
  const resized=await api(`/api/tasks/${created.data.id}`,'PUT',{plannedMinutes:150});
  assert.equal(resized.status,400);assert.match(resized.data.error,/only a start time/);assert.deepEqual(commitments(),before);
  assert.equal(app.runner.active,null);assert.equal(app.store.data.settings.schedulerEnabled,true);
});

test('automatic reorder changes only pending auto dates and rejects stale lists atomically',async t=>{
  const {app,api}=await setup(t);
  const body={title:'auto',prompt:'test',cwd:process.cwd(),schedule:{mode:'auto'}};
  const first=(await api('/api/tasks','POST',{...body,title:'first',priority:90})).data;
  const second=(await api('/api/tasks','POST',{...body,title:'second',priority:10})).data;
  const paused=(await api('/api/tasks','POST',{...body,title:'paused'})).data;
  await api(`/api/tasks/${paused.id}/action`,'POST',{action:'pause'});
  const exact=(await api('/api/tasks','POST',{...body,title:'exact',schedule:{mode:'exact',at:new Date(Date.now()+2*3600000).toISOString()}})).data;
  const fixed=(await api('/api/tasks','POST',{...body,title:'window',schedule:{mode:'window',windowStart:new Date(Date.now()+20*3600000).toISOString()}})).data;
  const history=(await api('/api/tasks','POST',{...body,title:'history'})).data;
  app.store.get(history.id).status='succeeded';app.store.save();
  const unchanged=()=>[exact,fixed,paused,history].map(({id})=>structuredClone(app.store.get(id)));
  const before=unchanged();
  const result=await api('/api/tasks/reorder','POST',{taskIds:[second.id,first.id]});
  assert.equal(result.status,200);assert.deepEqual(unchanged(),before);
  assert.ok(Date.parse(app.store.get(second.id).scheduledAt)<Date.parse(app.store.get(first.id).scheduledAt));
  assert.equal(app.store.get(second.id).autoOrder,0);assert.equal(app.store.get(first.id).autoOrder,1);
  const saved=JSON.stringify(app.store.data);
  for(const taskIds of [[first.id],[first.id,first.id],[first.id,paused.id]]) {
    assert.equal((await api('/api/tasks/reorder','POST',{taskIds})).status,400);
    assert.equal(JSON.stringify(app.store.data),saved);
  }
  const next=(await api('/api/tasks','POST',{...body,title:'new auto',priority:100})).data;
  await api('/api/plan','POST');
  assert.ok(Date.parse(app.store.get(next.id).scheduledAt)>Date.parse(app.store.get(first.id).scheduledAt));
});

test('linked Markdown previews reread disk and snapshot changes never move schedules',async t=>{
  const {app,api,dir}=await setup(t);
  const file=path.join(dir,'live.md');fs.writeFileSync(file,'# First prompt');
  const preview=await api(`/api/prompt-file?path=${encodeURIComponent(file)}`);
  assert.deepEqual(preview.data,{path:file,name:'live.md',text:'# First prompt'});
  const created=(await api('/api/tasks','POST',{title:'linked',promptFile:file,cwd:process.cwd(),schedule:{mode:'exact',at:new Date(Date.now()+3600000).toISOString()}})).data;
  const times=()=>{const task=app.store.get(created.id);return [task.scheduledAt,task.windowStart,task.windowEnd,task.status];};
  const before=times();fs.writeFileSync(file,'# Changed prompt');
  let snapshot=(await api('/api/state')).data;
  assert.equal(snapshot.tasks[0].prompt,'# Changed prompt');assert.deepEqual(times(),before);
  fs.unlinkSync(file);assert.equal((await api(`/api/prompt-file?path=${encodeURIComponent(file)}`)).status,400);
  snapshot=(await api('/api/state')).data;
  assert.equal(snapshot.tasks[0].prompt,'');assert.match(snapshot.tasks[0].promptFileError,/does not exist/);assert.deepEqual(times(),before);
  fs.writeFileSync(file,'# Recovered prompt');snapshot=(await api('/api/state')).data;
  assert.equal(snapshot.tasks[0].prompt,'# Recovered prompt');assert.equal(snapshot.tasks[0].promptFileError,null);assert.deepEqual(times(),before);
  assert.equal((await api('/api/prompt-file?path=relative.md')).status,400);
});

test('autoConnect false isolates background account reads and dispatch even for due auto tasks',async t=>{
  t.mock.timers.enable({apis:['setInterval']});
  const {app,api}=await setup(t);
  const created=(await api('/api/tasks','POST',{title:'due',prompt:'test',cwd:process.cwd(),schedule:{mode:'auto'}})).data;
  app.store.get(created.id).scheduledAt=new Date(Date.now()-1000).toISOString();
  let ticks=0;app.runner.tick=async()=>{ticks++;};
  t.mock.timers.tick(65000);
  assert.equal(app.runner.client.connectCount,0);assert.equal(ticks,0);assert.equal(app.runner.active,null);
});

test('automatic connection failures stay visible, retry and never overlap refreshes',async t=>{
  const client=new Fake();let release;
  const pending=new Promise(resolve=>{release=resolve;});let concurrent=0,maxConcurrent=0;
  client.connect=async()=>{
    client.connectCount++;concurrent++;maxConcurrent=Math.max(concurrent,maxConcurrent);
    try {if(client.connectCount===1)throw new Error('mock transport unavailable');if(client.connectCount===2)await pending;client.status.connected=true;}
    finally{concurrent--;}
  };
  const {app}=await setup(t,{autoConnect:true,clientFactory:()=>client,connectionRetryMs:30,connectionRefreshMs:60000});
  assert.match(app.snapshot().connection.lastError,/mock transport unavailable/);
  await waitFor(()=>client.connectCount===2);
  const joined=app.refreshConnection();release();assert.equal(await joined,true);
  assert.equal(maxConcurrent,1);assert.equal(client.connectCount,2);assert.equal(app.snapshot().connection.lastError,null);
  client.status.connected=false;client.emit('disconnect',new Error('mock disconnected'));
  await waitFor(()=>client.connectCount===3);assert.equal(client.status.connected,true);
});

test('periodic read-only quota refresh retains future committed dates',async t=>{
  const client=new Fake();let reads=0;const reset=Math.floor(Date.now()/1000)+15000;
  client.readLimits=async()=>({rateLimits:{primary:{usedPercent:++reads*10,windowDurationMins:300,resetsAt:reset}}});
  const {app,api}=await setup(t,{autoConnect:true,clientFactory:()=>client,connectionRefreshMs:30});
  const created=(await api('/api/tasks','POST',{title:'committed',prompt:'test',cwd:process.cwd(),schedule:{mode:'auto'}})).data;
  const committed=created.scheduledAt;
  await waitFor(()=>reads>=2);
  assert.equal(app.store.get(created.id).scheduledAt,committed);assert.ok(app.snapshot().limits.rateLimits.primary.usedPercent>=20);
});

test('an unconfirmed window polls every two seconds and confirms fresh usage without reloading metadata',async t=>{
  const now=Date.now();t.mock.timers.enable({apis:['Date','setInterval'],now});
  const client=new Fake();let reads=0,models=0,accounts=0,used=0;
  client.listModels=async()=>{models++;return [{model:'test',isDefault:true}];};
  client.readAccount=async()=>{accounts++;return {account:{type:'chatgpt'}};};
  client.readLimits=async()=>{reads++;return {rateLimits:{primary:{usedPercent:used,windowDurationMins:300,resetsAt:(now+18000_000)/1000}}};};
  const {app}=await setup(t,{autoConnect:true,clientFactory:()=>client});await app.refreshConnection();
  const baseline={reads,models,accounts,connects:client.connectCount};
  t.mock.timers.tick(1999);await new Promise(resolve=>setImmediate(resolve));assert.equal(reads,baseline.reads);
  used=1;t.mock.timers.tick(1);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(reads,baseline.reads+1);assert.equal(app.snapshot().quota.periods.fiveHour.state,'anchored');
  assert.equal(app.snapshot().quota.nodes[0].lock,'confirmed');
  t.mock.timers.tick(30000);await new Promise(resolve=>setImmediate(resolve));assert.equal(reads,baseline.reads+1);
  assert.deepEqual({models,accounts,connects:client.connectCount},{models:baseline.models,accounts:baseline.accounts,connects:baseline.connects});
});

test('ambiguous zero-use readings stop the initial fast-check burst without disabling window activation',async t=>{
  const now=Date.now();t.mock.timers.enable({apis:['Date','setInterval'],now});
  const client=new Fake();let reads=0;
  client.readLimits=async()=>{reads++;return {rateLimits:{primary:{usedPercent:0,windowDurationMins:300,resetsAt:(now+18000_000)/1000}}};};
  const {app}=await setup(t,{autoConnect:true,clientFactory:()=>client});await app.refreshConnection();
  const initial=reads;
  for(let elapsed=2000;elapsed<=20000;elapsed+=2000){t.mock.timers.tick(2000);await new Promise(resolve=>setImmediate(resolve));}
  const baseline=reads;
  assert.ok(baseline>initial&&baseline<=initial+10);
  t.mock.timers.tick(30000);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(reads,baseline);assert.equal(app.snapshot().quota.periods.fiveHour.state,'unknown');
  assert.equal(app.snapshot().quota.nodes.find(node=>node.kind==='fiveHour').canPlan,true);
});

test('confirmation timeout still clears a provisional lock when the account stops returning periods',async t=>{
  const now=Date.now();t.mock.timers.enable({apis:['Date','setInterval'],now});
  const client=new Fake();client.readLimits=async()=>({});
  const {app}=await setup(t,{autoConnect:true,clientFactory:()=>client});await app.refreshConnection();
  app.store.data.quota.plans.push({id:'confirmation-fixture',kind:'fiveHour',status:'succeeded',finishedAt:new Date(now).toISOString()});
  t.mock.timers.tick(120001);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(app.store.data.quota.plans[0].confirmed,false);
  assert.match(app.store.data.quota.plans[0].error,/could not be confirmed/);
});

test('a fresh read repairs the persisted rounded-zero greeting timeout and confirms the real API node without dispatch',async t=>{
  const now=Date.now(),started=now-51*60000,finished=started+6218,reset=started-8940+18000_000;
  const data={accountId:'recovery-account',rateLimitsByLimitId:{codex:{primary:{usedPercent:0,windowDurationMins:300,resetsAt:reset/1000}}}};
  const client=new Fake();let requests=0;client.readLimits=async()=>data;
  client.request=async()=>{requests++;throw new Error('Recovery must not send a greeting');};
  const {app,api}=await setup(t,{autoConnect:true,clientFactory:()=>client});
  const created=(await api('/api/tasks','POST',{title:'Unchanged task',prompt:'Keep this prompt',cwd:process.cwd()})).data;
  const baselineTasks=JSON.stringify(app.store.data.tasks),baselineSettings=JSON.stringify(app.store.data.settings);
  app.store.data.quota={accountId:'recovery-account',observations:{fiveHour:{state:'unknown',reason:'zero_usage',usedPercent:0,
    sampledAt:now-1000,stableSince:finished+1000,resetsAt:reset,bucketId:'codex',comparison:{sampledAt:now-1000,resetsAt:reset,bucketId:'codex'}}},
    plans:[{id:'real-shape-timeout',kind:'fiveHour',status:'succeeded',accountId:'recovery-account',confirmed:false,
      error:'The greeting completed, but this quota window could not be confirmed. It will not be repeated automatically.',finishedAt:new Date(finished).toISOString(),
      lastQuotaCheck:{meteredResetAt:new Date(started-15940+18000_000).toISOString()},
      task:{runs:[{status:'succeeded',startedAt:new Date(started).toISOString(),finishedAt:new Date(finished).toISOString(),
        modelProvider:'openai',meteredBucketId:'codex',tokenUsage:{total:{totalTokens:9123,outputTokens:8}}}]}}]};
  app.runner.limits=data;app.store.save();assert.equal((await api('/api/state')).data.quota.periods.fiveHour.state,'unknown');
  await app.refreshConnection();await app.runner.tick();
  const state=(await api('/api/state')).data,history=(await api('/api/window-plans')).data;
  assert.equal(state.quota.periods.fiveHour.state,'anchored');assert.equal(state.quota.periods.fiveHour.resetAt,new Date(reset).toISOString());
  assert.equal(state.quota.nodes.find(node=>node.kind==='fiveHour').certainty,'confirmed');
  assert.equal(history.plans[0].confirmed,true);assert.equal(history.plans[0].error,null);assert.equal(requests,0);
  assert.equal(JSON.stringify(app.store.data.tasks),baselineTasks);assert.equal(JSON.stringify(app.store.data.settings),baselineSettings);
  assert.equal(app.store.get(created.id).title,'Unchanged task');
  const persisted=JSON.parse(fs.readFileSync(app.store.file,'utf8'));
  assert.equal(persisted.quota.plans[0].confirmed,true);assert.equal(persisted.quota.observations.fiveHour.reason,'metered_activation');
});

test('entering the reset boundary starts fast reads before the normal minute refresh is due',async t=>{
  const now=Date.now();t.mock.timers.enable({apis:['Date','setInterval'],now});
  const client=new Fake();let reads=0;
  client.readLimits=async()=>{reads++;return {rateLimits:{primary:{usedPercent:Date.now()<now+20000?10:0,windowDurationMins:300,resetsAt:(now+20000)/1000}}};};
  const {app}=await setup(t,{autoConnect:true,clientFactory:()=>client});await app.refreshConnection();const initial=reads;
  t.mock.timers.tick(4000);await new Promise(resolve=>setImmediate(resolve));assert.equal(reads,initial);
  t.mock.timers.tick(2000);await new Promise(resolve=>setImmediate(resolve));assert.equal(reads,initial+1);
  t.mock.timers.tick(14000);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(reads,initial+2);assert.equal(app.snapshot().quota.periods.fiveHour.state,'floating');
  assert.equal(app.snapshot().quota.periods.fiveHour.projectedReset,true);
});

for(const signal of ['turnFinished','quotaUpdated'])test(`${signal} requests a fresh read immediately even while an ordinary task is active`,async t=>{
  const now=Date.now();t.mock.timers.enable({apis:['Date','setInterval'],now});
  const client=new Fake();let reads=0,models=0,used=0;
  client.listModels=async()=>{models++;return [{model:'test',isDefault:true}];};
  client.readLimits=async()=>{reads++;return {rateLimits:{primary:{usedPercent:used,windowDurationMins:300,resetsAt:(now+18000_000)/1000}}};};
  const {app}=await setup(t,{autoConnect:true,clientFactory:()=>client});await app.refreshConnection();
  const initialReads=reads,initialModels=models;
  app.runner.active={task:{id:'isolated-active-fixture',status:'running'},run:null,threadId:null};
  try {
    used=1;
    if(signal==='quotaUpdated')client.emit('notification',{method:'account/rateLimits/updated',params:{rateLimits:{primary:{usedPercent:1}}}});
    else app.runner.emit(signal);
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(reads,initialReads+1);assert.equal(models,initialModels);
    assert.equal(app.snapshot().quota.periods.fiveHour.state,'anchored');
  }finally{app.runner.active=null;}
});

test('quota read failures honor retry backoff instead of looping at the fast confirmation interval',async t=>{
  const now=Date.now();t.mock.timers.enable({apis:['Date','setInterval'],now});
  const client=new Fake();let reads=0,fail=false;
  client.readLimits=async()=>{reads++;if(fail)throw new Error('Quota temporarily unavailable');return {rateLimits:{primary:{usedPercent:0,windowDurationMins:300,resetsAt:(now+18000_000)/1000}}};};
  const {app}=await setup(t,{autoConnect:true,clientFactory:()=>client});await app.refreshConnection();const initial=reads;
  fail=true;t.mock.timers.tick(2000);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(reads,initial+1);assert.match(app.snapshot().connection.lastError,/Quota temporarily unavailable/);
  t.mock.timers.tick(14000);await new Promise(resolve=>setImmediate(resolve));assert.equal(reads,initial+1);
  fail=false;t.mock.timers.tick(1000);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(reads,initial+2);assert.equal(app.snapshot().connection.lastError,null);
});

test('close ignores an outstanding lightweight quota response without writing after the store closes',async t=>{
  const client=new Fake();const {app}=await setup(t,{autoConnect:true,clientFactory:()=>client});await app.refreshConnection();
  let release,writes=0;client.readLimits=()=>new Promise(resolve=>{release=resolve;});
  const pending=app.refreshQuota(),closing=app.close();await closing;
  app.store.save=()=>{writes++;throw new Error('Store already closed');};
  release({rateLimits:{primary:{usedPercent:1,windowDurationMins:300,resetsAt:Math.floor(Date.now()/1000)+18000}}});
  assert.equal(await pending,false);assert.equal(writes,0);assert.equal(await app.refreshQuota(),false);
});

test('close cancels timers and ignores an outstanding refresh completion',async t=>{
  const client=new Fake();let release;
  client.listModels=()=>new Promise(resolve=>{release=resolve;});
  const {app}=await setup(t,{autoConnect:true,clientFactory:()=>client});
  const refreshing=app.refreshConnection();
  const save=app.store.save.bind(app.store);let writes=0;app.store.save=()=>{writes++;save();};
  const closing=app.close();assert.equal(app.close(),closing);await closing;
  release([{model:'test'}]);assert.equal(await refreshing,false);
  assert.equal(writes,0);assert.ok(!fs.existsSync(app.store.lock));
  assert.equal(await app.refreshConnection(),false);
});

test('completed edits cannot dispatch again and explicit rescheduling preserves the actual capacity already used',async t=>{
  const {app,api,dir}=await setup(t);const file=path.join(dir,'reschedule.md');fs.writeFileSync(file,'original prompt');
  const created=(await api('/api/tasks','POST',{title:'completed linked task',promptFile:file,target:'existing',threadId:'saved-thread',modelMode:'inherit',schedule:{mode:'auto'}})).data;
  const task=app.store.get(created.id),run={id:'saved-run',status:'succeeded',startedAt:new Date().toISOString(),finishedAt:new Date().toISOString(),prompt:'original prompt',output:'saved output'};
  Object.assign(task,{status:'succeeded',runs:[run]});app.store.save();
  const before=structuredClone(task),route=`/api/tasks/${task.id}`;fs.writeFileSync(file,'latest prompt');
  const edited=await api(route,'PUT',{title:'completed edited'});
  assert.equal(edited.status,200);assert.equal(task.status,'succeeded');assert.equal(task.scheduledAt,before.scheduledAt);
  assert.equal(task.prompt,'latest prompt');assert.deepEqual(task.runs,before.runs);await app.runner.tick();assert.equal(app.runner.client.connectCount,0);
  const unchanged=JSON.stringify(app.store.data);
  for(const input of [{reschedule:true},{reschedule:'yes',schedule:{mode:'auto'}}]) {
    assert.equal((await api(route,'PUT',input)).status,400);assert.equal(JSON.stringify(app.store.data),unchanged);
  }
  const manual=await api(route,'PUT',{reschedule:true,schedule:{mode:'manual'}});
  assert.equal(manual.status,200);assert.equal(task.status,'queued');assert.equal(task.scheduledAt,null);
  await app.runner.tick();assert.equal(app.runner.client.connectCount,0);assert.deepEqual(task.runs,before.runs);
  const originalWindowEnd=(await api('/api/state')).data.windows[0].end;
  task.status='succeeded';app.store.save();const automatic=await api(route,'PUT',{reschedule:true,schedule:{mode:'auto'}});
  assert.equal(automatic.status,200);assert.equal(task.status,'scheduled');assert.ok(Date.parse(task.scheduledAt)>=Date.parse(originalWindowEnd));
  assert.equal(app.store.data.settings.tasksPerWindow,1);assert.equal(task.id,created.id);assert.equal(task.promptFile,file);assert.equal(task.threadId,'saved-thread');
  assert.equal(task.modelMode,'inherit');assert.deepEqual(task.runs,before.runs);
  const futureWindow=(await api('/api/state')).data.windows[2];task.status='succeeded';app.store.save();
  const fixed=await api(route,'PUT',{reschedule:true,schedule:{mode:'window',windowStart:futureWindow.start}});
  assert.equal(fixed.status,200);assert.equal(task.status,'scheduled');assert.equal(task.windowStart,futureWindow.start);
  assert.ok(Date.parse(task.scheduledAt)>=Date.parse(futureWindow.start));assert.ok(Date.parse(task.scheduledAt)<Date.parse(futureWindow.end));
  const exactAt=new Date(Date.now()+20*3600000).toISOString();task.status='succeeded';app.store.save();
  const exact=await api(route,'PUT',{reschedule:true,schedule:{mode:'exact',at:exactAt}});
  assert.equal(exact.status,200);assert.equal(task.status,'scheduled');assert.equal(task.scheduledAt,exactAt);
  assert.deepEqual(task.runs,before.runs);assert.equal(task.promptFile,file);assert.equal(app.runner.client.connectCount,0);assert.equal(app.runner.active,null);
});

test('ordinary API edits keep automatic deadlines and exact or pinned-window ISO commitments',async t=>{
  const {app,api}=await setup(t),minute=Math.floor(Date.now()/60000)*60000;
  const schedules=[{mode:'auto'},{mode:'exact',at:new Date(minute+10*3600000+23456).toISOString()},{mode:'window',windowStart:new Date(minute+15*3600000+37789).toISOString()}];
  const commitments=task=>({status:task.status,schedule:task.schedule,scheduledAt:task.scheduledAt,windowStart:task.windowStart,windowEnd:task.windowEnd,notBefore:task.notBefore,lastError:task.lastError,autoOrder:task.autoOrder,runs:task.runs});
  for (const schedule of schedules) {
    const created=(await api('/api/tasks','POST',{title:`committed ${schedule.mode}`,prompt:'original',cwd:process.cwd(),schedule})).data;
    const task=app.store.get(created.id);
    if (schedule.mode==='auto') {task.scheduledAt=new Date(minute+7*3600000+12345).toISOString();task.autoOrder=4;app.store.save();}
    const before=structuredClone(commitments(task));
    const edited=await api(`/api/tasks/${task.id}`,'PUT',{prompt:'edited',modelMode:'inherit'});
    assert.equal(edited.status,200);assert.equal(task.prompt,'edited');assert.equal(task.modelMode,'inherit');
    assert.deepEqual(commitments(task),before,schedule.mode);
    assert.equal((await api('/api/state')).data.tasks.find(item=>item.id===task.id).scheduledAt,before.scheduledAt);
  }
  await app.runner.tick();assert.equal(app.runner.client.connectCount,0);assert.equal(app.runner.active,null);
});

test('ordinary API edits keep quota and conversation deferrals effective before retry',async t=>{
  const {app,api}=await setup(t),windows=(await api('/api/state')).data.windows;
  const tasks=[];
  for (const [index,status] of ['waiting_quota','waiting_session'].entries()) {
    const created=(await api('/api/tasks','POST',{title:status,prompt:'original',cwd:process.cwd(),schedule:{mode:'auto'}})).data;
    const task=app.store.get(created.id),window=windows[index+1],until=new Date(Date.parse(window.start)+3600000+123).toISOString();
    Object.assign(task,{status,scheduledAt:until,windowStart:window.start,windowEnd:window.end,notBefore:until,lastError:`retained ${status}`,autoOrder:index});app.store.save();
    const before=structuredClone(task);
    const edited=await api(`/api/tasks/${task.id}`,'PUT',{prompt:'edited'});
    assert.equal(edited.status,200);assert.equal(task.prompt,'edited');
    for (const key of ['status','schedule','scheduledAt','windowStart','windowEnd','notBefore','lastError','autoOrder','runs']) assert.deepEqual(task[key],before[key],`${status}: ${key}`);
    tasks.push(task);
  }
  await app.runner.tick(Math.min(...tasks.map(task=>Date.parse(task.notBefore)))-1);
  assert.equal(app.runner.client.connectCount,0);assert.equal(app.runner.active,null);
  assert.deepEqual(tasks.map(task=>task.status),['waiting_quota','waiting_session']);
});

function quotaFixture(app) {
  const now=Date.now(),period=(minutes,used,reset)=>({usedPercent:used,windowDurationMins:minutes,resetsAt:reset/1000});
  app.runner.models=[{model:'gpt-6-luna',supportedReasoningEfforts:['low']}];
  app.runner.client.status.connected=true;
  app.runner.limits={accountId:'server-fixture',rateLimitsByLimitId:{codex:{primary:period(300,10,now+3600_000),secondary:period(10080,10,now+2*3600_000)}}};
  observeQuota(app.store.data.quota,app.runner.limits,now);app.store.save();
}
test('activation API validates dependencies, duplicates and delay bounds without creating user tasks',async t=>{
  const {app,api}=await setup(t);quotaFixture(app);
  let state=(await api('/api/state')).data;
  const weekly=state.quota.nodes.find(node=>node.kind==='week').time;
  const nodes=state.quota.nodes.filter(node=>node.kind==='fiveHour');
  assert.equal(state.quota.periods.fiveHour.state,'anchored');assert.equal(nodes[0].certainty,'confirmed');
  assert.equal((await api('/api/window-plans','POST',{nodeId:nodes[2].id})).status,400);
  assert.equal((await api('/api/window-plans','POST',{nodeId:nodes[1].id,at:new Date(Date.parse(nodes[1].time)-1).toISOString()})).status,400);
  const created=await api('/api/window-plans','POST',{nodeId:nodes[1].id,at:new Date(Date.parse(nodes[1].time)+3600_000).toISOString()});
  assert.equal(created.status,201);assert.equal(app.store.data.tasks.length,0);assert.equal(app.runner.client.connectCount,0);
  assert.equal((await api('/api/window-plans','POST',{nodeId:nodes[1].id})).status,400);
  state=(await api('/api/state')).data;
  assert.equal(state.quota.nodes.find(node=>node.id===nodes[1].id).lock,'planned');
  assert.equal(state.quota.nodes.find(node=>node.id===nodes[2].id).time,new Date(Date.parse(nodes[2].time)+3600_000).toISOString());
  assert.equal(state.quota.nodes.find(node=>node.kind==='week').time,weekly);
  assert.equal((await api(`/api/window-plans/${created.data.plan.id}`,'DELETE',{})).status,200);
  assert.equal((await api('/api/state')).data.quota.nodes.find(node=>node.id===nodes[1].id).time,nodes[1].time);
  assert.equal((await api(`/api/window-plans/${created.data.plan.id}`,'DELETE',{})).status,400);
  const persisted=JSON.parse(fs.readFileSync(app.store.file));assert.equal(persisted.quota.plans[0].status,'cancelled');
});

test('locking the nearest floating node kicks the real runner immediately and dispatches exactly one greeting',async t=>{
  t.mock.timers.enable({apis:['setInterval']});
  const client=new Fake(),now=Date.now(),duration=300*60_000,calls=[];
  const limits=at=>({accountId:'immediate-fixture',rateLimitsByLimitId:{codex:{
    primary:{usedPercent:0,windowDurationMins:300,resetsAt:(at+duration)/1000},
    secondary:{usedPercent:10,windowDurationMins:10080,resetsAt:(now+86400_000)/1000}}}});
  const snapshot=limits(now);
  client.listModels=async()=>[{model:'gpt-6-luna',supportedReasoningEfforts:['low']}];
  client.readLimits=async()=>snapshot;
  client.request=async(method,params)=>{
    calls.push({method,params});
    if(method==='thread/start')return {thread:{id:'activation-thread'},model:params.model,modelProvider:'openai'};
    if(method==='turn/start')return {turn:{id:'greeting-turn',status:'completed'}};
    return {};
  };
  const {app,api}=await setup(t,{autoConnect:true,clientFactory:()=>client});await app.refreshConnection();
  observeQuota(app.store.data.quota,limits(now-60_000),now-60_000);
  observeQuota(app.store.data.quota,snapshot,now);
  const node=app.snapshot().quota.nodes.find(node=>node.kind==='fiveHour');
  assert.equal(app.snapshot().quota.periods.fiveHour.state,'floating');
  let ticks=0;const tick=app.runner.tick.bind(app.runner);app.runner.tick=(...args)=>{ticks++;return tick(...args);};
  const response=await api('/api/window-plans','POST',{nodeId:node.id});
  assert.equal(response.status,201);assert.ok(ticks>=1,'POST must kick the runner without waiting for the periodic ticker');
  await waitFor(()=>app.store.data.quota.plans[0]?.status==='succeeded');
  const plan=app.store.data.quota.plans[0];
  assert.ok(Date.parse(plan.activationAt)<=Date.now());assert.equal(app.store.data.tasks.length,0);
  assert.deepEqual(calls.find(call=>call.method==='turn/start').params.input,[{type:'text',text:'你好'}]);
  await app.runner.tick();assert.equal(calls.filter(call=>call.method==='turn/start').length,1);
});

for(const kind of ['fiveHour','week'])test(`${kind} lock from the first zero-use snapshot dispatches without a sampling wait`,async t=>{
  t.mock.timers.enable({apis:['setInterval']});
  const client=new Fake(),now=Date.now(),calls=[];
  client.listModels=async()=>[{model:'gpt-6-luna',supportedReasoningEfforts:['low']}];
  client.readLimits=async()=>({accountId:'first-reading',rateLimitsByLimitId:{codex:{
    primary:{usedPercent:0,windowDurationMins:300,resetsAt:(now-14000+300*60000)/1000},
    secondary:{usedPercent:0,windowDurationMins:10080,resetsAt:(now-14000+10080*60000)/1000}}}});
  client.request=async(method,params)=>{
    calls.push({method,params});
    if(method==='thread/start')return {thread:{id:'first-reading-thread'},model:params.model,modelProvider:'openai'};
    if(method==='turn/start')return {turn:{id:'first-reading-turn',status:'completed'}};
    return {};
  };
  const {app,api}=await setup(t,{autoConnect:true,clientFactory:()=>client});await app.refreshConnection();
  const node=app.snapshot().quota.nodes.find(node=>node.kind===kind);
  assert.equal(app.snapshot().quota.periods[kind].state,'unknown');assert.equal(node.canPlan,true);
  const response=await api('/api/window-plans','POST',{nodeId:node.id});assert.equal(response.status,201);
  await waitFor(()=>app.store.data.quota.plans[0]?.status==='succeeded');
  assert.equal(app.store.data.quota.plans[0].lastQuotaCheck.state,'unknown');
  assert.equal(calls.filter(call=>call.method==='turn/start').length,1);
  assert.deepEqual(calls.find(call=>call.method==='turn/start').params.input,[{type:'text',text:'你好'}]);
});

for(const mode of ['scheduled','immediate'])test(`${mode} lock survives the real expired-reset response shape and confirms only after a metered update`,async t=>{
  const now=Date.now(),reset=now+20000,duration=300*60_000;
  t.mock.timers.enable({apis:['Date','setInterval'],now});
  const client=new Fake(),calls=[];let dispatchedAt=null,acknowledged=false;
  const limits=()=>({accountId:'expired-reset-fixture',ordinaryUsageAllowed:true,rateLimitsByLimitId:{codex:{
    primary:{usedPercent:acknowledged?1:Date.now()<reset?5:0,windowDurationMins:300,
      resetsAt:(acknowledged?dispatchedAt+duration:reset)/1000},
    secondary:{usedPercent:10,windowDurationMins:10080,resetsAt:(now+86400_000)/1000}}}});
  client.listModels=async()=>[{model:'gpt-6-luna',supportedReasoningEfforts:['low']}];
  client.readLimits=async()=>limits();
  client.request=async(method,params)=>{
    calls.push({method,params});
    if(method==='thread/start')return {thread:{id:'expiry-greeting'},model:params.model,modelProvider:'openai'};
    if(method==='turn/start'){dispatchedAt=Date.now();return {turn:{id:'expiry-turn',status:'completed'}};}
    return {};
  };
  const {app,api,base}=await setup(t,{autoConnect:true,clientFactory:()=>client});await app.refreshConnection();
  if(mode==='immediate'){t.mock.timers.tick(21000);await app.refreshConnection();}
  const state=(await api('/api/state')).data,nodes=state.quota.nodes.filter(node=>node.kind==='fiveHour');
  const node=nodes[mode==='scheduled'?1:0];
  const response=await api('/api/window-plans','POST',{nodeId:node.id});assert.equal(response.status,201);
  if(mode==='scheduled'){
    assert.equal(calls.length,0);assert.equal(response.data.plan.activationAt,new Date(reset).toISOString());
    t.mock.timers.tick(21000);await app.runner.tick();
  }
  await waitFor(()=>app.store.data.quota.plans[0]?.status==='succeeded');
  const plan=app.store.data.quota.plans[0];assert.equal(plan.confirmed,undefined);
  assert.equal(plan.lastQuotaCheck.projectedReset,true);
  assert.deepEqual(calls.find(call=>call.method==='turn/start').params.input,[{type:'text',text:'你好'}]);
  const pending=(await api('/api/state')).data;
  assert.equal(pending.quota.periods.fiveHour.state,'floating');
  const locked=pending.quota.nodes.find(node=>node.planId===plan.id);
  assert.equal(locked.lock,'planned');assert.equal(locked.canPlan,false);assert.equal(locked.certainty,'projected');
  assert.equal((await fetch(base+'/api/window-plans')).status,401);
  const diagnostic=(await api('/api/window-plans')).data;
  assert.equal(diagnostic.dataDirectory,app.store.directory??app.store.file.slice(0,app.store.file.lastIndexOf(path.sep)));
  assert.equal(diagnostic.plans[0].task.runs.length,1);assert.equal('accountId' in diagnostic.plans[0],false);
  acknowledged=true;await app.refreshConnection();
  assert.equal(plan.confirmed,true);
  const confirmed=(await api('/api/state')).data;
  assert.equal(confirmed.quota.periods.fiveHour.projectedReset,false);
  assert.equal(confirmed.quota.nodes.find(node=>node.kind==='fiveHour').certainty,'confirmed');
  await app.runner.tick();assert.equal(calls.filter(call=>call.method==='turn/start').length,1);
});
test('moving and cancelling an activation reflows automatic tasks but keeps exact dates untouched',async t=>{
  const {app,api}=await setup(t);quotaFixture(app);
  const nodes=app.snapshot().quota.nodes.filter(node=>node.kind==='fiveHour'),at=new Date(Date.parse(nodes[1].time)+3600_000).toISOString();
  const plan=(await api('/api/window-plans','POST',{nodeId:nodes[1].id,at})).data.plan;
  const exact=(await api('/api/tasks','POST',{title:'Exact',prompt:'p',cwd:process.cwd(),schedule:{mode:'exact',at:new Date(Date.now()+1800_000).toISOString()}})).data;
  const a=(await api('/api/tasks','POST',{title:'A',prompt:'p',cwd:process.cwd(),schedule:{mode:'auto'}})).data;
  const b=(await api('/api/tasks','POST',{title:'B',prompt:'p',cwd:process.cwd(),schedule:{mode:'auto'}})).data;
  assert.equal(a.scheduledAt,nodes[0].time);assert.equal(b.scheduledAt,at);
  const locked=app.snapshot().quota.nodes.find(node=>node.id===nodes[0].id);assert.equal(locked.lock,'confirmed');assert.equal(locked.canPlan,false);
  assert.equal((await api('/api/window-plans','POST',{nodeId:locked.id})).status,400);
  await api(`/api/window-plans/${plan.id}`,'DELETE',{});
  assert.equal(app.store.get(b.id).scheduledAt,nodes[1].time);assert.equal(app.store.get(exact.id).scheduledAt,exact.scheduledAt);
  assert.equal(app.snapshot().quota.nodes.find(node=>node.id===nodes[1].id).lock,'task');
});
test('activation planning rejects an unavailable cheap model and cannot be forged across origins',async t=>{
  const {app,api,base,cookie}=await setup(t);quotaFixture(app);const node=app.snapshot().quota.nodes.find(node=>node.kind==='fiveHour');
  app.runner.models=[{model:'gpt-6-astra',supportedReasoningEfforts:['low']}];
  const rejected=await api('/api/window-plans','POST',{nodeId:node.id});assert.equal(rejected.status,400);assert.match(rejected.data.error,/low-cost/);
  const remote=await fetch(base+'/api/window-plans',{method:'POST',headers:{cookie,origin:'https://example.test','Content-Type':'application/json'},body:JSON.stringify({nodeId:node.id})});
  assert.equal(remote.status,403);assert.equal(app.store.data.quota.plans.length,0);
});
test('a newly confirmed reset reflows future automatic dates to its exact seconds while retaining manual dates',async t=>{
  const client=new Fake();let reset=Math.floor(Date.now()/1000)+3600;
  client.readLimits=async()=>({rateLimits:{primary:{usedPercent:10,windowDurationMins:300,resetsAt:reset}}});
  const {app,api}=await setup(t,{autoConnect:true,clientFactory:()=>client});await app.refreshConnection();
  const auto=(await api('/api/tasks','POST',{title:'Automatic',prompt:'p',cwd:process.cwd(),schedule:{mode:'auto'}})).data;
  const exact=(await api('/api/tasks','POST',{title:'Exact',prompt:'p',cwd:process.cwd(),schedule:{mode:'exact',at:new Date(Date.now()+1800_000).toISOString()}})).data;
  reset+=17;await app.refreshConnection();
  assert.equal(Date.parse(app.store.get(auto.id).scheduledAt),reset*1000);assert.equal(app.store.get(exact.id).scheduledAt,exact.scheduledAt);
});

for(const mode of ['window','exact'])test(`${mode} snapping rejects a stale quota coordinate atomically but Alt-style exact dates remain supported`,async t=>{
  const {app,api}=await setup(t);quotaFixture(app);
  const task=(await api('/api/tasks','POST',{title:'Drag',prompt:'p',cwd:process.cwd()})).data;
  const node=app.snapshot().quota.nodes.find(node=>node.kind==='fiveHour'),route=`/api/tasks/${task.id}`;
  const schedule=mode==='window'?{mode,windowStart:node.time}:{mode,at:node.time};
  assert.equal((await api(route,'PUT',{schedule,quotaNodeId:node.id})).status,200);
  app.runner.limits.rateLimitsByLimitId.codex.primary.resetsAt+=17;observeQuota(app.store.data.quota,app.runner.limits);app.store.save();
  const before=JSON.stringify(app.store.get(task.id));
  const rejected=await api(route,'PUT',{schedule,quotaNodeId:node.id});
  assert.equal(rejected.status,400);assert.match(rejected.data.error,/timeline changed/);assert.equal(JSON.stringify(app.store.get(task.id)),before);
  const freelyChosen=new Date(Date.parse(node.time)+123456).toISOString();
  assert.equal((await api(route,'PUT',{schedule:{mode:'exact',at:freelyChosen}})).status,200);
  assert.equal(app.store.get(task.id).scheduledAt,freelyChosen);
});

test('node drops create capacity-bound window tasks and a full selection stays visibly unscheduled',async t=>{
  const {app,api}=await setup(t);quotaFixture(app);
  const node=app.snapshot().quota.nodes.find(node=>node.kind==='fiveHour');
  const body={title:'Window drop',prompt:'Fixture',cwd:process.cwd(),schedule:{mode:'manual'}};
  const first=(await api('/api/tasks','POST',body)).data,second=(await api('/api/tasks','POST',body)).data;
  const drop=id=>api(`/api/tasks/${id}`,'PUT',{schedule:{mode:'window',windowStart:node.time},quotaNodeId:node.id});
  const assigned=await drop(first.id);assert.equal(assigned.status,200);assert.equal(assigned.data.scheduledAt,node.time);
  const full=await drop(second.id);assert.equal(full.status,200);assert.equal(full.data.scheduledAt,null);
  assert.equal(full.data.status,'queued');assert.equal(full.data.schedule.windowStart,node.time);assert.match(full.data.planningError,/full/);
  await api(`/api/tasks/${first.id}`,'DELETE');
  const recovered=app.store.get(second.id);assert.equal(recovered.scheduledAt,node.time);assert.equal(recovered.planningError,null);
  const future=app.snapshot().quota.nodes.find(item=>item.kind==='fiveHour'&&item.windowStart===node.time);
  assert.equal(future.lock,'task');
});

test('automatic retry replanning cannot replace the original preflight deadline',async t=>{
  const now=Date.now();t.mock.timers.enable({apis:['Date'],now});
  const {app,api}=await setup(t);
  const created=(await api('/api/tasks','POST',{title:'Recover',prompt:'Fixture',cwd:process.cwd(),schedule:{mode:'auto'}})).data;
  const task=app.store.get(created.id);task.scheduledAt=new Date(now).toISOString();task.status='scheduled';
  app.runner.client.readLimits=async()=>{throw Object.assign(new Error('temporary quota timeout'),{code:'CODEX_TIMEOUT'});};
  await app.runner.tick();assert.equal(task.status,'scheduled');
  assert.equal(task.preflightRetry.deadline,new Date(now+15*60000).toISOString());
  assert.ok(Date.parse(task.scheduledAt)>=Date.parse(task.notBefore));
  t.mock.timers.setTime(now+16*60000);await app.runner.tick();assert.equal(task.status,'missed');assert.equal(task.runs.length,0);
});
