/**
 * SHA-256 as lowercase hex, with Web Crypto (browser and Node 22).
 * Used for QR badge tokens, which the offline till compares in hashed form (R-SYNC-06).
 */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
