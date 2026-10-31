(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OpenWhipGesture = factory();
})(globalThis, () => {
  function createGestureDetector(settings) {
    let points = [];
    let blockedUntil = 0;
    return {
      reset() { points = []; blockedUntil = 0; },
      sample(x, y, time) {
        if (![x, y, time].every(Number.isFinite)) return false;
        if (time < blockedUntil) { points = []; return false; }
        points = points.filter(point => time - point.time <= settings.windowMs && time > point.time);
        const triggered = points.some(point => {
          const elapsed = time - point.time;
          const distance = Math.hypot(x - point.x, y - point.y);
          return elapsed >= 8 && distance >= settings.minimumDistance && distance * 1000 / elapsed >= settings.minimumSpeed;
        });
        points.push({ x, y, time });
        if (triggered) { points = []; blockedUntil = time + settings.cooldownMs; }
        return triggered;
      },
    };
  }
  return { createGestureDetector };
});
