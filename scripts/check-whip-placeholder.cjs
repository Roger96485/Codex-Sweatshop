const {app,BrowserWindow}=require('electron');
const path=require('node:path'),assert=require('node:assert/strict'),{execFile}=require('node:child_process'),{promisify}=require('node:util');
const execute=promisify(execFile),root=path.join(__dirname,'..','vendor','wwwhip');
const output=path.resolve(process.argv[process.argv.indexOf('--fixture-output')+1]);
app.setPath('userData',path.join(output,'profile'));
app.commandLine.appendSwitch('force-renderer-accessibility','complete');
app.on('window-all-closed',()=>{});
let fixture;
async function main(){
  await app.whenReady();app.setAccessibilitySupportEnabled(true);
  const framework=path.join(process.env.SystemRoot||'C:\\Windows','Microsoft.NET','Framework64','v4.0.30319');
  const executable=path.join(output,'PlaceholderFixture.exe');
  await execute(path.join(framework,'csc.exe'),['/nologo','/target:exe',`/out:${executable}`,'/reference:System.Web.Extensions.dll',
    ...['UIAutomationClient.dll','UIAutomationTypes.dll','WindowsBase.dll'].map(name=>`/reference:${path.join(framework,'WPF',name)}`),
    path.join(root,'native','CodexInput.cs'),path.join(root,'test','PlaceholderFixture.cs')],{windowsHide:true,timeout:30000});
  fixture=new BrowserWindow({width:750,height:800,title:'WWWhip placeholder tests',webPreferences:{contextIsolation:true,nodeIntegration:false}});
  await fixture.loadFile(path.join(root,'test','placeholder-fixture.html'));
  await new Promise(resolve=>setTimeout(resolve,200));
  const handle=fixture.getNativeWindowHandle().readBigUInt64LE().toString();
  const result=await execute(executable,[handle,String(process.pid)],{windowsHide:true,timeout:15000});
  const rows=JSON.parse(result.stdout.trim()),byId=new Map(rows.map(row=>[row.id,row]));
  for(const id of ['placeholder-0','placeholder-1','placeholder-2','old-break','plain-break','form-before','second-editor-placeholder'])assert.equal(byId.get(id)?.effective,'',`${id} must be empty`);
  for(const id of ['literal-0','literal-1','literal-2','stale-class-0','stale-class-1','stale-class-2','wrong-label','unknown-class','no-prosemirror','space','zero-width','multiline','newline-literal','other-paragraph','mixed-draft']) {
    assert.ok(byId.get(id)?.raw,`${id} must be observed`);assert.equal(byId.get(id).effective,byId.get(id).raw,`${id} must retain its draft`);
  }
  assert.equal(byId.get('placeholder-0').raw,'使用 ChatGPT Work','regression reproduces the current label-only value');
  console.log(JSON.stringify({placeholderTestsPassed:22,realDesktopInputSent:false,rows}));
}
main().then(()=>app.exit(0),error=>{console.error(error);fixture?.destroy();app.exit(1);});
