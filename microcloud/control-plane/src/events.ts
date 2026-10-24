/**
 * In-process pub/sub that feeds the SSE endpoints and lets the orchestrator wait for supervisor
 * status reports. Single CP process, so no broker is needed.
 *
 * Topics:
 *   dep:<envId>:<n>   deployment events {seq, event, data}
 *   logs:<envId>      log lines as stored
 *   sv:<envId>        supervisor status reports
 */
type Listener = (payload: unknown) => void;

export class EventBus {
  private readonly topics = new Map<string, Set<Listener>>();

  publish(topic: string, payload: unknown): void {
    const set = this.topics.get(topic);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[events] listener on ${topic} threw`, err);
      }
    }
  }

  subscribe(topic: string, fn: Listener): () => void {
    let set = this.topics.get(topic);
    if (!set) {
      set = new Set();
      this.topics.set(topic, set);
    }
    set.add(fn);
    return () => {
      set.delete(fn);
      if (set.size === 0) this.topics.delete(topic);
    };
  }
}

export const depTopic = (envId: string, n: number) => `dep:${envId}:${n}`;
export const logsTopic = (envId: string) => `logs:${envId}`;
export const svTopic = (envId: string) => `sv:${envId}`;
