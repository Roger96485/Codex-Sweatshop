const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { validateConfiguration, readConfiguration, writeSubmitShortcut } = require('../lib/configuration');
const sample = () => structuredClone(require('../openwhip.config.json'));
test('default configuration uses Ctrl+Enter and preserves Chinese and literal text', () => {
  const value = sample();
  value.messages.push({ question: '中文测试 🙂', message: 'Literal $HOME `command` <script>中文🙂</script>' });
  const config = validateConfiguration(value);
  assert.equal(config.submitShortcut, 'ctrl-enter');
  assert.deepEqual(config.messages.at(-1), value.messages.at(-1));
});
test('invalid or unsupported configurations fail without a message fallback', () => {
  for (const modify of [v=>v.messages=[], v=>v.messages[0].message='\n', v=>v.messages[0].message='x\ny',
    v=>v.messages[0].message='\ud800', v=>v.gesture.minimumDistance=1, v=>v.submitShortcut='ctrl-c']) {
    const value = sample(); modify(value); assert.throws(()=>validateConfiguration(value));
  }
});
test('BOM is accepted and tray changes persist in JSON without overwriting message pairs', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'openwhip-config-'));
  const file = path.join(directory, 'config.json');
  try {
    const value = sample(); value.userNote = 'Keep this field';
    fs.writeFileSync(file, '\uFEFF' + JSON.stringify(value));
    assert.equal(readConfiguration(file).submitShortcut, 'ctrl-enter');
    writeSubmitShortcut(file, 'fill');
    assert.equal(readConfiguration(file).submitShortcut, 'fill');
    assert.deepEqual(readConfiguration(file).messages, value.messages);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).userNote, 'Keep this field');
    fs.writeFileSync(file, '{');
    assert.throws(()=>readConfiguration(file));
  } finally { fs.unlinkSync(file); fs.rmdirSync(directory); }
});
