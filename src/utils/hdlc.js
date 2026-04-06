/**
 * HDLC-like framing for RNS TCP interfaces.
 *
 * Matches the Python reference implementation framing.
 *
 * Frame format: [FLAG] [escaped payload] [FLAG]
 * Where FLAG = 0x7E, ESC = 0x7D, ESC_MASK = 0x20
 *
 * Escape rules (order matters):
 *   Encode: replace 0x7D with [0x7D, 0x5D], then replace 0x7E with [0x7D, 0x5E]
 *   Decode: replace [0x7D, 0x5E] with 0x7E, then replace [0x7D, 0x5D] with 0x7D
 */

import { HDLC_FLAG, HDLC_ESC, HDLC_ESC_MASK, HEADER1_SIZE } from '../constants.js';

/**
 * HDLC-escape a payload and wrap it with FLAG bytes.
 * @param {Uint8Array} data - Raw packet bytes
 * @returns {Uint8Array} Framed bytes ready to send on TCP
 */
export function hdlcEncode(data) {
  // Worst case: every byte needs escaping (2x) + 2 flags
  const out = [];
  out.push(HDLC_FLAG);

  for (let i = 0; i < data.length; i++) {
    const b = data[i];
    if (b === HDLC_ESC) {
      // Escape the ESC byte first (order matters!)
      out.push(HDLC_ESC);
      out.push(b ^ HDLC_ESC_MASK); // 0x7D → [0x7D, 0x5D]
    } else if (b === HDLC_FLAG) {
      out.push(HDLC_ESC);
      out.push(b ^ HDLC_ESC_MASK); // 0x7E → [0x7D, 0x5E]
    } else {
      out.push(b);
    }
  }

  out.push(HDLC_FLAG);
  return new Uint8Array(out);
}

/**
 * HDLC-unescape a frame (between FLAG bytes, FLAGS already stripped).
 * @param {Uint8Array} frame - Escaped frame bytes (without FLAG delimiters)
 * @returns {Uint8Array} Unescaped payload
 */
export function hdlcDecode(frame) {
  const out = [];
  let i = 0;

  while (i < frame.length) {
    if (frame[i] === HDLC_ESC && i + 1 < frame.length) {
      out.push(frame[i + 1] ^ HDLC_ESC_MASK);
      i += 2;
    } else {
      out.push(frame[i]);
      i += 1;
    }
  }

  return new Uint8Array(out);
}

/**
 * HDLC frame buffer — accumulates incoming bytes and extracts complete frames.
 *
 * Matches the Python TCPInterface read_loop approach:
 * scan the buffer for FLAG delimiters, extract frames between them.
 */
export class HdlcFrameBuffer {
  constructor() {
    this.buffer = new Uint8Array(0);
  }

  /**
   * Feed new bytes into the buffer.
   * @param {Uint8Array} chunk - Incoming bytes from TCP
   * @returns {Uint8Array[]} Array of complete, unescaped frames (may be empty)
   */
  feed(chunk) {
    // Append chunk to buffer
    const newBuf = new Uint8Array(this.buffer.length + chunk.length);
    newBuf.set(this.buffer);
    newBuf.set(chunk, this.buffer.length);
    this.buffer = newBuf;

    const frames = [];

    while (true) {
      // Find the first FLAG byte
      let frameStart = -1;
      for (let i = 0; i < this.buffer.length; i++) {
        if (this.buffer[i] === HDLC_FLAG) {
          frameStart = i;
          break;
        }
      }

      if (frameStart === -1) {
        // No FLAG found — discard everything before (garbage bytes)
        this.buffer = new Uint8Array(0);
        break;
      }

      // Find the next FLAG after frameStart
      let frameEnd = -1;
      for (let i = frameStart + 1; i < this.buffer.length; i++) {
        if (this.buffer[i] === HDLC_FLAG) {
          frameEnd = i;
          break;
        }
      }

      if (frameEnd === -1) {
        // No second FLAG yet — wait for more data
        // Keep buffer from frameStart onwards
        if (frameStart > 0) {
          this.buffer = this.buffer.slice(frameStart);
        }
        break;
      }

      // Extract frame between the two FLAGs
      const escaped = this.buffer.slice(frameStart + 1, frameEnd);

      // Advance buffer past frameEnd
      this.buffer = this.buffer.slice(frameEnd);

      // Skip empty frames (consecutive FLAGs)
      if (escaped.length === 0) continue;

      // Unescape the frame
      const frame = hdlcDecode(escaped);

      // Only accept frames that are at least HEADER_MINSIZE (19 bytes)
      if (frame.length >= HEADER1_SIZE) {
        frames.push(frame);
      }
    }

    return frames;
  }

  /**
   * Reset the buffer.
   */
  reset() {
    this.buffer = new Uint8Array(0);
  }
}
