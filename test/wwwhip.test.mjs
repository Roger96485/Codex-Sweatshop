import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {WhipService,defaultWhipConfiguration,validateWhipConfiguration} from '../src/wwwhip.mjs';

function setup(t,options={}){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'sweatshop-whip-')),calls=[];
  const runtime={start:async config=>{calls.push({start:structuredClone(config)});},stop:async()=>{calls.push({stop:true});},...options.runtime};
  const service=new WhipService(directory,{platform:'win32',runtimeFactory:()=>runtime,...options});
  t.after(async()=>{await service.close();fs.rmSync(directory,{recursive:true,force:true});});
  return {service,runtime,directory,calls};
}
test('WWWhip is off by default and enabling requires explicit reminder confirmation',async t=>{
  const {service,calls}=setup(t);await service.initialize();
  assert.equal(service.snapshot().enabled,false);assert.equal(calls.length,0);assert.equal(fs.existsSync(service.file),false);
  await assert.rejects(service.apply({enabled:true}),/Confirm/);assert.equal(calls.length,0);
});
test('configured Unicode prompts persist independently; disabling stops the runtime',async t=>{
  const {service,calls,directory}=setup(t);
  const configuration=defaultWhipConfiguration();configuration.messages=[{question:'继续吗？ 🙂',message:'请继续当前任务。'}];
  const on=await service.apply({enabled:true,confirmed:true,configuration});
  assert.equal(on.enabled,true);assert.equal(on.busy,false);assert.deepEqual(calls[0].start,configuration);
  assert.equal(fs.existsSync(path.join(directory,'state.json')),false);
  await service.apply({enabled:false});assert.equal(service.enabled,false);assert.ok(calls.some(call=>call.stop));
  const saved=JSON.parse(fs.readFileSync(service.file));assert.equal(saved.enabled,false);assert.deepEqual(saved.configuration,configuration);
});
test('enabled preferences restore the integrated runtime without binding or sending a chat',async t=>{
  const {service,directory}=setup(t);await service.apply({enabled:true,confirmed:true});await service.close();
  let starts=0;const restored=new WhipService(directory,{platform:'win32',runtimeFactory:()=>({start:async()=>{starts++;},stop:()=>{}})});
  await restored.initialize();assert.equal(starts,1);assert.equal(restored.enabled,true);await restored.close();
});
test('invalid prompts and unsupported platforms never start WWWhip',async t=>{
  const {service,calls}=setup(t,{platform:'linux'});
  await assert.rejects(service.apply({enabled:true,confirmed:true}),/Windows/);assert.equal(calls.length,0);
  for(const message of ['', 'a\nb','\ud800','x'.repeat(2001)]){
    const config=defaultWhipConfiguration();config.messages[0].message=message;
    assert.throws(()=>validateWhipConfiguration(config),/Invalid Whip/);
  }
});
test('failed startup rolls back shortcuts and does not persist enabled state',async t=>{
  let stops=0;const {service}=setup(t,{runtime:{start:async()=>{throw new Error('hotkey occupied');},stop:()=>{stops++;}}});
  await assert.rejects(service.apply({enabled:true,confirmed:true}),/hotkey occupied/);
  assert.equal(service.enabled,false);assert.equal(service.busy,false);assert.equal(stops,1);assert.equal(fs.existsSync(service.file),false);
});
test('corrupt preferences preserve their original bytes until explicitly replaced',async t=>{
  const {service,directory}=setup(t);const original='{invalid';fs.writeFileSync(service.file,original);
  const recovered=new WhipService(directory,{platform:'win32',runtimeFactory:()=>({start:async()=>{},stop:()=>{}})});
  assert.equal(recovered.enabled,false);assert.match(recovered.error,/Could not read/);assert.equal(fs.readFileSync(service.file,'utf8'),original);
  await recovered.apply({enabled:true,confirmed:true});assert.equal(fs.readFileSync(`${service.file}.invalid-backup`,'utf8'),original);await recovered.close();
});
test('closing during startup cannot leave an enabled helper behind',async t=>{
  let release,stops=0;const {service}=setup(t,{runtime:{start:()=>new Promise(resolve=>{release=resolve;}),stop:()=>{stops++;}}});
  const pending=service.apply({enabled:true,confirmed:true});const rejected=assert.rejects(pending,/closing/);
  await new Promise(resolve=>setImmediate(resolve));const closing=service.close();release();await closing;await rejected;
  assert.equal(service.enabled,false);assert.ok(stops>=2);assert.equal(fs.existsSync(service.file),false);
});
test('queued enable and disable transitions finish in the requested order',async t=>{
  const {service}=setup(t);const on=service.apply({enabled:true,confirmed:true}),off=service.apply({enabled:false});
  await Promise.all([on,off]);assert.equal(service.enabled,false);assert.equal(JSON.parse(fs.readFileSync(service.file)).enabled,false);
});

test('settings persist immediately while off without starting input or requiring enable consent',async t=>{
  const {service,calls}=setup(t),configuration=defaultWhipConfiguration();
  configuration.messages=[{question:'Continue?',message:'Continue.'}];
  await service.apply({configuration});
  assert.equal(service.enabled,false);assert.equal(calls.length,0);
  assert.deepEqual(JSON.parse(fs.readFileSync(service.file)).configuration,configuration);
  await service.apply({enabled:true,confirmed:true});
  assert.deepEqual(calls[0].start,configuration);
});

test('live configuration changes preserve confirmed On and apply in order with enable transitions',async t=>{
  const {service,calls}=setup(t),configuration=defaultWhipConfiguration();
  configuration.messages=[{question:'Updated?',message:'Updated live.'}];
  const on=service.apply({enabled:true,confirmed:true}),update=service.apply({configuration});
  await Promise.all([on,update]);
  assert.equal(service.enabled,true);assert.deepEqual(calls.at(-1).start,configuration);
  assert.equal(JSON.parse(fs.readFileSync(service.file)).enabled,true);
  const off=service.apply({enabled:false}),next=service.apply({configuration});await Promise.all([off,next]);
  assert.equal(service.enabled,false);assert.equal(calls.filter(call=>call.start).length,2);
});

test('invalid settings never overwrite saved prompts or change enable state',async t=>{
  const {service}=setup(t);await service.apply({enabled:true,confirmed:true});
  const saved=fs.readFileSync(service.file,'utf8'),configuration=defaultWhipConfiguration();configuration.messages[0].message='';
  await assert.rejects(service.apply({configuration}),/Invalid Whip/);
  assert.equal(fs.readFileSync(service.file,'utf8'),saved);assert.equal(service.enabled,true);
  await assert.rejects(service.apply({enabled:'false'}),/setting/);
});
