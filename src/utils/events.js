/**
 * Minimal EventEmitter — browser-compatible replacement for Node's EventEmitter.
 *
 * Supports on, off, once, emit — the subset used by RNS interfaces and transport.
 */

export class EventEmitter {
  constructor() {
    this._listeners = new Map();
  }

  /**
   * Register a listener for an event.
   * @param {string} event
   * @param {Function} fn
   * @returns {this}
   */
  on(event, fn) {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, []);
    }
    this._listeners.get(event).push(fn);
    return this;
  }

  /**
   * Remove a listener.
   * @param {string} event
   * @param {Function} fn
   * @returns {this}
   */
  off(event, fn) {
    const list = this._listeners.get(event);
    if (!list) return this;
    const idx = list.indexOf(fn);
    if (idx !== -1) list.splice(idx, 1);
    return this;
  }

  /**
   * Register a one-time listener.
   * @param {string} event
   * @param {Function} fn
   * @returns {this}
   */
  once(event, fn) {
    const wrapper = (...args) => {
      this.off(event, wrapper);
      fn(...args);
    };
    wrapper._original = fn;
    return this.on(event, wrapper);
  }

  /**
   * Emit an event with arguments.
   * @param {string} event
   * @param  {...any} args
   * @returns {boolean} true if any listeners were called
   */
  emit(event, ...args) {
    const list = this._listeners.get(event);
    if (!list || list.length === 0) return false;
    // Copy the list in case listeners modify it during iteration
    for (const fn of [...list]) {
      fn(...args);
    }
    return true;
  }

  /**
   * Remove all listeners for an event, or all events if no event specified.
   * @param {string} [event]
   * @returns {this}
   */
  removeAllListeners(event) {
    if (event) {
      this._listeners.delete(event);
    } else {
      this._listeners.clear();
    }
    return this;
  }
}
