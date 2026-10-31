// Prepare the supplied artwork with an exact rounded-square crop, then derive platform sizes.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
if(!process.versions.electron) {
  const profile=await fs.mkdtemp(path.join(os.tmpdir(),'sweatshop-icon-'));
  const env={...process.env,SWEATSHOP_ICON_PROFILE:profile};delete env.ELECTRON_RUN_AS_NODE;
  try {
    const result=await promisify(execFile)(path.join(root,'node_modules/electron/dist/electron.exe'),
      [fileURLToPath(import.meta.url)],{cwd:root,env,windowsHide:true,timeout:30000});
    if(!result.stdout.includes('"alphaPreserved":true'))throw new Error('Icon preparation did not finish');
    process.stdout.write(result.stdout);
  }finally {
    if(path.dirname(profile)!==os.tmpdir()||!path.basename(profile).startsWith('sweatshop-icon-'))throw new Error('Invalid icon-render profile');
    await fs.rm(profile,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
}else {
  const {app,nativeImage,BrowserWindow}=await import('electron');
  if(!process.env.SWEATSHOP_ICON_PROFILE)throw new Error('Run this renderer with Node.js');
  app.setPath('userData',process.env.SWEATSHOP_ICON_PROFILE);
  void app.whenReady().then(async()=>{try {
    const original=nativeImage.createFromPath(path.join(root,'desktop/icon-source.png'));
    if(original.isEmpty())throw new Error('Application icon source is missing');
    const dimensions=original.getSize(),side=Math.min(dimensions.width,dimensions.height);
    const left=Math.floor((dimensions.width-side)/2),top=Math.floor((dimensions.height-side)/2),radius=side*.18;
    const window=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
    await window.loadURL('data:text/html,<html><body></body></html>');
    const input=original.toDataURL();
    const result=await window.webContents.executeJavaScript(`(async()=>{
      const image=new Image();image.src=${JSON.stringify(input)};await image.decode();
      const canvas=document.createElement('canvas');canvas.width=canvas.height=${side};
      const context=canvas.getContext('2d');context.beginPath();context.roundRect(0,0,${side},${side},${radius});context.clip();
      context.drawImage(image,${left},${top},${side},${side},0,0,${side},${side});return canvas.toDataURL('image/png');
    })()`);
    const source=nativeImage.createFromDataURL(result);
    const {width,height}=source.getSize(),pixels=source.toBitmap();
    let transparent=0,visible=0,maxColor=0;
    for(let i=0;i<pixels.length;i+=4) {
      if(pixels[i+3]===0)transparent++;
      else {visible++;maxColor=Math.max(maxColor,pixels[i],pixels[i+1],pixels[i+2]);}
    }
    if(width!==height||!transparent||!visible)throw new Error('A square icon with transparent corners is required');
    // Inside the antialiased corner boundary every source pixel must remain identical.
    const originalPixels=original.toBitmap();let preserved=0;
    for(let y=0;y<side;y++)for(let x=0;x<side;x++) {
      const index=(y*side+x)*4,originalIndex=((y+top)*dimensions.width+x+left)*4;
      if(pixels[index+3]!==255)continue;
      for(let channel=0;channel<4;channel++)if(pixels[index+channel]!==originalPixels[originalIndex+channel])
        throw new Error('The rounded crop changed an interior source pixel');
      preserved++;
    }
    const png=size=>source.resize({width:size,height:size,quality:'best'}).toPNG();
    const sizes=[16,20,24,32,40,48,64,128,256],frames=sizes.map(png);
    const header=Buffer.alloc(6+16*sizes.length);header.writeUInt16LE(1,2);header.writeUInt16LE(sizes.length,4);
    let offset=header.length;
    frames.forEach((frame,index)=>{
      const entry=6+index*16,size=sizes[index];header[entry]=header[entry+1]=size===256?0:size;
      header.writeUInt16LE(1,entry+4);header.writeUInt16LE(32,entry+6);
      header.writeUInt32LE(frame.length,entry+8);header.writeUInt32LE(offset,entry+12);offset+=frame.length;
    });
    const ico=Buffer.concat([header,...frames]);
    await Promise.all([
      fs.writeFile(path.join(root,'desktop/icon-rounded.png'),source.toPNG()),
      fs.writeFile(path.join(root,'desktop/icon.png'),png(512)),fs.writeFile(path.join(root,'desktop/icon.ico'),ico),
      fs.writeFile(path.join(root,'public/favicon.png'),png(64)),fs.writeFile(path.join(root,'public/favicon.ico'),ico),
    ]);
    console.log(JSON.stringify({source:{width,height,transparentPixels:transparent,visiblePixels:visible,maxColor},
      crop:{left,top,side,cornerRadius:radius,opaqueInteriorPixelsUnchanged:preserved},sizes,alphaPreserved:true}));
    app.exit(0);
  }catch(error){console.error(error);app.exit(1);}});
}
