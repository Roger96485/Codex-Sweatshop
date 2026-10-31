import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {codexSubmitShortcut,readCodexSubmitShortcut} from '../src/whip-submit.mjs';

test('Whip follows the desktop Enter behavior and single-line conditional behavior',()=>{
  assert.equal(codexSubmitShortcut(),'enter');
  for(const [behavior,text,expected]of [['enter','Hello','enter'],['cmdAlways','Hello','ctrl-enter'],
    ['cmdIfMultiline','Hello','enter'],['cmdIfMultiline','Two\nlines','ctrl-enter']])
    assert.equal(codexSubmitShortcut({desktop:{composerEnterBehavior:behavior}},text),expected);
  assert.equal(codexSubmitShortcut({legacy:{'electron-persisted-atom-state':{'enter-behavior':'cmdAlways'}}}),'ctrl-enter');
  assert.equal(codexSubmitShortcut({desktop:{composerEnterBehavior:'enter'},legacy:{composerEnterBehavior:'cmdAlways'}}),'enter');
});

test('explicit Codex send bindings override Enter behavior and honor supported aliases',()=>{
  for(const key of ['Ctrl+Enter','Control+Enter','CmdOrCtrl+Enter','CommandOrControl+Enter','Enter+Ctrl'])
    assert.equal(codexSubmitShortcut({desktop:{composerEnterBehavior:'enter'},bindings:[{command:'composer.submit',key}]}),'ctrl-enter');
  assert.equal(codexSubmitShortcut({desktop:{composerEnterBehavior:'cmdAlways'},bindings:[{command:'composer.submit',key:'Enter'}]}),'enter');
  assert.equal(codexSubmitShortcut({bindings:[{command:'composer.submit',key:'Alt+S'},{command:'composer.submit',key:'Ctrl+Enter'}]}),'ctrl-enter');
  assert.equal(codexSubmitShortcut({bindings:[{command:'newTask',key:'Ctrl+N'}]}),'enter');
});

test('disabled, malformed and unsupported send settings stop before keyboard input',()=>{
  for(const bindings of [[{command:'composer.submit',key:null}],[{command:'composer.submit',key:'Alt+Enter'}],
    [{command:'composer.submit',key:'Ctrl+Enter Ctrl+X'}],[{command:'composer.submit',key:5}],{}])
    assert.throws(()=>codexSubmitShortcut({bindings}),/Nothing was sent/);
  assert.throws(()=>codexSubmitShortcut({desktop:{composerEnterBehavior:'unknown'}}),/Nothing was sent/);
});

test('every send rereads Codex configuration and custom bindings without writing either file',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'sweatshop-send-settings-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  let behavior='cmdAlways',reads=0;
  const client={status:{home:directory},async request(method,params){
    assert.equal(method,'config/read');assert.deepEqual(params,{includeLayers:false,cwd:null});reads++;
    return {config:{desktop:{composerEnterBehavior:behavior}}};
  }};
  assert.equal(await readCodexSubmitShortcut(client,'Hello'),'ctrl-enter');
  behavior='enter';assert.equal(await readCodexSubmitShortcut(client,'Hello'),'enter');
  const file=path.join(directory,'keybindings.json'),contents=JSON.stringify([{command:'composer.submit',key:'Ctrl+Enter'}]);fs.writeFileSync(file,contents);
  assert.equal(await readCodexSubmitShortcut(client,'Hello'),'ctrl-enter');assert.equal(fs.readFileSync(file,'utf8'),contents);
  fs.writeFileSync(file,'{invalid');await assert.rejects(readCodexSubmitShortcut(client,'Hello'),/Nothing was sent/);
  assert.equal(fs.readFileSync(file,'utf8'),'{invalid');assert.equal(reads,4);
});
