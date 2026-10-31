const { pickMessage } = require('./messages');

function createSendController({ driver, now = Date.now, cooldownMs = 1500, choose = pickMessage }) {
  let target = null;
  let busy = false;
  let nextSendAt = 0;
  let generation = 0;

  return {
    get state() { return { armed: !!target, busy, retryAfterMs: Math.max(0, nextSendAt - now()) }; },
    async arm() {
      const current = ++generation;
      target = null;
      if (busy) throw new Error('A message is still being sent. Try again in a moment.');
      const bound = await driver.bind();
      if (current !== generation) return null;
      target = bound;
      return bound;
    },
    disarm() {
      generation++;
      target = null;
      // Stop a pending native verification loop before it can press Enter.
      // Already-inserted text is left for the user to review, never rolled back.
      if (busy) driver.stop?.('Input cancelled. Check the draft before reactivating.');
    },
    async send(mode = 'ctrl-enter', text = choose()) {
      if (!target) return { status: 'unbound' };
      if (busy || now() < nextSendAt) return { status: 'cooldown' };
      if (!['enter', 'ctrl-enter', 'fill'].includes(mode)) throw new Error('Invalid submit mode');
      const bound = target;
      const current = generation;
      busy = true;
      nextSendAt = now() + cooldownMs;
      try {
        const result = await driver.send({ token: bound.token, text, mode });
        if (current !== generation) return { status: 'cancelled' };
        // Filling deliberately disarms: the draft must be handled by the user.
        if (mode === 'fill' || result.status !== 'submitted' || result.requiresRebind) target = null;
        return result;
      } catch (error) {
        // Never replay an uncertain keyboard submission or keep using stale focus.
        target = null;
        generation++;
        throw error;
      } finally {
        busy = false;
        nextSendAt = Math.max(nextSendAt, now() + cooldownMs);
      }
    },
  };
}

module.exports = { createSendController };
