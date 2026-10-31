import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const require=createRequire(import.meta.url),execute=promisify(execFile);
const {createWindowsCodexDriver}=require('../vendor/wwwhip/lib/windows-codex.js');
const root=path.resolve('vendor/wwwhip'),output=path.resolve('test-results/wwwhip-native');fs.mkdirSync(output,{recursive:true});
const framework=path.join(process.env.SystemRoot||'C:\\Windows','Microsoft.NET','Framework64','v4.0.30319');
const executable=path.join(output,'NativeTests.exe');
await execute(path.join(framework,'csc.exe'),['/nologo','/target:exe',`/out:${executable}`,
  ...['UIAutomationClient.dll','UIAutomationTypes.dll','WindowsBase.dll'].map(name=>`/reference:${path.join(framework,'WPF',name)}`),
  path.join(root,'native','CodexInput.cs'),path.join(root,'test','NativeTests.cs')],{windowsHide:true,timeout:30000});
const result=await execute(executable,[],{windowsHide:true,timeout:15000});process.stdout.write(result.stdout);
const driver=createWindowsCodexDriver({cacheDirectory:path.join(output,'production')});
try{
  const ready=await driver.start();if(!ready.ready||ready.inputSize!==40)throw new Error('Unexpected native worker readiness');
  try{await driver.send({token:'unbound-test',text:'Never send this',mode:'enter'});throw new Error('An unbound request was accepted');}
  catch(error){if(error.code!=='binding')throw error;}
  console.log(JSON.stringify({nativeChecksPassed:Number(/Native checks passed: (\d+)/.exec(result.stdout)?.[1]),productionWorkerReady:true,unboundSendRejected:true,realDesktopInputSent:false}));
}finally{driver.stop();}
