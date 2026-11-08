/**
 * The name of a sent file, from the `x-file-name` header (URI-encoded by the page). A malformed
 * encoding, or a name with a path in it, is never an error of the server: the name only says
 * which reader to use and is shown back in the history.
 */
export function headerFileName(header: unknown, fallback: string): string {
  const first: unknown = Array.isArray(header) ? header[0] : header;
  const raw = typeof first === 'string' ? first : '';
  if (!raw) return fallback;
  let name: string;
  try {
    name = decodeURIComponent(raw);
  } catch {
    name = raw;
  }
  name = [...name.replace(/^.*[\\/]/, '')]
    .filter((c) => c.charCodeAt(0) >= 0x20)
    .join('')
    .slice(0, 200);
  return name || fallback;
}
