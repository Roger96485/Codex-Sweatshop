import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn,spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store,validateTask } from '../src/store.mjs';

function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sweatshop-store-'));
  const store=new Store(dir);t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
  return {store,dir};
}

test('new tasks are unarranged while connection and scheduler enablement are automatic',t=>{
  const {store}=fixture(t);const task=store.create({title:'new',prompt:'text',cwd:process.cwd()});
  assert.deepEqual(task.schedule,{mode:'manual'});assert.equal(task.status,'queued');
  assert.equal(task.scheduledAt,undefined);assert.equal(store.data.settings.schedulerEnabled,true);
});

test('legacy start-node activation plans are revoked while ending-window plans and normal task history survive',t=>{
  const {store,dir}=fixture(t),task=store.create({title:'Retained',prompt:'p',cwd:process.cwd()});
  const before=structuredClone(task),at=new Date(Date.now()+3600_000).toISOString();
  store.data.quota.plans=[{id:'legacy',status:'scheduled',activationAt:at},
    {id:'corrected',status:'scheduled',activationAt:at,endAt:new Date(Date.parse(at)+18000_000).toISOString(),windowRelation:'ending'},
    {id:'history',status:'succeeded',activationAt:at}];store.save();store.close();
  const restarted=new Store(dir);try {
    assert.deepEqual(restarted.get(task.id),before);assert.equal(restarted.data.quota.plans[0].status,'cancelled');
    assert.match(restarted.data.quota.plans[0].error,/ending at the node/);assert.equal(restarted.data.quota.plans[1].status,'scheduled');
    assert.equal(restarted.data.quota.plans[2].status,'succeeded');
  }finally{restarted.close();}
});

test('linked files continue updating scheduled tasks without changing their startup commitments',t=>{
  const {store,dir}=fixture(t);const file=path.join(dir,'source.md');fs.writeFileSync(file,'first version');
  const task=store.create({title:'linked',promptFile:file,cwd:process.cwd(),schedule:{mode:'exact',at:'2026-10-05T00:00:00Z'}});
  Object.assign(task,{status:'scheduled',scheduledAt:task.schedule.at});store.save();
  fs.writeFileSync(file,'second version');assert.equal(store.refreshPromptFiles(),true);
  assert.equal(task.prompt,'second version');assert.equal(task.status,'scheduled');assert.equal(task.scheduledAt,task.schedule.at);
  assert.equal(store.refreshPromptFiles(),false);
  fs.unlinkSync(file);store.refreshPromptFiles();assert.equal(task.prompt,'');assert.match(task.promptFileError,/does not exist/);
  assert.throws(()=>store.resolvePrompt(task),/does not exist/);
  fs.writeFileSync(file,'restored');store.refreshPromptFiles();assert.equal(task.prompt,'restored');assert.equal(task.promptFileError,null);
  store.update(task.id,{promptFile:null,prompt:'literal'});fs.writeFileSync(file,'third');store.refreshPromptFiles();assert.equal(task.prompt,'literal');
});

test('drag reordering is atomic and applies only to the complete pending auto queue',t=>{
  const {store}=fixture(t);const create=(title,schedule={mode:'auto'})=>store.create({title,prompt:'text',cwd:process.cwd(),schedule});
  const a=create('A'),b=create('B'),manual=create('manual',{mode:'manual'}),done=create('done');done.status='succeeded';
  const before=JSON.stringify(store.data);
  for (const ids of [[a.id],[a.id,a.id],[a.id,manual.id],[a.id,done.id]]) assert.throws(()=>store.reorderAuto(ids),/queue has changed/);
  assert.equal(JSON.stringify(store.data),before);
  store.reorderAuto([b.id,a.id]);assert.equal(b.autoOrder,0);assert.equal(a.autoOrder,1);
  assert.equal(manual.autoOrder,undefined);assert.equal(done.autoOrder,undefined);
  store.update(a.id,{title:'A edited'});assert.equal(a.autoOrder,1);
  store.update(a.id,{schedule:{mode:'manual'}});assert.equal(a.autoOrder,undefined);
  store.update(a.id,{schedule:{mode:'auto'}});assert.equal(a.autoOrder,undefined);
});

test('simultaneous stale-lock recovery permits only one service owner',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sweatshop-lock-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const exited=spawnSync(process.execPath,['-e','console.log(process.pid)'],{encoding:'utf8',windowsHide:true});
  fs.writeFileSync(path.join(dir,'service.lock'),exited.stdout.trim());
  const worker=fileURLToPath(new URL('./fixtures/store-worker.mjs',import.meta.url));
  const run=()=>new Promise((resolve,reject)=>{let output='';const child=spawn(process.execPath,[worker,dir],{windowsHide:true});child.stdout.on('data',chunk=>output+=chunk);child.on('error',reject);child.on('close',code=>resolve({code,output}));});
  const results=await Promise.all([run(),run()]);assert.equal(results.filter(r=>r.output.includes('acquired')).length,1);assert.equal(results.filter(r=>r.output.includes('blocked')).length,1);
});
test('closing an already released store cannot remove a replacement lock',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sweatshop-lock-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const first=new Store(dir);first.close();const second=new Store(dir);first.close();assert.ok(fs.existsSync(second.lock));second.close();
});
test('corrupt state is preserved and never reset to an empty plan',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sweatshop-corrupt-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const filename=path.join(dir,'state.json');fs.writeFileSync(filename,'broken');assert.throws(()=>new Store(dir),/have been preserved/);assert.equal(fs.readFileSync(filename,'utf8'),'broken');assert.ok(!fs.existsSync(path.join(dir,'service.lock')));
});

test('legacy visual estimates are discarded while startup commitments survive migration',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sweatshop-estimate-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const store=new Store(dir);const task=store.create({title:'估时',prompt:'test',cwd:process.cwd()});
  assert.equal(Object.hasOwn(task,'plannedMinutes'),false);
  Object.assign(task,{plannedMinutes:60,status:'scheduled',scheduledAt:'2026-10-04T04:00:00.000Z'});store.save();store.close();
  const reopened=new Store(dir);const migrated=reopened.get(task.id);
  assert.equal(Object.hasOwn(migrated,'plannedMinutes'),false);
  assert.equal(migrated.status,'scheduled');assert.equal(migrated.scheduledAt,'2026-10-04T04:00:00.000Z');reopened.close();
});

test('obsolete estimate-only updates cannot resume paused jobs or move startup commitments',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sweatshop-estimate-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const store=new Store(dir);t.after(()=>store.close());
  const task=store.create({title:'拖动时长',prompt:'test',cwd:process.cwd()});
  Object.assign(task,{status:'paused',scheduledAt:'2026-10-04T04:00:00.000Z',notBefore:'2026-10-04T04:00:00.000Z',lastError:'保留',runs:[{id:'prior',status:'succeeded'}]});
  const before=JSON.parse(JSON.stringify(task));assert.throws(()=>store.update(task.id,{plannedMinutes:120}),/only a start time/);
  assert.deepEqual(task,before);
  task.status='running';assert.throws(()=>store.update(task.id,{plannedMinutes:180}),/running task cannot be edited/);
});

test('model inheritance is explicit and legacy tasks retain their chosen configuration',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sweatshop-config-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const store=new Store(dir);
  const custom=store.create({title:'旧配置',prompt:'test',cwd:process.cwd(),model:'chosen-model'});
  assert.equal(custom.modelMode,'custom');
  const inherited=store.create({title:'沿用配置',prompt:'test',target:'existing',threadId:'thread-id',modelMode:'inherit'});
  assert.equal(inherited.modelMode,'inherit');
  assert.throws(()=>validateTask({modelMode:'unrecognized'},inherited),/configuration mode/);
  delete custom.modelMode;store.save();store.close();
  const reopened=new Store(dir);t.after(()=>reopened.close());
  assert.equal(reopened.get(custom.id).modelMode,'custom');
  assert.equal(reopened.get(custom.id).model,'chosen-model');
  assert.equal(reopened.get(inherited.id).modelMode,'inherit');
});

test('editing completed content preserves its terminal status, configuration and dispatched history',t=>{
  const {store,dir}=fixture(t);const file=path.join(dir,'linked.md');fs.writeFileSync(file,'original source');
  const task=store.create({title:'completed',promptFile:file,target:'existing',threadId:'existing-thread',modelMode:'inherit',schedule:{mode:'auto'}});
  const run={id:'completed-run',status:'succeeded',startedAt:'2026-10-05T00:00:01.000Z',finishedAt:'2026-10-05T00:00:02.000Z',prompt:'original source',output:'original result'};
  Object.assign(task,{status:'succeeded',scheduledAt:run.startedAt,windowStart:'2026-10-05T00:00:00.000Z',windowEnd:'2026-10-05T05:00:00.000Z',runs:[run],autoOrder:2});
  const commitments=()=>[task.status,task.scheduledAt,task.windowStart,task.windowEnd];const before=commitments();
  fs.writeFileSync(file,'updated source');store.update(task.id,{title:'completed edited',runs:[],status:'queued'});
  assert.equal(task.title,'completed edited');assert.equal(task.prompt,'updated source');assert.equal(task.promptFile,file);
  assert.deepEqual(commitments(),before);assert.equal(task.runs.length,1);assert.equal(task.runs[0],run);
  assert.equal(run.prompt,'original source');assert.equal(run.output,'original result');assert.equal(task.threadId,'existing-thread');
  assert.equal(task.target,'existing');assert.equal(task.modelMode,'inherit');assert.equal(task.autoOrder,2);
  store.update(task.id,{promptFile:null,prompt:'edited literal',reschedule:false});
  assert.equal(task.prompt,'edited literal');assert.deepEqual(commitments(),before);assert.equal(task.runs[0],run);
});

test('content edits retain pending commitments, retry delays and non-running terminal states',t=>{
  const {store}=fixture(t);
  const execution=task=>({status:task.status,scheduledAt:task.scheduledAt,windowStart:task.windowStart,windowEnd:task.windowEnd,notBefore:task.notBefore,lastError:task.lastError,autoOrder:task.autoOrder,schedule:task.schedule});
  for (const status of ['queued','scheduled','waiting_quota','waiting_session','paused','missed','failed','interrupted','uncertain','succeeded']) {
    const task=store.create({title:status,prompt:'original',cwd:process.cwd(),schedule:{mode:'auto'}});
    const run={id:`${status}-run`,status:'failed',prompt:'dispatched prompt',output:'saved output'};
    Object.assign(task,{status,scheduledAt:'2026-10-05T01:00:00.123Z',windowStart:'2026-10-05T00:00:00.123Z',windowEnd:'2026-10-05T05:00:00.123Z',notBefore:'2026-10-05T01:00:00.123Z',lastError:'retained execution note',autoOrder:2,runs:[run]});
    const before=structuredClone(execution(task));
    store.update(task.id,{prompt:'edited',modelMode:'inherit',reschedule:false});
    assert.equal(task.prompt,'edited');assert.equal(task.modelMode,'inherit');
    assert.deepEqual(execution(task),before,status);assert.equal(task.runs[0],run);assert.equal(task.runs.length,1);
  }
});

test('explicit pending schedule changes still reset commitments without discarding dispatch history',t=>{
  const {store}=fixture(t);const task=store.create({title:'waiting',prompt:'text',cwd:process.cwd(),schedule:{mode:'auto'}});
  const run={id:'prior',status:'failed',prompt:'prior prompt'};
  Object.assign(task,{status:'waiting_quota',scheduledAt:'2026-10-05T01:00:00.000Z',windowStart:'2026-10-05T00:00:00.000Z',windowEnd:'2026-10-05T05:00:00.000Z',notBefore:'2026-10-05T02:00:00.000Z',lastError:'waiting',autoOrder:1,runs:[run]});
  const at='2026-10-05T03:00:00.456Z';store.update(task.id,{schedule:{mode:'exact',at}});
  assert.equal(task.status,'queued');assert.deepEqual(task.schedule,{mode:'exact',at});
  for (const key of ['scheduledAt','windowStart','windowEnd','notBefore','lastError']) assert.equal(task[key],null);
  assert.equal(task.autoOrder,undefined);assert.equal(task.runs[0],run);
});

test('explicit completed rescheduling preserves identity and linked history while clearing the prior commitment',t=>{
  const {store,dir}=fixture(t);const file=path.join(dir,'linked.md');fs.writeFileSync(file,'old source');
  const task=store.create({title:'completed',promptFile:file,target:'existing',threadId:'existing-thread',model:'chosen-model',effort:'high',speed:'priority',schedule:{mode:'auto'}});
  const run={id:'old-run',status:'succeeded',prompt:'old source',output:'old result'};
  Object.assign(task,{status:'succeeded',scheduledAt:'2026-10-05T00:00:00.000Z',windowStart:'2026-10-05T00:00:00.000Z',windowEnd:'2026-10-05T05:00:00.000Z',notBefore:'2026-10-05T01:00:00.000Z',lastError:'old note',runs:[run],autoOrder:1});
  const id=task.id,createdAt=task.createdAt,before=JSON.stringify(store.data);
  for(const input of [{reschedule:true},{reschedule:'true',schedule:{mode:'manual'}},{reschedule:true,schedule:{mode:'exact',at:'invalid'}}]) {
    assert.throws(()=>store.update(id,input));assert.equal(JSON.stringify(store.data),before);
  }
  fs.writeFileSync(file,'latest source');store.update(id,{reschedule:true,schedule:{mode:'manual'}});
  assert.equal(task.id,id);assert.equal(task.createdAt,createdAt);assert.equal(task.status,'queued');assert.deepEqual(task.schedule,{mode:'manual'});
  assert.equal(task.scheduledAt,null);assert.equal(task.windowStart,null);assert.equal(task.windowEnd,null);assert.equal(task.notBefore,null);assert.equal(task.lastError,null);
  assert.equal(task.promptFile,file);assert.equal(task.prompt,'latest source');assert.equal(task.target,'existing');assert.equal(task.threadId,'existing-thread');
  assert.equal(task.model,'chosen-model');assert.equal(task.effort,'high');assert.equal(task.speed,'priority');assert.equal(task.runs[0],run);
  assert.equal(task.autoOrder,undefined);assert.equal(Object.hasOwn(task,'reschedule'),false);
  task.status='succeeded';task.autoOrder=1;store.update(id,{reschedule:true,schedule:{mode:'auto'}});
  assert.equal(task.status,'queued');assert.equal(task.autoOrder,undefined);assert.equal(task.runs[0],run);
});
