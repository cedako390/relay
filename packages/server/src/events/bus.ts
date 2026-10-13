import type { ServerEvent } from '@orch/shared';

type Listener = (event: ServerEvent) => void;

/** In-process fan-out of state changes to /ws/events subscribers. */
export class EventBus {
  private readonly listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  publish(event: ServerEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A broken subscriber must not affect others or the publisher.
      }
    }
  }
}
