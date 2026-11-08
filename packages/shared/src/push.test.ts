import { describe, expect, it } from 'vitest';
import { pushEndpointAllowed } from './push';

describe('audit KV2, S07: push endpoints', () => {
  it('accepts the push services of the browsers', () => {
    for (const e of [
      'https://fcm.googleapis.com/fcm/send/abc:def',
      'https://updates.push.services.mozilla.com/wpush/v2/gAAA',
      'https://web.push.apple.com/QGx2',
      'https://wns2-par02p.notify.windows.com/w/?token=AwYA',
    ])
      expect(pushEndpointAllowed(e)).toBe(true);
  });

  it('refuses any other address, a non-default port, plain HTTP and look-alike hosts', () => {
    for (const e of [
      'http://fcm.googleapis.com/fcm/send/abc',
      'https://fcm.googleapis.com:8443/fcm/send/abc',
      'https://192.168.1.10:6382/',
      'https://localhost/',
      'https://127.0.0.1/',
      'https://evil.com/fcm.googleapis.com',
      'https://fcm.googleapis.com.evil.com/',
      'https://xfcm.googleapis.com/',
      'https://user:pw@fcm.googleapis.com/',
      'file:///etc/passwd',
      'pas une adresse',
    ])
      expect(pushEndpointAllowed(e)).toBe(false);
  });
});
