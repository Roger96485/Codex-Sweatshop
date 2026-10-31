// The main process owns the countdown. Renderer repaint delays cannot shorten
// it, duplicate submission, or let an older selection win after a new gesture.
function createPreviewController({ onPreview, onCommit, onCancel = () => {}, onError = () => {},
  now = Date.now, schedule = setTimeout, unschedule = clearTimeout, delayMs = 3000 }) {
  let items = [];
  let cursor = -1;
  let timer = null;
  let generation = 0;
  let phase = 'idle';
  function cancel(notify = true) {
    const wasPending = phase === 'pending';
    generation++;
    unschedule(timer);
    timer = null;
    phase = 'idle';
    if (wasPending && notify) onCancel();
  }
  return {
    get phase() { return phase; },
    configure(entries) { cancel(false); items = entries.map(entry => Object.freeze({ ...entry })); cursor = -1; },
    cancel,
    trigger() {
      if (!items.length || phase === 'committing') return false;
      unschedule(timer);
      const current = ++generation;
      const index = cursor = (cursor + 1) % items.length;
      const item = items[index];
      phase = 'pending';
      const deadline = now() + delayMs;
      onPreview({ item, index, total: items.length, deadline });
      timer = schedule(async () => {
        if (generation !== current || phase !== 'pending') return;
        timer = null;
        phase = 'committing';
        try { await onCommit(item); }
        catch (error) { if (generation === current) onError(error); }
        finally { if (generation === current) phase = 'idle'; }
      }, delayMs);
      return true;
    },
  };
}
module.exports = { createPreviewController };
