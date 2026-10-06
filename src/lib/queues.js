// Work queues between pipeline stages (ported from the frontend desk).
// In-memory, cap ~50 each; full → drop oldest, never block, never crash.

export class StageQueue {
  constructor(name, cap = 50) {
    this.name = name;
    this.cap = cap;
    this.q = [];
    this.seen = new Set();
    this.dropped = 0;
    this.pushed = 0;
  }
  keyOf(item) { return item && (item.address || item.mint); }
  push(item) {
    if (!item) return false;
    const k = this.keyOf(item);
    if (k && this.seen.has(k)) return false;
    if (this.q.length >= this.cap) {
      const old = this.q.shift();
      const ok = old && this.keyOf(old);
      if (ok) this.seen.delete(ok);
      this.dropped++;
    }
    this.q.push(item);
    if (k) this.seen.add(k);
    this.pushed++;
    return true;
  }
  unshiftFront(items) {
    for (const it of (items || [])) {
      const k = this.keyOf(it);
      if (k && this.seen.has(k)) continue;
      this.q.unshift(it);
      if (k) this.seen.add(k);
    }
  }
  drain(n) {
    const out = this.q.splice(0, n);
    for (const it of out) {
      const k = this.keyOf(it);
      if (k) this.seen.delete(k);
    }
    return out;
  }
  get size() { return this.q.length; }
  // Heat triage: reorder the queue so the hottest candidates are drained
  // first. Cold coins don't get killed — they just wait at the back, so the
  // research budget is never wasted on dead momentum.
  sortBy(fn) {
    try { this.q.sort((a, b) => fn(b) - fn(a)); } catch { /* keep order */ }
  }
  stats() { return { name: this.name, size: this.q.length, dropped: this.dropped, pushed: this.pushed }; }
}

export const Q = {
  vet: new StageQueue('vet'),
  rug: new StageQueue('rug'),
  research: new StageQueue('research'),
  score: new StageQueue('score'),
  trade: new StageQueue('trade'),
  risk: new StageQueue('risk'),
};

export function queueStats() {
  const o = {};
  for (const k of Object.keys(Q)) o[k] = Q[k].stats();
  return o;
}
