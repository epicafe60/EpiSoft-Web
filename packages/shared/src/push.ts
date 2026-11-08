/**
 * Audit KV2, S07: the server sends an HTTP request to the address a browser gives when it
 * subscribes to notifications. Only the push services of the browsers are accepted, over HTTPS on
 * the default port: otherwise any signed-in account could make the server call an address of its
 * choice, including on the local network (the MariaDB of the MinisForum, the router).
 */
const PUSH_HOSTS: readonly string[] = [
  'fcm.googleapis.com', // Chrome, Edge on Android, Brave, Opera
  'android.googleapis.com',
  'push.services.mozilla.com', // Firefox: updates.push.services.mozilla.com
  'push.apple.com', // Safari: web.push.apple.com
  'notify.windows.com', // Edge on Windows: wns2-*.notify.windows.com
];

/** At most this many devices receive the notifications of one account; the oldest go first. */
export const MAX_PUSH_DEVICES = 10;

export function pushEndpointAllowed(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.port !== '' || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  return PUSH_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}
