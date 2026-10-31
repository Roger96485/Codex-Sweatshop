import {BrowserWindow,ipcMain,screen,globalShortcut} from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {whipRoot} from '../src/wwwhip.mjs';
import {loadAppIcon} from './app-icon.mjs';

const require=createRequire(import.meta.url);
const {createWindowsCodexDriver}=require('../vendor/wwwhip/lib/windows-codex.js');
const {createSendController}=require('../vendor/wwwhip/lib/send-controller.js');
const {createPreviewController}=require('../vendor/wwwhip/lib/preview-controller.js');
const HOTKEY='Control+Alt+W',HIDE_HOTKEY='Control+Alt+Escape';
const messages={target:'Click an empty Codex composer, then press Ctrl+Alt+W.',composer:'Focus an empty Codex composer and try again.',
  draft:'The composer contains a draft. Send or clear it first.',focus:'The target chat or focus changed. Activate Whip again.',
  document:'The target chat could not be identified.',readonly:'The composer is not editable.',unreadable:'The composer could not be read. Nothing was sent.',
  modifier:'Release Ctrl, Alt, Shift and Windows before whipping.',binding:'The chat binding expired. Activate Whip again.',
  'draft-mismatch':'The inserted text could not be confirmed. Review the draft.',partial:'Input was interrupted. Review the draft; it will not be resent.',
  process:'Run Codex and Sweatshop at the same privilege level.'};

/** Runs inside Sweatshop's Electron lifecycle: no second application or tray. */
export function createWhipRuntime({cacheDirectory,onError=()=>{},driver=null,shortcuts=globalShortcut,readSubmitShortcut}={}){
  const bundled=path.join(whipRoot,'native','OpenWhip.Input.exe');
  driver??=createWindowsCodexDriver({cacheDirectory,...(fs.existsSync(bundled)?{build:async()=>bundled}:{})});
  const sender=createSendController({driver});
  let enabled=false,configuration=null,overlay=null,ready=false,activating=false,generation=0;
  let introTimer=null,dropTimer=null,errorTimer=null,strike=null,strikeSequence=0,escapeRegistered=false;
  let lastStatus={text:'',kind:'info',ready:false};
  const ownedShortcuts=new Set();
  const publish=(text,kind='info',details={})=>{
    lastStatus={text,kind,ready:enabled,...details};
    if(ready&&overlay&&!overlay.isDestroyed())overlay.webContents.send('wwwhip:whip-status',lastStatus);
  };
  const showError=error=>{
    const message=messages[error.code]??error.message;
    publish(message,'error',{ready:false,pending:false});onError(message);
    clearTimeout(errorTimer);errorTimer=setTimeout(hide,1600);
  };
  const preview=createPreviewController({delayMs:2000,
    onPreview:({item,index,total,deadline})=>publish(`Whip again to switch (${index+1}/${total}) · Press Esc to cancel`,'info',
      {question:item.question,deadline,durationMs:2000,pending:true}),
    onCommit:sendSelected,onCancel:hide,onError:showError});
  function hide(){
    generation++;clearTimeout(introTimer);clearTimeout(dropTimer);clearTimeout(errorTimer);
    introTimer=dropTimer=errorTimer=null;preview.cancel(false);sender.disarm();
    if(escapeRegistered){shortcuts.unregister('Escape');escapeRegistered=false;ownedShortcuts.delete('Escape');}
    strike?.reject(new Error('Whip cancelled.'));strike=null;
    if(overlay&&!overlay.isDestroyed()){overlay.webContents.send('wwwhip:stop-whip');overlay.hide();}
  }
  function drop(){
    clearTimeout(introTimer);introTimer=null;preview.cancel(false);generation++;sender.disarm();
    strike?.reject(new Error('Whip cancelled.'));strike=null;
    if(!overlay||overlay.isDestroyed())return;
    overlay.setIgnoreMouseEvents(true);overlay.webContents.send('wwwhip:drop-whip');
    clearTimeout(dropTimer);dropTimer=setTimeout(hide,700);
  }
  function escape(){if(preview.phase==='pending')preview.cancel();else hide();}
  function introduce(){
    if(!enabled||!ready||!overlay?.isVisible())return;
    const cursor=screen.getCursorScreenPoint(),bounds=overlay.getBounds(),current=generation;
    overlay.webContents.send('wwwhip:configure-whip',configuration.gesture);
    overlay.webContents.send('wwwhip:spawn-whip',{x:cursor.x-bounds.x,y:cursor.y-bounds.y});
    publish('Press Esc to SPARE.','info',{question:'WHIP me to urge me on.',pending:true,deadline:Date.now()+3000,durationMs:3000});
    clearTimeout(introTimer);introTimer=setTimeout(()=>{if(current===generation)hide();},3000);
  }
  function createOverlay(){
    const window=overlay=new BrowserWindow({ ...screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).bounds,
      transparent:true,frame:false,alwaysOnTop:true,focusable:false,skipTaskbar:true,resizable:false,hasShadow:false,show:false,icon:loadAppIcon(),
      webPreferences:{preload:path.join(whipRoot,'preload.js'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false,
        webSecurity:true,allowRunningInsecureContent:false,partition:'wwwhip-overlay'}});
    window.setTitle('Whip · Codex');window.setAlwaysOnTop(true,'screen-saver');window.setOpacity(.99);ready=false;
    window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    window.webContents.on('will-navigate',event=>event.preventDefault());
    window.webContents.session.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
    window.webContents.session.setPermissionCheckHandler(()=>false);
    window.webContents.on('did-finish-load',()=>{if(overlay!==window)return;ready=true;introduce();});
    window.on('closed',()=>{if(overlay!==window)return;hide();overlay=null;ready=false;});
    void window.loadFile(path.join(whipRoot,'overlay.html')).catch(showError);
  }
  async function activate(){
    if(!enabled||activating)return;
    if(sender.state.busy){hide();return;}
    if(overlay?.isVisible()){drop();return;}
    activating=true;const current=++generation;
    try{
      preview.configure(configuration.messages);
      const bound=await sender.arm();if(!bound||!enabled||current!==generation)return;
      escapeRegistered=shortcuts.register('Escape',escape);
      if(!escapeRegistered){sender.disarm();throw new Error('Escape is already in use. Release it before activating Whip.');}
      ownedShortcuts.add('Escape');
      if(!overlay)createOverlay();
      overlay.setBounds(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).bounds);
      overlay.setIgnoreMouseEvents(false);overlay.showInactive();if(ready)introduce();
    }catch(error){if(enabled&&current===generation)showError(error);}
    finally{activating=false;}
  }
  function automaticStrike(){
    return new Promise((resolve,reject)=>{
      const id=++strikeSequence,timer=setTimeout(()=>{if(strike?.id===id)strike=null;reject(new Error('Whip animation did not respond. Nothing was sent.'));},2500);
      strike={id,resolve:()=>{clearTimeout(timer);resolve();},reject:error=>{clearTimeout(timer);reject(error);}};
      overlay.webContents.send('wwwhip:auto-strike',{id});
    });
  }
  async function sendSelected(item){
    if(!enabled||!overlay?.isVisible()||!sender.state.armed||sender.state.busy)return;
    const current=generation;
    try{
      publish('Sending command...','info',{question:item.question,ready:false,pending:false});
      await automaticStrike();if(!enabled||current!==generation)return;
      if(!readSubmitShortcut)throw new Error('Could not read Codex send settings. Nothing was sent.');
      const mode=await readSubmitShortcut(item.message);
      if(!enabled||current!==generation)return;
      const result=await sender.send(mode,item.message);
      if(!enabled||current!==generation)return;
      if(result.status==='submitted'||result.status==='filled'){hide();return;}
      throw new Error(result.status==='unconfirmed'?'Submission was not confirmed. Review the chat; it will not be resent.':'Activate Whip again before sending.');
    }catch(error){if(enabled&&current===generation){sender.disarm();showError(error);}}
  }
  function trusted(event){return enabled&&overlay&&!overlay.isDestroyed()&&overlay.isVisible()&&event.sender===overlay.webContents
    &&event.senderFrame===overlay.webContents.mainFrame&&event.senderFrame.url===pathToFileURL(path.join(whipRoot,'overlay.html')).href;}
  ipcMain.on('wwwhip:whip-crack',event=>{if(!trusted(event)||!sender.state.armed||sender.state.busy)return;clearTimeout(introTimer);introTimer=null;preview.trigger();});
  ipcMain.on('wwwhip:strike-impact',(event,id)=>{if(!trusted(event)||strike?.id!==id)return;strike.resolve();strike=null;});
  ipcMain.on('wwwhip:hide-overlay',event=>{if(trusted(event))hide();});
  ipcMain.on('wwwhip:disarm-whip',event=>{if(trusted(event))drop();});
  function stop(){
    enabled=false;hide();driver.stop();
    for(const key of ownedShortcuts)shortcuts.unregister(key);ownedShortcuts.clear();
    if(overlay&&!overlay.isDestroyed())overlay.destroy();overlay=null;ready=false;
  }
  return {
    async start(config){
      stop();configuration=structuredClone(config);
      try{
        const ping=await driver.start();if(!ping?.ready)throw new Error('The Windows input helper is not ready.');
        for(const [key,callback] of [[HOTKEY,()=>{void activate();}],[HIDE_HOTKEY,hide]]){
          if(!shortcuts.register(key,callback))throw new Error(`${key.replaceAll('Control','Ctrl')} is already in use. Close the standalone Whip and try again.`);
          ownedShortcuts.add(key);
        }
        enabled=true;
      }catch(error){stop();throw error;}
    },stop,activate,
    get overlay(){return overlay;},get status(){return {...lastStatus,enabled,phase:preview.phase};},
  };
}
