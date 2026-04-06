import { describe, it, expect } from 'vitest';
import { hdlcEncode, hdlcDecode, HdlcFrameBuffer } from '../src/utils/hdlc.js';
import { HDLC_FLAG, HDLC_ESC, HEADER1_SIZE } from '../src/constants.js';
import { equal, randomBytes, concat as concatBytes } from '../src/utils/bytes.js';

describe('HDLC framing', () => {
  describe('encode/decode round-trip', () => {
    it('round-trips simple data', () => {
      const data = new Uint8Array([1, 2, 3, 4, 5]);
      const encoded = hdlcEncode(data);
      // First and last bytes are FLAG
      expect(encoded[0]).toBe(HDLC_FLAG);
      expect(encoded[encoded.length - 1]).toBe(HDLC_FLAG);
      // Decode the inner part
      const decoded = hdlcDecode(encoded.slice(1, encoded.length - 1));
      expect(equal(decoded, data)).toBe(true);
    });

    it('escapes FLAG bytes (0x7E) in payload', () => {
      const data = new Uint8Array([0x01, HDLC_FLAG, 0x02]);
      const encoded = hdlcEncode(data);
      // The 0x7E in the middle should be escaped to [0x7D, 0x5E]
      // Total: FLAG + 0x01 + ESC + 0x5E + 0x02 + FLAG = 6 bytes
      expect(encoded.length).toBe(6);
      const decoded = hdlcDecode(encoded.slice(1, encoded.length - 1));
      expect(equal(decoded, data)).toBe(true);
    });

    it('escapes ESC bytes (0x7D) in payload', () => {
      const data = new Uint8Array([0x01, HDLC_ESC, 0x02]);
      const encoded = hdlcEncode(data);
      // The 0x7D should be escaped to [0x7D, 0x5D]
      expect(encoded.length).toBe(6);
      const decoded = hdlcDecode(encoded.slice(1, encoded.length - 1));
      expect(equal(decoded, data)).toBe(true);
    });

    it('handles payload that is all special bytes', () => {
      const data = new Uint8Array([HDLC_FLAG, HDLC_ESC, HDLC_FLAG, HDLC_ESC]);
      const encoded = hdlcEncode(data);
      const decoded = hdlcDecode(encoded.slice(1, encoded.length - 1));
      expect(equal(decoded, data)).toBe(true);
    });

    it('round-trips random data', () => {
      const data = randomBytes(100);
      const encoded = hdlcEncode(data);
      const decoded = hdlcDecode(encoded.slice(1, encoded.length - 1));
      expect(equal(decoded, data)).toBe(true);
    });
  });

  describe('HdlcFrameBuffer', () => {
    it('extracts a single complete frame', () => {
      const buf = new HdlcFrameBuffer();
      // Create a frame with >= HEADER1_SIZE bytes
      const payload = randomBytes(HEADER1_SIZE + 10);
      const framed = hdlcEncode(payload);
      const frames = buf.feed(framed);
      expect(frames).toHaveLength(1);
      expect(equal(frames[0], payload)).toBe(true);
    });

    it('extracts multiple frames from a single chunk', () => {
      const buf = new HdlcFrameBuffer();
      const p1 = randomBytes(HEADER1_SIZE);
      const p2 = randomBytes(HEADER1_SIZE + 5);
      const data = concatBytes(hdlcEncode(p1), hdlcEncode(p2));
      const frames = buf.feed(data);
      expect(frames).toHaveLength(2);
      expect(equal(frames[0], p1)).toBe(true);
      expect(equal(frames[1], p2)).toBe(true);
    });

    it('handles partial frames across multiple feeds', () => {
      const buf = new HdlcFrameBuffer();
      const payload = randomBytes(HEADER1_SIZE + 20);
      const framed = hdlcEncode(payload);

      // Split in the middle
      const mid = Math.floor(framed.length / 2);

      const frames1 = buf.feed(framed.slice(0, mid));
      expect(frames1).toHaveLength(0); // incomplete

      const frames2 = buf.feed(framed.slice(mid));
      expect(frames2).toHaveLength(1);
      expect(equal(frames2[0], payload)).toBe(true);
    });

    it('handles byte-at-a-time feeding', () => {
      const buf = new HdlcFrameBuffer();
      const payload = randomBytes(HEADER1_SIZE);
      const framed = hdlcEncode(payload);

      let allFrames = [];
      for (let i = 0; i < framed.length; i++) {
        const frames = buf.feed(new Uint8Array([framed[i]]));
        allFrames.push(...frames);
      }
      expect(allFrames).toHaveLength(1);
      expect(equal(allFrames[0], payload)).toBe(true);
    });

    it('skips frames smaller than HEADER1_SIZE', () => {
      const buf = new HdlcFrameBuffer();
      const tooSmall = new Uint8Array([1, 2, 3]); // only 3 bytes
      const framed = hdlcEncode(tooSmall);
      const frames = buf.feed(framed);
      expect(frames).toHaveLength(0); // rejected
    });

    it('discards garbage before first FLAG', () => {
      const buf = new HdlcFrameBuffer();
      const payload = randomBytes(HEADER1_SIZE);
      const framed = hdlcEncode(payload);
      const garbage = new Uint8Array([0x01, 0x02, 0x03]);
      const data = concatBytes(garbage, framed);
      const frames = buf.feed(data);
      expect(frames).toHaveLength(1);
      expect(equal(frames[0], payload)).toBe(true);
    });

    it('handles consecutive FLAG bytes (empty frames)', () => {
      const buf = new HdlcFrameBuffer();
      const payload = randomBytes(HEADER1_SIZE);
      // FLAG FLAG FLAG <encoded> FLAG
      const data = concatBytes(
        new Uint8Array([HDLC_FLAG, HDLC_FLAG, HDLC_FLAG]),
        hdlcEncode(payload)
      );
      const frames = buf.feed(data);
      expect(frames).toHaveLength(1);
      expect(equal(frames[0], payload)).toBe(true);
    });

    it('reset clears the buffer', () => {
      const buf = new HdlcFrameBuffer();
      buf.feed(new Uint8Array([HDLC_FLAG, 0x01, 0x02])); // partial frame
      buf.reset();
      // After reset, feeding a complete frame should work cleanly
      const payload = randomBytes(HEADER1_SIZE);
      const frames = buf.feed(hdlcEncode(payload));
      expect(frames).toHaveLength(1);
    });
  });
});
