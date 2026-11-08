import { describe, expect, it } from 'vitest';
import { contentMatchesType, MAX_UNZIPPED_BYTES, zipProblem } from './files';

const bytes = (...v: number[]) => new Uint8Array(v);

/** A zip with one stored entry announcing `unpacked` bytes (central directory + end record). */
function zip(unpacked: number, entries = 1): Uint8Array {
  const name = 'a';
  const central = 46 + name.length;
  const buf = new Uint8Array(central * entries + 22);
  const v = new DataView(buf.buffer);
  for (let i = 0; i < entries; i++) {
    const p = i * central;
    v.setUint32(p, 0x02014b50, true);
    v.setUint32(p + 24, unpacked, true);
    v.setUint16(p + 28, name.length, true);
    buf[p + 46] = 0x61;
  }
  const e = central * entries;
  v.setUint32(e, 0x06054b50, true);
  v.setUint16(e + 10, entries, true);
  v.setUint32(e + 16, 0, true);
  return buf;
}

describe('the files people send', () => {
  it('recognises the real type from the first bytes', () => {
    expect(
      contentMatchesType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0), 'image/png'),
    ).toBe(true);
    expect(contentMatchesType(bytes(0xff, 0xd8, 0xff, 0xe0), 'image/jpeg')).toBe(true);
    expect(contentMatchesType(new TextEncoder().encode('%PDF-1.7'), 'application/pdf')).toBe(true);
    expect(contentMatchesType(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '), 'image/webp')).toBe(
      true,
    );
    // An HTML page or an SVG announced as an image, a PNG announced as a PDF.
    expect(contentMatchesType(new TextEncoder().encode('<html><script>'), 'image/png')).toBe(false);
    expect(contentMatchesType(new TextEncoder().encode('<svg onload=x>'), 'image/jpeg')).toBe(
      false,
    );
    expect(
      contentMatchesType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), 'application/pdf'),
    ).toBe(false);
    expect(contentMatchesType(bytes(0x3c), 'text/html')).toBe(false);
  });

  it('refuses a spreadsheet that would unpack to too much (zip bomb)', () => {
    expect(zipProblem(zip(1_000_000))).toBeNull();
    expect(zipProblem(zip(MAX_UNZIPPED_BYTES + 1))).toMatch(/volumineux/);
    expect(zipProblem(zip(MAX_UNZIPPED_BYTES / 2, 3))).toMatch(/volumineux/);
    expect(zipProblem(new TextEncoder().encode('pas un zip'))).toMatch(/valide/);
  });
});
