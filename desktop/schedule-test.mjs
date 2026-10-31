import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { app, Menu } from 'electron';
import { observeQuota,emptyQuotaState } from '../src/quota-windows.mjs';

const MINUTE = 60_000;
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

/** Uses only the isolated Store and an inference-prohibiting client. */
export async function testScheduleUi({ contents, window, service, runtimeCwd, choosePromptFile,whipFixture }) {
  assert.equal(service.store.data.settings.schedulerEnabled, true);
  assert.equal(service.store.data.tasks.length, 0);
  // Supply known identities in this inference-free fixture; production reads
  // config/thread metadata through Codex before assigning a task-derived lock.
  service.runner.inspectTaskModels=async()=>{
    for(const task of service.store.data.tasks)service.runner.taskModelCache.set(task.id,{
      key:service.runner.taskModelKey(task),at:Date.now(),identity:{model:task.model||'gpt-6-luna',modelProvider:'openai'},
    });
  };
  const passed = [];
  const quotaScreenshots=[];
  const outputIndex=process.argv.indexOf('--smoke-output');
  const screenshotPath=outputIndex>=0?path.resolve(process.argv[outputIndex+1]):path.join(process.cwd(),'test-results',app.isPackaged?'schedule-packaged.png':'schedule-source.png');
  const relatedScreenshot=label=>/-(source|packaged)\.png$/i.test(screenshotPath)
    ?screenshotPath.replace(/-(source|packaged)\.png$/i,`-${label}-$1.png`):screenshotPath.replace(/\.png$/i,`-${label}.png`);
  const record = label => { passed.push(label); console.log(JSON.stringify({ scheduleStep:label })); };
  const execute = (fn,...args) => contents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`);
  const wait = async (predicate,label,timeout=8000) => {
    const deadline = Date.now()+timeout;
    while(Date.now()<deadline) { if(await predicate())return;await pause(35); }
    const view = await execute(()=>({dialog:document.querySelector('dialog[open]')?.id,
      errors:[...document.querySelectorAll('.form-error:not([hidden]),.toast.error')].map(item=>item.textContent),
      ghost:document.querySelector('.drag-ghost')?.outerHTML,
      resetPreviews:document.querySelectorAll('.reset-shift-preview').length,
      board:document.getElementById('schedule-board')?.getBoundingClientRect().toJSON(),
      dragging:document.body.className}));
    throw new Error(`${label} 超时：${JSON.stringify(view)}`);
  };
  const waitUi=(fn,label,...args)=>wait(()=>execute(fn,...args),label);
  const click=selector=>execute(selector=>{
    const element=document.querySelector(selector);if(!element)throw new Error(`找不到控件 ${selector}`);element.click();
  },selector);
  const fill=fields=>execute(fields=>{
    for(const[selector,value]of Object.entries(fields)){
      const input=document.querySelector(selector);if(!input)throw new Error(`找不到输入框 ${selector}`);
      input.value=String(value);input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));
    }
  },fields);
  const frame=()=>execute(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const key=async keyCode=>{contents.sendInputEvent({type:'keyDown',keyCode});contents.sendInputEvent({type:'keyUp',keyCode});await pause(50);};
  const api=(route,method,body)=>execute(async(route,method,body)=>{
    const response=await fetch(route,{method,credentials:'same-origin',headers:{'Content-Type':'application/json'},body:['GET','HEAD'].includes(method)||body==null?undefined:JSON.stringify(body)});
    const data=await response.json();if(!response.ok)throw new Error(data.error||`HTTP ${response.status}`);return data;
  },route,method,body);
  const task=id=>structuredClone(service.store.get(id));
  window.show();window.focus();contents.focus();
  const savedQuota=structuredClone(service.store.data.quota);
  try {
    const error='Cannot confirm the current quota window. Activation was not sent.';
    const historical={id:'startup-history-fixture',kind:'fiveHour',status:'failed',error,
      finishedAt:new Date(Date.now()-3600000).toISOString()};
    const pending={id:'startup-pending-fixture',kind:'fiveHour',status:'scheduled',error:null};
    service.store.data.quota.plans.push(historical,pending);service.store.save();
    for(let reload=0;reload<2;reload++) {
      const loaded=new Promise(resolve=>contents.once('did-finish-load',resolve));
      contents.reload();
      await loaded;
      await waitUi(()=>Number(document.getElementById('schedule-surface')?.dataset.start)>0,'Reload and receive the initial state');
      await frame();
      assert.equal(await execute(()=>document.querySelectorAll('.toast.error').length),0);
      assert.equal(service.store.data.quota.plans.find(plan=>plan.id===historical.id).error,error);
    }
    record('startup and page reload preserve historical activation failures without replaying error toasts');
    Object.assign(pending,{status:'failed',error,finishedAt:new Date().toISOString()});
    service.store.save();service.runner.emit('change');
    await waitUi(message=>[...document.querySelectorAll('.toast.error')].some(item=>item.textContent===message),'A newly failed activation remains visible',error);
    service.runner.emit('change');await api('/api/state','GET');await frame();
    assert.equal(await execute(message=>[...document.querySelectorAll('.toast.error')].filter(item=>item.textContent===message).length,error),1);
    record('an activation failing after startup still notifies once, even when its message matches a historical failure');
  }finally {
    service.store.data.quota=savedQuota;service.store.save();service.runner.emit('change');
    await execute(()=>document.querySelectorAll('.toast').forEach(element=>element.remove()));
  }
  const whipTests=await import('./wwwhip-test.mjs').then(module=>module.testWhipUi({contents,service,fixture:whipFixture,screenshot:relatedScreenshot('wwwhip')}));
  passed.push(...whipTests.passed);
  const longThreadTitle='UI check · Escaped <img src=x onerror="window.__threadInjection=true"> & '+ 'Long conversation title '.repeat(12);
  const longProjectName=('Project <&> '+ 'long project name '.repeat(10)).trim();
  const threads=[{id:'ui-fixture-thread',name:'UI check · Existing session',cwd:runtimeCwd,projectName:'UI project <&>',modelProvider:'openai'},
    {id:'ui-fixture-thread-second',name:'UI check · Search target',cwd:runtimeCwd,modelProvider:'openai'},
    {id:'ui-fixture-worktree',name:'UI check · Worktree session',cwd:'C:\\Users\\Fixture\\.codex\\worktrees\\a1b2c3d4\\UI Worktree Project',modelProvider:'openai'},
    {id:'ui-fixture-escaped',name:longThreadTitle,cwd:runtimeCwd,projectName:longProjectName,modelProvider:'openai'},
    {id:'ui-fixture-page-three',name:'UI check · Third page',cwd:runtimeCwd,modelProvider:'openai'}];

  window.show();window.focus();contents.focus();await frame();
  await execute(threads=>{
    const original=window.fetch.bind(window);
    window.__scheduleTest={calls:[],original,threads};
    window.fetch=async(input,init)=>{
      const url=new URL(typeof input==='string'?input:input.url,location.href);
      let body;try{body=typeof init?.body==='string'?JSON.parse(init.body):undefined;}catch{}
      const call={route:url.pathname,search:url.searchParams.get('search')||'',cursor:url.searchParams.get('cursor')||'',method:init?.method||'GET',body,finished:false};
      if(call.route.startsWith('/api/'))window.__scheduleTest.calls.push(call);
      if(call.method==='PUT'&&call.route===`/api/tasks/${window.__scheduleTest.holdTaskId}`){
        await new Promise(resolve=>{window.__scheduleTest.releaseHeldWrite=resolve;});
      }
      let response;
      if(call.route==='/api/threads'&&call.method==='GET'){
        const matches=window.__scheduleTest.threads.filter(thread=>!call.search||thread.name.includes(call.search));
        const offset=Number(call.cursor||0),data=matches.slice(offset,offset+2);
        response=new Response(JSON.stringify({data,nextCursor:offset+data.length<matches.length?String(offset+data.length):null}),{headers:{'Content-Type':'application/json'}});
      }else if(call.method==='PUT'&&body?.reschedule&&call.route===`/api/tasks/${window.__scheduleTest.failRescheduleId}`){
        window.__scheduleTest.failRescheduleId=null;
        response=new Response(JSON.stringify({error:'Isolated reschedule failure'}),{status:400,headers:{'Content-Type':'application/json'}});
      }else response=await original(input,init);
      call.finished=true;
      if(call.route==='/api/state'&&response.ok)void response.clone().json().then(data=>{call.tasks=data.tasks.map(({id,title,scheduledAt})=>({id,title,scheduledAt}));});
      return response;
    };
  },threads);
  service.runner.models=[{id:'ui-fixture-model',model:'ui-fixture-model',displayName:'UI check model',
    supportedReasoningEfforts:[{reasoningEffort:'low',description:'Low'},{reasoningEffort:'high',description:'High'}],serviceTiers:[{id:'priority',name:'Fast'}]}];
  service.runner.emit('change');
  await waitUi(()=>!!document.querySelector('#composer-model option[value="ui-fixture-model"]'),'读取模型夹具');

  const obsoleteIds=['composer-options','composer-priority','composer-schedule-mode','composer-markdown-file','task-dialog','task-form',
    'composer-title','composer-title-field','composer-edit-indicator','composer-schedule-fields','composer-at','composer-window','composer-custom-window','composer-exact-fields','composer-window-fields',
    'timeline-options-dialog','board-date','drop-mode','board-zoom','queue-search','queue-filter','json-import-file','import-dialog',
    'settings-dialog','history-dialog'];
  assert.equal(await execute(ids=>ids.every(id=>!document.getElementById(id))
    && !document.querySelector('[data-action="today"],[data-action="open-timeline-options"],[data-action="import-json"],[data-action="export-json"],[data-action="import-markdown"],[data-action="open-data-directory"],[data-action="open-settings"],[data-action="open-history"],.settings-gear')
    && !document.querySelector('input[type="file"]')
    && !document.getElementById('connection-button').dataset.action,obsoleteIds),true);
  assert.equal(window.isMenuBarVisible(),false);assert.equal(window.getTitle(),'Codex Sweatshop');
  const script=await execute(async()=>await(await fetch('/app.js')).text());
  assert.ok(!/chooseMarkdownFiles|openDataDirectory|\/api\/export|\/api\/import|json-import-file|markdown-import-cwd|composer-markdown-file/.test(script));
  record('legacy batch imports, data-directory actions and timeline controls are removed');

  const zoom=await execute(()=>{
    const range=document.getElementById('timeline-zoom'),panel=document.querySelector('.schedule-panel'),icon=document.querySelector('.timeline-slider-icon svg');
    return{min:range.min,max:range.max,step:range.step,vertical:getComputedStyle(range).writingMode,
      length:range.getBoundingClientRect().height,oldLength:panel.getBoundingClientRect().height-110,
      oldSliderIcon:!!icon?.querySelector('circle'),hasIcon:!!icon};
  });
  assert.deepEqual([zoom.min,zoom.max,zoom.step],['16','48','4']);
  assert.equal(zoom.vertical,'vertical-lr');assert.ok(zoom.hasIcon&&!zoom.oldSliderIcon);
  assert.ok(zoom.length>=zoom.oldLength*.4&&zoom.length<=zoom.oldLength*.6,JSON.stringify(zoom));
  record('timeline zoom retains its range with a half-length vertical track and a line-spacing icon');
  assert.equal(await execute(()=>{
    const cancel=document.getElementById('composer-cancel');
    return getComputedStyle(cancel).visibility==='hidden'&&cancel.disabled&&cancel.getAttribute('aria-hidden')==='true'
      &&cancel.getBoundingClientRect().width>0
      &&!document.querySelector('.composer-panel.is-editing')&&document.getElementById('composer-submit').textContent==='Create task';
  }),true);
  record('creation uses the shared compact options with an inaccessible Cancel placeholder');
  const staticCopy=await execute(()=>{
    const attributes=[...document.querySelectorAll('[placeholder],[aria-label],[title]')].flatMap(element=>['placeholder','aria-label','title'].map(name=>element.getAttribute(name)||''));
    return [document.title,document.body.textContent,...attributes].filter(text=>/\p{Script=Han}/u.test(text));
  });
  assert.deepEqual(staticCopy,[]);
  assert.match(await execute(()=>document.querySelector('.marker-now time')?.textContent||''),/^Today (?:[01]\d|2[0-3]):[0-5]\d$/);
  assert.equal(Menu.getApplicationMenu(),null);await key('Alt');assert.equal(window.isMenuBarVisible(),false);
  await execute(()=>{const input=document.getElementById('composer-prompt');input.value='Menu-free keyboard check';input.focus();});
  contents.sendInputEvent({type:'keyDown',keyCode:'A',modifiers:['control']});contents.sendInputEvent({type:'keyUp',keyCode:'A',modifiers:['control']});await frame();
  assert.equal(await execute(()=>{const input=document.getElementById('composer-prompt');return input.selectionEnd-input.selectionStart===input.value.length;}),true);
  await execute(()=>{document.getElementById('composer-prompt').value='';});
  record('UI copy remains English and the application has no menu bar even after Alt, with text shortcuts intact');

  const threadRequests=()=>execute(()=>window.__scheduleTest.calls.filter(call=>call.route==='/api/threads').length);
  await click('input[name="composerTarget"][value="existing"]');
  const beforeOpen=await threadRequests();
  await click('#composer-thread-toggle');
  await waitUi(()=>!document.getElementById('composer-thread-panel').hidden
    && document.querySelector('#composer-thread-options [data-thread-id="ui-fixture-thread"]'),'打开会话弹层并刷新');
  assert.ok(await threadRequests()>beforeOpen);
  assert.equal(await execute(()=>document.getElementById('composer-thread-toggle').getAttribute('aria-expanded')),'true');
  record('session popover refreshes automatically on opening');
  const threadCompact=await execute(()=>[...document.querySelectorAll('#composer-thread-options .thread-option')].map(option=>({
    height:option.getBoundingClientRect().height,whiteSpace:getComputedStyle(option).whiteSpace,
  })));
  assert.ok(threadCompact.length===2&&threadCompact.every(option=>option.height>=35.5*.6&&option.height<=35.5*.75&&option.whiteSpace==='nowrap'),JSON.stringify(threadCompact));
  record('session choices use single compact rows at about two thirds of their previous height');
  await click('#composer-load-more');
  await waitUi(()=>document.querySelectorAll('#composer-thread-options [data-thread-id]').length===4,'Append the second chat page');
  await click('#composer-load-more');
  await waitUi(()=>document.querySelectorAll('#composer-thread-options [data-thread-id]').length===5&&document.getElementById('composer-load-more').hidden,'Append the final chat page');
  const paginatedThreads=await execute(()=>({ids:[...document.querySelectorAll('#composer-thread-options [data-thread-id]')].map(option=>option.dataset.threadId),
    cursors:window.__scheduleTest.calls.filter(call=>call.route==='/api/threads').map(call=>call.cursor)}));
  assert.deepEqual(paginatedThreads.ids,threads.map(thread=>thread.id));assert.ok(paginatedThreads.cursors.includes('2')&&paginatedThreads.cursors.includes('4'));
  record('session pagination appends distinct choices and hides Load more only after the final page');
  const projects=await execute(()=>[...document.querySelectorAll('#composer-thread-options .thread-option')].map(option=>{
    const title=option.querySelector('.thread-option-title'),project=option.querySelector('.thread-option-project'),text=project?.querySelector('span');
    const titleRect=title?.getBoundingClientRect(),projectRect=project?.getBoundingClientRect();
    return{id:option.dataset.threadId,title:title?.textContent,project:text?.textContent,
      folder:!!project?.querySelector('svg[aria-hidden="true"]'),titleStyle:title?{whiteSpace:getComputedStyle(title).whiteSpace,overflow:getComputedStyle(title).overflow,textOverflow:getComputedStyle(title).textOverflow}:null,
      projectStyle:text?{whiteSpace:getComputedStyle(text).whiteSpace,overflow:getComputedStyle(text).overflow,textOverflow:getComputedStyle(text).textOverflow}:null,
      sameRow:!!titleRect&&!!projectRect&&Math.abs((titleRect.top+titleRect.bottom)/2-(projectRect.top+projectRect.bottom)/2)<=1,
      titleBeforeProject:!!titleRect&&!!projectRect&&titleRect.right<=projectRect.left,
      titleOverflows:!!title&&title.scrollWidth>title.clientWidth,projectOverflows:!!text&&text.scrollWidth>text.clientWidth,
      unsafeMarkup:!!option.querySelector('img,script'),hoverTitle:!!option.querySelector('[title]')||option.hasAttribute('title')};
  }));
  const explicitProject=projects.find(option=>option.id===threads[0].id),cwdProject=projects.find(option=>option.id===threads[1].id),worktreeProject=projects.find(option=>option.id==='ui-fixture-worktree'),escapedProject=projects.find(option=>option.id==='ui-fixture-escaped');
  assert.equal(explicitProject.project,threads[0].projectName);assert.equal(cwdProject.project,path.basename(runtimeCwd));assert.equal(worktreeProject.project,'UI Worktree Project');
  assert.equal(escapedProject.title,longThreadTitle);assert.equal(escapedProject.project,longProjectName);
  assert.ok(projects.every(option=>option.folder&&option.sameRow&&option.titleBeforeProject&&!option.unsafeMarkup&&!option.hoverTitle),JSON.stringify(projects));
  assert.deepEqual(escapedProject.titleStyle,{whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'});
  assert.deepEqual(escapedProject.projectStyle,{whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'});
  assert.ok(escapedProject.titleOverflows&&escapedProject.projectOverflows);assert.equal(await execute(()=>!!window.__threadInjection),false);
  record('session rows show escaped project names or folder fallbacks on the right with safe one-line ellipsis');
  await execute(()=>document.activeElement?.blur());contents.sendInputEvent({type:'mouseMove',x:20,y:20});await frame();
  const threadScreenshot=relatedScreenshot('sessions');await writeFile(threadScreenshot,(await contents.capturePage()).toPNG());
  await fill({'#composer-thread-search':'Search target'});
  await waitUi(()=>window.__scheduleTest.calls.some(call=>call.route==='/api/threads'&&call.search==='Search target')
    && document.querySelectorAll('#composer-thread-options [data-thread-id]').length===1,'弹层内部搜索');
  await click('#composer-thread-options [data-thread-id="ui-fixture-thread-second"]');
  await waitUi(()=>document.getElementById('composer-thread-panel').hidden,'选择后关闭会话弹层');
  assert.equal(await execute(()=>document.getElementById('composer-thread').value),threads[1].id);
  record('session search is internal, debounced and saves selection');
  const beforeReopen=await threadRequests();
  await click('#composer-thread-toggle');
  await wait(()=>threadRequests().then(count=>count>beforeReopen),'再次打开刷新会话');
  await click('#composer-thread-options [data-thread-id="ui-fixture-thread-second"]');
  record('reopening a populated session selector reads fresh sessions');

  const create=async(title,{existing=false,custom=false,linked=false}={})=>{
    await click(`input[name="composerTarget"][value="${existing?'existing':'new'}"]`);
    if(existing){
      if(await execute(()=>document.getElementById('composer-thread').value!== 'ui-fixture-thread-second')){
        await click('#composer-thread-toggle');
        await waitUi(()=>!!document.querySelector('#composer-thread-options [data-thread-id="ui-fixture-thread-second"]'),'会话候选');
        await click('#composer-thread-options [data-thread-id="ui-fixture-thread-second"]');
      }
    }else await fill({'#composer-cwd':runtimeCwd});
    await click(`input[name="composerConfig"][value="${custom?'custom':'inherit'}"]`);
    if(custom)await fill({'#composer-model':'ui-fixture-model','#composer-effort':'high','#composer-speed':'priority'});
    else assert.equal(await execute(()=>['composer-model','composer-effort','composer-speed'].every(id=>document.getElementById(id).disabled)),true);
    if(!linked)await fill({'#composer-prompt':`# ${title}\nThis isolated UI test does not connect to Codex or start inference.`});
    await execute(()=>document.getElementById('composer-form').requestSubmit());
    await wait(()=>service.store.data.tasks.some(item=>item.title===title),'常驻表单创建手动任务');
    const id=service.store.data.tasks.find(item=>item.title===title).id;
    await waitUi(id=>!!document.getElementById(`queue-task-${id}`),'创建后显示任务',id);
    return id;
  };
  const first=await create('UI check · Organize documentation');
  assert.equal(task(first).schedule.mode,'manual');assert.equal(task(first).priority,50);assert.equal(task(first).scheduledAt,null);
  assert.equal(await execute(id=>document.getElementById(`queue-task-${id}`).classList.contains('tint-gray')
    && !document.getElementById(`schedule-task-${id}`),first),true);
  await service.runner.tick();assert.equal(service.runner.active,null);assert.equal(task(first).status,'queued');
  record('new tasks are gray unscheduled manual tasks despite enabled scheduler');
  const second=await create('UI check · Complete examples',{existing:true});
  assert.equal(task(second).threadId,threads[1].id);assert.equal(task(second).modelMode,'inherit');
  assert.equal(task(second).model,'');assert.equal(task(second).effort,'');assert.equal(task(second).speed,'default');
  record('existing sessions preserve inherited model, reasoning and speed');
  const custom=await create('UI check · Custom configuration',{custom:true});
  assert.equal(task(custom).modelMode,'custom');assert.equal(task(custom).model,'ui-fixture-model');assert.equal(task(custom).effort,'high');assert.equal(task(custom).speed,'priority');
  record('custom model configuration stays available without connecting');
  const expiredAt=new Date(Date.now()-2*60*MINUTE).toISOString();
  const expired=service.store.create({title:'UI check · Expired task',prompt:'Isolated expired fixture; no inference.',target:'new',cwd:runtimeCwd,modelMode:'inherit',schedule:{mode:'exact',at:expiredAt}});
  Object.assign(expired,{status:'missed',scheduledAt:expiredAt});service.store.save();service.runner.emit('change');
  await waitUi(id=>document.getElementById(`queue-task-${id}`)?.classList.contains('tint-gray')
    &&document.getElementById(`queue-task-${id}`)?.dataset.draggable==='true','过期任务可以重新安排',expired.id);
  await click(`[data-action="toggle-task"][data-task-id="${expired.id}"]`);
  await click(`[data-action="auto-task"][data-task-id="${expired.id}"]`);
  await wait(()=>task(expired.id).schedule.mode==='auto'&&task(expired.id).status==='scheduled','过期任务重新进入自动编排');
  await api(`/api/tasks/${expired.id}`,'DELETE',{});
  record('expired missed tasks are gray and can reenter automatic scheduling');

  const fixtureFile=path.join(runtimeCwd,'UI check · File prompt.md');
  const initialText='# UI check · File prompt\nFirst file version.';
  await writeFile(fixtureFile,initialText,'utf8');choosePromptFile(fixtureFile);
  await click('[data-action="link-prompt-file"][data-prefix="composer"]');
  await waitUi(file=>document.getElementById('composer-prompt-file').value===file&&document.getElementById('composer-file-name').textContent.includes('File prompt.md'),'原生单文件关联',fixtureFile);
  await waitUi(text=>document.getElementById('composer-prompt').value===text,'关联文件完成读取',initialText);
  record('native prompt picker associates one absolute Markdown path');
  const composerText='# UI check · File prompt\nThe file keeps updating before task creation.';
  await writeFile(fixtureFile,composerText,'utf8');
  await waitUi(text=>document.getElementById('composer-prompt').value===text,'常驻表单持续刷新关联文件',composerText);
  record('visible linked composer polls the current Markdown content');
  const linked=await create('UI check · File prompt',{linked:true});
  assert.equal(task(linked).promptFile,fixtureFile);assert.equal(task(linked).schedule.mode,'manual');
  const linkedWrite=await execute(id=>window.__scheduleTest.calls.find(call=>call.route==='/api/tasks'&&call.method==='POST'&&call.body.promptFile===id)?.body,fixtureFile);
  assert.equal(linkedWrite.prompt,'');assert.equal(linkedWrite.promptFile,fixtureFile);
  record('linked tasks persist a source path rather than a copied prompt submission');

  const toggle=id=>click(`[data-action="toggle-task"][data-task-id="${id}"]`);
  const expand=async id=>{
    if(await execute(id=>document.getElementById(`queue-task-${id}`).getAttribute('aria-expanded')!=='true',id))await toggle(id);
    await waitUi(id=>document.getElementById(`queue-task-${id}`).getAttribute('aria-expanded')==='true','展开单项任务',id);
  };
  const cardStyle=id=>execute(id=>{
    const card=document.getElementById(`queue-task-${id}`),style=getComputedStyle(card),title=getComputedStyle(card.querySelector('h3'));
    return{background:style.backgroundColor,borderColor:style.borderTopColor,borderWidth:style.borderTopWidth,borderStyle:style.borderTopStyle,
      radius:style.borderRadius,shadow:style.boxShadow,fontWeight:title.fontWeight};
  },id);
  contents.sendInputEvent({type:'mouseMove',x:20,y:20});await frame();
  const collapsedStyle=await cardStyle(first);await expand(first);await frame();
  assert.deepEqual(await cardStyle(first),collapsedStyle);await toggle(first);
  record('collapsing or expanding a task preserves its background border corners and title weight');
  await expand(first);await expand(second);
  assert.equal(await execute(id=>document.getElementById(`queue-task-${id}`).getAttribute('aria-expanded'),first),'false');
  await toggle(second);
  record('task rows stay collapsed by default with a single expanded detail');

  const openEditor=async id=>{
    await expand(id);await click(`[data-action="edit-task"][data-task-id="${id}"]`);
    await waitUi(id=>!!document.querySelector('.composer-panel.is-editing')
      &&document.getElementById(`queue-task-${id}`).classList.contains('is-editing')
      &&document.getElementById('composer-heading').textContent==='Edit task','Load task into the shared composer',id);
  };
  const waitCreate=async()=>{if(await execute(()=>document.getElementById('confirm-dialog').open))await click('#confirm-submit');return waitUi(()=>!document.querySelector('.composer-panel.is-editing')
    &&document.getElementById('composer-submit').textContent==='Create task','Restore the creation composer');};
  await openEditor(first);await click('.app-title');await waitCreate();
  await openEditor(first);await fill({'#composer-prompt':'Unsaved background-dismiss check'});
  await click('[data-action="open-auto-settings"]');assert.equal(await execute(()=>!!document.querySelector('.composer-panel.is-editing')),true);await key('Escape');
  await click('.app-title');await waitUi(()=>document.getElementById('confirm-dialog').open,'Background edit cancellation requests confirmation');
  await click('#confirm-dialog [data-close-dialog]');
  assert.equal(await execute(()=>document.getElementById('composer-prompt').value),'Unsaved background-dismiss check');
  await click('.app-title');await click('#confirm-submit');await waitCreate();
  record('outside noninteractive clicks cancel pristine editing and confirm dirty drafts; interactive actions preserve editing');
  const authoredTitle=task(first).title,authoredPrompt=task(first).prompt;
  const preservedTitle='User content · 用户标题',preservedPrompt='# 原样保留\nUser-authored text stays unchanged.';
  await api(`/api/tasks/${first}`,'PUT',{title:preservedTitle,prompt:preservedPrompt});
  await waitUi((id,title)=>document.querySelector(`#queue-task-${id} h3`)?.textContent===title,'User title remains unchanged',first,preservedTitle);
  await openEditor(first);
  assert.equal(await execute(()=>document.getElementById('composer-prompt').value),preservedPrompt);
  await execute(()=>document.getElementById('composer-form').requestSubmit());await waitCreate();
  assert.equal(task(first).title,preservedTitle);assert.equal(task(first).prompt,preservedPrompt);
  await api(`/api/tasks/${first}`,'PUT',{title:authoredTitle,prompt:authoredPrompt});
  await waitUi((id,title)=>document.querySelector(`#queue-task-${id} h3`)?.textContent===title,'Restore English screenshot fixture',first,authoredTitle);
  record('English UI leaves existing user-authored Unicode titles and prompts unchanged');
  const changedText='# UI check · File prompt\nThe file has updated to its second version.';
  await writeFile(fixtureFile,changedText,'utf8');
  await api('/api/state','GET');
  await wait(()=>task(linked).prompt===changedText,'同步最新文件内容');
  await openEditor(linked);
  await waitUi(text=>document.getElementById('composer-prompt').value===text,'文件新内容的编辑预览',changedText);
  assert.equal(await execute(()=>document.getElementById('composer-prompt-file').value),fixtureFile);
  await key('Escape');await waitCreate();
  record('changing linked Markdown refreshes saved preview without replacing its path');

  await expand(first);assert.equal(await execute((id,text)=>document.getElementById(`queue-body-${id}`).textContent.includes(text),first,authoredPrompt),false);
  await expand(linked);
  assert.equal(await execute((id,name,text)=>{
    const body=document.getElementById(`queue-body-${id}`);
    return body.textContent.includes(name)&&!body.textContent.includes(text);
  },linked,path.basename(fixtureFile),changedText),true);
  await writeFile(fixtureFile,'','utf8');await api('/api/state','GET');
  await waitUi(id=>[...document.querySelectorAll(`#queue-body-${id} .linked-file-error`)].some(element=>!element.hidden&&element.textContent),'Keep linked-file errors visible without expanding the prompt',linked);
  assert.equal(await execute((id,name)=>document.getElementById(`queue-body-${id}`).textContent.includes(name),linked,path.basename(fixtureFile)),true);
  await writeFile(fixtureFile,changedText,'utf8');await api('/api/state','GET');
  await waitUi(id=>[...document.querySelectorAll(`#queue-body-${id} .linked-file-error`)].every(element=>element.hidden),'Clear the isolated linked-file error',linked);
  record('expanded task rows show linked filenames and errors without displaying full prompts');

  const composerDraft=()=>execute(()=>({
    target:document.querySelector('input[name="composerTarget"]:checked').value,
    config:document.querySelector('input[name="composerConfig"]:checked').value,
    values:Object.fromEntries(['cwd','thread','model','effort','speed','prompt','prompt-file'].map(name=>[name,document.getElementById(`composer-${name}`).value])),
  }));
  await click('input[name="composerTarget"][value="existing"]');
  if(await execute(()=>document.getElementById('composer-thread').value!=='ui-fixture-thread-second')){
    await click('#composer-thread-toggle');await waitUi(()=>!!document.querySelector('#composer-thread-options [data-thread-id="ui-fixture-thread-second"]'),'Choose a draft conversation');
    await click('#composer-thread-options [data-thread-id="ui-fixture-thread-second"]');
  }
  await click('input[name="composerConfig"][value="custom"]');
  await fill({'#composer-cwd':runtimeCwd,'#composer-model':'ui-fixture-model','#composer-effort':'low','#composer-speed':'priority'});
  choosePromptFile(fixtureFile);await click('[data-action="link-prompt-file"][data-prefix="composer"]');
  await waitUi(text=>document.getElementById('composer-prompt').value===text&&document.getElementById('composer-prompt-file').value!== '','Load a linked creation draft',changedText);
  const linkedCreationDraft=await composerDraft(),firstBeforeEdit=task(first),tasksBeforeEdit=service.store.data.tasks.length;
  await openEditor(first);
  assert.equal(await execute(id=>document.querySelectorAll('#composer-form').length===1
    &&getComputedStyle(document.getElementById('composer-cancel')).visibility==='visible'&&!document.getElementById('composer-cancel').disabled
    &&document.querySelector(`#queue-task-${id} .badge.blue.editing[role="status"]`)?.textContent.trim()==='Editing'
    &&!!document.querySelector(`#queue-task-${id} .badge.editing .badge-dot[aria-hidden="true"]`)
    &&document.getElementById('composer-submit').textContent==='Save changes'&&!document.querySelector('dialog[open]'),first),true);
  record('task editing reuses the highlighted composer and task row without opening a second form');
  await fill({'#composer-prompt':'# Unsaved edit\nKeep this text through refresh.'});
  await click('input[name="composerConfig"][value="custom"]');
  await fill({'#composer-model':'ui-fixture-model','#composer-effort':'high','#composer-speed':'priority'});
  const editingDraft=await composerDraft(),editingCalls=await execute(()=>window.__scheduleTest.calls.length);
  service.runner.emit('change');
  await waitUi(count=>window.__scheduleTest.calls.slice(count).some(call=>call.route==='/api/state'&&call.finished),'Receive SSE during composer editing',editingCalls);await frame();
  assert.deepEqual(await composerDraft(),editingDraft);
  assert.equal(service.store.data.tasks.length,tasksBeforeEdit);assert.deepEqual(task(first),firstBeforeEdit);
  record('SSE preserves unsaved composer fields and never creates or updates a task');
  await click('#composer-cancel');await waitCreate();
  await waitUi(text=>document.getElementById('composer-prompt').value===text,'Restore the linked creation draft preview',linkedCreationDraft.values.prompt);
  assert.deepEqual(await composerDraft(),linkedCreationDraft);assert.deepEqual(task(first),firstBeforeEdit);
  record('Cancel edit restores the creation draft including conversation model and Markdown link');
  await click('[data-action="unlink-prompt-file"][data-prefix="composer"]');
  await fill({'#composer-prompt':'# New-task draft\nRestore this text after Escape.'});
  const textCreationDraft=await composerDraft(),secondBeforeEdit=task(second);
  await openEditor(second);await fill({'#composer-prompt':'An unsaved change to an existing task.'});await key('Escape');await waitCreate();
  assert.deepEqual(await composerDraft(),textCreationDraft);assert.deepEqual(task(second),secondBeforeEdit);
  record('Escape leaves the task unchanged and restores an unsubmitted text draft');
  await click('input[name="composerTarget"][value="new"]');await click('input[name="composerConfig"][value="inherit"]');
  await fill({'#composer-cwd':'','#composer-prompt':''});

  const formGeometry=()=>execute(()=>{
    const panel=document.querySelector('.composer-panel'),body=document.getElementById('composer-body'),bounds=panel.getBoundingClientRect();
    const rect=element=>{const box=element.getBoundingClientRect();return{x:box.left-bounds.left,y:box.top-bounds.top,width:box.width,height:box.height};};
    const controls=[...body.querySelectorAll('input:not([type="hidden"]),select,textarea,button')].filter(element=>{
      const box=element.getBoundingClientRect();return box.width>0&&box.height>0;
    }).map(element=>({key:element.id||(element.name?`${element.name}:${element.value}`:element.dataset.action||element.tagName),...rect(element)}));
    return{maxHeight:getComputedStyle(panel).maxHeight,panel:rect(panel),body:rect(body),controls,
      order:[...body.children].filter(element=>element.getBoundingClientRect().height>0).map(element=>element.id||element.className)};
  });
  for(const id of[first,second,custom]){
    const fixture=task(id);
    await click(`input[name="composerTarget"][value="${fixture.target}"]`);
    if(fixture.target==='new')await fill({'#composer-cwd':fixture.cwd});
    else{
      await click('#composer-thread-toggle');await waitUi(thread=>!!document.querySelector(`[data-thread-id="${thread}"]`),'Match the creation conversation',fixture.threadId);
      await click(`#composer-thread-options [data-thread-id="${fixture.threadId}"]`);
    }
    await click(`input[name="composerConfig"][value="${fixture.modelMode}"]`);
    if(fixture.modelMode==='custom')await fill({'#composer-model':fixture.model,'#composer-effort':fixture.effort,'#composer-speed':fixture.speed});
    await fill({'#composer-prompt':fixture.prompt});await frame();
    const creationGeometry=await formGeometry();await openEditor(id);await frame();const editGeometry=await formGeometry();
    assert.equal(editGeometry.maxHeight,creationGeometry.maxHeight);assert.deepEqual(editGeometry.order,creationGeometry.order);
    assert.deepEqual(editGeometry.controls.map(control=>control.key),creationGeometry.controls.map(control=>control.key));
    for(const group of['panel','body'])for(const metric of['x','y','width','height'])assert.ok(Math.abs(editGeometry[group][metric]-creationGeometry[group][metric])<=1,`${id} ${group}.${metric}: ${JSON.stringify({creationGeometry,editGeometry})}`);
    for(let index=0;index<creationGeometry.controls.length;index++)for(const metric of['x','y','width','height'])assert.ok(Math.abs(editGeometry.controls[index][metric]-creationGeometry.controls[index][metric])<=1,`${id} ${creationGeometry.controls[index].key}.${metric}: ${JSON.stringify({creationGeometry,editGeometry})}`);
    if(fixture.target==='existing'){
      assert.equal(await execute(()=>document.getElementById('composer-new-fields').hidden&&!document.getElementById('composer-existing-fields').hidden),true);
      await execute(()=>document.getElementById('composer-form').requestSubmit());await waitCreate();assert.equal(task(id).cwd,fixture.cwd);
    }else{await click('#composer-cancel');await waitCreate();}
  }
  record('creation and editing share identical body geometry for new existing and custom-model tasks');
  await openEditor(second);await click('input[name="composerTarget"][value="new"]');
  assert.equal(await execute(()=>!document.getElementById('composer-new-fields').hidden&&document.getElementById('composer-cwd').required&&document.getElementById('composer-existing-fields').hidden),true);
  await click('#composer-cancel');await waitCreate();
  await openEditor(first);await click('input[name="composerTarget"][value="existing"]');
  const writesBeforeTargetValidation=await execute(()=>window.__scheduleTest.calls.filter(call=>call.method==='PUT').length);
  await execute(()=>document.getElementById('composer-form').requestSubmit());
  await waitUi(()=>!document.getElementById('composer-error').hidden,'Require a chat before saving an existing target');
  assert.equal(await execute(()=>window.__scheduleTest.calls.filter(call=>call.method==='PUT').length),writesBeforeTargetValidation);
  await click('#composer-cancel');await waitCreate();
  record('target changes reveal the shared required folder or chat selector without persisting incomplete edits');
  await click('input[name="composerTarget"][value="new"]');await click('input[name="composerConfig"][value="inherit"]');await fill({'#composer-cwd':'','#composer-prompt':''});

  const axis=()=>execute(()=>{
    const surface=document.getElementById('schedule-surface'),board=document.getElementById('schedule-board');
    const rect=surface.getBoundingClientRect(),bounds=board.getBoundingClientRect();
    return{segments:JSON.parse(surface.dataset.timelineSegments),top:rect.top,left:bounds.left,right:bounds.right};
  });
  const timeToY=(time,segments)=>{
    const part=segments.find(item=>item.start<=time&&time<=item.end);assert.ok(part,'目标必须在可观测时间轴内');
    return part.yStart+(time-part.start)/(part.end-part.start)*(part.yEnd-part.yStart);
  };
  const scrollToTime=async time=>{
    const geometry=await axis();await execute(y=>{const board=document.getElementById('schedule-board');board.scrollTop=y-board.clientHeight/2;},timeToY(time,geometry.segments));await frame();
  };
  const atTime=async time=>{const geometry=await axis();return{x:Math.round(geometry.left+(geometry.right-geometry.left)*.75),y:Math.round(geometry.top+timeToY(time,geometry.segments))};};
  const point=selector=>execute(selector=>{
    const element=document.querySelector(selector);if(!element)throw new Error(`找不到卡片 ${selector}`);
    if(element.classList.contains('queue-task'))element.scrollIntoView({block:'nearest'});
    const rect=element.getBoundingClientRect(),y=Math.round(rect.top+Math.min(9,rect.height/3));
    return{x:Math.round(rect.left+Math.min(70,rect.width/3)),y,top:rect.top,bottom:rect.bottom,offsetPixels:y-rect.top};
  },selector);
  let dragAlt=false;
  const mouse=(type,point,down=false)=>contents.sendInputEvent({type,x:Math.round(point.x),y:Math.round(point.y),button:'left',clickCount:1,modifiers:[...(down?['leftbuttondown']:[]),...(dragAlt?['alt']:[])]});
  const beginDrag=async(from,to,altKey=true)=>{
    dragAlt=altKey;
    mouse('mouseMove',from);mouse('mouseDown',from);await pause(35);mouse('mouseMove',{x:from.x+8,y:from.y},true);mouse('mouseMove',to,true);
    await waitUi(()=>document.body.classList.contains('is-dragging'),'原生指针开始拖动');
  };
  const dragVisuals=()=>execute(()=>{
    const visual=element=>{
      if(!element)return null;
      const style=getComputedStyle(element),stripe=getComputedStyle(element,'::before');
      return{hidden:element.hidden,height:element.getBoundingClientRect().height,
        corners:[style.borderTopLeftRadius,style.borderTopRightRadius,style.borderBottomLeftRadius,style.borderBottomRightRadius],
        stripeTop:stripe.top,stripeHeight:stripe.height,stripeRadius:stripe.borderRadius,stripeColor:stripe.backgroundColor,
        background:style.backgroundColor,tints:[...element.classList].filter(name=>name.startsWith('tint-'))};
    };
    return{ghost:visual(document.querySelector('.drag-ghost')),preview:visual(document.getElementById('drop-preview')),
      blue:visual(document.querySelector('.schedule-task.tint-blue'))};
  });
  const release=async to=>{mouse('mouseUp',to);dragAlt=false;await waitUi(()=>!document.body.classList.contains('is-dragging'),'结束原生拖动');await pause(380);};
  const boardMove=async(id,time)=>{
    await scrollToTime(Date.parse(task(id).scheduledAt));const from=await point(`#schedule-task-${id}`),to=await atTime(time);
    return{from,to:{...to,y:to.y+from.offsetPixels}};
  };
  const initialAxis=await axis();assert.ok(initialAxis.segments.every(part=>part.start<part.end&&part.yStart<part.yEnd));
  record('rolling compact timeline exposes monotonic segmented coordinates');
  const sharedStart=Math.ceil((Date.now()+2*60*MINUTE)/(15*MINUTE))*15*MINUTE;
  await openEditor(first);await scrollToTime(sharedStart);
  const taskBeforeBlockedDrag=task(first),blockedPuts=await execute(()=>window.__scheduleTest.calls.filter(call=>call.method==='PUT').length);
  let from=await point(`#queue-task-${first}`),to=await atTime(sharedStart);
  mouse('mouseMove',from);mouse('mouseDown',from);mouse('mouseMove',{x:from.x+8,y:from.y},true);mouse('mouseMove',to,true);await pause(150);mouse('mouseUp',to);
  assert.equal(await execute(()=>document.body.classList.contains('is-dragging')),false);
  assert.equal(await execute(()=>window.__scheduleTest.calls.filter(call=>call.method==='PUT').length),blockedPuts);assert.deepEqual(task(first),taskBeforeBlockedDrag);
  await click('#composer-cancel');await waitCreate();
  record('an editing task cannot send a concurrent drag update and Cancel restores its drag affordance');
  await openEditor(first);await execute(id=>{window.__scheduleTest.holdTaskId=id;},first);
  await execute(()=>document.getElementById('composer-form').requestSubmit());
  await waitUi(()=>typeof window.__scheduleTest.releaseHeldWrite==='function'&&document.getElementById('composer-submit').disabled,'Hold one isolated save request in flight');
  const savePuts=await execute(()=>window.__scheduleTest.calls.filter(call=>call.method==='PUT').length),otherBeforeSave=task(second);
  try{
    from=await point(`#queue-task-${second}`);to=await atTime(sharedStart);
    mouse('mouseMove',from);mouse('mouseDown',from);mouse('mouseMove',{x:from.x+8,y:from.y},true);mouse('mouseMove',to,true);await pause(150);mouse('mouseUp',to);
    assert.equal(await execute(()=>document.body.classList.contains('is-dragging')),false);
    assert.equal(await execute(()=>window.__scheduleTest.calls.filter(call=>call.method==='PUT').length),savePuts);assert.deepEqual(task(second),otherBeforeSave);
  }finally{await execute(()=>{window.__scheduleTest.holdTaskId=null;window.__scheduleTest.releaseHeldWrite();delete window.__scheduleTest.releaseHeldWrite;});}
  await waitCreate();
  record('an in-flight composer save blocks new task drags and prevents competing schedule writes');
  await scrollToTime(sharedStart+2*MINUTE);
  from=await point(`#queue-task-${first}`);to=await atTime(sharedStart+2*MINUTE);
  await beginDrag(from,to);
  // The first native move starts dragging; the final move reaches the timeline.
  // Wait for that second event before inspecting the rendered drop affordance.
  await waitUi(()=>!document.getElementById('drop-preview').hidden
    &&document.querySelector('.drag-ghost')?.classList.contains('tint-yellow'),
    'Native drag reaches the timeline preview');
  const exactDragVisuals=await dragVisuals();
  for(const visual of[exactDragVisuals.ghost,exactDragVisuals.preview]){
    assert.ok(visual&&!visual.hidden&&Math.abs(visual.height-42)<.1,JSON.stringify(exactDragVisuals));
    assert.deepEqual(visual.corners,['0px','0px','10px','10px']);
    assert.deepEqual([visual.stripeTop,visual.stripeHeight,visual.stripeRadius],['0px','2px','0px']);
    assert.deepEqual(visual.tints,['tint-yellow']);
  }
  assert.equal(await execute(()=>document.querySelector('.drag-ghost').children.length===1
    &&document.getElementById('drop-preview').children.length===1&&!document.getElementById('drop-preview-time')
    &&!!document.querySelector('.drag-time-highlight time')&&getComputedStyle(document.querySelector('.drag-time-highlight time')).fontWeight==='500'),true);
  contents.sendInputEvent({type:'keyUp',keyCode:'Alt'});await frame();
  assert.equal(await execute(()=>!!document.querySelector('.drag-time-highlight')),false);
  contents.sendInputEvent({type:'keyDown',keyCode:'Alt'});await frame();
  assert.equal(await execute(()=>!!document.querySelector('.drag-time-highlight')),true);
  record('task drag previews omit time details and Alt adds a highlighted timeline tick that tracks modifier changes');
  assert.equal(exactDragVisuals.ghost.stripeColor,exactDragVisuals.preview.stripeColor);
  assert.equal(exactDragVisuals.ghost.background,exactDragVisuals.preview.background);
  const nativeDragSelection=await execute(id=>({userSelect:getComputedStyle(document.getElementById(`queue-task-${id}`)).userSelect,
    selectedText:window.getSelection()?.toString()||''}),first);
  assert.deepEqual(nativeDragSelection,{userSelect:'none',selectedText:''});
  await execute(()=>document.querySelectorAll('.toast').forEach(toast=>toast.remove()));
  const dragScreenshot=relatedScreenshot('drag');await writeFile(dragScreenshot,(await contents.capturePage()).toPNG());
  await release(to);
  assert.equal(await execute(()=>!!document.querySelector('.drag-time-highlight')),false);
  await wait(()=>task(first).schedule.mode==='exact'&&Date.parse(task(first).schedule.at)===sharedStart,'手动任务拖到时间轴保存');
  record('Alt-dragging a gray manual task onto timeline saves a freely placed quarter-hour start');
  record('native time dragging avoids text selection and gives preview and ghost matching fixed-height card geometry and yellow tints');
  await scrollToTime(sharedStart);
  from=await point(`#queue-task-${second}`);to=await atTime(sharedStart);
  await beginDrag(from,to);await release(to);
  await wait(()=>Date.parse(task(second).schedule.at)===sharedStart,'同时间拖放第二个任务');
  await waitUi((a,b)=>document.getElementById(`schedule-task-${a}`)?.dataset.columns==='2'
    && document.getElementById(`schedule-task-${b}`)?.dataset.columns==='2','同启动时间并排',first,second);
  assert.equal(await execute(()=>!document.querySelector('.duration-handle,[data-planned-minutes],#task-planned-minutes')),true);
  record('same-start cards remain horizontal and have no duration or end time');
  assert.equal(await execute(id=>document.getElementById(`schedule-task-${id}`).classList.contains('tint-yellow'),first),true);
  const futureWindow=service.snapshot().windows.find(entry=>Date.parse(entry.start)>Date.now()+4*60*MINUTE&&Date.parse(entry.start)<Date.now()+20*60*MINUTE);
  assert.ok(futureWindow);await api(`/api/tasks/${custom}`,'PUT',{schedule:{mode:'window',windowStart:futureWindow.start}});
  await wait(()=>task(custom).schedule.mode==='window'&&task(custom).schedule.windowStart===futureWindow.start,'保存五小时窗口安排');
  await waitUi(id=>document.getElementById(`queue-task-${id}`)?.classList.contains('tint-aqua')
    &&document.getElementById(`schedule-task-${id}`)?.classList.contains('tint-aqua'),'窗口任务浅青色',custom);
  record('existing window schedules retain their cyan task tint in the compact UI');
  const preciseStart=new Date(Date.parse(futureWindow.start)+123).toISOString().replace(/\.(\d{3})Z$/,(_,digits)=>`.${digits}456Z`);
  const createWritesBeforeEdit=await execute(()=>window.__scheduleTest.calls.filter(call=>call.route==='/api/tasks'&&call.method==='POST').length);
  for(const schedule of[{mode:'exact',at:preciseStart},{mode:'window',windowStart:preciseStart}]){
    await api(`/api/tasks/${custom}`,'PUT',{schedule});
    await waitUi((id,mode,start)=>document.getElementById(`queue-task-${id}`).classList.contains(mode==='exact'?'tint-yellow':'tint-aqua')
      &&Number(document.getElementById(`schedule-task-${id}`)?.dataset.start)===Date.parse(start),'Receive the precise schedule before opening its editor',custom,schedule.mode,preciseStart);
    const persistedSchedule=task(custom).schedule,persistedTitle=task(custom).title;
    await openEditor(custom);
    await execute(()=>document.getElementById('composer-form').requestSubmit());await waitCreate();
    assert.deepEqual(task(custom).schedule,persistedSchedule);
    const editWrite=await execute(id=>window.__scheduleTest.calls.filter(call=>call.route===`/api/tasks/${id}`&&call.method==='PUT').at(-1)?.body,custom);
    assert.equal(editWrite.schedule,undefined);assert.ok(editWrite.title===undefined||editWrite.title===persistedTitle);
    assert.deepEqual([task(custom).modelMode,task(custom).model,task(custom).effort,task(custom).speed],['custom','ui-fixture-model','high','priority']);
  }
  assert.equal(await execute(()=>window.__scheduleTest.calls.filter(call=>call.route==='/api/tasks'&&call.method==='POST').length),createWritesBeforeEdit);
  await api(`/api/tasks/${custom}`,'PUT',{schedule:{mode:'window',windowStart:futureWindow.start}});
  record('saving existing tasks preserves precise exact and window times and custom model choices without creating duplicates');

  const createAuto=async title=>{
    const id=await create(title);await expand(id);await click(`[data-action="auto-task"][data-task-id="${id}"]`);
    await wait(()=>task(id).schedule.mode==='auto','切换为自动编排');
    await waitUi(id=>document.getElementById(`queue-task-${id}`)?.dataset.priorityDraggable==='true','自动任务拖动优先级',id);
    return id;
  };
  const autoFirst=await createAuto('UI check · Automatic documentation');
  const autoSecond=await createAuto('UI check · Automatic checks');
  assert.equal(await execute((autoIds,manualId)=>{
    const rows=[...document.querySelectorAll('#task-list .queue-task')],indexes=autoIds.map(id=>rows.findIndex(row=>row.dataset.taskId===id));
    return autoIds.every(id=>document.getElementById(`queue-task-${id}`).classList.contains('tint-blue'))
      && Math.min(...indexes)>rows.findIndex(row=>row.dataset.taskId===manualId);
  },[autoFirst,autoSecond],linked),true);
  record('automatic tasks are blue and grouped below manually arranged tasks');
  // Priority drag stays inside the right-hand list; scheduled-time drag remains independent.
  from=await point(`#queue-task-${autoSecond}`);const above=await point(`#queue-task-${autoFirst}`);
  to={x:above.x,y:above.top+2};
  await beginDrag(from,to);
  const priorityDragVisuals=await dragVisuals();
  assert.deepEqual(priorityDragVisuals.ghost.tints,['tint-blue']);assert.ok(priorityDragVisuals.preview.hidden);
  assert.deepEqual(priorityDragVisuals.ghost.corners,['0px','0px','10px','10px']);
  assert.ok(Math.abs(priorityDragVisuals.ghost.height-42)<.1);
  assert.equal(priorityDragVisuals.ghost.stripeColor,priorityDragVisuals.blue.stripeColor);
  assert.equal(priorityDragVisuals.ghost.background,priorityDragVisuals.blue.background);
  await release(to);
  await wait(()=>task(autoSecond).autoOrder===0&&task(autoFirst).autoOrder===1,'原生列表拖动更新自动顺序');
  await waitUi((a,b)=>{
    const ids=[...document.querySelectorAll('#task-list .queue-task[data-priority-draggable="true"]')].map(item=>item.dataset.taskId);
    return ids[0]===b&&ids[1]===a;
  },'刷新后保留自动任务的列表顺序',autoFirst,autoSecond);
  const reorder=await execute(()=>window.__scheduleTest.calls.filter(call=>call.route==='/api/tasks/reorder').at(-1)?.body);
  assert.deepEqual(reorder.taskIds,[autoSecond,autoFirst]);
  record('native automatic-list reorder sends the complete ordered task IDs');
  record('automatic-list drag preserves the blue card tint and hides the time-drop preview');

  ({from,to}=await boardMove(first,sharedStart+45*MINUTE));
  const beforeEscape=task(first),putsBefore=await execute(()=>window.__scheduleTest.calls.filter(call=>call.method==='PUT').length);
  await beginDrag(from,to);await key('Escape');mouse('mouseUp',to);await pause(60);
  assert.deepEqual(task(first),beforeEscape);
  assert.equal(await execute(()=>window.__scheduleTest.calls.filter(call=>call.method==='PUT').length),putsBefore);
  record('Escape cancels a time drag without mutation');
  ({from,to}=await boardMove(first,sharedStart+45*MINUTE));
  await execute(id=>{
    Object.assign(window.__scheduleTest,{stableCard:document.getElementById(`schedule-task-${id}`),stableList:document.getElementById(`queue-task-${id}`),
      stableSurface:document.getElementById('schedule-surface'),segments:document.getElementById('schedule-surface').dataset.timelineSegments,baseline:window.__scheduleTest.calls.length});
  },first);
  await beginDrag(from,to);
  await api(`/api/tasks/${custom}`,'PUT',{title:'UI check · Updated custom configuration'});
  await waitUi(id=>window.__scheduleTest.calls.slice(window.__scheduleTest.baseline).some(call=>call.route==='/api/state'
    &&call.tasks?.some(task=>task.id===id&&task.title==='UI check · Updated custom configuration')),'拖动期间收到刷新',custom);
  assert.equal(await execute(id=>window.__scheduleTest.stableCard===document.getElementById(`schedule-task-${id}`)
    &&window.__scheduleTest.stableList===document.getElementById(`queue-task-${id}`)
    &&window.__scheduleTest.stableSurface===document.getElementById('schedule-surface')
    &&window.__scheduleTest.segments===document.getElementById('schedule-surface').dataset.timelineSegments,first),true);
  await release(to);await wait(()=>Date.parse(task(first).schedule.at)===sharedStart+45*MINUTE,'刷新后保存拖动');
  record('SSE keeps pointer DOM and piecewise timeline frozen until release');

  await pause(380);await scrollToTime(Date.parse(task(first).scheduledAt));
  await execute(id=>document.getElementById(`schedule-task-${id}`).focus(),first);await key('Enter');
  await waitUi(id=>!!document.querySelector('.composer-panel.is-editing')&&document.getElementById(`queue-task-${id}`).classList.contains('is-editing'),'Keyboard opens the compact composer',first);
  assert.equal(await execute(()=>!document.querySelector('#composer-form [name="endAt"],#composer-form [name="plannedMinutes"],#composer-form [id*="duration"]')),true);
  await key('Escape');await waitCreate();
  record('keyboard task editing uses the shared compact options without schedule or duration fields');
  const terminalIds=['failed','uncertain','succeeded','interrupted','cancelled','canceled'].map((status,index)=>{
    const at=new Date(sharedStart+(300+index*60)*MINUTE).toISOString();
    const item=service.store.create({title:`UI check · ${status}`,prompt:'Isolated status fixture; no real execution.',target:'new',cwd:runtimeCwd,modelMode:'inherit',schedule:{mode:'exact',at}});
    Object.assign(item,{status,scheduledAt:at});return item.id;
  });
  const completedId=terminalIds[2],completedRun={id:'ui-fixture-completed-run',status:'succeeded',
    startedAt:new Date(Date.now()-MINUTE).toISOString(),endedAt:new Date().toISOString(),output:'Isolated completed fixture output.'};
  service.store.get(completedId).runs=[completedRun];
  service.store.save();service.runner.emit('change');
  await waitUi(ids=>ids.every(id=>document.getElementById(`queue-task-${id}`)?.dataset.draggable==='false'
    &&document.getElementById(`schedule-task-${id}`)?.dataset.draggable==='false'),'只读状态不支持拖动',terminalIds);
  const stripes=await execute(()=>['tint-gray','tint-yellow','tint-aqua','tint-blue'].map(tint=>{
    const card=document.querySelector(`.schedule-task.${tint}`);if(!card)return{tint,missing:true};
    const stripe=getComputedStyle(card,'::before'),style=getComputedStyle(card);
    return{tint,height:card.getBoundingClientRect().height,top:stripe.top,left:stripe.left,right:stripe.right,
      stripeHeight:stripe.height,radius:stripe.borderRadius,color:stripe.backgroundColor,overflow:style.overflow,
      corners:[style.borderTopLeftRadius,style.borderTopRightRadius,style.borderBottomLeftRadius,style.borderBottomRightRadius]};
  }));
  assert.ok(stripes.every(item=>!item.missing&&Math.abs(item.height-42)<.1&&item.top==='0px'
    &&item.left==='0px'&&item.right==='0px'&&item.stripeHeight==='2px'&&item.radius==='0px'&&item.overflow!=='hidden'),JSON.stringify(stripes));
  for(const stripe of stripes)assert.deepEqual(stripe.corners,['0px','0px','10px','10px']);
  record('all scheduled task tints use square top corners rounded bottoms and straight strips on fixed-height start-only cards');
  assert.equal(await execute(id=>document.getElementById(`queue-task-${id}`).classList.contains('tint-green')
    &&!!document.querySelector(`#queue-task-${id} [data-action="reschedule-task"]`),completedId),true);
  const greenColor=await execute(id=>getComputedStyle(document.getElementById(`queue-task-${id}`),'::before').backgroundColor,completedId);
  const green=greenColor.match(/[\d.]+/g).slice(0,3).map(Number);
  assert.ok(green[1]>green[0]&&green[1]>green[2]&&green[1]<160,`Completed stripe must use dark green: ${green}`);
  contents.sendInputEvent({type:'mouseMove',x:20,y:20});await frame();
  const terminalBackgrounds=[];
  for(const id of terminalIds){
    assert.equal(await execute(id=>document.getElementById(`queue-task-${id}`).classList.contains('ended-task'),id),true);
    assert.equal(await execute(id=>!!document.querySelector(`#queue-task-${id} [data-action="reschedule-task"]`),id),!['cancelled','canceled'].includes(task(id).status));
    const collapsedTerminal=await cardStyle(id);terminalBackgrounds.push(collapsedTerminal.background);
    await expand(id);await frame();assert.deepEqual(await cardStyle(id),collapsedTerminal);await toggle(id);
  }
  assert.ok(terminalBackgrounds.every(background=>background===terminalBackgrounds[0]&&background!==collapsedStyle.background),JSON.stringify(terminalBackgrounds));
  const gray=terminalBackgrounds[0].match(/[\d.]+/g).map(Number);
  assert.ok(Math.max(...gray.slice(0,3))-Math.min(...gray.slice(0,3))<=2&&gray[0]>=200&&gray[0]<255&&(gray.length===3||gray[3]===1),`Ended cards must have an opaque light gray background: ${terminalBackgrounds[0]}`);
  record('ended tasks keep the same gray background when expanded while completed tasks retain a dark green stripe');
  await scrollToTime(Date.parse(task(terminalIds[0]).scheduledAt));await execute(id=>document.getElementById(`schedule-task-${id}`).focus(),terminalIds[0]);await key('Enter');
  await waitUi(()=>document.getElementById('output-dialog').open,'只读状态键盘详情');await key('Escape');
  record('terminal timeline cards keep read-only keyboard status details');
  const completedBeforeEdit=task(completedId);
  await openEditor(completedId);
  assert.equal(await execute(id=>{
    const row=document.getElementById(`queue-task-${id}`),editing=row.querySelector('.badge.blue.editing[role="status"]');
    return editing?.textContent.trim()==='Editing'&&!!editing.querySelector('.badge-dot[aria-hidden="true"]')
      &&[...row.querySelectorAll('.badge:not(.editing)')].some(badge=>badge.textContent.trim()==='Completed')
      &&!document.getElementById('composer-edit-indicator');
  },completedId),true);
  record('the task-row Editing badge includes its blue dot and preserves the separate Completed status');
  await fill({'#composer-prompt':'Completed task content can be edited without another run.'});
  await execute(id=>{window.__scheduleTest.holdTaskId=id;document.getElementById('composer-form').requestSubmit();},completedId);
  await waitUi(()=>typeof window.__scheduleTest.releaseHeldWrite==='function'&&document.getElementById('composer-submit').disabled,'Hold a completed-task content save');
  const writesBeforeBlockedReschedule=await execute(()=>window.__scheduleTest.calls.filter(call=>call.method==='PUT').length);
  try{
    await click(`[data-action="reschedule-task"][data-task-id="${completedId}"]`);await frame();
    assert.equal(await execute(()=>window.__scheduleTest.calls.filter(call=>call.method==='PUT').length),writesBeforeBlockedReschedule);
    assert.equal(task(completedId).status,'succeeded');assert.deepEqual(task(completedId).runs,[completedRun]);
  }finally{await execute(()=>{window.__scheduleTest.holdTaskId=null;window.__scheduleTest.releaseHeldWrite();delete window.__scheduleTest.releaseHeldWrite;});}
  await waitCreate();
  record('an in-flight composer save blocks one-click rescheduling without a competing request');
  assert.equal(task(completedId).status,'succeeded');assert.deepEqual(task(completedId).runs,[completedRun]);
  assert.deepEqual(task(completedId).schedule,completedBeforeEdit.schedule);assert.equal(task(completedId).scheduledAt,completedBeforeEdit.scheduledAt);
  const completedEditWrite=await execute(id=>window.__scheduleTest.calls.filter(call=>call.route===`/api/tasks/${id}`&&call.method==='PUT').at(-1)?.body,completedId);
  assert.equal(completedEditWrite.reschedule,undefined);assert.equal(completedEditWrite.schedule,undefined);
  record('editing completed task content keeps its status and history without scheduling another execution');
  const beforeReschedule=task(completedId);
  await click('input[name="composerTarget"][value="existing"]');await click('input[name="composerConfig"][value="custom"]');
  await fill({'#composer-cwd':runtimeCwd,'#composer-model':'ui-fixture-model','#composer-effort':'low','#composer-speed':'priority','#composer-prompt':'# Creation draft\nKeep this draft through one-click rescheduling.'});
  const rescheduleCreationDraft=await composerDraft();
  await openEditor(completedId);await fill({'#composer-prompt':'An unsaved completed-task edit must survive Reschedule.'});
  const rescheduleEditingDraft=await composerDraft();
  await execute(id=>{window.__scheduleTest.failRescheduleId=id;},completedId);
  await click(`[data-action="reschedule-task"][data-task-id="${completedId}"]`);
  await waitUi(()=>[...document.querySelectorAll('.toast.error')].some(toast=>toast.textContent.includes('Isolated reschedule failure')),'Show a failed isolated reschedule');
  assert.deepEqual(task(completedId),beforeReschedule);assert.deepEqual(await composerDraft(),rescheduleEditingDraft);
  assert.equal(await execute(()=>document.getElementById('composer-heading').textContent==='Edit task'&&!document.querySelector('dialog[open]')),true);
  record('a failed one-click reschedule keeps the task history and current editing draft unchanged');
  await click(`[data-action="reschedule-task"][data-task-id="${completedId}"]`);
  await wait(()=>task(completedId).status==='queued'&&task(completedId).schedule.mode==='manual'&&task(completedId).scheduledAt===null,'Reschedule directly returns the completed task to manual');
  await waitUi(id=>document.getElementById(`queue-task-${id}`)?.classList.contains('tint-gray')&&!document.getElementById(`schedule-task-${id}`),'Manual rescheduling returns a completed task to the gray queue',completedId);
  assert.deepEqual(await composerDraft(),rescheduleEditingDraft);
  assert.equal(await execute(id=>document.getElementById('composer-heading').textContent==='Edit task'
    &&document.getElementById('composer-submit').textContent==='Save changes'
    &&!!document.querySelector(`#queue-task-${id} .badge.editing[role="status"]`)
    &&!document.querySelector('dialog[open]'),completedId),true);
  assert.equal(task(completedId).status,'queued');assert.equal(task(completedId).schedule.mode,'manual');assert.equal(task(completedId).scheduledAt,null);
  assert.equal(task(completedId).title,beforeReschedule.title);
  assert.equal(task(completedId).prompt,beforeReschedule.prompt);assert.deepEqual(task(completedId).runs,[completedRun]);
  const directRescheduleWrite=await execute(id=>window.__scheduleTest.calls.filter(call=>call.route===`/api/tasks/${id}`&&call.method==='PUT').at(-1)?.body,completedId);
  assert.deepEqual(directRescheduleWrite,{reschedule:true,schedule:{mode:'manual'}});
  await click('#composer-cancel');await waitCreate();assert.deepEqual(await composerDraft(),rescheduleCreationDraft);
  record('one-click rescheduling uses only the manual scheduling flag and preserves identity history and both composer drafts');
  for(const mode of['auto','exact']){
    Object.assign(service.store.get(completedId),{status:'succeeded',schedule:completedBeforeEdit.schedule,scheduledAt:completedBeforeEdit.scheduledAt});
    service.store.save();service.runner.emit('change');
    await waitUi(id=>document.getElementById(`queue-task-${id}`)?.classList.contains('tint-green'),'Restore the completed fixture',completedId);
    if(mode==='auto'){
      await openEditor(first);await fill({'#composer-prompt':'Another task edit survives rescheduling a completed task.'});
    }
    const untouchedComposer=await composerDraft();
    await expand(completedId);await click(`[data-action="reschedule-task"][data-task-id="${completedId}"]`);
    await wait(()=>task(completedId).status==='queued'&&task(completedId).schedule.mode==='manual','Directly reschedule without entering an editor');
    await waitUi(id=>document.getElementById(`queue-task-${id}`)?.classList.contains('tint-gray'),'Reflect direct rescheduling in the task row',completedId);
    assert.deepEqual(await composerDraft(),untouchedComposer);assert.equal(await execute(()=>!!document.querySelector('dialog[open]')),false);
    const write=await execute(id=>window.__scheduleTest.calls.filter(call=>call.route===`/api/tasks/${id}`&&call.method==='PUT').at(-1)?.body,completedId);
    assert.equal(write.reschedule,true);assert.deepEqual(write.schedule,{mode:'manual'});
    if(mode==='auto'){
      assert.equal(await execute(id=>document.getElementById(`queue-task-${id}`).classList.contains('is-editing')&&document.getElementById('composer-heading').textContent==='Edit task',first),true);
      await click('#composer-cancel');await waitCreate();assert.deepEqual(await composerDraft(),rescheduleCreationDraft);
      await expand(completedId);await click(`[data-action="auto-task"][data-task-id="${completedId}"]`);
      await wait(()=>task(completedId).schedule.mode==='auto'&&task(completedId).status==='scheduled','Arrange a rescheduled task automatically');
    }else{
      const exactStart=sharedStart+420*MINUTE;await scrollToTime(exactStart);
      from=await point(`#queue-task-${completedId}`);to=await atTime(exactStart);await beginDrag(from,to);await release(to);
      await wait(()=>task(completedId).schedule.mode==='exact'&&Date.parse(task(completedId).schedule.at)===exactStart,'Drag a rescheduled task to an exact start');
    }
    assert.equal(task(completedId).id,completedId);assert.equal(task(completedId).schedule.mode,mode);assert.equal(task(completedId).status,'scheduled');
    assert.deepEqual(task(completedId).runs,[completedRun]);
  }
  record('direct rescheduling preserves an unrelated editor or creation draft before automatic or timeline scheduling');
  for(const id of terminalIds)await api(`/api/tasks/${id}`,'DELETE',{});

  const statusBeforeApproval=service.store.get(first).status;
  const approval={id:'ui-fixture-approval',taskId:first,method:'item/tool/requestUserInput',params:{questions:[{
    id:'project',header:'Project choice',question:'Which project should be used?',
    options:[{label:'Current project',description:'Use the existing project directory.'}],
  }]}};
  service.store.get(first).status='awaiting_approval';service.runner.approvals=[approval];service.store.save();service.runner.emit('change');
  await waitUi(id=>!!document.querySelector(`#queue-task-${id} [data-action="open-approvals"]`),'Task exposes its pending request',first);
  await expand(first);await click(`#queue-task-${first} [data-action="open-approvals"]`);
  await waitUi(()=>document.getElementById('approvals-dialog').open,'Open request from task row');
  await click('#approvals-dialog input[name="answer-project"]');
  await fill({'#approvals-dialog textarea[name="free-project"]':'Draft answer kept during refresh.'});
  const requestCallsBefore=await execute(()=>window.__scheduleTest.calls.length);service.runner.emit('change');
  await waitUi(count=>window.__scheduleTest.calls.slice(count).some(call=>call.route==='/api/state'&&call.finished),'Pending request receives SSE refresh',requestCallsBefore);
  await frame();
  assert.equal(await execute(()=>document.querySelector('#approvals-dialog textarea[name="free-project"]').value),'Draft answer kept during refresh.');
  assert.equal(await execute(()=>document.querySelector('#approvals-dialog input[name="answer-project"]').checked),true);
  await key('Escape');
  record('pending approvals stay reachable from task rows and preserve draft answers through SSE');
  await click(`#queue-task-${first} [data-action="view-task"]`);
  await waitUi(()=>document.getElementById('output-dialog').open,'Open pending task status');
  assert.equal(await execute(()=>!!document.querySelector('#output-dialog [data-action="open-approvals"]')),true);
  await click('#output-dialog [data-action="open-approvals"]');await waitUi(()=>document.getElementById('approvals-dialog').open,'Open request from task status');
  await key('Escape');if(await execute(()=>document.getElementById('output-dialog').open))await key('Escape');
  service.store.get(first).status=statusBeforeApproval;service.runner.approvals=[];service.store.save();service.runner.emit('change');
  await waitUi(id=>!document.querySelector(`#queue-task-${id} [data-action="open-approvals"]`),'Clear isolated request fixture',first);
  record('individual task status retains the request-review entry without a global history page');

  const originalRespond=service.runner.client.respond,requestReplies=[];
  service.runner.client.respond=(id,result)=>requestReplies.push({id,result});
  const requestForm={mode:'form',serverName:'Fixture MCP',message:'Choose the values to return.',requestedSchema:{type:'object',required:['name','count','enabled','choices'],properties:{
    name:{type:'string',minLength:1},count:{type:'integer',minimum:1,maximum:9},enabled:{type:'boolean'},
    choices:{type:'array',minItems:1,items:{type:'string',enum:['one','two','three']}},
  }}};
  const showElicitation=async(id,params)=>{
    service.store.get(first).status='awaiting_approval';
    service.runner.approvals=[{id,rpcId:id,taskId:first,method:'mcpServer/elicitation/request',params}];
    service.store.save();service.runner.emit('change');
    await waitUi(id=>!!document.querySelector(`#queue-task-${id} [data-action="open-approvals"]`),'Expose MCP request',first);
    await expand(first);await click(`#queue-task-${first} [data-action="open-approvals"]`);
    await waitUi(id=>!!document.querySelector(`[data-elicitation][data-approval-id="${id}"]`),'Render MCP request',id);
  };
  try {
    await showElicitation('fixture-mcp-form',requestForm);
    await fill({'[name="elicitation-0"]':'Keep this draft','[name="elicitation-1"]':'3','[name="elicitation-2"]':'false'});
    await click('[name="elicitation-3"][value="one"]');await click('[name="elicitation-3"][value="three"]');
    const before=await execute(()=>window.__scheduleTest.calls.length);service.runner.emit('change');
    await waitUi(count=>window.__scheduleTest.calls.slice(count).some(call=>call.route==='/api/state'&&call.finished),'Refresh MCP draft',before);await frame();
    assert.deepEqual(await execute(()=>[...document.querySelectorAll('[name="elicitation-3"]')].map(input=>input.checked)),[true,false,true]);
    assert.equal(await execute(()=>document.querySelector('[name="elicitation-0"]').value),'Keep this draft');
    await click('[data-elicitation] button[type="submit"]');await wait(()=>requestReplies.length===1,'Submit typed MCP response');
    assert.deepEqual(requestReplies[0],{id:'fixture-mcp-form',result:{action:'accept',content:{name:'Keep this draft',count:3,enabled:false,choices:['one','three']}}});
    await key('Escape');
    record('MCP forms preserve text and independent checkbox selections through refresh and return typed answers');

    await showElicitation('fixture-mcp-url',{mode:'url',serverName:'Fixture MCP',message:'Complete this request.',url:'https://example.com/consent',elicitationId:'fixture'});
    const opened=await execute(()=>window.sweatshopDesktop.openRequestUrl('fixture-mcp-url'));
    assert.deepEqual(opened,{url:'https://example.com/consent',opened:false});assert.equal(requestReplies.length,1);
    await click('[data-action="open-request-url"]');await frame();assert.equal(requestReplies.length,1);
    await click('[data-elicitation] button[type="submit"]');await wait(()=>requestReplies.length===2,'Continue URL request');
    assert.deepEqual(requestReplies[1].result,{action:'accept',content:null});await key('Escape');
    record('MCP URL requests use the validated desktop bridge and require an explicit Continue after opening');

    for(const action of ['decline','cancel']) {
      await showElicitation(`fixture-mcp-${action}`,requestForm);
      assert.equal(await execute(()=>document.querySelector('[name="elicitation-0"]').value),'');
      await click(`[data-action="${action}-elicitation"]`);
      await wait(()=>requestReplies.some(reply=>reply.id===`fixture-mcp-${action}`),`Send MCP ${action}`);
      assert.deepEqual(requestReplies.at(-1).result,{action,content:null});await key('Escape');
    }
    record('MCP decline and cancel return distinct actions and never reuse another request draft');
  } finally {
    service.runner.client.respond=originalRespond;service.runner.approvals=[];
    service.store.get(first).status=statusBeforeApproval;service.store.save();service.runner.emit('change');
    if(await execute(()=>document.getElementById('approvals-dialog').open))await key('Escape');
  }

  await openEditor(linked);await click('[data-action="unlink-prompt-file"][data-prefix="composer"]');
  assert.equal(await execute(()=>document.getElementById('composer-prompt-file').value),'');
  assert.equal(await execute(()=>document.getElementById('composer-prompt').readOnly),false);
  await fill({'#composer-prompt':'UI check · Temporarily switched to a text prompt'});
  await execute(()=>document.getElementById('composer-form').requestSubmit());
  await wait(()=>!task(linked).promptFile&&task(linked).prompt==='UI check · Temporarily switched to a text prompt','保存解除文件关联');
  await waitCreate();
  await openEditor(linked);await click('[data-action="link-prompt-file"][data-prefix="composer"]');
  await waitUi(file=>document.getElementById('composer-prompt-file').value===file,'在编辑器重新关联文件',fixtureFile);
  await execute(()=>document.getElementById('composer-form').requestSubmit());
  await wait(()=>task(linked).promptFile===fixtureFile,'保存重新关联文件');
  await waitCreate();
  record('unlinking restores text editing and relinking persists current source');

  await click('[data-action="open-auto-settings"]');
  await waitUi(()=>document.getElementById('auto-settings-dialog').open,'Open automatic scheduling settings');
  assert.equal(await execute(()=>!!document.querySelector('#auto-settings-content #settings-form')
    &&document.querySelectorAll('#auto-settings-content form').length===1
    &&!document.querySelector('#auto-settings-dialog .reset-credits-card,#auto-settings-dialog [data-action="open-history"],#auto-settings-dialog #reset-credits-content')),true);
  record('automatic scheduling settings open independently and contain no reset-credit details');
  assert.equal(await execute(()=>!document.querySelector('#scheduler-toggle,[data-action="connect"],[data-action="refresh"],[data-action="open-data-directory"]')),true);
  const choices=await execute(()=>[...document.getElementById('settings-starting-from').options].map(option=>option.value));
  const resetTimes=await execute(()=>[...document.querySelectorAll('.timeline-marker:not([data-appendix])')].filter(marker=>marker.dataset.nodeIds.split(' ').some(id=>id.startsWith('fiveHour:'))).map(marker=>new Date(Number(marker.dataset.time)).toISOString()));
  assert.deepEqual(choices,['now',...resetTimes]);
  assert.equal(await execute(()=>!document.querySelector('#settings-timezone,#settings-anchor,.settings-actions,#settings-dirty-label,#settings-form button[type="submit"]')
    &&document.getElementById('settings-form').textContent.includes('Starting from')
    &&['starting-from-hint','reserved-hours-hint'].every(id=>document.getElementById(id).textContent.trim().split(/\s+/).length<=10)),true);
  await writeFile(relatedScreenshot('settings'),(await contents.capturePage()).toPNG());
  const selected=choices[2];await fill({'#settings-starting-from':selected});
  await wait(()=>service.store.data.settings.startingFrom===selected,'Starting node applies immediately');
  assert.equal(service.store.data.settings.timezone,Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC');
  await fill({'#settings-capacity':'2'});await wait(()=>service.store.data.settings.tasksPerWindow===2,'Capacity applies immediately');
  await fill({'#settings-capacity':'3'});await fill({'#settings-capacity':'2'});await fill({'#settings-capacity':'1'});
  await wait(()=>service.store.data.settings.tasksPerWindow===1,'Rapid edits preserve final value');
  await execute(()=>{const input=document.getElementById('settings-quiet-enabled');input.click();});
  await wait(()=>service.store.data.settings.quietHours.enabled,'Reserved hours apply without saving');
  await execute(()=>{document.getElementById('settings-quiet-enabled').click();});
  await wait(()=>!service.store.data.settings.quietHours.enabled,'Disable reserved hours immediately');
  await fill({'#settings-starting-from':'now'});await wait(()=>service.store.data.settings.startingFrom==='now','Current node can be selected');
  await fill({'#settings-starting-from':choices[1]});await wait(()=>service.store.data.settings.startingFrom===choices[1],'Restore next reset selection');
  assert.equal(await execute(()=>[...document.querySelectorAll('.toast')].some(item=>item.textContent==='Settings saved')),false);
  await key('Escape');
  record('automatic settings use matching five-hour nodes plus Now; changes apply immediately without timezone, save, discard or success notices');
  const originalPreciseAt=new Date(sharedStart+90*MINUTE+123).toISOString();
  await api(`/api/tasks/${first}`,'PUT',{schedule:{mode:'exact',at:originalPreciseAt}});
  await waitUi((id,at)=>Number(document.getElementById(`schedule-task-${id}`)?.dataset.start)===Date.parse(at),'Receive the precise task before editing',first,originalPreciseAt);
  await openEditor(first);await execute(()=>document.getElementById('composer-form').requestSubmit());await waitCreate();
  assert.equal(task(first).schedule.at,originalPreciseAt);
  record('ordinary task editing preserves exact milliseconds with automatic time-zone settings');
  const limitsBeforeReset=service.runner.limits;
  service.runner.limits={rateLimitResetCredits:{availableCount:1,credits:[{
    title:'Reset credit',status:'available',expiresAt:new Date(Date.now()+24*60*MINUTE).toISOString(),
    description:'Bonus reset instructions must not be shown.',
  }]}};service.runner.emit('change');
  await waitUi(()=>document.querySelector('#reset-credit-summary strong')?.textContent==='1','Read isolated reset-credit count');
  assert.match(await execute(()=>document.querySelector('#reset-credit-summary small')?.textContent||''),/\bTomorrow (?:[01]\d|2[0-3]):[0-5]\d/);
  await click('[data-action="open-reset-credits"]');await waitUi(()=>document.getElementById('reset-credits-dialog').open,'Open reset-credit details');
  assert.equal(await execute(()=>!!document.querySelector('#reset-credits-content .reset-credits-card')
    &&!document.querySelector('#reset-credits-dialog form,#reset-credits-dialog input,#reset-credits-dialog select,#reset-credits-dialog textarea')
    &&!document.getElementById('reset-credits-content').textContent.includes('Bonus reset instructions must not be shown.')
    &&!document.getElementById('reset-credits-content').textContent.includes('Sorted by expiry')
    &&!document.getElementById('reset-credits-content').textContent.includes('Reset credits are informational')
    &&!document.getElementById('auto-settings-dialog').open),true);
  assert.equal(await execute(()=>/\p{Script=Han}/u.test(document.getElementById('reset-credits-content').textContent)),false);
  await key('Escape');service.runner.limits=limitsBeforeReset;service.runner.emit('change');
  record('reset credits have a separate read-only details dialog without settings or gift descriptions');
  const tooltips=await execute(()=>({
    title:document.title,
    unexpected:[...document.querySelectorAll('[title]')].filter(element=>element.getAttribute('title')
      &&!element.matches('[data-action="link-prompt-file"],[data-action="auto-task"],[data-action="choose-directory"],#timeline-zoom,.timeline-marker time,.timeline-dot,.reset-lock')).map(element=>({tag:element.tagName,id:element.id,title:element.getAttribute('title')})),
    accessible:[...document.querySelectorAll('.queue-task,.schedule-task')].every(element=>!!element.getAttribute('aria-label')),
  }));
  assert.deepEqual(tooltips.unexpected,[]);assert.equal(tooltips.title,'Codex Sweatshop');assert.equal(tooltips.accessible,true);
  record('hover titles include only linking, zoom, quota nodes, automatic queueing and folder browsing');
  const writes=await execute(()=>window.__scheduleTest.calls.filter(call=>['POST','PUT'].includes(call.method)&&call.route.startsWith('/api/tasks')));
  assert.ok(writes.every(call=>![...Object.keys(call.body||{}),...Object.keys(call.body?.schedule||{})].some(key=>['plannedMinutes','duration','endAt','end'].includes(key))));
  record('task writes never submit duration or end-time fields');

  // Exercise quota controls against isolated, explicit samples. The client's inference
  // prohibition remains enabled throughout this block.
  const quotaBefore={tasks:structuredClone(service.store.data.tasks),quota:structuredClone(service.store.data.quota),
    limits:service.runner.limits,models:service.runner.models};
  try {
    for(const task of service.store.data.tasks){task.status='queued';task.schedule={mode:'manual'};task.scheduledAt=null;delete task.quotaNode;}
    service.store.data.quota=emptyQuotaState();
    service.runner.models=[...quotaBefore.models,{model:'gpt-6-luna',displayName:'GPT-6 Luna',supportedReasoningEfforts:['low'],serviceTiers:[]}];
    const sampledAt=Date.now(),minute=Math.floor(sampledAt/MINUTE)*MINUTE;
    const data=(at,used,reset)=>({accountId:'isolated-quota-ui',rateLimitsByLimitId:{codex:{
      primary:{usedPercent:used,windowDurationMins:300,resetsAt:reset/1000},
      secondary:{usedPercent:used,windowDurationMins:10080,resetsAt:(at+2*60*MINUTE+31000)/1000}}}});
    service.runner.limits=data(sampledAt,0,sampledAt+300*MINUTE);
    observeQuota(service.store.data.quota,service.runner.limits,sampledAt);service.applyPlan();
    await waitUi(()=>document.querySelectorAll('.window-unanchored').length===2
      &&document.getElementById('quota-five-hour').querySelector('small').textContent==='Window unconfirmed','Zero-use state is actionable without a checking wait');
    const unconfirmed=service.snapshot().quota.nodes.find(node=>node.kind==='fiveHour');
    assert.equal(await execute(id=>document.querySelector(`.reset-lock[data-node-id="${id}"]`).disabled,unconfirmed.id),false);
    const requestedAt=Date.now();await click(`.reset-lock[data-node-id="${unconfirmed.id}"]`);
    await wait(()=>service.store.data.quota.plans.some(plan=>plan.status==='scheduled'),'Plan from the first zero-use reading');
    const requested=service.store.data.quota.plans.find(plan=>plan.status==='scheduled');
    assert.ok(Date.parse(requested.activationAt)>=requestedAt&&Date.parse(requested.activationAt)<=Date.now());
    await waitUi(id=>document.querySelector(`.reset-lock[data-node-id="${id}"]`)?.classList.contains('locked'),'Current-window plan remains cancellable',unconfirmed.id);
    await click(`.reset-lock[data-node-id="${unconfirmed.id}"]`);
    await wait(()=>requested.status==='cancelled','Cancel the isolated current-window plan');
    record('zero-use windows show a quiet unconfirmed warning and allow immediate anchoring without waiting for samples');
    service.store.data.quota=emptyQuotaState();
    service.runner.limits=data(sampledAt,12,minute+60*MINUTE+17000);observeQuota(service.store.data.quota,service.runner.limits,sampledAt);
    service.applyPlan();service.runner.emit('change');
    await waitUi(()=>document.querySelectorAll('.marker-confirmed').length===2&&!!document.querySelector('.marker-week .weekly-label'),'Confirmed five-hour and weekly reset markers');
    let quota=service.snapshot().quota,firstQuota=quota.nodes.find(node=>node.kind==='fiveHour'),weekly=quota.nodes.find(node=>node.kind==='week');
    assert.equal(await execute(()=>document.querySelectorAll('.marker-confirmed .timeline-dot').length===2
      &&[...document.querySelectorAll('.marker-confirmed .timeline-dot')].every(dot=>getComputedStyle(dot).backgroundColor==='rgb(91, 140, 113)')
      &&document.querySelector('.marker-week time').textContent.includes('Week')
      &&document.querySelector('.marker-now .timeline-dot').title==='Current time'),true);
    record('confirmed five-hour and weekly reset nodes are green and expose distinct hover descriptions');
    assert.equal(await execute(id=>document.querySelector(`.reset-lock[data-node-id="${id}"]`).disabled,weekly.id),true);
    const futureWeek=quota.nodes.filter(node=>node.kind==='week')[1];
    assert.equal(await execute(()=>document.querySelectorAll('.marker-week[data-appendix]').length),1);
    await click(`.reset-lock[data-node-id="${futureWeek.id}"]`);
    await waitUi(id=>document.querySelector(`.reset-lock[data-node-id="${id}"]`)?.classList.contains('locked'),'Plan next weekly ending window',futureWeek.id);
    let weeklyPlan=service.store.data.quota.plans.find(plan=>plan.status==='scheduled');
    assert.equal(weeklyPlan.activationAt,weekly.time);assert.equal(weeklyPlan.endAt,futureWeek.time);
    await click(`.reset-lock[data-node-id="${futureWeek.id}"]`);
    await wait(()=>service.store.data.quota.plans.every(plan=>plan.status==='cancelled'),'Cancel weekly activation');
    record('the additional weekly endpoint schedules its greeting one week earlier and supports cancellation');
    await waitUi(id=>!!document.querySelector(`[data-reset-drag="${id}"]`),'Cancelled weekly endpoint is draggable again',futureWeek.id);
    await execute(id=>document.querySelector(`[data-reset-drag="${id}"]`).scrollIntoView({block:'center'}),futureWeek.id);await frame();
    const footerFrom=await point(`[data-reset-drag="${futureWeek.id}"]`),footerTo={x:footerFrom.x,y:footerFrom.y+28};
    await beginDrag(footerFrom,footerTo,false);await release(footerTo);
    await wait(()=>service.store.data.quota.plans.some(plan=>plan.status==='scheduled'),'Delay extra weekly endpoint');
    weeklyPlan=service.store.data.quota.plans.find(plan=>plan.status==='scheduled');
    assert.ok(Date.parse(weeklyPlan.endAt)>Date.parse(futureWeek.time));assert.equal(Date.parse(weeklyPlan.endAt)-Date.parse(weeklyPlan.activationAt),10080*MINUTE);
    await click(`.reset-lock[data-node-id="${futureWeek.id}"]`);await wait(()=>weeklyPlan.status==='cancelled','Cancel delayed extra weekly endpoint');
    record('extra weekly endpoints retain native forward dragging and rollback without stretching task coordinates');
    service.runner.limits.rateLimitsByLimitId.codex.secondary.resetsAt=(sampledAt+6*24*60*MINUTE)/1000;
    observeQuota(service.store.data.quota,service.runner.limits,sampledAt);service.store.save();service.runner.emit('change');
    await waitUi(()=>document.querySelectorAll('.marker-week:not([data-appendix])').length===0&&document.querySelectorAll('.marker-week[data-appendix]').length===2,'Two nearest weekly endpoints are appended outside three days');
    assert.equal(await execute(()=>Number(document.getElementById('schedule-surface').dataset.end)-Number(document.getElementById('schedule-surface').dataset.start)),72*60*MINUTE);
    assert.equal(await execute(()=>document.querySelector('[data-action="show-weekly-windows"]')===null),true);
    const footerNodes=service.snapshot().quota.nodes.filter(node=>node.kind==='week'),footerId=footerNodes[1].id;
    await execute(id=>document.querySelector(`.reset-lock[data-node-id="${id}"]`).scrollIntoView({block:'center'}),footerId);await frame();
    const taskBeforeFooter=task(first),footerTaskFrom=await point(`#queue-task-${first}`),footerTaskTo=await point(`.timeline-marker[data-appendix][data-node-ids="${footerId}"]`);
    footerTaskTo.x+=350;
    await beginDrag(footerTaskFrom,footerTaskTo,false);
    assert.equal(await execute(()=>document.querySelector('.drag-ghost').classList.contains('invalid-drop')),true);await release(footerTaskTo);
    assert.deepEqual(task(first),taskBeforeFooter);
    record('three-day task coordinates append two out-of-range weekly endpoints and reject task drops there');
    const weeklyScreenshot=relatedScreenshot('weekly-appendix');await execute(()=>document.querySelectorAll('.toast').forEach(element=>element.remove()));await frame();
    await writeFile(weeklyScreenshot,(await contents.capturePage()).toPNG());quotaScreenshots.push(weeklyScreenshot);
    const coincidence=Date.parse(firstQuota.time)+300*MINUTE;
    service.runner.limits.rateLimitsByLimitId.codex.secondary.resetsAt=coincidence/1000;
    observeQuota(service.store.data.quota,service.runner.limits,sampledAt);service.store.save();service.runner.emit('change');
    await waitUi(time=>document.querySelector(`.timeline-marker[data-time="${time}"]`)?.querySelectorAll('time').length===2,'Coincident hourly and weekly markers',coincidence);
    assert.equal(await execute(time=>{
      const marker=document.querySelector(`.timeline-marker[data-time="${time}"]`),labels=marker.querySelectorAll('time');
      return getComputedStyle(labels[0]).fontStyle==='italic'&&getComputedStyle(labels[1]).fontStyle==='normal'
        &&getComputedStyle(marker.querySelector('.dot-projected')).backgroundColor==='rgb(184, 184, 184)'
        &&getComputedStyle(marker.querySelector('.dot-confirmed')).backgroundColor==='rgb(91, 140, 113)'
        &&marker.querySelectorAll('.reset-lock').length===2;
    },coincidence),true);
    record('coincident five-hour and weekly markers retain independent certainty, colors and lock controls');
    const anchoredScreenshot=relatedScreenshot('quota-anchored');
    await execute(()=>{document.getElementById('schedule-board').scrollTop=0;document.querySelectorAll('.toast').forEach(element=>element.remove());});await frame();
    await writeFile(anchoredScreenshot,(await contents.capturePage()).toPNG());quotaScreenshots.push(anchoredScreenshot);

    service.store.data.quota=emptyQuotaState();
    const floatingReset=sampledAt+300*MINUTE;
    observeQuota(service.store.data.quota,data(sampledAt-60000,0,floatingReset-60000),sampledAt-60000);
    service.runner.limits=data(sampledAt,0,floatingReset);observeQuota(service.store.data.quota,service.runner.limits,sampledAt);
    service.applyPlan();service.runner.emit('change');
    await waitUi(()=>document.querySelectorAll('.window-unanchored').length===2&&document.querySelectorAll('.marker-projected').length>0,'Orange unanchored warnings and projected nodes');
    quota=service.snapshot().quota;const projected=quota.nodes.filter(node=>node.kind==='fiveHour');firstQuota=projected[0];
    assert.equal(await execute(()=>document.getElementById('quota-five-hour').querySelector('small').textContent==='Window not anchored'
      &&document.getElementById('quota-week').querySelector('small').textContent==='Window not anchored'
      &&[...document.querySelectorAll('.marker-projected time')].every(time=>getComputedStyle(time).fontStyle==='italic')
      &&getComputedStyle(document.querySelector('.window-unanchored')).color==='rgb(189, 121, 55)'),true);
    assert.equal(await execute(id=>document.querySelector(`.reset-lock[data-node-id="${id}"]`).disabled,projected[1].id),true);
    record('unanchored quota warnings are orange; forecasts are italic, unlocked and enforce preceding-window dependencies');
    await scrollToTime(Date.parse(firstQuota.time));
    let resetPoint=await point(`[data-reset-drag="${firstQuota.id}"]`),resetTarget=await atTime(Date.parse(firstQuota.time)+60*MINUTE);
    await beginDrag(resetPoint,resetTarget,false);
    await waitUi(()=>document.querySelectorAll('.reset-shift-preview').length>1,'Preview shifted future quota nodes');
    const previewBeforeCancel=await execute(()=>({count:document.querySelectorAll('.reset-shift-preview').length,
      title:document.querySelector('.drag-ghost')?.textContent,locked:!!document.querySelector('.reset-shift-preview .reset-lock.locked')}));
    assert.ok(previewBeforeCancel.count>1&&previewBeforeCancel.locked);await key('Escape');mouse('mouseUp',resetTarget);dragAlt=false;await pause(400);
    assert.equal(service.store.data.quota.plans.length,0);
    record('Escape cancels a node drag without persisting an activation');
    await scrollToTime(Date.parse(firstQuota.time));resetPoint=await point(`[data-reset-drag="${firstQuota.id}"]`);resetTarget=await atTime(Date.parse(firstQuota.time)+60*MINUTE);
    await beginDrag(resetPoint,resetTarget,false);await release(resetTarget);
    await wait(()=>service.store.data.quota.plans.some(plan=>plan.status==='scheduled'&&plan.kind==='fiveHour'),'Persist a delayed quota activation');
    const delayed=service.store.data.quota.plans.find(plan=>plan.status==='scheduled');
    assert.ok(Date.parse(delayed.endAt)>=Date.parse(firstQuota.time)+50*MINUTE);
    assert.equal(Date.parse(delayed.endAt)-Date.parse(delayed.activationAt),300*MINUTE);
    await waitUi(id=>document.querySelector(`.reset-lock[data-node-id="${id}"]`)?.classList.contains('locked'),'Locked planned node',firstQuota.id);
    assert.equal(await execute(id=>getComputedStyle(document.querySelector(`.reset-lock[data-node-id="${id}"]`).closest('.timeline-marker').querySelector('time')).fontStyle,firstQuota.id),'normal');
    const shifted=service.snapshot().quota.nodes.filter(node=>node.kind==='fiveHour');
    assert.equal(Date.parse(shifted[1].time)-Date.parse(projected[1].time),Date.parse(delayed.endAt)-Date.parse(firstQuota.time));
    assert.equal(shifted[1].lock,null);assert.equal(service.snapshot().quota.periods.fiveHour.state,'floating');
    record('native node dragging plans activation, regularizes its label and shifts only later five-hour forecasts');
    const plannedScreenshot=relatedScreenshot('quota-planned');await execute(()=>{document.getElementById('schedule-board').scrollTop=0;document.querySelectorAll('.toast').forEach(element=>element.remove());});await frame();
    await writeFile(plannedScreenshot,(await contents.capturePage()).toPNG());quotaScreenshots.push(plannedScreenshot);
    await scrollToTime(Date.parse(shifted[0].time));await click(`.reset-lock[data-node-id="${firstQuota.id}"]`);
    await wait(()=>delayed.status==='cancelled','Unlock and restore forecast');
    assert.equal(service.snapshot().quota.nodes.find(node=>node.kind==='fiveHour').time,firstQuota.time);
    record('unlocking the planned node revokes its activation and restores the original timeline');

    await scrollToTime(Date.parse(firstQuota.time)-10*MINUTE);
    const nativeFrom=await point(`#queue-task-${first}`),nativeTo=await atTime(Date.parse(firstQuota.time)-9*MINUTE);
    await beginDrag(nativeFrom,nativeTo,false);await release(nativeTo);
    await wait(()=>task(first).scheduledAt===firstQuota.time,'Default task drag snaps to exact quota node seconds');
    assert.equal(task(first).schedule.mode,'window');
    assert.equal(task(first).schedule.windowStart,firstQuota.time);
    const endingNode=service.snapshot().quota.nodes.find(node=>node.kind==='fiveHour'&&node.windowStart===firstQuota.time);
    await waitUi(id=>document.querySelector(`.reset-lock[data-node-id="${id}"]`)?.disabled
      &&document.querySelector(`.reset-lock[data-node-id="${id}"]`)?.classList.contains('locked'),'Task-driven ending-window lock is disabled',endingNode.id);
    assert.equal(await execute(id=>document.querySelector(`.reset-lock[data-node-id="${id}"]`).title,endingNode.id),'A scheduled task will anchor this quota window');
    record('default task dragging creates a specified window and locks the matching ending node');
    const restoreAt=new Date(Date.parse(firstQuota.time)+15*MINUTE).toISOString();
    await api(`/api/tasks/${first}`,'PUT',{schedule:{mode:'exact',at:restoreAt}});
    await waitUi(id=>!!document.querySelector(`[data-reset-drag="${id}"]`),'Node becomes unlocked after task is moved off its precise timestamp',firstQuota.id);
    await scrollToTime(Date.parse(firstQuota.time));resetPoint=await point(`[data-reset-drag="${firstQuota.id}"]`);resetTarget=await atTime(Date.parse(firstQuota.time)-60*MINUTE);
    await beginDrag(resetPoint,resetTarget,false);await release(resetTarget);
    await wait(()=>service.store.data.quota.plans.some(plan=>plan.status==='scheduled'),'Backward dragging clamps to original node');
    const backwards=service.store.data.quota.plans.find(plan=>plan.status==='scheduled');
    assert.ok(Date.parse(backwards.endAt)>=Date.parse(firstQuota.time));assert.equal(Date.parse(backwards.endAt)-Date.parse(backwards.activationAt),300*MINUTE);
    record('dragging an unlocked node backwards keeps its original start time');
    assert.equal(service.runner.client.status.connected,false);
  } finally {
    service.store.data.tasks=quotaBefore.tasks;service.store.data.quota=quotaBefore.quota;
    service.runner.limits=quotaBefore.limits;service.runner.models=quotaBefore.models;service.store.save();service.runner.emit('change');
    await waitUi(()=>!document.querySelector('.window-unanchored'),'Restore isolated quota fixture');
  }

  await api(`/api/tasks/${custom}`,'DELETE',{});
  for(const id of[first,second])await api(`/api/tasks/${id}`,'PUT',{schedule:{mode:'exact',at:new Date(sharedStart).toISOString()}});
  const previewIds=[first,second,linked,autoFirst,autoSecond];
  await waitUi(ids=>ids.every(id=>!!document.getElementById(`queue-task-${id}`)),'显示最终五项任务',previewIds);
  await waitUi((a,b)=>document.getElementById(`schedule-task-${a}`)?.dataset.columns==='2'
    &&document.getElementById(`schedule-task-${b}`)?.dataset.columns==='2','最终同时间并排',first,second);
  await expand(first);
  await click('input[name="composerTarget"][value="new"]');await click('input[name="composerConfig"][value="inherit"]');
  await fill({'#composer-cwd':'','#composer-prompt':''});
  assert.equal(await execute(()=>{
    const surface=document.getElementById('schedule-surface');
    return Number(surface.dataset.end)-Number(surface.dataset.start)===72*60*60_000
      &&Math.abs(Number(surface.dataset.start)-Date.now())<2*60_000
      &&['quota-five-hour','quota-week','reset-credit-summary'].every(id=>document.querySelector(`#${id} strong`)?.textContent==='—')
      &&document.querySelectorAll('.queue-task[aria-expanded="true"]').length===1;
  }),true);
  const originalSize=window.getSize();
  try{
    for(const width of[900,1060,originalSize[0]]){
      window.setSize(width,originalSize[1]);await frame();
      await execute(()=>document.getElementById('schedule-board').scrollTop=0);await frame();
      const labels=await execute(()=>{
        const board=document.getElementById('schedule-board').getBoundingClientRect();
        const zoom=document.querySelector('.timeline-options').getBoundingClientRect();
        const times=[...document.querySelectorAll('.timeline-marker time')].map(element=>{
          const rect=element.getBoundingClientRect();
          return{text:element.textContent,left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom};
        }).filter(rect=>rect.bottom>board.top&&rect.top<board.bottom);
        return{width:innerWidth,times,alongside:times.filter(rect=>rect.bottom>zoom.top&&rect.top<zoom.bottom),
          insufficientClearance:times.filter(rect=>rect.left<zoom.right+2),
          overlap:times.filter(rect=>Math.min(rect.right,zoom.right)-Math.max(rect.left,zoom.left)>.5
            &&Math.min(rect.bottom,zoom.bottom)-Math.max(rect.top,zoom.top)>.5)};
      });
      assert.ok(labels.times.some(label=>label.text.startsWith('Tomorrow '))&&labels.alongside.length>0,JSON.stringify(labels));
      assert.deepEqual(labels.insufficientClearance,[],`Time labels need clear horizontal space beside the zoom panel: ${JSON.stringify(labels)}`);
      assert.deepEqual(labels.overlap,[],`Time labels overlap the zoom panel at ${labels.width}px: ${JSON.stringify(labels.overlap)}`);
    }
  }finally{window.setSize(...originalSize);await frame();}
  record('English time labels remain clear of the zoom panel at desktop and minimum window widths');
  await openEditor(first);
  await execute(()=>{
    document.getElementById('schedule-board').scrollTop=0;document.getElementById('task-list').scrollTop=0;
    document.querySelector('.composer-panel').scrollTop=0;document.activeElement?.blur();document.querySelectorAll('.toast').forEach(item=>item.remove());
  });contents.sendInputEvent({type:'mouseMove',x:20,y:20});await frame();
  const editScreenshot=relatedScreenshot('edit');
  await writeFile(editScreenshot,(await contents.capturePage()).toPNG());
  await click('#composer-cancel');await waitCreate();
  await execute(()=>{
    document.getElementById('schedule-board').scrollTop=0;document.getElementById('task-list').scrollTop=0;
    document.querySelectorAll('.toast').forEach(item=>item.remove());document.activeElement?.blur();
    window.fetch=window.__scheduleTest.original;delete window.__scheduleTest;
  });contents.sendInputEvent({type:'mouseMove',x:20,y:20});await frame();
  assert.equal(service.store.data.tasks.length,5);assert.equal(service.store.data.settings.schedulerEnabled,true);assert.equal(service.runner.client.status.connected,false);
  record('final isolated preview has manual gray rows, bottom blue automatic tasks and parallel exact starts');
  return{passed,taskCount:5,preview:'five isolated examples; enabled scheduler, no connection or inference',editScreenshot,threadScreenshot,dragScreenshot,quotaScreenshots};
}
