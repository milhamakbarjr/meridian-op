import { EventEmitter } from "node:events";

/**
 * Singleton event bus. Bot internals call `bus.emit(type, payload)`; the
 * dashboard WebSocket handler subscribes and fans events out to clients.
 *
 * Stock Node EventEmitter — if nobody is listening, events drop silently.
 * That guarantees zero overhead when DASHBOARD_ENABLED=false.
 */
class DashboardBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(64);
    this._seq = 0;
  }

  /**
   * Emit a dashboard event with auto-incremented sequence number. WebSocket
   * clients use `seq` to detect dropped frames and trigger a snapshot refetch.
   */
  publish(type, data = {}) {
    const frame = {
      type,
      ts: new Date().toISOString(),
      seq: ++this._seq,
      data,
    };
    this.emit("event", frame);
    this.emit(type, frame);
    return frame;
  }

  currentSeq() {
    return this._seq;
  }
}

export const bus = new DashboardBus();
