import fs from 'node:fs/promises';
import path from 'node:path';
import {homedir} from 'node:os';

function fail(message){throw new Error(`${message} Nothing was sent.`);}
function shortcut(key){
  if(typeof key!=='string'||/\s/.test(key.trim()))return null;
  const parts=key.trim().toLowerCase().split('+');
  if(parts.length===1&&parts[0]==='enter')return 'enter';
  if(parts.length===2&&parts.includes('enter')&&parts.some(part=>['ctrl','control','cmdorctrl','commandorcontrol'].includes(part)))return 'ctrl-enter';
  return null;
}

export function codexSubmitShortcut({desktop={},legacy={},bindings=[]}={},text=''){
  if(!Array.isArray(bindings)||bindings.some(item=>!item||typeof item.command!=='string'||!(item.key===null||typeof item.key==='string')))
    fail('Could not read Codex keyboard shortcuts.');
  const custom=bindings.filter(item=>item.command==='composer.submit');
  if(custom.length){
    if(custom.some(item=>item.key===null))fail('Sending is disabled in Codex keyboard shortcuts.');
    const supported=custom.map(item=>shortcut(item.key)).find(Boolean);
    if(!supported)fail('Whip supports Enter or Ctrl+Enter for the Codex send shortcut.');
    return supported;
  }
  const behavior=desktop.composerEnterBehavior??legacy['electron-persisted-atom-state']?.['enter-behavior']??legacy.composerEnterBehavior??'enter';
  if(behavior==='cmdAlways')return 'ctrl-enter';
  if(behavior==='enter')return 'enter';
  if(behavior==='cmdIfMultiline')return /[\r\n]/.test(text)?'ctrl-enter':'enter';
  fail('Could not identify the Codex Enter setting.');
}

async function optionalJson(file,fallback){
  try{return JSON.parse((await fs.readFile(file,'utf8')).replace(/^\uFEFF/,''));}
  catch(error){if(error.code==='ENOENT')return fallback;fail('Could not read Codex keyboard settings.');}
}

/** Read on every send; never write Codex settings or use Whip's legacy manual mode. */
export async function readCodexSubmitShortcut(client,text){
  const response=await client.request('config/read',{includeLayers:false,cwd:null});
  if(!response.config||typeof response.config!=='object')fail('Could not read Codex settings.');
  const directory=client.status.home||process.env.CODEX_HOME||path.join(homedir(),'.codex');
  const [bindings,legacy]=await Promise.all([
    optionalJson(path.join(directory,'keybindings.json'),[]),
    response.config.desktop?.composerEnterBehavior==null?optionalJson(path.join(directory,'.codex-global-state.json'),{}):{},
  ]);
  return codexSubmitShortcut({desktop:response.config.desktop,legacy,bindings},text);
}
