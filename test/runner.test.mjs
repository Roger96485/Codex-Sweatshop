import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { Runner } from '../src/runner.mjs';
import { observeQuota,quotaTimeline,planWindowActivation,PERIODS } from '../src/quota-windows.mjs';

class FakeClient extends EventEmitter {
  status={connected:true};calls=[];mode='normal';
  async connect(){}
  async listModels(){return [{model:'test-model',isDefault:true,defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'medium'}],serviceTiers:[{id:'priority'}]}];}
  async readAccount(){return {account:{type:'chatgpt',planType:'plus'}};}
  async readLimits(){return {ordinaryUsageAllowed:true,rateLimits:{primary:{usedPercent:5,windowDurationMins:300,resetsAt:Math.floor(Date.now()/1000)+5000},secondary:{usedPercent:this.mode==='quota'?100:1,windowDurationMins:10080,resetsAt:Math.floor(Date.now()/1000)+86400}}};}
  async request(method,params){
    this.calls.push({method,params});
    if(method==='thread/read')return {thread:{cwd:process.cwd(),status:{type:this.mode==='busy'?'active':'idle'}}};
    if(method==='thread/resume'&&this.mode==='locked')throw new Error('already has an active writer');
    if(method==='thread/start'||method==='thread/resume')return {thread:{id:'thread-1'},model:params.model,modelProvider:params.modelProvider??'openai'};
    if(method==='turn/start'){
      if(this.mode==='timeout')throw Object.assign(new Error('timeout'),{sent:true,uncertain:true});
      if(this.mode==='rpc-error')throw Object.assign(new Error('invalid tier'),{sent:true,uncertain:false});
      this.emit('notification',{method:'turn/started',params:{threadId:'thread-1',turn:{id:'turn-1'}}});
      if(this.mode==='fast-complete')this.emit('notification',{method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-1',status:'completed'}}});
      return {turn:{id:'turn-1',status:'inProgress'}};
    }
    return {};
  }
  respond(id,result,error){this.calls.push({id,result,error});}
}
function setup(t,extra={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sweatshop-runner-'));
  const store=new Store(dir);const client=new FakeClient();const runner=new Runner(store,client);
  const task=store.create({title:'测试',prompt:'# 完整提示词\n请完成任务',cwd:process.cwd(),model:'test-model',effort:'medium',speed:'default',...extra});
  t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
  return {dir,store,client,runner,task};
}

test('lightweight quota confirmation reads no models or account metadata and starts no inference',async t=>{
  const {runner,client}=setup(t);await runner.refresh();
  let reads=0;const original=client.readLimits.bind(client);
  client.connect=client.listModels=client.readAccount=async()=>{throw new Error('Unexpected metadata refresh');};
  client.readLimits=async()=>{reads++;return original();};
  const models=runner.models,account=runner.account;
  await runner.refreshQuota();
  assert.equal(reads,1);assert.equal(runner.models,models);assert.equal(runner.account,account);
  assert.equal(runner.store.data.quota.observations.fiveHour.state,'anchored');assert.deepEqual(client.calls,[]);
});

test('lightweight reads coalesce and finish before a newer complete quota read',async t=>{
  const {runner,client}=setup(t);await runner.refresh();
  let release,reads=0,concurrent=0,maxConcurrent=0;
  const data=used=>({rateLimits:{primary:{usedPercent:used,windowDurationMins:300,resetsAt:Math.floor(Date.now()/1000)+5000}}});
  client.readLimits=async()=>{
    reads++;concurrent++;maxConcurrent=Math.max(maxConcurrent,concurrent);
    try{return reads===1?await new Promise(resolve=>{release=()=>resolve(data(10));}):data(20);}
    finally{concurrent--;}
  };
  const first=runner.refreshQuota(),joined=runner.refreshQuota(),complete=runner.refresh();
  await new Promise(resolve=>setImmediate(resolve));assert.equal(reads,1);
  release();await Promise.all([first,joined,complete]);
  assert.equal(reads,2);assert.equal(maxConcurrent,1);assert.equal(runner.limits.rateLimits.primary.usedPercent,20);
});
test('automatic dispatch checks reserved hours before connecting and again after resuming',async t=>{
  for(const delayed of [false,true]){
    const {store,client,runner,task}=setup(t,{schedule:{mode:'auto'}});
    const clock=new Intl.DateTimeFormat('en',{timeZone:store.data.settings.timezone,hourCycle:'h23',hour:'2-digit',minute:'2-digit'}).formatToParts(Date.now());
    const hour=clock.find(part=>part.type==='hour').value;
    const quiet={enabled:true,start:`${hour}:00`,end:`${String((Number(hour)+1)%24).padStart(2,'0')}:00`};
    if(delayed){
      const original=client.request.bind(client);
      client.request=async(method,params)=>{const result=await original(method,params);if(method==='thread/start')store.data.settings.quietHours=quiet;return result;};
    }else store.data.settings.quietHours=quiet;
    await runner.launch(task);
    assert.equal(task.status,'scheduled');assert.ok(task.notBefore);assert.equal(task.runs.length,0);assert.equal(runner.active,null);
    assert.equal(client.calls.some(call=>call.method==='turn/start'),false);
    if(delayed)assert.equal(client.calls.some(call=>call.method==='thread/unsubscribe'),true);
    else assert.equal(client.calls.length,0);
  }
});

test('explicit and window tasks remain user-timed during reserved hours',async t=>{
  for(const mode of ['exact','window']) {
    const at=new Date().toISOString();
    const {store,runner,client,task}=setup(t,{schedule:{mode,at,windowStart:at}});
    store.data.settings.quietHours={enabled:true,start:'00:00',end:'23:59'};
    client.mode='fast-complete';await runner.launch(task);
    assert.equal(task.status,'succeeded');assert.equal(client.calls.filter(call=>call.method==='turn/start').length,1);
  }
});

test('a specified window expiring during preflight cannot dispatch outside its window',async t=>{
  const now=Date.now();t.mock.timers.enable({apis:['Date'],now});
  const {runner,client,task}=setup(t,{schedule:{mode:'window',windowStart:new Date(now-4*3600000).toISOString()}});
  task.windowEnd=new Date(now+1000).toISOString();
  const request=client.request.bind(client);
  client.request=async(method,params)=>{const result=await request(method,params);if(method==='thread/start')t.mock.timers.setTime(now+2000);return result;};
  await runner.launch(task);assert.equal(task.status,'missed');assert.equal(task.runs.length,0);
  assert.equal(client.calls.some(call=>call.method==='turn/start'),false);
});

test('a specified window expiring while dispatch intent is saved is still never sent',async t=>{
  const now=Date.now();t.mock.timers.enable({apis:['Date'],now});
  const {runner,store,client,task}=setup(t,{schedule:{mode:'window',windowStart:new Date(now-PERIODS.fiveHour+1000).toISOString()}});
  const save=store.save.bind(store);store.save=()=>{save();if(task.runs.length)t.mock.timers.setTime(now+1000);};
  await runner.launch(task);assert.equal(task.status,'missed');assert.equal(task.runs.length,0);
  assert.equal(client.calls.some(call=>call.method==='turn/start'),false);
});

test('a transient dispatch rejection explicitly marked unsent can retry without recording a run',async t=>{
  const {runner,client,task}=setup(t),request=client.request.bind(client);
  client.request=async(method,params)=>{
    if(method==='turn/start')throw Object.assign(new Error('connection closed before writing'),{code:'CODEX_DISCONNECTED',sent:false,uncertain:false});
    return request(method,params);
  };
  await runner.launch(task);assert.equal(task.status,'scheduled');assert.equal(task.runs.length,0);assert.equal(task.preflightRetry.attempts,1);
  client.request=request;client.mode='fast-complete';await runner.launch(task);
  assert.equal(task.status,'succeeded');assert.equal(task.runs.length,1);assert.equal(task.preflightRetry,undefined);
});

test('temporary preflight errors retry within the original deadline and survive restart',async t=>{
  const now=Date.now();t.mock.timers.enable({apis:['Date'],now});
  const {runner,client,store,task,dir}=setup(t,{schedule:{mode:'exact',at:new Date(now).toISOString()}});
  task.status='scheduled';task.scheduledAt=new Date(now).toISOString();
  client.readLimits=async()=>{throw Object.assign(new Error('temporary timeout'),{code:'CODEX_TIMEOUT',sent:true,uncertain:true});};
  await runner.tick();assert.equal(task.status,'scheduled');assert.equal(task.runs.length,0);
  assert.equal(task.preflightRetry.deadline,new Date(now+15*60000).toISOString());assert.equal(task.preflightRetry.attempts,1);
  store.close();const restored=new Store(dir);t.after(()=>restored.close());
  const freshClient=new FakeClient();freshClient.mode='fast-complete';const freshRunner=new Runner(restored,freshClient);
  t.mock.timers.setTime(now+5000);await freshRunner.tick();
  const saved=restored.get(task.id);assert.equal(saved.status,'succeeded');assert.equal(saved.preflightRetry,undefined);
  await freshRunner.tick();assert.equal(freshClient.calls.filter(call=>call.method==='turn/start').length,1);
});

test('preflight retries expire instead of sliding their grace period on every replan',async t=>{
  const now=Date.now();t.mock.timers.enable({apis:['Date'],now});
  const {runner,client,task}=setup(t,{schedule:{mode:'auto'}});
  task.status='scheduled';task.scheduledAt=new Date(now).toISOString();
  client.readLimits=async()=>{throw Object.assign(new Error('timeout'),{code:'CODEX_TIMEOUT'});};
  await runner.tick();const deadline=task.preflightRetry.deadline;
  task.scheduledAt=task.notBefore;t.mock.timers.setTime(now+5000);await runner.tick();
  assert.equal(task.preflightRetry.deadline,deadline);assert.equal(task.preflightRetry.attempts,2);
  task.scheduledAt=new Date(now+3600000).toISOString();t.mock.timers.setTime(now+16*60000);await runner.tick();
  assert.equal(task.status,'missed');assert.equal(task.runs.length,0);
});

test('a disconnect before dispatch can retry while an uncertain dispatch remains terminal',async t=>{
  const {runner,client,task}=setup(t);const read=client.readLimits.bind(client);
  client.readLimits=async()=>{client.emit('disconnect',new Error('connection reset'));return read();};
  await runner.launch(task);assert.equal(task.status,'scheduled');assert.equal(task.runs.length,0);
  assert.equal(client.calls.some(call=>call.method==='turn/start'),false);
  client.readLimits=read;client.mode='timeout';await runner.launch(task);
  assert.equal(task.status,'uncertain');const calls=client.calls.length;await runner.tick();assert.equal(client.calls.length,calls);
});

test('task lock identities resolve inherited config and conversations without starting inference',async t=>{
  const {runner,client,store,task}=setup(t,{modelMode:'inherit',model:'',schedule:{mode:'auto'}});
  await runner.refresh();
  client.request=async(method,params)=>{
    client.calls.push({method,params});
    if(method==='config/read')return {config:{model:'test-model',model_provider:'openai'}};
    if(method==='thread/read')return {thread:{model:'separate-model',modelProvider:'separate-provider',cwd:process.cwd()}};
    throw new Error('No inference allowed');
  };
  await runner.inspectTaskModels();assert.deepEqual(runner.quotaTaskModels().get(task.id),{model:'test-model',modelProvider:'openai'});
  task.target='existing';task.threadId='other';assert.equal(runner.quotaTaskModels().has(task.id),false);
  await runner.inspectTaskModels();assert.deepEqual(runner.quotaTaskModels().get(task.id),{model:'separate-model',modelProvider:'separate-provider'});
  client.request=async method=>method==='thread/read'?{thread:{model:null,modelProvider:'openai',cwd:process.cwd()}}:{config:{model:'test-model'}};
  await runner.inspectTaskModels({force:true});assert.equal(runner.quotaTaskModels().get(task.id).model,null);
  client.request=async()=>{throw new Error('cannot inspect');};await runner.inspectTaskModels({force:true});
  assert.equal(runner.quotaTaskModels().has(task.id),false);
  assert.equal(client.calls.some(call=>['thread/start','thread/resume','turn/start'].includes(call.method)),false);
});

test('MCP elicitation waits for validated consent and resolved requests restore running status',async t=>{
  const {runner,client,task}=setup(t);await runner.launch(task);
  const params={threadId:'thread-1',serverName:'fixture',mode:'form',message:'Choose a count',requestedSchema:{type:'object',required:['count'],properties:{count:{type:'integer',minimum:1,maximum:3}}}};
  client.emit('serverRequest',{id:81,method:'mcpServer/elicitation/request',params});
  assert.equal(task.status,'awaiting_approval');assert.equal(client.calls.some(call=>call.id===81),false);
  const approval=runner.approvals[0];assert.throws(()=>runner.approve(approval.id,{action:'accept',content:{count:9}}),/Check/);
  assert.equal(runner.approvals.length,1);runner.approve(approval.id,{action:'accept',content:{count:2}});
  assert.deepEqual(client.calls.at(-1).result,{action:'accept',content:{count:2}});assert.equal(task.status,'running');
  client.emit('serverRequest',{id:82,method:'mcpServer/elicitation/request',params});
  client.emit('notification',{method:'serverRequest/resolved',params:{threadId:'thread-1',requestId:82}});
  assert.equal(runner.approvals.length,0);assert.equal(task.status,'running');
});

test('unavailable Desktop dynamic tools return typed failure and prevent false success',async t=>{
  const {runner,client,task}=setup(t);await runner.launch(task);
  client.emit('serverRequest',{id:91,method:'item/tool/call',params:{threadId:'thread-1',turnId:'turn-1',tool:'desktop_only',arguments:{}}});
  const reply=client.calls.find(call=>call.id===91);assert.equal(reply.error,undefined);assert.equal(reply.result.success,false);
  assert.equal(reply.result.contentItems[0].type,'inputText');
  client.emit('notification',{method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-1',status:'completed'}}});
  assert.equal(task.status,'uncertain');assert.match(task.lastError,/requires Codex Desktop/);assert.match(task.runs[0].desktopToolError,/not executed/);
});
test('saving dispatch intent across a reserved boundary leaves no unsent run or consumed slot',async t=>{
  const {store,client,runner,task}=setup(t,{schedule:{mode:'auto'}});
  const hour=new Intl.DateTimeFormat('en',{timeZone:store.data.settings.timezone,hourCycle:'h23',hour:'2-digit'}).format(new Date());
  const save=store.save.bind(store);
  store.save=()=>{save();if(task.runs.length)store.data.settings.quietHours={enabled:true,start:`${hour}:00`,end:`${String((Number(hour)+1)%24).padStart(2,'0')}:00`};};
  await runner.launch(task);
  assert.equal(client.calls.some(call=>call.method==='turn/start'),false);assert.equal(task.runs.length,0);
  assert.equal(task.status,'scheduled');assert.ok(task.notBefore);assert.equal(runner.active,null);
  assert.equal(client.calls.some(call=>call.method==='thread/unsubscribe'),true);
});
test('dispatch persists a single full prompt, model options, and completion',async t=>{
  const {store,client,runner,task}=setup(t);await runner.launch(task);
  const sent=client.calls.find(c=>c.method==='turn/start');
  assert.equal(sent.params.input[0].text,task.prompt);assert.equal(sent.params.serviceTier,'default');assert.equal(sent.params.approvalPolicy,'on-request');assert.equal(sent.params.sandboxPolicy.networkAccess,false);
  assert.equal(JSON.parse(fs.readFileSync(store.file)).tasks[0].runs[0].turnId,'turn-1');
  client.emit('notification',{method:'item/agentMessage/delta',params:{threadId:'thread-1',delta:'完成'}});
  client.emit('notification',{method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-1',status:'completed'}}});
  assert.equal(task.status,'succeeded');assert.equal(task.runs[0].output,'完成');assert.equal(runner.active,null);
  store.data.settings.schedulerEnabled=true;await runner.tick();assert.equal(client.calls.filter(c=>c.method==='turn/start').length,1);
});
test('completion arriving before RPC response is still recorded',async t=>{
  const {runner,client,task}=setup(t);client.mode='fast-complete';await runner.launch(task);assert.equal(task.status,'succeeded');assert.equal(task.runs.length,1);
});
test('weekly exhaustion defers without even creating a thread',async t=>{
  const {runner,client,task}=setup(t);client.mode='quota';await runner.launch(task);assert.equal(task.status,'waiting_quota');assert.ok(task.notBefore);assert.equal(client.calls.length,0);
});
test('busy and writer-locked existing threads wait without prompt injection',async t=>{
  for(const mode of ['busy','locked']){
    const {runner,client,task}=setup(t,{target:'existing',threadId:'existing'});client.mode=mode;await runner.launch(task);assert.equal(task.status,'waiting_session');assert.ok(!client.calls.some(c=>c.method==='turn/start'));
  }
});
test('unknown delivery never retries, definitive RPC rejection is failed',async t=>{
  for(const [mode,status]of [['timeout','uncertain'],['rpc-error','failed']]){
    const {runner,client,task,store}=setup(t);client.mode=mode;await runner.launch(task);assert.equal(task.status,status);store.data.settings.schedulerEnabled=true;await runner.tick();assert.equal(client.calls.filter(c=>c.method==='turn/start').length,1);
  }
});
test('approvals require explicit decision and apply only to the requested operation',async t=>{
  const {runner,client,task}=setup(t);await runner.launch(task);
  client.emit('serverRequest',{id:51,method:'item/commandExecution/requestApproval',params:{threadId:'thread-1',command:'test'}});
  assert.equal(task.status,'awaiting_approval');assert.equal(client.calls.filter(c=>c.id===51).length,0);
  runner.approve(runner.approvals[0].id,{decision:'decline'});assert.deepEqual(client.calls.at(-1),{id:51,result:{decision:'decline'},error:undefined});assert.equal(task.status,'running');
});
test('interrupt RPC success waits for terminal turn notification',async t=>{
  const {runner,client,task}=setup(t);await runner.launch(task);await runner.cancel(task);assert.equal(task.status,'running');
  client.emit('notification',{method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-1',status:'interrupted'}}});assert.equal(task.status,'interrupted');
});
test('paused scheduler and missed times cannot send prompts',async t=>{
  const {runner,client,task,store}=setup(t,{schedule:{mode:'exact',at:new Date(Date.now()-3600000).toISOString()}});task.status='scheduled';task.scheduledAt=task.schedule.at;store.data.settings.schedulerEnabled=false;await runner.tick();assert.equal(client.calls.length,0);
  store.data.settings.schedulerEnabled=true;await runner.tick();assert.equal(task.status,'missed');assert.equal(client.calls.length,0);
});

test('unarranged tasks never dispatch even if an obsolete startup timestamp remains',async t=>{
  const {runner,client,task}=setup(t);task.status='scheduled';task.scheduledAt=new Date().toISOString();
  await runner.tick();assert.equal(task.schedule.mode,'manual');assert.equal(client.calls.length,0);assert.equal(task.runs.length,0);
  delete task.schedule;await runner.tick();assert.equal(client.calls.length,0);assert.equal(task.runs.length,0);
});

test('same-time automatic tasks dispatch in the dragged queue order',async t=>{
  const {runner,client,task,store}=setup(t,{schedule:{mode:'auto'},priority:100});
  const second=store.create({title:'dragged first',prompt:'first to send',cwd:process.cwd(),model:'test-model',effort:'medium',priority:1,schedule:{mode:'auto'}});
  store.reorderAuto([second.id,task.id]);
  const at=new Date().toISOString();for(const item of [task,second])Object.assign(item,{status:'scheduled',scheduledAt:at});
  await runner.tick();assert.equal(client.calls.find(call=>call.method==='turn/start').params.input[0].text,second.prompt);
  assert.equal(second.status,'running');assert.equal(task.runs.length,0);
});

test('linked prompts resolve after asynchronous preflight and run history preserves what was sent',async t=>{
  const {runner,client,task,store,dir}=setup(t);
  const file=path.join(dir,'linked.md');fs.writeFileSync(file,'old source');store.update(task.id,{promptFile:file});
  let release;client.connect=()=>new Promise(resolve=>{release=resolve;});
  const pending=runner.launch(task);fs.writeFileSync(file,'# updated before dispatch\nfollow the new file');release();await pending;
  const sent=client.calls.find(call=>call.method==='turn/start');assert.equal(sent.params.input[0].text,'# updated before dispatch\nfollow the new file');
  assert.equal(task.runs[0].prompt,sent.params.input[0].text);
  fs.writeFileSync(file,'updated after dispatch');store.refreshPromptFiles();
  assert.equal(task.prompt,'updated after dispatch');assert.equal(task.runs[0].prompt,sent.params.input[0].text);
  assert.equal(client.calls.filter(call=>call.method==='turn/start').length,1);
});

test('a linked file removed during preflight never dispatches cached text',async t=>{
  const {runner,client,task,store,dir}=setup(t);
  const file=path.join(dir,'removed.md');fs.writeFileSync(file,'cached source');store.update(task.id,{promptFile:file});
  let release;client.connect=()=>new Promise(resolve=>{release=resolve;});const pending=runner.launch(task);
  fs.unlinkSync(file);release();await pending;
  assert.equal(task.status,'failed');assert.match(task.lastError,/Markdown file does not exist/);
  assert.equal(task.runs.length,0);assert.ok(!client.calls.some(call=>call.method==='turn/start'));
  assert.ok(client.calls.some(call=>call.method==='thread/unsubscribe'));
});
test('restart marks an in-flight task uncertain and preserves its history',async t=>{
  const {store,runner,task,dir}=setup(t);await runner.launch(task);store.close();const reopened=new Store(dir);t.after(()=>reopened.close());assert.equal(reopened.get(task.id).status,'uncertain');assert.equal(reopened.get(task.id).runs[0].status,'uncertain');
});
test('preflight reserves the task and prevents simultaneous dispatch',async t=>{
  const {store,runner,client,task}=setup(t);let release;client.connect=()=>new Promise(resolve=>{release=resolve;});const pending=runner.launch(task);
  assert.equal(task.status,'running');assert.throws(()=>store.update(task.id,{title:'changed'}),/running task cannot be edited/);await assert.rejects(runner.launch(task),/already running/);release();await pending;assert.equal(client.calls.filter(c=>c.method==='turn/start').length,1);
});
test('missing quota and invalid catalog options stop before inference',async t=>{
  const {runner,client,task}=setup(t);client.readLimits=async()=>null;await runner.launch(task);assert.equal(task.status,'failed');assert.ok(!client.calls.some(c=>c.method==='turn/start'));
});
test('shutdown revokes preflight lease before any prompt can be sent',async t=>{
  const {runner,client,task}=setup(t);let release;client.connect=()=>new Promise(resolve=>{release=resolve;});const pending=runner.launch(task);runner.suspendForShutdown();release();await pending;
  assert.equal(task.status,'interrupted');assert.ok(!client.calls.some(c=>c.method==='turn/start'));await assert.rejects(runner.launch(task),/service is closing/);
});
test('sparse quota notifications preserve metadata and update the matching bucket',async t=>{
  const {runner}=setup(t);runner.limits={rateLimitsByLimitId:{codex:{planType:'plus',primary:{usedPercent:20,windowDurationMins:300,resetsAt:1234}}},rateLimits:{planType:'plus'}};
  runner.onNotification({method:'account/rateLimits/updated',params:{rateLimits:{limitId:'codex',planType:null,primary:{usedPercent:35,resetsAt:null}}}});
  assert.equal(runner.limits.rateLimitsByLimitId.codex.primary.usedPercent,35);assert.equal(runner.limits.rateLimitsByLimitId.codex.primary.resetsAt,1234);assert.equal(runner.limits.rateLimitsByLimitId.codex.planType,'plus');
});

test('inherited existing-thread configuration never sends model, effort or tier overrides',async t=>{
  const {runner,client,task}=setup(t,{target:'existing',threadId:'existing',modelMode:'inherit',model:'',effort:'',speed:'default'});
  const original=client.request.bind(client);
  client.request=async(method,params)=>{
    const response=await original(method,params);
    if(method==='thread/resume')return {...response,model:'test-model',reasoningEffort:'medium',serviceTier:'priority'};
    return response;
  };
  await runner.launch(task);
  const resume=client.calls.find(c=>c.method==='thread/resume');
  const turn=client.calls.find(c=>c.method==='turn/start');
  assert.ok(turn);
  for(const key of ['model','effort','serviceTier','serviceTierForTurn']) {
    assert.equal(Object.hasOwn(resume.params,key),false);
    assert.equal(Object.hasOwn(turn.params,key),false);
  }
  assert.equal(turn.params.input[0].text,task.prompt);
  assert.equal(turn.params.sandboxPolicy.networkAccess,false);
});

test('inherited model quota is checked after resolution before any prompt dispatch',async t=>{
  const {runner,client,task}=setup(t,{modelMode:'inherit',model:'',effort:''});
  const original=client.request.bind(client);
  client.listModels=async()=>[{model:'test-model',isDefault:true},{model:'inherited-model'}];
  client.readLimits=async()=>({ordinaryUsageAllowed:true,rateLimitsByLimitId:{
    codex:{primary:{usedPercent:1,windowDurationMins:300}},
    inherited:{normalModelSlug:'inherited-model',primary:{usedPercent:100,windowDurationMins:300,resetsAt:Math.floor(Date.now()/1000)+1000}},
  }});
  client.request=async(method,params)=>{
    const response=await original(method,params);
    return method==='thread/start'?{...response,model:'inherited-model'}:response;
  };
  await runner.launch(task);
  const start=client.calls.find(c=>c.method==='thread/start');
  assert.ok(start);
  assert.equal(Object.hasOwn(start.params,'model'),false);
  assert.equal(Object.hasOwn(start.params,'serviceTier'),false);
  assert.equal(task.status,'waiting_quota');
  assert.equal(task.runs.length,0);
  assert.ok(!client.calls.some(c=>c.method==='turn/start'));
  assert.ok(client.calls.some(c=>c.method==='thread/unsubscribe'));
});

test('an unconfirmed inherited model fails without inference and releases resumed ownership',async t=>{
  const {runner,client,task}=setup(t,{target:'existing',threadId:'existing',modelMode:'inherit',model:'',effort:''});
  await runner.launch(task);
  assert.equal(task.status,'failed');
  assert.match(task.lastError,/Cannot confirm the model in the inherited configuration/);
  assert.ok(!client.calls.some(c=>c.method==='turn/start'));
  assert.ok(client.calls.some(c=>c.method==='thread/unsubscribe'));
});

test('an inherited model can use its available bucket when the default Codex bucket is exhausted',async t=>{
  const {runner,client,task}=setup(t,{target:'existing',threadId:'existing',modelMode:'inherit',model:'',effort:''});
  const original=client.request.bind(client);
  client.readLimits=async()=>({ordinaryUsageAllowed:true,rateLimitsByLimitId:{
    codex:{primary:{usedPercent:100,windowDurationMins:300,resetsAt:Math.floor(Date.now()/1000)+1000}},
    special:{normalModelSlug:'test-model',primary:{usedPercent:20,windowDurationMins:300}},
  }});
  client.request=async(method,params)=>{
    const response=await original(method,params);
    return method==='thread/resume'?{...response,model:'test-model'}:response;
  };
  await runner.launch(task);
  assert.equal(task.status,'running');
  assert.ok(client.calls.some(c=>c.method==='turn/start'));
});

test('lost resume response releases the known subscription without dispatching a prompt',async t=>{
  const {runner,client,task}=setup(t,{target:'existing',threadId:'existing',modelMode:'inherit',model:'',effort:''});
  const original=client.request.bind(client);
  client.request=async(method,params)=>{
    if(method==='thread/resume') {
      client.calls.push({method,params});
      throw Object.assign(new Error('resume response timeout'),{sent:true,uncertain:true});
    }
    return original(method,params);
  };
  await runner.launch(task);
  assert.equal(task.status,'scheduled');assert.equal(task.preflightRetry.attempts,1);assert.ok(task.notBefore);
  assert.ok(!client.calls.some(c=>c.method==='turn/start'));
  assert.deepEqual(client.calls.find(c=>c.method==='thread/unsubscribe').params,{threadId:'existing'});
});

test('subscription cleanup failure is visible without misreporting execution completion',async t=>{
  const {runner,client,task}=setup(t);const original=client.request.bind(client);
  client.request=async(method,params)=>method==='thread/unsubscribe'?Promise.reject(new Error('cleanup failed')):original(method,params);
  await runner.launch(task);
  client.emit('notification',{method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-1',status:'completed'}}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(task.status,'succeeded');
  assert.equal(task.runs[0].status,'succeeded');
  assert.match(task.lastError,/Could not release the conversation/);
});

function activationSetup(t,extra={}) {
  const context=setup(t),{runner,client,store}=context,now=Date.now();
  client.listModels=async()=>[{model:'gpt-6-luna',supportedReasoningEfforts:[{reasoningEffort:'low'}],serviceTiers:[{id:'priority'}]}];
  client.readLimits=async()=>({accountId:'activation-account',ordinaryUsageAllowed:true,rateLimitsByLimitId:{codex:{
    primary:{usedPercent:0,windowDurationMins:300,resetsAt:Math.floor(Date.now()/1000)+18000},
    secondary:{usedPercent:10,windowDurationMins:10080,resetsAt:Math.floor(Date.now()/1000)+86400}}}});
  const end=new Date(now-1000+18000_000).toISOString();
  const plan={id:'activation-plan',accountId:'activation-account',kind:'fiveHour',baseAt:end,originAt:end,endAt:end,windowRelation:'ending',
    index:0,activationAt:new Date(now-1000).toISOString(),status:'scheduled',...extra};
  store.data.quota.accountId='activation-account';store.data.quota.plans.push(plan);store.save();
  return {...context,plan};
}
test('a due activation uses an isolated new thread, minimum Luna effort and one standard-speed greeting',async t=>{
  const {runner,client,store,plan,task}=activationSetup(t);client.mode='fast-complete';await runner.tick();
  const start=client.calls.find(call=>call.method==='thread/start'),turn=client.calls.find(call=>call.method==='turn/start');
  assert.equal(plan.status,'succeeded');assert.equal(store.data.tasks.length,1);assert.equal(task.runs.length,0);
  assert.equal(start.params.ephemeral,true);assert.equal(start.params.allowProviderModelFallback,false);
  assert.equal(start.params.modelProvider,'openai');
  assert.equal(start.params.sandbox,'read-only');assert.equal(start.params.config.project_doc_max_bytes,0);
  assert.notEqual(start.params.cwd,task.cwd);assert.deepEqual(start.params.environments,[]);
  assert.deepEqual([turn.params.model,turn.params.effort,turn.params.serviceTier],['gpt-6-luna','low','default']);
  assert.deepEqual(turn.params.input,[{type:'text',text:'你好'}]);assert.equal(turn.params.approvalPolicy,'never');
  assert.deepEqual(turn.params.sandboxPolicy,{type:'readOnly',networkAccess:false});
  assert.equal(plan.confirmed,undefined);await runner.refresh();assert.equal(plan.confirmed,undefined);
  const read=client.readLimits;client.readLimits=async()=>{const data=await read();data.rateLimitsByLimitId.codex.primary.usedPercent=1;return data;};
  await runner.refresh();assert.equal(plan.confirmed,true);
  await runner.tick();assert.equal(client.calls.filter(call=>call.method==='turn/start').length,1);
});
test('an ordinary scheduled task takes priority and a now-anchored activation is skipped without another greeting',async t=>{
  const {runner,client,store,plan,task}=activationSetup(t);const at=new Date(Date.now()-500).toISOString();
  Object.assign(task,{status:'scheduled',schedule:{mode:'exact',at},scheduledAt:at,model:'gpt-6-luna',effort:'low'});client.mode='fast-complete';
  await runner.tick();assert.equal(task.status,'succeeded');assert.equal(plan.status,'scheduled');
  client.readLimits=async()=>({accountId:'activation-account',ordinaryUsageAllowed:true,rateLimits:{primary:{usedPercent:1,windowDurationMins:300,resetsAt:Math.floor(Date.now()/1000)+18000}}});
  await runner.tick();assert.equal(plan.status,'skipped');assert.equal(plan.confirmed,true);
  assert.equal(client.calls.filter(call=>call.method==='turn/start').length,1);assert.equal(store.data.tasks.length,1);
});
test('a pending activation waits when the actual previous window has not reset',async t=>{
  const {runner,client,plan}=activationSetup(t);
  client.readLimits=async()=>({accountId:'activation-account',rateLimits:{primary:{usedPercent:1,windowDurationMins:300,resetsAt:Math.floor(Date.now()/1000)+2000}}});
  await runner.tick();assert.equal(plan.status,'scheduled');assert.match(plan.error,/previous window/);assert.ok(plan.notBefore);
  assert.equal(client.calls.length,0);assert.equal(runner.active,null);
});

for(const kind of ['fiveHour','week'])test(`${kind} an ambiguous zero-use preflight sends exactly one greeting instead of delaying a whole period`,async t=>{
  const now=Date.now();t.mock.timers.enable({apis:['Date'],now});
  const {runner,client,store,plan}=activationSetup(t,{kind});client.mode='fast-complete';
  client.readLimits=async()=>({accountId:'activation-account',rateLimitsByLimitId:{codex:{
    primary:{usedPercent:0,windowDurationMins:300,resetsAt:(now-14000+PERIODS.fiveHour)/1000},
    secondary:{usedPercent:0,windowDurationMins:10080,resetsAt:(now-14000+PERIODS.week)/1000}}}});
  await runner.refresh();assert.equal(store.data.quota.observations[kind].state,'unknown');
  client.listModels=client.readAccount=async()=>{throw new Error('Activation unnecessarily reloaded metadata');};
  await runner.tick();assert.equal(plan.status,'succeeded');assert.equal(plan.lastQuotaCheck.state,'unknown');
  assert.equal(plan.notBefore,null);assert.equal(plan.task.runs.length,1);
  assert.deepEqual(client.calls.find(call=>call.method==='turn/start').params.input,[{type:'text',text:'你好'}]);
  await runner.tick();assert.equal(client.calls.filter(call=>call.method==='turn/start').length,1);
});

test('disconnected quota confirmation expires without retaining an indefinite disabled lock',async t=>{
  const {runner,plan}=activationSetup(t);
  Object.assign(plan,{status:'succeeded',finishedAt:new Date(Date.now()-120001).toISOString()});
  runner.limits=null;runner.client.status.connected=false;
  let changes=0;runner.on('change',()=>changes++);
  runner.expireConfirmations();runner.expireConfirmations();
  assert.equal(plan.confirmed,false);assert.equal(changes,1);assert.match(plan.error,/could not be confirmed/);
});

test('an unsent plan deferred for five hours by an ambiguous old reading becomes runnable on a fresh zero-use read',async t=>{
  const {runner,client,plan}=activationSetup(t);client.mode='fast-complete';
  Object.assign(plan,{error:'Waiting for the previous window to reset.',notBefore:new Date(Date.now()+PERIODS.fiveHour).toISOString()});
  await runner.refresh();assert.equal(plan.notBefore,null);assert.equal(plan.error,null);
  await runner.tick();assert.equal(plan.status,'succeeded');assert.equal(client.calls.filter(call=>call.method==='turn/start').length,1);
});

test('activation records actual server token usage before completion',async t=>{
  const {runner,client,plan}=activationSetup(t);await runner.tick();
  const tokenUsage={total:{inputTokens:50,outputTokens:6,totalTokens:56,reasoningOutputTokens:0}};
  client.emit('notification',{method:'thread/tokenUsage/updated',params:{threadId:'thread-1',tokenUsage}});
  client.emit('notification',{method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-1',status:'completed'}}});
  assert.equal(plan.status,'succeeded');assert.deepEqual(plan.task.runs[0].tokenUsage,tokenUsage);
});

for(const kind of ['fiveHour','week'])test(`${kind} due activation survives a fresh zero-use reading retaining the expired reset`,async t=>{
  const now=Date.now();t.mock.timers.enable({apis:['Date'],now});
  const {runner,client,store,plan}=activationSetup(t,{kind});client.mode='fast-complete';
  const data={accountId:'activation-account',ordinaryUsageAllowed:true,rateLimitsByLimitId:{codex:{
    primary:{usedPercent:0,windowDurationMins:300,resetsAt:(now-1000)/1000},
    secondary:{usedPercent:0,windowDurationMins:10080,resetsAt:(now-1000)/1000}}}};
  client.readLimits=async()=>data;await runner.tick();
  assert.equal(plan.status,'succeeded');assert.equal(plan.lastQuotaCheck.projectedReset,true);
  assert.equal(plan.lastQuotaCheck.meteredResetAt,new Date(now-1000).toISOString());
  assert.equal(plan.confirmed,undefined);assert.equal(store.data.tasks.length,1);
  assert.deepEqual(client.calls.find(call=>call.method==='turn/start').params.input,[{type:'text',text:'你好'}]);
  // A successful model reply is not enough. The expired reading cannot confirm billing.
  t.mock.timers.tick(1000);await runner.refresh();assert.equal(plan.confirmed,undefined);
  data.rateLimitsByLimitId.codex[kind==='fiveHour'?'primary':'secondary']={usedPercent:1,
    windowDurationMins:PERIODS[kind]/60000,resetsAt:(now+PERIODS[kind])/1000};
  await runner.refresh();assert.equal(plan.confirmed,true);
  await runner.tick();assert.equal(client.calls.filter(call=>call.method==='turn/start').length,1);
});

test('an expired old positive reading defers briefly instead of permanently failing, then sends when refreshed',async t=>{
  const now=Date.now();t.mock.timers.enable({apis:['Date'],now});
  const {runner,client,plan}=activationSetup(t);client.mode='fast-complete';
  let used=10;
  client.readLimits=async()=>({accountId:'activation-account',rateLimitsByLimitId:{codex:{
    primary:{usedPercent:used,windowDurationMins:300,resetsAt:(now-1000)/1000}}}});
  await runner.tick();assert.equal(plan.status,'scheduled');assert.match(plan.error,/readings to refresh/);
  assert.equal(Date.parse(plan.notBefore),now+2000);assert.equal(client.calls.length,0);
  used=0;t.mock.timers.tick(1000);await runner.tick();assert.equal(client.calls.length,0);
  t.mock.timers.tick(1000);await runner.tick();assert.equal(plan.status,'succeeded');
  assert.equal(client.calls.filter(call=>call.method==='turn/start').length,1);
});

test('an idle expired five-hour window cannot send a greeting while the weekly quota is exhausted',async t=>{
  const {runner,client,plan}=activationSetup(t);
  client.readLimits=async()=>({accountId:'activation-account',ordinaryUsageAllowed:false,rateLimitsByLimitId:{codex:{
    primary:{usedPercent:0,windowDurationMins:300,resetsAt:Math.floor(Date.now()/1000)-1},
    secondary:{usedPercent:100,windowDurationMins:10080,resetsAt:Math.floor(Date.now()/1000)+86400}}}});
  await runner.tick();assert.equal(plan.status,'scheduled');assert.ok(plan.notBefore);
  assert.equal(client.calls.length,0);assert.equal(plan.confirmed,undefined);
});

test('locking a floating window from an older forecast sends the greeting now without waiting five hours',async t=>{
  const now=Date.now();t.mock.timers.enable({apis:['Date'],now});
  const {runner,client,store}=activationSetup(t);store.data.quota.plans=[];client.mode='fast-complete';
  const limits=()=>({accountId:'activation-account',rateLimitsByLimitId:{codex:{
    primary:{usedPercent:0,windowDurationMins:300,resetsAt:(Date.now()+PERIODS.fiveHour)/1000},
    secondary:{usedPercent:10,windowDurationMins:10080,resetsAt:(now+PERIODS.week)/1000}}}});
  observeQuota(store.data.quota,limits(),now);
  t.mock.timers.tick(60_000);const snapshot=limits();observeQuota(store.data.quota,snapshot,Date.now());
  const timeline=quotaTimeline(snapshot,store.data.quota,store.data.settings,[],Date.now());
  assert.equal(timeline.periods.fiveHour.state,'floating');
  t.mock.timers.tick(23_000);
  const plan=planWindowActivation(store.data.quota,timeline,{nodeId:timeline.nodes.find(node=>node.kind==='fiveHour').id});
  assert.equal(Date.parse(plan.activationAt),Date.now());
  // Preflight rereads the last moving forecast, whose start now lags the
  // appointment by 23 seconds. It is not an unexpired previous window.
  client.readLimits=async()=>snapshot;
  await runner.tick();
  assert.equal(plan.status,'succeeded');assert.equal(plan.notBefore,null);
  assert.deepEqual(client.calls.find(call=>call.method==='turn/start').params.input,[{type:'text',text:'你好'}]);
  await runner.tick();assert.equal(client.calls.filter(call=>call.method==='turn/start').length,1);
});
test('no advertised low-cost model fails activation without any default-model inference',async t=>{
  const {runner,client,plan}=activationSetup(t);client.listModels=async()=>[{model:'gpt-6-astra',supportedReasoningEfforts:['low']}];
  await runner.tick();assert.equal(plan.status,'failed');assert.match(plan.error,/low-cost/);assert.equal(client.calls.length,0);
});
test('uncertain activation delivery never automatically retries, including after a store restart',async t=>{
  const {runner,client,plan,store,dir}=activationSetup(t);client.mode='timeout';await runner.tick();
  assert.equal(plan.status,'uncertain');await runner.tick();assert.equal(client.calls.filter(call=>call.method==='turn/start').length,1);
  store.close();const restarted=new Store(dir);try{assert.equal(restarted.data.quota.plans[0].status,'uncertain');}finally{restarted.close();}
});
test('restarting during an activation persists uncertainty without inventing a user task',async t=>{
  const {runner,plan,store,dir}=activationSetup(t);await runner.tick();assert.equal(plan.status,'running');
  runner.suspendForShutdown();store.close();const restarted=new Store(dir);
  try{assert.equal(restarted.data.quota.plans[0].status,'uncertain');assert.equal(restarted.data.tasks.length,1);}finally{restarted.close();}
});
test('activation refuses a different quota alias and does not ask for tool approvals',async t=>{
  const {runner,client,plan}=activationSetup(t);
  const original=client.readLimits;client.readLimits=async()=>{const data=await original();data.rateLimitsByLimitId.codex.normalModelSlug='gpt-6-astra';return data;};
  await runner.tick();assert.equal(plan.status,'failed');assert.match(plan.error,/different quota bucket/);assert.equal(client.calls.length,0);
});
test('simultaneous five-hour and weekly appointments use one greeting when their reset timestamps agree',async t=>{
  const {runner,client,plan,store}=activationSetup(t);const weekly={...plan,id:'weekly-plan',kind:'week'};store.data.quota.plans.push(weekly);client.mode='fast-complete';
  client.readLimits=async()=>({accountId:'activation-account',rateLimits:{primary:{usedPercent:0,windowDurationMins:300,resetsAt:Math.floor(Date.now()/1000)+18000},
    secondary:{usedPercent:0,windowDurationMins:10080,resetsAt:Math.floor(Date.now()/1000)+604800}}});
  await runner.tick();assert.equal(plan.status,'succeeded');
  const data=await client.readLimits();data.rateLimits.primary.usedPercent=1;data.rateLimits.secondary.usedPercent=1;
  client.readLimits=async()=>data;await runner.tick();assert.equal(weekly.status,'skipped');
  assert.equal(client.calls.filter(call=>call.method==='turn/start').length,1);
});
test('zero-rounded usage holds a simultaneous second activation while the first greeting is being verified',async t=>{
  const {runner,client,plan,store}=activationSetup(t);const weekly={...plan,id:'weekly-plan',kind:'week'};store.data.quota.plans.push(weekly);client.mode='fast-complete';
  client.readLimits=async()=>({accountId:'activation-account',rateLimits:{primary:{usedPercent:0,windowDurationMins:300,resetsAt:Math.floor(Date.now()/1000)+18000},
    secondary:{usedPercent:0,windowDurationMins:10080,resetsAt:Math.floor(Date.now()/1000)+604800}}});
  await runner.tick();await runner.tick();assert.equal(weekly.status,'scheduled');assert.ok(weekly.notBefore);
  assert.match(weekly.error,/confirmation/);assert.equal(client.calls.filter(call=>call.method==='turn/start').length,1);
});

test('coincident weekly and five-hour plans never repeat a greeting whose dispatch is uncertain, including restart',async t=>{
  const {runner,client,store,plan,dir}=activationSetup(t);
  store.data.quota.plans.push({...plan,id:'weekly-uncertain',kind:'week'});client.mode='timeout';
  await runner.tick();assert.equal(plan.status,'uncertain');assert.equal(plan.task.runs[0].delivery,'pending');
  store.close();const restored=new Store(dir);t.after(()=>restored.close());
  const next=new FakeClient();next.mode='fast-complete';next.readLimits=client.readLimits.bind(client);next.listModels=client.listModels.bind(client);
  const after=new Runner(restored,next);await after.tick();
  assert.equal(restored.data.quota.plans[1].status,'uncertain');
  assert.match(restored.data.quota.plans[1].error,/No duplicate greeting/);
  assert.equal(next.calls.some(call=>call.method==='turn/start'),false);
});
test('the activation rejects a fallback model before dispatching any prompt',async t=>{
  const {runner,client,plan}=activationSetup(t),request=client.request.bind(client);
  client.request=async(method,params)=>{const result=await request(method,params);return method==='thread/start'?{...result,model:'gpt-6-astra'}:result;};
  await runner.tick();assert.equal(plan.status,'failed');assert.match(plan.error,/low-cost model/);assert.ok(!client.calls.some(call=>call.method==='turn/start'));
});

test('a completed ordinary task suppresses the greeting even when usage rounds to zero',async t=>{
  const {runner,client,plan,task}=activationSetup(t),at=new Date(Date.now()-500).toISOString();
  Object.assign(task,{status:'scheduled',schedule:{mode:'exact',at},scheduledAt:at,model:'gpt-6-luna',effort:'low'});
  client.mode='fast-complete';await runner.tick();await runner.tick();
  assert.equal(task.status,'succeeded');assert.equal(plan.status,'skipped');assert.equal(plan.confirmed,true);
  assert.equal(task.runs[0].meteredBucketId,'codex');assert.equal(task.runs[0].modelProvider,'openai');
  assert.equal(client.calls.filter(call=>call.method==='turn/start').length,1);
});
test('partial new-reset notifications do not carry old usage into activation detection',async t=>{
  const {runner,client,plan}=activationSetup(t),reset=Math.floor(Date.now()/1000)+18000;
  runner.limits={rateLimitsByLimitId:{codex:{primary:{usedPercent:12,windowDurationMins:300,resetsAt:reset-1000}}}};
  client.emit('notification',{method:'account/rateLimits/updated',params:{rateLimits:{limitId:'codex',primary:{resetsAt:reset}}}});
  assert.equal(runner.limits.rateLimitsByLimitId.codex.primary.usedPercent,undefined);assert.equal(plan.status,'scheduled');
  client.emit('notification',{method:'account/rateLimits/updated',params:{rateLimits:{limitId:'codex',primary:{resetsAt:reset,usedPercent:1}}}});
  assert.equal(plan.status,'skipped');assert.equal(plan.confirmed,true);assert.equal(client.calls.length,0);
});
test('a mismatched provider fails before the activation prompt is sent',async t=>{
  const {runner,client,plan}=activationSetup(t),request=client.request.bind(client);
  client.request=async(method,params)=>{const result=await request(method,params);return method==='thread/start'?{...result,modelProvider:'other'}:result;};
  await runner.tick();assert.equal(plan.status,'failed');assert.ok(!client.calls.some(call=>call.method==='turn/start'));
});

test('an inherited cadence delay is respected when checking whether the preceding window has reset',async t=>{
  const {runner,client,plan}=activationSetup(t,{baseAt:new Date(Date.now()+14400_000).toISOString(),inheritedOffset:3600_000});
  client.readLimits=async()=>({accountId:'activation-account',rateLimitsByLimitId:{codex:{primary:{usedPercent:1,windowDurationMins:300,resetsAt:Math.floor(Date.now()/1000)+16000}}}});
  await runner.tick();assert.equal(plan.status,'scheduled');assert.match(plan.error,/previous window/);
  assert.equal(client.calls.length,0);assert.equal(plan.confirmed,undefined);
});

for(const kind of ['fiveHour','week'])test(`${kind} ending-node activation executes at the preceding boundary, not at its reset endpoint`,async t=>{
  const now=Date.now(),start=now+20000;t.mock.timers.enable({apis:['Date'],now});
  const {runner,client,store}=activationSetup(t);store.data.quota.plans=[];client.mode='fast-complete';
  const periods=(used,epoch)=>({accountId:'activation-account',rateLimitsByLimitId:{codex:{
    primary:{usedPercent:used,windowDurationMins:300,resetsAt:(epoch+PERIODS.fiveHour)/1000},
    secondary:{usedPercent:used,windowDurationMins:10080,resetsAt:(epoch+PERIODS.week)/1000}}}});
  const before=periods(10,start);before.rateLimitsByLimitId.codex.primary.resetsAt=start/1000;before.rateLimitsByLimitId.codex.secondary.resetsAt=start/1000;
  observeQuota(store.data.quota,before,now);
  const timeline=quotaTimeline(before,store.data.quota,store.data.settings,[],now);
  const node=timeline.nodes.filter(node=>node.kind===kind)[1],plan=planWindowActivation(store.data.quota,timeline,{nodeId:node.id},now);
  assert.equal(Date.parse(plan.activationAt),start);assert.equal(Date.parse(plan.endAt),start+PERIODS[kind]);
  client.readLimits=async()=>Date.now()<start?before:periods(0,start);
  await runner.tick();assert.equal(client.calls.length,0);assert.equal(plan.status,'scheduled');
  t.mock.timers.setTime(start);await runner.tick();
  assert.equal(plan.status,'succeeded');assert.equal(Date.parse(plan.task.runs[0].startedAt),start);
  assert.equal(client.calls.filter(call=>call.method==='turn/start').length,1);
  t.mock.timers.setTime(start+PERIODS[kind]);await runner.tick();
  assert.equal(client.calls.filter(call=>call.method==='turn/start').length,1);
});
