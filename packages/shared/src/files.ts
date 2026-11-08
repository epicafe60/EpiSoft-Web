// Checks on the files people send (images, invoice documents, spreadsheets). The type announced by
// the browser is only a claim: the first bytes say what the file really is.

const SIGNATURES: Record<string, (b: Uint8Array) => boolean> = {
  'image/png': (b) => starts(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  'image/jpeg': (b) => starts(b, [0xff, 0xd8, 0xff]),
  // RIFF....WEBP
  'image/webp': (b) =>
    starts(b, [0x52, 0x49, 0x46, 0x46]) && starts(b.subarray(8), [0x57, 0x45, 0x42, 0x50]),
  'application/pdf': (b) => starts(b, [0x25, 0x50, 0x44, 0x46, 0x2d]), // %PDF-
};

function starts(b: Uint8Array, sig: readonly number[]): boolean {
  return b.length >= sig.length && sig.every((v, i) => b[i] === v);
}

/** Whether the content really is of the announced type (PNG, JPEG, WebP, PDF). */
export function contentMatchesType(bytes: Uint8Array, mime: string): boolean {
  return SIGNATURES[mime]?.(bytes) ?? false;
}

/** What a spreadsheet (a zip archive) may hold once unpacked: far above any real import. */
export const MAX_UNZIPPED_BYTES = 200 * 1024 * 1024;
export const MAX_ZIP_ENTRIES = 5_000;

/**
 * A « zip bomb »: a 10 MB .xlsx that unpacks to gigabytes and exhausts the memory of the server.
 * Reads the central directory of the archive (the sizes it announces) without unpacking anything.
 * Returns null when acceptable, or the reason. Sizes announced by a forged archive can lie: the
 * library then stops at the real size of the data, which the limit on the upload keeps small.
 */
export function zipProblem(bytes: Uint8Array): string | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // End of central directory: signature 0x06054b50, within the last 64 KB + 22 bytes.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return 'Ce fichier n’est pas un classeur Excel valide.';
  const entries = view.getUint16(eocd + 10, true);
  const dirOffset = view.getUint32(eocd + 16, true);
  if (entries > MAX_ZIP_ENTRIES) return 'Classeur trop complexe.';
  if (entries === 0xffff || dirOffset === 0xffffffff) return 'Classeur trop volumineux.'; // zip64
  let total = 0;
  let p = dirOffset;
  for (let n = 0; n < entries; n++) {
    if (p + 46 > bytes.length || view.getUint32(p, true) !== 0x02014b50)
      return 'Ce fichier n’est pas un classeur Excel valide.';
    const unpacked = view.getUint32(p + 24, true);
    if (unpacked === 0xffffffff) return 'Classeur trop volumineux.';
    total += unpacked;
    if (total > MAX_UNZIPPED_BYTES) return 'Classeur trop volumineux une fois décompressé.';
    p +=
      46 +
      view.getUint16(p + 28, true) +
      view.getUint16(p + 30, true) +
      view.getUint16(p + 32, true);
  }
  return null;
}
