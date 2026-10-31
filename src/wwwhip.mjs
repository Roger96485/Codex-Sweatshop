import fs from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const require=createRequire(import.meta.url);
const {validateConfiguration}=require('../vendor/wwwhip/lib/configuration.js');
export const whipRoot=fileURLToPath(new URL('../vendor/wwwhip/',import.meta.url));
export function defaultWhipConfiguration(){return validateWhipConfiguration(JSON.parse(fs.readFileSync(path.join(whipRoot,'openwhip.config.json'),'utf8')));}
export function validateWhipConfiguration(value){
  try{return structuredClone(validateConfiguration(value));}
  catch{throw new Error('Invalid Whip configuration: use 1–100 single-line prompts, valid questions and supported gesture settings.');}
}

/** Owns only Whip preferences; task data and Codex configuration stay independent. */
export class WhipService extends EventEmitter {
  constructor(directory,{runtimeFactory=null,platform=process.platform}={}){
    super();this.file=path.join(directory,'wwwhip.json');this.factory=runtimeFactory;
    this.supported=platform==='win32'&&!!runtimeFactory;this.enabled=false;this.busy=false;
    this.configuration=defaultWhipConfiguration();this.error=null;this.runtime=null;this.closed=false;this.operations=Promise.resolve();
    this.restoreEnabled=false;this.storageError=false;
    if(fs.existsSync(this.file))try{
      const saved=JSON.parse(fs.readFileSync(this.file,'utf8'));
      if(saved.version!==1||typeof saved.enabled!=='boolean')throw new Error('Invalid preference structure');
      this.configuration=validateWhipConfiguration(saved.configuration);this.restoreEnabled=saved.enabled;
    }catch{this.error='Could not read Whip preferences. Review the configuration before enabling.';this.storageError=true;}
  }
  snapshot(){return {supported:this.supported,enabled:this.enabled,busy:this.busy,error:this.error,configuration:structuredClone(this.configuration)};}
  changed(){this.emit('change');}
  save(enabled,configuration){
    fs.mkdirSync(path.dirname(this.file),{recursive:true});
    if(this.storageError&&fs.existsSync(this.file))fs.copyFileSync(this.file,`${this.file}.invalid-backup`);
    const temporary=`${this.file}.${process.pid}.tmp`;
    try{fs.writeFileSync(temporary,JSON.stringify({version:1,enabled,configuration},null,2)+'\n');fs.renameSync(temporary,this.file);this.storageError=false;}
    finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
  }
  async initialize(){
    if(this.restoreEnabled&&this.supported)try{await this.apply({enabled:true,confirmed:true,configuration:this.configuration});}
    catch{/* The persisted preference remains available; a failed runtime never reports On. */}
    return this.snapshot();
  }
  apply(input){
    if(!input||typeof input!=='object'||(input.enabled!==undefined&&typeof input.enabled!=='boolean')
      ||(input.enabled===undefined&&!input.configuration))return Promise.reject(new Error('Choose a Whip setting to update.'));
    if(input.enabled&&input.confirmed!==true)return Promise.reject(new Error('Confirm the Whip reminder before enabling.'));
    let proposed;try{proposed=input.configuration?validateWhipConfiguration(input.configuration):null;}
    catch(error){return Promise.reject(error);}
    const operation=this.operations.then(async()=>{
      if(this.closed)throw new Error('Whip is closing.');
      const enabled=input.enabled??this.enabled,configuration=proposed??structuredClone(this.configuration);
      if(enabled&&!this.supported)throw new Error('Whip is available in the Windows desktop application.');
      this.busy=true;this.error=null;this.changed();
      try{
        if(enabled){
          this.runtime??=this.factory({onError:message=>{this.error=message;this.changed();}});
          await this.runtime.start(configuration);
          if(this.closed){await this.runtime.stop();throw new Error('Whip is closing.');}
        }else if(input.enabled===false)await this.runtime?.stop();
        this.save(enabled,configuration);this.configuration=configuration;this.enabled=enabled;
        return this.snapshot();
      }catch(error){
        await this.runtime?.stop();this.enabled=false;this.error=error.message;throw error;
      }finally{this.busy=false;this.changed();}
    });
    this.operations=operation.catch(()=>{});return operation.then(()=>this.snapshot());
  }
  async close(){this.closed=true;await this.runtime?.stop();await this.operations;await this.runtime?.stop();this.enabled=false;}
}
