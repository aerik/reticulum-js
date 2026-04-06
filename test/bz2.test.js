import { describe, it, expect } from 'vitest';
import { decodeBz2 } from '../src/vendor/bz2.js';
import { decompressBz2 } from '../src/utils/decompress.js';
import { fromHex, toHex, equal, fromUtf8 } from '../src/utils/bytes.js';
import { execSync } from 'child_process';

const PYTHON = new URL('../.venv/Scripts/python.exe', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');

function pythonCompress(data) {
  // Write data to temp file, compress with Python, read back
  const { writeFileSync, readFileSync, unlinkSync } = require('fs');
  const tmpIn = 'test_bz2_in.bin';
  const tmpOut = 'test_bz2_out.bin';
  writeFileSync(tmpIn, Buffer.from(data));
  execSync(`"${PYTHON}" -c "import bz2; open('${tmpOut}','wb').write(bz2.compress(open('${tmpIn}','rb').read()))"`);
  const compressed = readFileSync(tmpOut);
  unlinkSync(tmpIn);
  unlinkSync(tmpOut);
  return new Uint8Array(compressed);
}

describe('bz2 decompressor', () => {
  it('decompresses a known bz2 stream', () => {
    // "hello world" compressed with Python bz2
    const compressed = fromHex(
      '425a683931415926535944f7137800000191804000064490802000220334843021b68154278bb9229c2848227b89bc00'
    );
    const result = decodeBz2(compressed);
    expect(new TextDecoder().decode(result)).toBe('hello world');
  });

  it('decompresses repeated data', () => {
    const compressed = pythonCompress(new Uint8Array(600).fill(0x58)); // 'X' * 600
    const result = decodeBz2(compressed);
    expect(result.length).toBe(600);
    expect(result.every(b => b === 0x58)).toBe(true);
  });

  it('decompresses text data', () => {
    const original = 'The quick brown fox jumps over the lazy dog. '.repeat(50);
    const compressed = pythonCompress(fromUtf8(original));
    const result = decodeBz2(compressed);
    expect(new TextDecoder().decode(result)).toBe(original);
  });

  it('decompresses binary data with all byte values', () => {
    const original = new Uint8Array(256);
    for (let i = 0; i < 256; i++) original[i] = i;
    const compressed = pythonCompress(original);
    const result = decodeBz2(compressed);
    expect(result.length).toBe(256);
    expect(equal(result, original)).toBe(true);
  });

  it('decompresses large data (10KB)', () => {
    const original = new Uint8Array(10000);
    for (let i = 0; i < original.length; i++) original[i] = i % 256;
    const compressed = pythonCompress(original);
    const result = decodeBz2(compressed);
    expect(result.length).toBe(10000);
    expect(equal(result, original)).toBe(true);
  });

  it('throws on invalid data', () => {
    expect(() => decodeBz2(new Uint8Array([1, 2, 3, 4]))).toThrow(/Not bzip/);
  });

  it('throws on truncated data', () => {
    const compressed = fromHex('425a6839314159265359'); // valid header, truncated
    expect(() => decodeBz2(compressed)).toThrow();
  });

  describe('text encoding / decoding', () => {
    it('handles ASCII text', () => {
      const original = 'Hello, World! 0123456789 ~!@#$%^&*()';
      const compressed = pythonCompress(fromUtf8(original));
      const result = decodeBz2(compressed);
      expect(new TextDecoder().decode(result)).toBe(original);
    });

    it('handles UTF-8 multibyte (Cyrillic)', () => {
      const original = 'Привет мир! Reticulum — это круто.';
      const compressed = pythonCompress(fromUtf8(original));
      const result = decodeBz2(compressed);
      expect(new TextDecoder().decode(result)).toBe(original);
    });

    it('handles UTF-8 multibyte (CJK)', () => {
      const original = '你好世界！レティキュラムは素晴らしいです。';
      const compressed = pythonCompress(fromUtf8(original));
      const result = decodeBz2(compressed);
      expect(new TextDecoder().decode(result)).toBe(original);
    });

    it('handles UTF-8 4-byte (emoji)', () => {
      const original = '🌐🔒🔑💬 Reticulum mesh 🛜📡';
      const compressed = pythonCompress(fromUtf8(original));
      const result = decodeBz2(compressed);
      expect(new TextDecoder().decode(result)).toBe(original);
    });

    it('handles mixed ASCII and multibyte in large text', () => {
      const original = ('Hello Привет 你好 🌐 ').repeat(200);
      const compressed = pythonCompress(fromUtf8(original));
      const result = decodeBz2(compressed);
      expect(new TextDecoder().decode(result)).toBe(original);
    });

    it('result is a valid Uint8Array (not Buffer)', () => {
      const compressed = pythonCompress(fromUtf8('test'));
      const result = decodeBz2(compressed);
      expect(result).toBeInstanceOf(Uint8Array);
      // Should NOT be a Node Buffer (even in Node)
      expect(result.constructor.name).toBe('Uint8Array');
    });
  });

  describe('decompressBz2 wrapper', () => {
    it('works through the abstraction', () => {
      const compressed = pythonCompress(fromUtf8('test via wrapper'));
      const result = decompressBz2(compressed);
      expect(new TextDecoder().decode(result)).toBe('test via wrapper');
    });
  });
});
