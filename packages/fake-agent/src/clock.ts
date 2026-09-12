import type { IsoTime } from "@loom/core";

/** Explicit time only: no wall-clock sleeps or global timer replacement. */
export class FakeClock {
  private time: number;
  private sequence = 0;
  private timers = new Map<number, { at: number; callback: () => void }>();
  constructor(start = "2026-09-12T00:00:00.000Z") {
    this.time = Date.parse(start);
    if (!Number.isFinite(this.time)) throw new Error("Invalid clock start");
  }
  now = (): IsoTime => new Date(this.time).toISOString() as IsoTime;
  after(ms: number, callback: () => void): () => void {
    this.validate(ms);
    const id = ++this.sequence;
    this.timers.set(id, { at: this.time + ms, callback });
    return () => {
      this.timers.delete(id);
    };
  }
  advance(ms: number): void {
    this.validate(ms);
    const target = this.time + ms;
    let count = 0;
    while (true) {
      const next = [...this.timers]
        .filter(([, t]) => t.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      if (++count > 10000) throw new Error("Fake clock timer limit exceeded");
      this.time = next[1].at;
      this.timers.delete(next[0]);
      next[1].callback();
    }
    this.time = target;
  }
  nextDelay(): number | null {
    const next = Math.min(...[...this.timers.values()].map((t) => t.at));
    return Number.isFinite(next) ? next - this.time : null;
  }
  private validate(ms: number) {
    if (!Number.isSafeInteger(ms) || ms < 0)
      throw new Error("Clock duration must be a nonnegative safe integer");
  }
}
