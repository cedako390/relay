/** Keeps the tail of a text stream (about `maxChars` characters), trimming whole chunks from the front. */
export class RingBuffer {
  private chunks: string[] = [];
  private size = 0;

  constructor(private readonly maxChars: number = 256 * 1024) {}

  push(chunk: string): void {
    if (!chunk) return;
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > this.maxChars && this.chunks.length > 1) {
      this.size -= this.chunks.shift()!.length;
    }
    // A single oversized chunk: keep only its tail.
    if (this.size > this.maxChars) {
      const only = this.chunks[0]!;
      this.chunks[0] = only.slice(only.length - this.maxChars);
      this.size = this.maxChars;
    }
  }

  snapshot(): string {
    return this.chunks.join('');
  }

  get length(): number {
    return this.size;
  }
}
