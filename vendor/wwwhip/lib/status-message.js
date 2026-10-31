const messages = {
  target: '请先点击 Codex Desktop 的空白消息框，再按 Ctrl+Alt+W。',
  composer: '请点击 Codex Desktop 的主聊天、侧边聊天或 ChatGPT Chat / Work 空白消息框后重试。',
  draft: '输入框中有真实草稿。请先自行发送或清除，再激活鞭子。',
  focus: '窗口、任务或输入焦点已改变。请回到目标消息框重新激活。',
  document: '无法识别目标任务，请回到 Codex 消息框重新激活。',
  readonly: '消息框当前不可编辑，请稍后重试。',
  unreadable: '无法读取消息框内容，未发送按键。请重新激活。',
  modifier: '请松开 Ctrl、Alt、Shift 和 Windows 键后再甩动。',
  'draft-mismatch': '填入后的内容无法确认，未按发送键。请检查输入框。',
  partial: 'Windows 阻止了部分输入。请检查消息框，程序不会自动重发。',
  binding: '绑定已失效，请点击目标消息框，再按 Ctrl+Alt+W。',
  process: '无法识别前台程序，请以相同权限运行 Codex 和 Whip。',
};
module.exports = { statusMessage: error => messages[error.code] || `操作未完成：${error.message}` };
