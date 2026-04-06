/**
 * KISS framing for RNS interfaces.
 *
 * Matches the Python reference implementation.
 *
 * Frame format: [FEND] [CMD_DATA] [escaped payload] [FEND]
 * Where FEND=0xC0, FESC=0xDB, TFEND=0xDC, TFESC=0xDD
 *
 * Escape rules (order matters — escape FESC before FEND):
 *   Encode: replace 0xDB with [0xDB, 0xDD], then replace 0xC0 with [0xDB, 0xDC]
 *   Decode: 0xDB 0xDC → 0xC0, 0xDB 0xDD → 0xDB
 *
 * Unlike HDLC (buffer-scan approach), KISS uses a byte-at-a-time state machine.
 */

import {
  KISS_FEND, KISS_FESC, KISS_TFEND, KISS_TFESC, KISS_CMD_DATA,
  HEADER1_SIZE,
} from '../constants.js';

/**
 * KISS-encode a payload and wrap with FEND bytes.
 * @param {Uint8Array} data - Raw packet bytes
 * @returns {Uint8Array} Framed bytes: FEND + CMD_DATA + escaped_data + FEND
 */
export function kissEncode(data) {
  const out = [];
  out.push(KISS_FEND);
  out.push(KISS_CMD_DATA);

  for (let i = 0; i < data.length; i++) {
    const b = data[i];
    if (b === KISS_FESC) {
      // Escape FESC first (order matters!)
      out.push(KISS_FESC);
      out.push(KISS_TFESC); // 0xDB → [0xDB, 0xDD]
    } else if (b === KISS_FEND) {
      out.push(KISS_FESC);
      out.push(KISS_TFEND); // 0xC0 → [0xDB, 0xDC]
    } else {
      out.push(b);
    }
  }

  out.push(KISS_FEND);
  return new Uint8Array(out);
}

/**
 * KISS frame buffer — byte-at-a-time state machine decoder.
 *
 * Matches the Python TCPInterface KISS read loop:
 * - On FEND: if in_frame and command == CMD_DATA, deliver buffer
 * - First byte after FEND sets command (masked with 0x0F)
 * - FESC sets escape flag; next byte is unescaped
 */
export class KissFrameBuffer {
  constructor() {
    this._inFrame = false;
    this._escape = false;
    this._command = 0xFE; // CMD_UNKNOWN
    this._buffer = [];
  }

  /**
   * Feed incoming bytes. Returns array of complete, unescaped frames.
   * @param {Uint8Array} chunk
   * @returns {Uint8Array[]}
   */
  feed(chunk) {
    const frames = [];

    for (let i = 0; i < chunk.length; i++) {
      const b = chunk[i];

      if (b === KISS_FEND) {
        // Delimiter — deliver current frame if valid
        if (this._inFrame && this._command === KISS_CMD_DATA && this._buffer.length >= HEADER1_SIZE) {
          frames.push(new Uint8Array(this._buffer));
        }
        // Start new frame
        this._inFrame = true;
        this._command = 0xFE; // will be set by next byte
        this._buffer = [];
        this._escape = false;
        continue;
      }

      if (!this._inFrame) continue;

      // First byte after FEND is the command
      if (this._command === 0xFE) {
        this._command = b & 0x0F;
        continue;
      }

      // Only accumulate DATA frames
      if (this._command !== KISS_CMD_DATA) continue;

      if (this._escape) {
        // Unescape
        if (b === KISS_TFEND) {
          this._buffer.push(KISS_FEND);
        } else if (b === KISS_TFESC) {
          this._buffer.push(KISS_FESC);
        } else {
          // Invalid escape — keep raw byte
          this._buffer.push(b);
        }
        this._escape = false;
      } else if (b === KISS_FESC) {
        this._escape = true;
      } else {
        this._buffer.push(b);
      }
    }

    return frames;
  }

  /**
   * Reset the state machine.
   */
  reset() {
    this._inFrame = false;
    this._escape = false;
    this._command = 0xFE;
    this._buffer = [];
  }
}
