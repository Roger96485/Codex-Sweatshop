// Content is separate from transport so a later message picker can supply text.
const DEFAULT_MESSAGES = Object.freeze([
  'FASTER', 'FASTER', 'FASTER', 'GO FASTER',
  'Faster CLANKER', 'Work FASTER', 'Speed it up clanker',
]);

function pickMessage(random = Math.random) {
  return DEFAULT_MESSAGES[Math.floor(random() * DEFAULT_MESSAGES.length)];
}

module.exports = { DEFAULT_MESSAGES, pickMessage };
