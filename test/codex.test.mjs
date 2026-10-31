import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { CodexClient, discoverCodex, redact } from '../src/codex.mjs';

const fixture = `
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
if (process.argv.includes('--version')) {
  if (process.env.ELECTRON_RUN_AS_NODE !== '1') { console.error('JavaScript CLI discovery must run Electron as Node'); process.exit(1); }
  if (process.argv[1].includes('slow-version')) {
    setTimeout(() => { console.log('codex-cli 0.159.2'); process.exit(0); }, 200);
    await new Promise(() => {});
  }
  console.log('codex-cli 0.159.2'); process.exit(0);
}
if (process.argv[1].includes('slow-version')) appendFileSync(process.argv[1] + '.spawned', 'app-server\\n');
const reply = (id, result) => process.stdout.write(JSON.stringify({ id, result }) + '\\n');
let initialized = false;
let projectMode = 'canonical';
const projectRequests = [];
createInterface({input: process.stdin}).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') {
    if (process.env.CODEX_HOME.includes('init-failure')) {
      process.stderr.write('authorization=secret-value user=test@example.com\\n');
      process.stdout.write(JSON.stringify({id: m.id, error: {code: -32600, message: 'Initialization rejected'}}) + '\\n');
    } else if (process.env.CODEX_HOME.includes('slow-initialize')) {
      process.stdout.write(JSON.stringify({method:'test/initializing',params:{}})+'\\n');
      setTimeout(() => reply(m.id, {}), 200);
    } else reply(m.id, {codexHome: process.env.CODEX_HOME, platformFamily:'windows', platformOs:'windows', userAgent:'fixture'});
  } else if (m.method === 'initialized') initialized = true;
  else if (m.method === 'test/projectMode') { projectMode = m.params.mode; reply(m.id, true); }
  else if (m.method === 'test/projectRequests') reply(m.id, projectRequests);
  else if (m.method === 'test/echo') reply(m.id, {params: m.params, initialized, codexHome: process.env.CODEX_HOME});
  else if (m.method === 'test/never') { /* Deliberately silent. */ }
  else if (m.method === 'test/close') process.exit(8);
  else if (m.method === 'test/error') process.stdout.write(JSON.stringify({id:m.id,error:{code:-32600,message:'thread already has an active writer'}})+'\\n');
  else if (m.method === 'test/approval') {
    process.stdout.write(JSON.stringify({id: 'approval-1', method:'item/commandExecution/requestApproval', params:{threadId:'thread',turnId:'turn',itemId:'item',command:'echo test'}})+'\\n');
    reply(m.id, true);
  } else if (m.method === 'test/notification') {
    process.stdout.write(JSON.stringify({method:'turn/completed',params:{threadId:'thread',turn:{id:'turn',status:'completed'}}})+'\\n');
    reply(m.id, true);
  } else if (m.method === 'test/malformed') process.stdout.write('{bad-json}\\n');
  else if (m.method === 'model/list') reply(m.id, {data: [{model: m.params.cursor ? 'second' : 'first', supportedReasoningEfforts:[{reasoningEffort:'ultra'}],serviceTiers:[{id:'priority'}]}], nextCursor:m.params.cursor ? null : 'page-2'});
  else if (m.method === 'thread/list') reply(m.id,m.params.searchTerm === 'projects' ? {
    data:[{id:'thread-a',name:'User conversation title',cwd:'D:/Projects/repo/subdir',projectId:'project-a',status:{type:'notLoaded'},extra:{retained:true}},{id:'thread-b',cwd:'C:/Users/test/.codex/worktrees/abcdef/worktree-repo',projectId:'project-b'},{id:'thread-missing',cwd:'D:/Projects/unassigned',projectId:'missing-project'},{id:'thread-none',cwd:'D:/Projects/legacy',projectId:null}],
    nextCursor:'threads-next',backwardsCursor:'threads-back',observedParams:m.params
  } : {data:[],nextCursor:'more',observedParams:m.params});
  else if (m.method === 'project/list') {
    projectRequests.push(m.params);
    if (projectMode === 'unsupported' || (projectMode === 'partial-error' && m.params.cursor)) process.stdout.write(JSON.stringify({id:m.id,error:{code:-32601,message:'Method not found'}})+'\\n');
    else if (projectMode === 'repeated') reply(m.id,{data:[{id:'project-a',name:'Partial name'}],nextCursor:'same-cursor'});
    else if (projectMode === 'unbounded') reply(m.id,{data:[{id:'project-a',name:'Partial name'}],nextCursor:'cursor-'+projectRequests.length});
    else reply(m.id,m.params.cursor ? {data:[{id:'project-b',name:'Canonical worktree project'}],nextCursor:null} : {data:[{id:'project-a',name:'Canonical project name'}],nextCursor:'project-next'});
  }
  else if (m.method === 'account/read') reply(m.id,{account:{type:'chatgpt',email:'private@example.com',planType:'pro'},requiresOpenaiAuth:true,observedParams:m.params});
  else if (m.method === 'account/rateLimits/read') reply(m.id,{rateLimits:{primary:{usedPercent:23,windowDurationMins:300,resetsAt:1800000000}},rateLimitsByLimitId:{codex:{primary:{usedPercent:23}}}});
  else if (m.id === 'approval-1') process.stdout.write(JSON.stringify({method:'test/approvalResponse',params:{result:m.result}})+'\\n');
  else if (m.id !== undefined) reply(m.id, {});
});
`;

async function setup(t, suffix = '', binaryName = 'mock-codex.mjs') {
  const directory = await mkdtemp(path.join(tmpdir(), 'sweatshop-codex-'));
  const binary = path.join(directory, binaryName);
  await writeFile(binary, fixture);
  const home = path.join(directory, suffix || 'home');
  const client = new CodexClient({ binary, home, cwd: directory });
  t.after(async () => { await client.stop(); await rm(directory, { recursive: true, force: true }); });
  return { client, binary, home };
}

test('discovers an explicit JavaScript CLI without shell execution', async t => {
  const { binary } = await setup(t);
  const discovered = await discoverCodex({ binary });
  assert.equal(discovered.command, process.execPath);
  assert.deepEqual(discovered.args, [binary]);
  assert.equal(discovered.version, '0.159.2');
});

test('initializes once for concurrent callers and explicitly passes CODEX_HOME', async t => {
  const { client, home } = await setup(t);
  const [first, second] = await Promise.all([client.connect(), client.connect()]);
  assert.equal(first.connected, true); assert.deepEqual(first, second);
  const echoed = await client.request('test/echo', { text: '中文 Markdown\n$() `test`' });
  assert.equal(echoed.initialized, true);
  assert.equal(echoed.codexHome, home);
  assert.deepEqual(echoed.params, { text: '中文 Markdown\n$() `test`' });
});

test('preserves pagination and discovers all model efforts and speed tiers', async t => {
  const { client } = await setup(t);
  const models = await client.listModels();
  assert.deepEqual(models.map(model => model.model), ['first', 'second']);
  assert.equal(models[0].supportedReasoningEfforts[0].reasoningEffort, 'ultra');
  assert.equal(models[0].serviceTiers[0].id, 'priority');
  const threads = await client.listThreads({ search: '标题', cursor: 'old' });
  assert.equal(threads.nextCursor, 'more');
  assert.equal(threads.observedParams.searchTerm, '标题');
  assert.equal(threads.observedParams.cursor, 'old');
  assert.equal(threads.observedParams.useStateDbOnly, true);
});

test('thread project badges use canonical IDs while preserving thread metadata and pagination', async t => {
  const {client}=await setup(t);
  const page=await client.listThreads({search:'projects',cursor:'thread-old'});
  assert.equal(page.nextCursor,'threads-next');assert.equal(page.backwardsCursor,'threads-back');
  assert.equal(page.observedParams.cursor,'thread-old');assert.equal(page.observedParams.searchTerm,'projects');
  assert.equal(page.data[0].projectName,'Canonical project name');assert.equal(page.data[0].name,'User conversation title');
  assert.equal(page.data[0].cwd,'D:/Projects/repo/subdir');assert.deepEqual(page.data[0].extra,{retained:true});assert.deepEqual(page.data[0].status,{type:'notLoaded'});
  assert.equal(page.data[1].projectName,'Canonical worktree project');
  for(const thread of page.data.slice(2)) assert.equal(Object.hasOwn(thread,'projectName'),false);
  assert.deepEqual(await client.request('test/projectRequests'),[{limit:100},{limit:100,cursor:'project-next'}]);
  await client.listThreads({search:'projects',cursor:page.nextCursor});
  assert.equal((await client.request('test/projectRequests')).length,2);
});

test('concurrent thread searches share the project catalog but pages without project IDs do not read it', async t => {
  const {client}=await setup(t);
  await client.listThreads();assert.deepEqual(await client.request('test/projectRequests'),[]);
  const pages=await Promise.all([client.listThreads({search:'projects'}),client.listThreads({search:'projects'})]);
  assert.ok(pages.every(page=>page.data[0].projectName==='Canonical project name'));
  assert.equal((await client.request('test/projectRequests')).length,2);
});

test('unsupported optional project metadata leaves threads usable and does not poison the successful cache', async t => {
  const {client}=await setup(t);await client.request('test/projectMode',{mode:'unsupported'});
  const fallback=await client.listThreads({search:'projects'});
  assert.equal(fallback.nextCursor,'threads-next');assert.equal(fallback.data.length,4);
  assert.ok(fallback.data.every(thread=>!Object.hasOwn(thread,'projectName')));
  assert.equal(client.status.connected,true);assert.equal(client.status.lastError,null);
  await client.request('test/projectMode',{mode:'canonical'});
  assert.equal((await client.listThreads({search:'projects'})).data[0].projectName,'Canonical project name');
  assert.equal((await client.request('test/projectRequests')).length,3);
  await client.request('test/projectMode',{mode:'unsupported'});
  assert.equal((await client.listThreads({search:'projects'})).data[1].projectName,'Canonical worktree project');
  assert.equal((await client.request('test/projectRequests')).length,3);
  await client.stop();await client.connect();
  assert.deepEqual(await client.request('test/projectRequests'),[]);
  assert.equal((await client.listThreads({search:'projects'})).data[0].projectName,'Canonical project name');
  assert.equal((await client.request('test/projectRequests')).length,2);
});

test('partial project catalog failures are discarded without disconnecting or caching incomplete labels', async t => {
  const {client}=await setup(t);await client.request('test/projectMode',{mode:'partial-error'});
  const fallback=await client.listThreads({search:'projects'});
  assert.ok(fallback.data.every(thread=>!Object.hasOwn(thread,'projectName')));assert.equal(client.status.connected,true);
  await client.request('test/projectMode',{mode:'canonical'});
  assert.equal((await client.listThreads({search:'projects'})).data[1].projectName,'Canonical worktree project');
  assert.equal((await client.request('test/projectRequests')).length,4);
});

test('repeated project pagination cursors terminate and remain an optional metadata failure', async t => {
  const {client}=await setup(t);await client.request('test/projectMode',{mode:'repeated'});
  const fallback=await client.listThreads({search:'projects'});
  assert.ok(fallback.data.every(thread=>!Object.hasOwn(thread,'projectName')));
  assert.equal((await client.request('test/projectRequests')).length,2);assert.equal(client.status.connected,true);assert.equal(client.status.lastError,null);
  await client.request('test/projectMode',{mode:'canonical'});
  assert.equal((await client.listThreads({search:'projects'})).data[0].projectName,'Canonical project name');
});

test('project catalogs are bounded even when every page returns a different cursor', async t => {
  const {client}=await setup(t);await client.request('test/projectMode',{mode:'unbounded'});
  const fallback=await client.listThreads({search:'projects'});
  assert.ok(fallback.data.every(thread=>!Object.hasOwn(thread,'projectName')));
  assert.equal((await client.request('test/projectRequests')).length,20);assert.equal(client.status.connected,true);
});

test('reads account without forcing token refresh and retains raw quota results', async t => {
  const { client } = await setup(t);
  const account = await client.readAccount();
  assert.equal(account.observedParams.refreshToken, false);
  assert.equal(account.account.planType, 'pro');
  assert.equal((await client.readLimits()).rateLimits.primary.usedPercent, 23);
});

test('forwards approvals and notifications without automatically granting permissions', async t => {
  const { client } = await setup(t);
  await client.connect();
  const approval = once(client, 'serverRequest');
  await client.request('test/approval');
  const [request] = await approval;
  assert.equal(request.id, 'approval-1');
  assert.equal(request.method, 'item/commandExecution/requestApproval');
  const notification = once(client, 'notification');
  client.respond(request.id, { decision: 'decline' });
  const [responseNotice] = await notification;
  assert.deepEqual(responseNotice.params.result, { decision: 'decline' });
  const completed = once(client, 'notification');
  await client.request('test/notification');
  assert.equal((await completed)[0].method, 'turn/completed');
});

test('sent request timeout records uncertainty instead of retrying', async t => {
  const { client } = await setup(t);
  await client.connect();
  await assert.rejects(client.request('test/never', {}, 30), error => error.code === 'CODEX_TIMEOUT' && error.sent === true && error.uncertain === true);
  assert.equal((await client.request('test/echo')).initialized, true);
});

test('a failed initialize never reports the caller mutation as sent and redacts diagnostics', async t => {
  const { client } = await setup(t, 'init-failure');
  await assert.rejects(client.request('turn/start', { input: [], threadId: 'unused' }), error => error.code === -32600 && error.sent === false && error.uncertain === false);
  assert.equal(client.status.connected, false);
  assert.match(client.status.lastError, /Initialization rejected/);
  assert.doesNotMatch(client.status.lastError, /secret-value|test@example\.com/);
});

test('process closure rejects all pending RPCs and marks delivery as uncertain', async t => {
  const { client } = await setup(t);
  await client.connect();
  const silent = client.request('test/never', {}, 5000);
  const close = client.request('test/close', {}, 5000);
  const results = await Promise.allSettled([silent, close]);
  for (const result of results) {
    assert.equal(result.status, 'rejected');
    assert.equal(result.reason.sent, true);
    assert.equal(result.reason.uncertain, true);
  }
  assert.equal(client.status.connected, false);
});

test('writer lock rejection remains a definitive RPC error', async t => {
  const { client } = await setup(t);
  await assert.rejects(client.request('test/error'), error => error.rpcCode === -32600 && error.uncertain === false && /active writer/.test(error.message));
});

test('malformed protocol data disconnects safely without disclosing the payload', async t => {
  const { client } = await setup(t);
  await assert.rejects(client.request('test/malformed'), error => error.code === 'CODEX_PROTOCOL_ERROR');
  assert.equal(client.status.connected, false);
  assert.doesNotMatch(client.status.lastError, /bad-json/);
});

test('redacts authentication and email strings from process diagnostics', () => {
  const text = redact('Bearer abc123 refresh_token="abcXYZ" sk-longsecret123 person@example.com eyJhbGciOiJub25lIn0.payload.signature');
  assert.doesNotMatch(text, /abc123|abcXYZ|longsecret123|person@example\.com|payload/);
});

test('stop during executable discovery cancels connection before app-server can spawn', async t => {
  const { client, binary } = await setup(t, '', 'slow-version-codex.mjs');
  const connecting = client.connect();
  const rejected = assert.rejects(connecting, error => error.code === 'CODEX_STOPPED');
  await client.stop();
  await rejected;
  assert.equal(client.status.connected, false);
  const { access } = await import('node:fs/promises');
  await assert.rejects(access(binary + '.spawned'), error => error.code === 'ENOENT');
  // A deliberate new connect after stop uses a new generation and remains usable.
  await client.connect();
  assert.equal(client.status.connected, true);
  await access(binary + '.spawned');
});

test('stop during initialize tears down the child without a connect-stop deadlock', async t => {
  const { client } = await setup(t, 'slow-initialize');
  const initializing = once(client, 'notification');
  const connecting = client.connect();
  const rejected = assert.rejects(connecting, error => error.code === 'CODEX_STOPPED');
  assert.equal((await initializing)[0].method, 'test/initializing');
  await client.stop();
  await rejected;
  assert.equal(client.status.connected, false);
});
