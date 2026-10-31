import fs from 'node:fs';
import path from 'node:path';

const MAX_BYTES = 1_000_000;

/** Read the current source, never a previously saved task preview. */
export function readPromptFile(filePath) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new Error('A linked Markdown file requires an absolute local path');
  const resolved = path.resolve(filePath);
  if (!['.md','.markdown'].includes(path.extname(resolved).toLowerCase())) throw new Error('Select a Markdown file');
  let descriptor;
  try {
    descriptor = fs.openSync(resolved,'r');
    const metadata = fs.fstatSync(descriptor);
    if (!metadata.isFile() || metadata.size > MAX_BYTES) throw new Error('The Markdown file must be a file no larger than 1 MB');
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const bytes = fs.readSync(descriptor,buffer,total,buffer.length-total,null);
      if (!bytes) break;
      total += bytes;
    }
    if (total > MAX_BYTES) throw new Error('The Markdown file exceeds 1 MB');
    let text;
    try { text = new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,total)); }
    catch { throw new Error('The Markdown file must use UTF-8 encoding'); }
    if (!text.trim()) throw new Error('The Markdown file must not be empty');
    return {path:resolved,name:path.basename(resolved),text};
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('The linked Markdown file does not exist');
    if (['EACCES','EPERM'].includes(error.code)) throw new Error('Cannot read the linked Markdown file');
    throw error;
  } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}
