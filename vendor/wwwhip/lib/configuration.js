const fs = require('node:fs');
const path = require('node:path');
const MODES = ['enter', 'ctrl-enter', 'fill'];
function validateConfiguration(value) {
  function requireValue(condition, message) {
    if (!condition) throw new Error(`配置错误：${message}`);
  }
  requireValue(value && value.version === 1, 'version 必须为 1。');
  requireValue(MODES.includes(value.submitShortcut), 'submitShortcut 应为 ctrl-enter、enter 或 fill。');
  requireValue(Array.isArray(value.messages) && value.messages.length > 0 && value.messages.length <= 100, 'messages 需要包含 1–100 组询问和消息。');
  const messages = value.messages.map((entry, index) => {
    for (const [key, max] of [['question', 240], ['message', 2000]]) {
      const text = entry?.[key];
      requireValue(typeof text === 'string' && text.trim().length > 0 && text.length <= max,
        `第 ${index + 1} 组 ${key} 需要包含 1–${max} 个字符。`);
      requireValue(!/[\u0000-\u001f\u007f-\u009f]/u.test(text) && text.isWellFormed(),
        `第 ${index + 1} 组 ${key} 不支持换行、控制字符或不完整的 Unicode。`);
    }
    return Object.freeze({ question: entry.question, message: entry.message });
  });
  const gesture = value.gesture;
  requireValue(gesture && typeof gesture === 'object', '缺少 gesture 设置。');
  for (const [key, min, max] of [['minimumDistance', 100, 1500], ['minimumSpeed', 1000, 15000], ['windowMs', 80, 500], ['cooldownMs', 400, 3000]]) {
    requireValue(Number.isFinite(gesture[key]) && gesture[key] >= min && gesture[key] <= max,
      `gesture.${key} 必须在 ${min}–${max} 之间。`);
  }
  return { version: 1, submitShortcut: value.submitShortcut, gesture: { ...gesture }, messages };
}
function readConfiguration(file) {
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch (error) { throw new Error(`无法读取配置 ${path.basename(file)}：${error.message}`); }
  return validateConfiguration(value);
}
function writeSubmitShortcut(file, mode) {
  const value = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  value.submitShortcut = mode;
  validateConfiguration(value);
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', 'utf8');
    fs.renameSync(temporary, file);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
module.exports = { readConfiguration, validateConfiguration, writeSubmitShortcut };
