import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'sweatshop-whip-input-'));
const environment={...process.env};delete environment.ELECTRON_RUN_AS_NODE;
const child=spawn(path.join(root,'node_modules','electron','dist','electron.exe'),[path.join(root,'scripts','check-whip-input.cjs'),'--fixture-output',temporary,...(process.argv.includes('--wait-for-focus')?['--wait-for-focus']:[])],
  {cwd:root,env:environment,windowsHide:true,stdio:['ignore','pipe','pipe']});
let output='',errors='',timedOut=false;
const timer=setTimeout(()=>{timedOut=true;child.kill();},90000);
try{
  const code=await new Promise((resolve,reject)=>{
    child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',chunk=>{errors+=chunk;});
    child.once('error',reject);child.once('close',resolve);
  });
  process.stdout.write(output);if(errors)process.stderr.write(errors);
  if(code!==0||timedOut||!output.includes('"nativeFixturePassed":true'))throw new Error('The isolated Windows input fixture did not pass.');
}finally{
  clearTimeout(timer);
  if(path.dirname(temporary)!==path.resolve(os.tmpdir())||!/^sweatshop-whip-input-[A-Za-z0-9]+$/.test(path.basename(temporary)))throw new Error('Invalid test cleanup path');
  await fs.rm(temporary,{recursive:true,force:true,maxRetries:20,retryDelay:100});
}
