import { describe, it, expect } from 'vitest';
import { EventEmitter } from '../src/utils/events.js';

describe('EventEmitter', () => {
  it('emits events to listeners', () => {
    const ee = new EventEmitter();
    let called = false;
    ee.on('test', () => { called = true; });
    ee.emit('test');
    expect(called).toBe(true);
  });

  it('passes arguments to listeners', () => {
    const ee = new EventEmitter();
    let received = null;
    ee.on('data', (a, b) => { received = [a, b]; });
    ee.emit('data', 'hello', 42);
    expect(received).toEqual(['hello', 42]);
  });

  it('supports multiple listeners', () => {
    const ee = new EventEmitter();
    const calls = [];
    ee.on('x', () => calls.push(1));
    ee.on('x', () => calls.push(2));
    ee.emit('x');
    expect(calls).toEqual([1, 2]);
  });

  it('returns false when no listeners', () => {
    const ee = new EventEmitter();
    expect(ee.emit('nothing')).toBe(false);
  });

  it('returns true when listeners called', () => {
    const ee = new EventEmitter();
    ee.on('x', () => {});
    expect(ee.emit('x')).toBe(true);
  });

  describe('off', () => {
    it('removes a specific listener', () => {
      const ee = new EventEmitter();
      let count = 0;
      const fn = () => { count++; };
      ee.on('x', fn);
      ee.emit('x');
      expect(count).toBe(1);

      ee.off('x', fn);
      ee.emit('x');
      expect(count).toBe(1); // not called again
    });

    it('does nothing for non-existent listener', () => {
      const ee = new EventEmitter();
      ee.off('x', () => {}); // should not throw
    });
  });

  describe('once', () => {
    it('fires only once', () => {
      const ee = new EventEmitter();
      let count = 0;
      ee.once('x', () => { count++; });
      ee.emit('x');
      ee.emit('x');
      ee.emit('x');
      expect(count).toBe(1);
    });

    it('passes arguments', () => {
      const ee = new EventEmitter();
      let val = null;
      ee.once('x', (v) => { val = v; });
      ee.emit('x', 42);
      expect(val).toBe(42);
    });
  });

  describe('removeAllListeners', () => {
    it('removes all listeners for an event', () => {
      const ee = new EventEmitter();
      let count = 0;
      ee.on('x', () => { count++; });
      ee.on('x', () => { count++; });
      ee.removeAllListeners('x');
      ee.emit('x');
      expect(count).toBe(0);
    });

    it('removes all listeners for all events', () => {
      const ee = new EventEmitter();
      let count = 0;
      ee.on('a', () => { count++; });
      ee.on('b', () => { count++; });
      ee.removeAllListeners();
      ee.emit('a');
      ee.emit('b');
      expect(count).toBe(0);
    });
  });

  describe('edge cases', () => {
    it('listener removing itself during emit', () => {
      const ee = new EventEmitter();
      const calls = [];
      const fn1 = () => {
        calls.push(1);
        ee.off('x', fn1); // remove self during iteration
      };
      const fn2 = () => { calls.push(2); };
      ee.on('x', fn1);
      ee.on('x', fn2);
      ee.emit('x');
      expect(calls).toEqual([1, 2]); // fn2 should still fire
    });

    it('chaining on() calls', () => {
      const ee = new EventEmitter();
      const result = ee.on('a', () => {}).on('b', () => {});
      expect(result).toBe(ee);
    });
  });
});
