// Keep the upstream renderer intact while using external assets and a local CSP.
import fs from 'node:fs';
const root='vendor/wwwhip/',file=root+'overlay.html';let html=fs.readFileSync(file,'utf8');
if(html.includes('<style>')){
  html=html.replace(/<style>([\s\S]*?)<\/style>/,(_match,css)=>{fs.writeFileSync(root+'overlay.css',css);return '<link rel="stylesheet" href="overlay.css">';});
  html=html.replace(/<script>([\s\S]*?)<\/script>/,(_match,js)=>{fs.writeFileSync(root+'overlay.js',js);return '<script src="overlay.js"></script>';});
  html=html.replace('<meta charset="utf-8">','<meta charset="utf-8">\n<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; media-src \'self\'; img-src \'self\' data:; base-uri \'none\'; form-action \'none\'">');
  fs.writeFileSync(file,html);
}
