import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readPromptFile } from '../src/prompt-files.mjs';

function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sweatshop-prompt-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  return path.join(dir,'任务.md');
}
test('Markdown links read current UTF-8 content and canonical file identity',t=>{
  const file=fixture(t);fs.writeFileSync(file,'# 初版\n');
  assert.deepEqual(readPromptFile(file),{path:file,name:'任务.md',text:'# 初版\n'});
  fs.writeFileSync(file,'# 新版\n内容');assert.equal(readPromptFile(file).text,'# 新版\n内容');
  fs.unlinkSync(file);assert.throws(()=>readPromptFile(file),/does not exist/);
});
test('invalid file identity, empty source, invalid encoding and excessive size fail explicitly',t=>{
  const file=fixture(t);
  assert.throws(()=>readPromptFile('relative.md'),/absolute local path/);
  assert.throws(()=>readPromptFile(file+'.txt'),/Markdown file/);
  fs.writeFileSync(file,' \n');assert.throws(()=>readPromptFile(file),/must not be empty/);
  fs.writeFileSync(file,Buffer.from([0xff,0xfe]));assert.throws(()=>readPromptFile(file),/UTF-8/);
  fs.writeFileSync(file,Buffer.alloc(1_000_001,65));assert.throws(()=>readPromptFile(file),/1 MB/);
});
