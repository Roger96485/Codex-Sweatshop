import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Store, activeStatuses, validateSettings } from './store.mjs';
import { CodexClient, redact } from './codex.mjs';
import { Runner } from './runner.mjs';
import { planTasks, quotaWindows } from './planner.mjs';
import { readPromptFile } from './prompt-files.mjs';
import { quotaTimeline, currentQuotaWindows, planWindowActivation, cancelWindowActivation, activationModel } from './quota-windows.mjs';
import {WhipService} from './wwwhip.mjs';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const publicRoot=path.join(root,'public');
const MAX_BODY=4_000_000;
const FAST_QUOTA_REFRESH_MS=2000;

export async function createApp({dataDirectory=path.join(root,'data'),runtimeCwd=root,clientFactory=options=>new CodexClient(options),autoConnect=true,connectionRefreshMs=60000,connectionRetryMs=15000,whipRuntimeFactory=null}={}) {
  const store=new Store(dataDirectory);
  // Local wall-clock settings follow the computer automatically.
  store.data.settings.timezone=Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const options=()=>({binary:store.data.settings.binary||undefined,home:store.data.settings.codexHome||undefined,cwd:runtimeCwd});
  const client=clientFactory(options());
  const runner=new Runner(store,client);
  const streams=new Set();const token=randomBytes(32).toString('hex');
  let lastWarnings=[];let closed=false;let closing=null;
  let refreshingConnection=null;let connectionReady=false;let connectionError=null;let nextConnectionRefresh=0;
  let refreshingQuota=null;let nextQuotaRefresh=0;let lastQuotaRefresh=0;let quotaError=null;
  let initialQuotaCheckAt=null;
  const changed=()=>{if(!closed)for(const res of streams)res.write('event: change\ndata: {}\n\n');};
  const whip=new WhipService(dataDirectory,{runtimeFactory:whipRuntimeFactory});
  whip.on('change',changed);await whip.initialize();
  runner.on('change',changed);
  runner.client.on('disconnect',()=>{connectionReady=false;nextConnectionRefresh=Date.now()+connectionRetryMs;});
  const timeline=()=>quotaTimeline(runner.limits,store.data.quota,store.data.settings,store.data.tasks,Date.now(),72,{taskModels:runner.quotaTaskModels()});
  function applyPlan({refill=true}={}) {
    if(closed)return;
    const forecast=timeline();
    const plan=planTasks(store.data.tasks,store.data.settings,runner.limits,Date.now(),{preserveCommitted:refill,nodes:forecast.nodes});
    const assigned=new Map(plan.assignments.map(a=>[a.taskId,a]));
    for(const task of store.data.tasks) {
      if(!['queued','scheduled','waiting_quota','waiting_session'].includes(task.status))continue;
      const assignment=assigned.get(task.id);
      task.planningError=plan.issues?.[task.id]??null;
      if(assignment) {
        Object.assign(task,{scheduledAt:assignment.scheduledAt,windowStart:assignment.windowStart,windowEnd:assignment.windowEnd});
        const node=forecast.nodes.find(node=>node.kind==='fiveHour'&&node.time===assignment.scheduledAt);
        if(node)task.quotaNode={kind:node.kind,index:node.index,originAt:node.originAt,baseAt:node.baseAt,time:node.time};
        else delete task.quotaNode;
        if(task.status==='queued')task.status='scheduled';
      } else {task.scheduledAt=null;task.windowStart=null;task.windowEnd=null;if(task.status==='scheduled')task.status='queued';}
    }
    lastWarnings=plan.warnings;store.save();changed();return plan;
  }
  // A quota/session delay may enter reserved hours before the next periodic refill.
  runner.on('deferred',()=>applyPlan({refill:true}));
  function syncPromptFiles() {if(!closed&&store.refreshPromptFiles())changed();}
  const snapshot=()=>{syncPromptFiles();const quota=timeline();return {tasks:store.data.tasks,settings:store.data.settings,whip:whip.snapshot(),connection:{...runner.client.status,lastError:connectionError??quotaError??runner.client.status.lastError??null,account:runner.account},models:runner.models,limits:runner.limits,quota,windows:quotaWindows(runner.limits,store.data.settings,Date.now(),16,{nodes:quota.nodes}),approvals:runner.approvals,warnings:lastWarnings};};
  function quotaRefreshDelay() {
    const now=Date.now(),periods=Object.values(currentQuotaWindows(runner.limits,store.data.quota,now));
    const confirming=store.data.quota.plans.some(plan=>plan.status==='running'||plan.status==='succeeded'&&plan.confirmed==null);
    const nearReset=periods.some(period=>period.state==='anchored'&&Date.parse(period.resetAt)>now&&Date.parse(period.resetAt)-now<=15000);
    const due=store.data.quota.plans.some(plan=>plan.status==='scheduled'
      && Math.max(Date.parse(plan.activationAt),Date.parse(plan.notBefore??plan.activationAt))<=now+15000);
    const unknown=periods.some(period=>period.state==='unknown');
    if(unknown)initialQuotaCheckAt??=now;else initialQuotaCheckAt=null;
    const initialCheck=unknown&&now-initialQuotaCheckAt<20000;
    return confirming||nearReset||due||initialCheck?Math.min(FAST_QUOTA_REFRESH_MS,connectionRefreshMs):connectionRefreshMs;
  }
  function applyQuotaRefresh(previousReset,firstConnection=false) {
    const current=timeline().periods.fiveHour;
    applyPlan({refill:!firstConnection&&!(current?.state==='anchored'&&current.resetAt!==previousReset)});
  }
  async function refreshConnection() {
    if(closed||!autoConnect||runner.suspended||runner.active)return false;
    if(refreshingConnection)return refreshingConnection;
    const operation=(async()=>{
      try {
        const firstConnection=!connectionReady;
        const previousReset=timeline().periods.fiveHour?.resetAt;
        await runner.refresh();
        if(closed)return false;
        connectionReady=true;connectionError=null;quotaError=null;nextConnectionRefresh=Date.now()+connectionRefreshMs;
        lastQuotaRefresh=Date.now();nextQuotaRefresh=lastQuotaRefresh+quotaRefreshDelay();
        applyQuotaRefresh(previousReset,firstConnection);
        void runner.inspectTaskModels({force:true}).then(changed).catch(()=>{});
        return true;
      } catch(error) {
        if(!closed){connectionReady=false;connectionError=redact(error.message);nextConnectionRefresh=Date.now()+connectionRetryMs;changed();}
        return false;
      }
    })();
    refreshingConnection=operation;
    try{return await operation;}finally{if(refreshingConnection===operation)refreshingConnection=null;}
  }
  async function refreshQuota() {
    if(closed||!autoConnect||runner.suspended||!connectionReady||!runner.client.status.connected)return false;
    if(refreshingQuota)return refreshingQuota;
    if(refreshingConnection)return refreshingConnection;
    const operation=(async()=>{
      try {
        const previousReset=timeline().periods.fiveHour?.resetAt;
        await runner.refreshQuota();
        if(closed)return false;
        quotaError=null;lastQuotaRefresh=Date.now();nextQuotaRefresh=lastQuotaRefresh+quotaRefreshDelay();
        applyQuotaRefresh(previousReset);
        // Long-running tasks still allow read-only identity checks for queued tasks.
        void runner.inspectTaskModels().then(changed).catch(()=>{});
        return true;
      } catch(error) {
        if(!closed){quotaError=redact(error.message);nextQuotaRefresh=Date.now()+connectionRetryMs;changed();}
        return false;
      }
    })();
    refreshingQuota=operation;
    try{return await operation;}finally{if(refreshingQuota===operation)refreshingQuota=null;}
  }
  function replanAutomatic() {
    for(const task of store.data.tasks)if(['queued','scheduled','waiting_quota','waiting_session'].includes(task.status)&&task.schedule?.mode==='auto') {
      task.scheduledAt=null;task.windowStart=null;task.windowEnd=null;
    }
    return applyPlan();
  }
  const confirmQuota=()=>{nextQuotaRefresh=0;void refreshQuota();};
  runner.on('turnFinished',confirmQuota);
  runner.on('quotaUpdated',confirmQuota);
  function json(res,status,value){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));}
  function authenticated(req) {
    const match=(req.headers.cookie??'').match(/(?:^|;\s*)sweatshop_session=([a-f0-9]+)/);
    return !!match&&match[1].length===token.length&&timingSafeEqual(Buffer.from(match[1]),Buffer.from(token));
  }
  async function body(req) {
    if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']??''))throw new Error('Requests must use JSON');
    let bytes=0;const parts=[];
    for await(const part of req){bytes+=part.length;if(bytes>MAX_BODY)throw new Error('Request body is too large');parts.push(part);}
    const parsed=JSON.parse(Buffer.concat(parts).toString('utf8')||'{}');
    if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error('Invalid request structure');return parsed;
  }
  const server=http.createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Cache-Control','no-store');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    const address=server.address();const port=address?.port;
    const hosts=new Set([`127.0.0.1:${port}`,`localhost:${port}`]);
    if(!hosts.has(req.headers.host))return json(res,403,{error:'Only local access is allowed'});
    const url=new URL(req.url,`http://${req.headers.host}`);
    const origin=req.headers.origin;
    if(origin&&!['http://127.0.0.1:'+port,'http://localhost:'+port].includes(origin))return json(res,403,{error:'Invalid request origin'});
    if(req.headers['sec-fetch-site']==='cross-site')return json(res,403,{error:'Cross-site requests are rejected'});
    try {
      if(closed)return json(res,503,{error:'The service is closing'});
      if(url.pathname.startsWith('/api/')) {
        if(!authenticated(req))return json(res,401,{error:'Reopen the tool from its local page'});
        if(req.method==='GET') {
          if(url.pathname==='/api/state')return json(res,200,snapshot());
          if(url.pathname==='/api/window-plans')return json(res,200,{dataDirectory:path.dirname(store.file),
            observations:store.data.quota.observations,
            plans:store.data.quota.plans.map(({accountId,task,...plan})=>({...plan,
              task:task?{status:task.status,lastError:task.lastError,model:task.model??null,effort:task.effort??null,runs:task.runs}:null}))});
          if(url.pathname==='/api/prompt-file')return json(res,200,readPromptFile(url.searchParams.get('path')));
          if(url.pathname==='/api/events') {
            res.writeHead(200,{'Content-Type':'text/event-stream','Connection':'keep-alive'});res.write('event: change\ndata: {}\n\n');streams.add(res);
            res.on('close',()=>streams.delete(res));return;
          }
          if(url.pathname==='/api/threads')return json(res,200,await runner.client.listThreads({search:url.searchParams.get('search')||undefined,cursor:url.searchParams.get('cursor')||undefined}));
          return json(res,404,{error:'API endpoint not found'});
        }
        const input=await body(req);
        if(req.method==='POST'&&url.pathname==='/api/whip'){await whip.apply(input);return json(res,200,whip.snapshot());}
        if(req.method==='POST'&&url.pathname==='/api/shutdown') {
          if(runner.active)throw new Error('Stop the running task in the interface before closing the service');
          json(res,200,{ok:true});setTimeout(()=>{void close();},50);return;
        }
        if(req.method==='POST'&&url.pathname==='/api/tasks') {const task=store.create(input);await runner.inspectTaskModels({tasks:[task]});applyPlan();return json(res,201,task);}
        if(req.method==='POST'&&url.pathname==='/api/tasks/reorder') {store.reorderAuto(input.taskIds);replanAutomatic();return json(res,200,snapshot());}
        if(req.method==='POST'&&url.pathname==='/api/plan') {
          return json(res,200,replanAutomatic());
        }
        if(req.method==='POST'&&url.pathname==='/api/window-plans') {
          activationModel(runner.models);
          const plan=planWindowActivation(store.data.quota,timeline(),input);store.save();replanAutomatic();
          if(autoConnect&&connectionReady&&runner.client.status.connected&&!refreshingConnection)
            void runner.tick().catch(error=>{console.error(redact(error.message));});
          return json(res,201,{plan,snapshot:snapshot()});
        }
        const windowPlan=url.pathname.match(/^\/api\/window-plans\/([^/]+)$/);
        if(req.method==='DELETE'&&windowPlan) {
          cancelWindowActivation(store.data.quota,windowPlan[1]);store.save();replanAutomatic();return json(res,200,snapshot());
        }
        if(req.method==='POST'&&url.pathname==='/api/settings') {
          const {binary,codexHome,timezone,...editableSettings}=input;
          if(editableSettings.startingFrom && editableSettings.startingFrom!=='now'
            && !timeline().nodes.some(node=>node.kind==='fiveHour' && node.time===editableSettings.startingFrom))
            throw new Error('Select an available five-hour node.');
          const settings=validateSettings(editableSettings,store.data.settings);
          settings.schedulerEnabled=true;
          settings.timezone=Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
          store.data.settings=settings;store.save();
          replanAutomatic();return json(res,200,snapshot());
        }
        const approval=url.pathname.match(/^\/api\/approvals\/([^/]+)$/);
        if(req.method==='POST'&&approval) {runner.approve(approval[1],input);return json(res,200,snapshot());}
        const action=url.pathname.match(/^\/api\/tasks\/([^/]+)\/action$/);
        if(req.method==='POST'&&action) {
          const task=store.get(action[1]);
          if(input.action==='cancel')await runner.cancel(task);
          else if(input.action==='run') {
            if(activeStatuses.has(task.status))throw new Error('This task is already running');
            if(runner.active)throw new Error('Another task is already running');
            delete task.preflightRetry;
            void runner.launch(task); // Intent is reserved synchronously by launch before response.
          } else if(input.action==='pause') {if(activeStatuses.has(task.status))throw new Error('Use Stop execution instead');task.status='paused';store.save();changed();}
          else if(['resume','retry'].includes(input.action)) {
            if(activeStatuses.has(task.status))throw new Error('This task is already running');
            task.status='queued';task.scheduledAt=null;task.notBefore=new Date(Date.now()+5000).toISOString();task.lastError=null;
            delete task.preflightRetry;
            if(input.action==='retry') task.schedule={mode:'exact',at:task.notBefore};
            applyPlan();
          } else throw new Error('Invalid task action');
          return json(res,200,snapshot());
        }
        const taskPath=url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
        if(taskPath&&req.method==='PUT'){
          if(input.quotaNodeId) {
            const node=timeline().nodes.find(node=>node.id===input.quotaNodeId&&node.kind==='fiveHour'&&node.startWindow!==false);
            const requested=input.schedule?.mode==='window'?input.schedule.windowStart:input.schedule?.mode==='exact'?input.schedule.at:null;
            if(!node||!requested||Date.parse(node.time)!==Date.parse(requested))
              throw new Error('The quota timeline changed while dragging. Refresh and drag the task again.');
          }
          const task=store.update(taskPath[1],input);await runner.inspectTaskModels({tasks:[task]});applyPlan();return json(res,200,task);
        }
        if(taskPath&&req.method==='DELETE'){store.delete(taskPath[1]);applyPlan();return json(res,200,{ok:true});}
        return json(res,404,{error:'API endpoint not found'});
      }
      if(req.method!=='GET')return json(res,405,{error:'Unsupported request method'});
      const files={'/':'index.html','/index.html':'index.html','/app.js':'app.js','/wwwhip.js':'wwwhip.js','/styles.css':'styles.css','/favicon.png':'favicon.png','/favicon.ico':'favicon.ico','/schedule-geometry.mjs':'schedule-geometry.mjs','/elicitation.mjs':'elicitation.mjs'};
      const filename=files[url.pathname];if(!filename)return json(res,404,{error:'File not found'});
      if(filename==='index.html')res.setHeader('Set-Cookie',`sweatshop_session=${token}; HttpOnly; SameSite=Strict; Path=/`);
      res.setHeader('Content-Type',filename.endsWith('.html')?'text/html; charset=utf-8':/\.(m?js)$/.test(filename)?'text/javascript; charset=utf-8':filename.endsWith('.png')?'image/png':filename.endsWith('.ico')?'image/x-icon':'text/css; charset=utf-8');
      res.end(fs.readFileSync(path.join(publicRoot,filename)));
    } catch(error){json(res,400,{error:redact(error.message)});}
  });
  let lastRefill=0;
  const ticker=setInterval(()=>{
    if(closed)return;
    runner.expireConfirmations();
    syncPromptFiles();
    if(store.data.settings.schedulerEnabled&&Date.now()-lastRefill>30000){lastRefill=Date.now();applyPlan({refill:true});}
    if(autoConnect&&connectionReady&&runner.client.status.connected&&!refreshingConnection)void runner.tick().catch(error=>{console.error(redact(error.message));});
  },1000);
  const connectionTimer=autoConnect?setInterval(()=>{
    if(closed)return;
    const now=Date.now();
    if(!connectionReady||!runner.client.status.connected||now>=nextConnectionRefresh&&!runner.active) {
      if(now>=nextConnectionRefresh)void refreshConnection();
    } else if(now>=nextQuotaRefresh || quotaError===null&&now-lastQuotaRefresh>=quotaRefreshDelay())void refreshQuota();
  },Math.max(10,Math.min(1000,connectionRefreshMs,connectionRetryMs))):null;
  const heartbeat=setInterval(()=>{for(const stream of streams)stream.write(': keepalive\n\n');},20000);
  function close() {
    if(closing)return closing;
    closed=true;clearInterval(ticker);clearInterval(heartbeat);clearInterval(connectionTimer);runner.suspendForShutdown();
    closing=(async()=>{
      try {
        // stop() invalidates pending connection discovery and records running turns as uncertain.
        try{await whip.close();}finally{
          try{await runner.client.stop();}finally{
            for(const stream of streams)stream.end();
            await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
          }
        }
      } finally {store.close();}
    })();
    return closing;
  }
  if(autoConnect)void refreshConnection();
  return {server,store,runner,whip,applyPlan,snapshot,refreshConnection,refreshQuota,close};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const port=Number(process.env.SWEATSHOP_PORT??4317);
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid SWEATSHOP_PORT');
  const app=await createApp({dataDirectory:process.env.SWEATSHOP_DATA_DIR||undefined});
  app.server.on('error',error=>{console.error(`Cannot start the service: ${error.message}`);app.store.close();process.exit(1);});
  app.server.listen(port,'127.0.0.1',()=>{console.log(`Codex Sweatshop → http://127.0.0.1:${port}`);console.log('Codex account and quota are read automatically. New tasks await scheduling; scheduled tasks run when due. Keep this service running for tasks to start on time.');});
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{void app.close().then(()=>process.exit(0));});
}
