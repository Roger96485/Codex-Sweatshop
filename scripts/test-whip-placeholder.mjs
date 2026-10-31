import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url))),temporary=await fs.mkdtemp(path.join(os.tmpdir(),'sweatshop-whip-placeholder-'));
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
let output='',errors='',timedOut=false;
const child=spawn(path.join(root,'node_modules','electron','dist','electron.exe'),[path.join(root,'scripts','check-whip-placeholder.cjs'),'--fixture-output',temporary],
  {cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
const timer=setTimeout(()=>{timedOut=true;child.kill();},45000);
try{
  const code=await new Promise((resolve,reject)=>{child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',chunk=>{errors+=chunk;});child.once('error',reject);child.once('close',resolve);});
  process.stdout.write(output);if(errors)process.stderr.write(errors);
  if(code!==0||timedOut)throw new Error('Read-only placeholder tests failed.');
}finally{
  clearTimeout(timer);
  if(path.dirname(temporary)!==path.resolve(os.tmpdir())||!/^sweatshop-whip-placeholder-[A-Za-z0-9]+$/.test(path.basename(temporary)))throw new Error('Invalid placeholder fixture cleanup path.');
  await fs.rm(temporary,{recursive:true,force:true,maxRetries:20,retryDelay:100});
}
