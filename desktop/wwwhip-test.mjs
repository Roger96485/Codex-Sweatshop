import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {BrowserWindow,ipcMain} from 'electron';

/** The real integrated overlay and countdown; transport only records into a fixture. */
export async function testWhipUi({contents,service,fixture,screenshot}){
  const passed=[],pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const execute=(fn,...args)=>contents.executeJavaScript(`(${fn})(...${JSON.stringify(args)})`);
  const wait=async(test,label)=>{const deadline=Date.now()+6500;while(Date.now()<deadline){if(await test())return;await pause(25);}throw new Error(`Whip check timed out: ${label}`);};
  const click=selector=>execute(selector=>document.querySelector(selector).click(),selector);
  const inspect=()=>execute(()=>({open:document.getElementById('whip-dialog').open,checked:document.getElementById('whip-toggle').getAttribute('aria-checked'),disabled:document.getElementById('whip-toggle').disabled}));
  const record=label=>{passed.push(label);console.log(JSON.stringify({whipStep:label}));};
  const setEntry=(selector,question,message)=>execute((selector,question,message)=>{
    const entry=document.querySelector(selector);
    for(const [field,text]of [['[data-whip-question]',question],['[data-whip-message]',message]]){
      const input=entry.querySelector(field);input.value=text;input.dispatchEvent(new Event('input',{bubbles:true}));
    }
  },selector,question,message);
  BrowserWindow.fromWebContents(contents).showInactive();
  const frame=()=>execute(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));await frame();
  const chrome=await execute(()=>{
    const toggle=document.getElementById('whip-toggle'),cards=document.querySelector('.topbar-cards');
    return {right:toggle.getBoundingClientRect().left>=cards.getBoundingClientRect().right,
      label:toggle.getAttribute('aria-label'),color:getComputedStyle(toggle).color,oldName:document.body.textContent.includes('WWWhip'),
      manualMode:!!document.getElementById('whip-submit-mode')};
  });
  assert.equal(chrome.right,true);assert.equal(chrome.label,'Whip off');assert.equal(chrome.oldName,false);assert.equal(chrome.manualMode,false);
  assert.equal(chrome.color,'rgb(119, 119, 119)');
  record('Whip uses a neutral gray switch at the top right and no manual send-mode control');
  assert.deepEqual(await inspect(),{open:false,checked:'false',disabled:false});assert.equal(fixture.starts,0);
  await click('#whip-toggle');assert.equal((await inspect()).open,true);assert.equal(fixture.starts,0);
  assert.deepEqual(await execute(()=>[...document.querySelectorAll('#whip-dialog .dialog-footer button')].map(button=>button.textContent)),['Settings','Enable']);
  assert.equal(await execute(()=>document.querySelector('#whip-dialog input,#whip-dialog select')!==null),false);
  if(screenshot){await frame();fs.writeFileSync(screenshot.replace('.png','-reminder.png'),(await contents.capturePage()).toPNG());}
  assert.equal((await inspect()).checked,'false');
  await click('#whip-dialog [data-close-dialog]');assert.equal((await inspect()).checked,'false');assert.equal(fixture.starts,0);
  record('opening and cancelling the reminder never starts a helper or enables hotkeys');
  await click('#whip-toggle');
  const externalShortcut=()=>{};fixture.shortcuts.set('Control+Alt+W',externalShortcut);
  await execute(()=>document.getElementById('whip-form').requestSubmit());
  await wait(async()=>await execute(()=>!document.getElementById('whip-error').hidden&&!document.getElementById('whip-enable').disabled),'hotkey conflict reminder');
  assert.equal(service.whip.enabled,false);assert.equal(fixture.shortcuts.get('Control+Alt+W'),externalShortcut);
  assert.equal(fixture.shortcuts.size,1);assert.equal(fs.existsSync(service.whip.file),false);
  assert.match(await execute(()=>document.getElementById('whip-error').textContent),/already in use/);
  fixture.shortcuts.delete('Control+Alt+W');
  record('shortcut conflict keeps Whip off without unregistering the existing owner or persisting On');
  const startsBeforeSettings=fixture.starts;
  await click('#whip-settings');
  assert.equal((await inspect()).open,false);assert.equal(await execute(()=>document.getElementById('whip-settings-dialog').open),true);
  assert.equal(await execute(()=>!!document.querySelector('#whip-settings-dialog .dialog-footer')),false);
  await setEntry('.whip-entry:first-child','Continue <safely> 🙂?','Isolated continuation 🙂');
  await wait(()=>service.whip.configuration.messages[0].message==='Isolated continuation 🙂','immediate settings save');
  assert.equal(service.whip.enabled,false);assert.equal(fixture.starts,startsBeforeSettings);
  assert.equal(JSON.parse(fs.readFileSync(service.whip.file)).enabled,false);
  record('the separate settings dialog saves immediately without enabling Whip or starting input');
  await setEntry('.whip-entry:first-child','Continue <safely> 🙂?','');
  await wait(()=>execute(()=>!document.getElementById('whip-settings-error').hidden),'invalid settings validation');
  assert.equal(service.whip.configuration.messages[0].message,'Isolated continuation 🙂');
  await setEntry('.whip-entry:first-child','Continue <safely> 🙂?','Isolated continuation 🙂');
  await wait(()=>execute(()=>document.getElementById('whip-settings-error').hidden),'valid settings recovery');
  record('invalid prompt drafts keep the last valid configuration intact');
  const originalApply=service.whip.apply.bind(service.whip);let releaseSave,saveStarted=false;
  const saveBarrier=new Promise(resolve=>{releaseSave=resolve;});
  service.whip.apply=async input=>{if(input.configuration&&!saveStarted){saveStarted=true;await saveBarrier;}return originalApply(input);};
  try{
    await setEntry('.whip-entry:first-child','Continue <safely> 🙂?','Earlier edit');
    await wait(()=>saveStarted,'first settings write waiting');
    await setEntry('.whip-entry:first-child','Continue <safely> 🙂?','Latest edit');releaseSave();
    await wait(()=>service.whip.configuration.messages[0].message==='Latest edit','newer settings edit wins');
    assert.equal(await execute(()=>document.querySelector('[data-whip-message]').value),'Latest edit');
  }finally{releaseSave();service.whip.apply=originalApply;}
  await setEntry('.whip-entry:first-child','Continue <safely> 🙂?','Isolated continuation 🙂');
  await wait(()=>service.whip.configuration.messages[0].message==='Isolated continuation 🙂','restore isolated prompt');
  record('edits made during an in-flight save persist in order and survive state refresh');
  await click('#whip-add');await setEntry('.whip-entry:last-child','Last choice?','Last message');
  await wait(()=>service.whip.configuration.messages.at(-1).message==='Last message','added prompt save');
  await click('.whip-entry:last-child [data-whip-action="up"]');
  assert.equal(await execute(()=>document.querySelector('.whip-entry:nth-last-child(2) [data-whip-message]').value),'Last message');
  await click('.whip-entry:nth-last-child(2) [data-whip-action="remove"]');
  // Let the modal reach Chromium's compositor before capturing the visual.
  await pause(200);
  await wait(()=>!service.whip.configuration.messages.some(item=>item.message==='Last message'),'removed prompt save');
  const geometry=await execute(()=>{const dialog=document.getElementById('whip-settings-dialog');return {open:dialog.open,height:dialog.getBoundingClientRect().height,bottom:dialog.getBoundingClientRect().bottom,viewport:innerHeight};});
  assert.equal(geometry.open,true);assert.ok(geometry.height>400&&geometry.bottom<=geometry.viewport);
  if(screenshot){await execute(()=>document.getElementById('whip-settings-form').scrollTop=0);await frame();fs.writeFileSync(screenshot,(await contents.capturePage()).toPNG());}
  await setEntry('.whip-entry:first-child','Continue <safely> 🙂?','Saved on close 🙂');
  await click('#whip-settings-dialog [data-close-dialog]');
  await wait(async()=>(await inspect()).open,'return to reminder');
  assert.equal(service.whip.configuration.messages[0].message,'Saved on close 🙂');
  await click('#whip-settings');await setEntry('.whip-entry:first-child','Continue <safely> 🙂?','Isolated continuation 🙂');
  await click('#whip-settings-dialog [data-close-dialog]');await wait(async()=>(await inspect()).open,'return to enable after settings');
  record('prompt ordering and edits persist on close without Save or Discard buttons');
  let releaseStartup;fixture.startBarrier=new Promise(resolve=>{releaseStartup=resolve;});const starts=fixture.starts;
  await execute(()=>document.getElementById('whip-form').requestSubmit());
  await wait(()=>service.whip.busy,'pending native startup');
  const protectedReminder=await execute(()=>{
    const dialog=document.getElementById('whip-dialog');dialog.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:0,clientY:0}));
    const cancel=new Event('cancel',{cancelable:true});dialog.dispatchEvent(cancel);
    return {open:dialog.open,cancelPrevented:cancel.defaultPrevented,settingsDisabled:document.getElementById('whip-settings').disabled,disabled:document.getElementById('whip-enable').disabled};
  });
  assert.deepEqual(protectedReminder,{open:true,cancelPrevented:true,settingsDisabled:true,disabled:true});
  releaseStartup();fixture.startBarrier=null;
  record('startup keeps the reminder visible and prevents competing edits or accidental backdrop cancellation');
  await wait(()=>service.whip.enabled,'confirm enable');await wait(async()=>(await inspect()).checked==='true'&&!(await inspect()).disabled,'on state');
  assert.equal((await inspect()).open,false);assert.equal(fixture.starts,starts+1);
  assert.deepEqual([...fixture.shortcuts.keys()],['Control+Alt+W','Control+Alt+Escape']);
  assert.equal(service.whip.configuration.messages[0].message,'Isolated continuation 🙂');
  assert.equal(service.whip.configuration.messages[0].question,'Continue <safely> 🙂?');
  assert.equal(JSON.parse(fs.readFileSync(service.whip.file)).enabled,true);
  record('confirmation saves editable ordered prompt pairs and registers the integrated shortcuts');
  const runtime=service.whip.runtime;
  async function activate(){
    fixture.shortcuts.get('Control+Alt+W')();
    await wait(()=>runtime.overlay?.isVisible()&&!runtime.overlay.webContents.isLoading(),'overlay activation');
    // Record-only tests drive explicit gestures; physical mouse motion belongs
    // to the user's desktop and must neither change test selections nor be captured.
    runtime.overlay.setIgnoreMouseEvents(true);
    await runtime.overlay.webContents.executeJavaScript("document.addEventListener('mousemove',event=>event.stopImmediatePropagation(),{capture:true});");
    await wait(()=>runtime.overlay.webContents.executeJavaScript("document.getElementById('question').textContent==='WHIP me to urge me on.'"),'introduction');
    return runtime.overlay;
  }
  let overlay=await activate();
  const gesture=()=>runtime.overlay.webContents.executeJavaScript('window.bridge.whipCrack()');
  await pause(3150);assert.equal(runtime.overlay.isVisible(),false);assert.equal(fixture.sent.length,0);
  record('the three-second introduction times out without sending');
  overlay=await activate();
  const statusBefore=runtime.status.question;
  ipcMain.emit('wwwhip:whip-crack',{sender:contents,senderFrame:contents.mainFrame});await pause(40);
  assert.equal(runtime.status.question,statusBefore);
  record('the main application cannot impersonate overlay gesture IPC');
  await gesture();await pause(80);
  assert.equal(runtime.status.question,'Continue <safely> 🙂?');
  const firstDeadline=runtime.status.deadline;
  await pause(400);await gesture();await pause(60);assert.ok(runtime.status.deadline>=firstDeadline+350);
  assert.equal(runtime.status.question,service.whip.configuration.messages[1].question);
  fixture.shortcuts.get('Escape')();await pause(2150);
  assert.equal(fixture.sent.length,0);assert.equal(runtime.overlay.isVisible(),false);assert.equal(fixture.shortcuts.has('Escape'),false);
  record('gestures cycle in configured order; Escape cancels the countdown and releases its shortcut');
  overlay=await activate();await gesture();
  await pause(60);assert.equal(runtime.status.question,'Continue <safely> 🙂?');
  await wait(()=>fixture.sent.length===1,'one paired message after the automatic strike');
  assert.equal(fixture.sent[0].text,'Isolated continuation 🙂');assert.equal(fixture.sent[0].mode,'ctrl-enter');
  await wait(()=>!runtime.overlay.isVisible(),'overlay closes after sending');await pause(500);assert.equal(fixture.sent.length,1);
  record('the real animation sends exactly one matching configured prompt through the recording transport');
  fixture.submitMode='enter';
  await activate();await gesture();await wait(()=>fixture.sent.length===2,'follow changed Codex Enter mode');
  assert.equal(fixture.sent[1].mode,'enter');assert.equal(fixture.settingsReads,2);
  await wait(()=>!runtime.overlay.isVisible(),'overlay closes after changed submission');
  record('each send follows the latest Codex submit setting instead of the saved legacy manual mode');
  fixture.settingsError='Could not read Codex settings. Nothing was sent.';
  await activate();await gesture();await wait(()=>runtime.status.kind==='error','unreadable Codex settings');
  assert.equal(fixture.sent.length,2);await wait(()=>!runtime.overlay.isVisible(),'error overlay hides');fixture.settingsError=null;
  record('unreadable Codex submit settings prevent all keyboard input and are never retried');
  await activate();await gesture();await pause(80);
  const stops=fixture.stops;await click('#whip-toggle');
  await wait(()=>!service.whip.enabled,'disable');await wait(async()=>(await inspect()).checked==='false'&&!(await inspect()).disabled,'off state');
  await pause(2300);assert.equal(fixture.sent.length,2);assert.equal(fixture.shortcuts.size,0);assert.ok(fixture.stops>stops);assert.equal(runtime.overlay,null);
  assert.equal(BrowserWindow.getAllWindows().filter(window=>window!==BrowserWindow.fromWebContents(contents)).length,0);
  assert.equal(JSON.parse(fs.readFileSync(service.whip.file)).enabled,false);
  record('switching off cancels pending sends, destroys the overlay, stops the helper and unregisters only owned shortcuts');
  await click('#whip-toggle');
  await click('#whip-settings');
  assert.equal(await execute(()=>document.querySelector('[data-whip-message]').value),'Isolated continuation 🙂');
  await click('#whip-settings-dialog [data-close-dialog]');await wait(async()=>(await inspect()).open,'last reminder');
  await click('#whip-dialog [data-close-dialog]');
  record('the next enable reminder retains the saved prompt configuration');
  return {passed,recordedSends:fixture.sent.length,realCodexSends:0};
}
