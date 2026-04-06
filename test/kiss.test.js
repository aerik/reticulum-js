import { describe, it, expect } from 'vitest';
import { kissEncode, KissFrameBuffer } from '../src/utils/kiss.js';
import { KISS_FEND, KISS_FESC, KISS_TFEND, KISS_TFESC, KISS_CMD_DATA, HEADER1_SIZE } from '../src/constants.js';
import { equal, randomBytes, concat as concatBytes } from '../src/utils/bytes.js';

describe('KISS framing', () => {
  describe('kissEncode', () => {
    it('wraps data with FEND and CMD_DATA', () => {
      const data = new Uint8Array([1, 2, 3]);
      const encoded = kissEncode(data);
      expect(encoded[0]).toBe(KISS_FEND);
      expect(encoded[1]).toBe(KISS_CMD_DATA);
      expect(encoded[encoded.length - 1]).toBe(KISS_FEND);
    });

    it('escapes FESC bytes', () => {
      const data = new Uint8Array([0x01, KISS_FESC, 0x02]);
      const encoded = kissEncode(data);
      // FESC → [FESC, TFESC] = [0xDB, 0xDD]
      expect(encoded).toContain(KISS_FESC);
      expect(encoded).toContain(KISS_TFESC);
    });

    it('escapes FEND bytes in payload', () => {
      const data = new Uint8Array([0x01, KISS_FEND, 0x02]);
      const encoded = kissEncode(data);
      // FEND in payload → [FESC, TFEND] = [0xDB, 0xDC]
      // Should not have a bare FEND in the middle
      let innerFends = 0;
      for (let i = 2; i < encoded.length - 1; i++) {
        if (encoded[i] === KISS_FEND) innerFends++;
      }
      expect(innerFends).toBe(0);
    });
  });

  describe('KissFrameBuffer', () => {
    it('extracts a complete frame', () => {
      const buf = new KissFrameBuffer();
      const payload = randomBytes(HEADER1_SIZE + 10);
      const framed = kissEncode(payload);
      const frames = buf.feed(framed);
      expect(frames).toHaveLength(1);
      expect(equal(frames[0], payload)).toBe(true);
    });

    it('handles multiple frames in one chunk', () => {
      const buf = new KissFrameBuffer();
      const p1 = randomBytes(HEADER1_SIZE);
      const p2 = randomBytes(HEADER1_SIZE + 5);
      const data = concatBytes(kissEncode(p1), kissEncode(p2));
      const frames = buf.feed(data);
      expect(frames).toHaveLength(2);
      expect(equal(frames[0], p1)).toBe(true);
      expect(equal(frames[1], p2)).toBe(true);
    });

    it('handles partial frames across feeds', () => {
      const buf = new KissFrameBuffer();
      const payload = randomBytes(HEADER1_SIZE + 20);
      const framed = kissEncode(payload);
      const mid = Math.floor(framed.length / 2);

      expect(buf.feed(framed.slice(0, mid))).toHaveLength(0);
      const frames = buf.feed(framed.slice(mid));
      expect(frames).toHaveLength(1);
      expect(equal(frames[0], payload)).toBe(true);
    });

    it('handles byte-at-a-time feeding', () => {
      const buf = new KissFrameBuffer();
      const payload = randomBytes(HEADER1_SIZE);
      const framed = kissEncode(payload);

      const allFrames = [];
      for (let i = 0; i < framed.length; i++) {
        allFrames.push(...buf.feed(new Uint8Array([framed[i]])));
      }
      expect(allFrames).toHaveLength(1);
      expect(equal(allFrames[0], payload)).toBe(true);
    });

    it('unescapes FESC/TFEND and FESC/TFESC', () => {
      const buf = new KissFrameBuffer();
      // Payload containing both special bytes
      const payload = new Uint8Array(HEADER1_SIZE + 2);
      payload.fill(0x42);
      payload[HEADER1_SIZE] = KISS_FEND;     // will be escaped
      payload[HEADER1_SIZE + 1] = KISS_FESC; // will be escaped

      const framed = kissEncode(payload);
      const frames = buf.feed(framed);
      expect(frames).toHaveLength(1);
      expect(equal(frames[0], payload)).toBe(true);
    });

    it('round-trips random data with all byte values', () => {
      const buf = new KissFrameBuffer();
      // Create payload with every byte value 0x00-0xFF
      const payload = new Uint8Array(256);
      for (let i = 0; i < 256; i++) payload[i] = i;

      const framed = kissEncode(payload);
      const frames = buf.feed(framed);
      expect(frames).toHaveLength(1);
      expect(equal(frames[0], payload)).toBe(true);
    });

    it('drops frames smaller than HEADER1_SIZE', () => {
      const buf = new KissFrameBuffer();
      const tiny = new Uint8Array([1, 2, 3]);
      const framed = kissEncode(tiny);
      const frames = buf.feed(framed);
      expect(frames).toHaveLength(0);
    });

    it('ignores non-DATA command frames', () => {
      const buf = new KissFrameBuffer();
      // Manually build a frame with command 0x01 (not CMD_DATA=0x00)
      const fake = new Uint8Array([KISS_FEND, 0x01, ...randomBytes(HEADER1_SIZE), KISS_FEND]);
      const frames = buf.feed(fake);
      expect(frames).toHaveLength(0);
    });

    it('reset clears state', () => {
      const buf = new KissFrameBuffer();
      // Feed partial frame
      buf.feed(new Uint8Array([KISS_FEND, KISS_CMD_DATA, 0x01, 0x02]));
      buf.reset();

      // New complete frame should work
      const payload = randomBytes(HEADER1_SIZE);
      const frames = buf.feed(kissEncode(payload));
      expect(frames).toHaveLength(1);
      expect(equal(frames[0], payload)).toBe(true);
    });
  });
});
