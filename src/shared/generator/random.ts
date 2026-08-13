/**
 * Seeded PRNG. Determinism matters here: a failing generated payload has to be
 * reproducible from its seed, or debugging the generator is guesswork.
 */
export class Rng {
  private state: number;

  constructor(seed: number | string) {
    this.state =
      typeof seed === 'number'
        ? seed >>> 0
        : [...seed].reduce((acc, char) => (Math.imul(acc ^ char.charCodeAt(0), 16_777_619) >>> 0), 2_166_136_261);
    if (this.state === 0) this.state = 0x9e3779b9;
  }

  /** mulberry32 */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  }

  int(minInclusive: number, maxInclusive: number): number {
    return minInclusive + Math.floor(this.next() * (maxInclusive - minInclusive + 1));
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('Rng.pick called with an empty array');
    return items[this.int(0, items.length - 1)] as T;
  }

  /** Picks from a weighted table, e.g. sitting start times clustering at 10:00. */
  weighted<T>(entries: readonly (readonly [T, number])[]): T {
    const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
    let roll = this.next() * total;
    for (const [value, weight] of entries) {
      roll -= weight;
      if (roll <= 0) return value;
    }
    return entries[entries.length - 1]![0];
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  shuffle<T>(items: readonly T[]): T[] {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      [copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
    }
    return copy;
  }

  uuid(): string {
    const hex = '0123456789abcdef';
    let out = '';
    for (let i = 0; i < 36; i++) {
      if (i === 8 || i === 13 || i === 18 || i === 23) out += '-';
      else if (i === 14) out += '4';
      else if (i === 19) out += hex[this.int(8, 11)];
      else out += hex[this.int(0, 15)];
    }
    return out;
  }
}
