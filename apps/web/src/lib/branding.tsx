import { useEffect } from 'react';
import { queryOptions, useQuery } from '@tanstack/react-query';
import {
  DEFAULT_BRANDING,
  DEFAULT_LOGO_URL,
  SETTING_DEFAULTS,
  DEFAULT_TIME_ZONE,
  setAppTimeZone,
  type BrandingInfo,
} from '@episoft/shared';
import { api } from './api';

// The name, the logo and the colour of the application, as the administrators set them. Public (the
// sign-in page shows them), kept in the browser so that the till still shows them offline.

const KEY = 'episoft.branding';

export const DEFAULT_BRANDING_INFO: BrandingInfo = {
  appName: DEFAULT_BRANDING.appName,
  shortName: DEFAULT_BRANDING.shortName,
  associationName: SETTING_DEFAULTS['association.identity'].name,
  accentColor: DEFAULT_BRANDING.accentColor,
  logoUrl: DEFAULT_LOGO_URL,
  customLogo: false,
  timeZone: DEFAULT_TIME_ZONE,
};

function readCached(): BrandingInfo | undefined {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULT_BRANDING_INFO, ...(JSON.parse(raw) as BrandingInfo) } : undefined;
  } catch {
    return undefined;
  }
}

// The time zone of the shop applies from the first call, also offline (last known value).
setAppTimeZone(readCached()?.timeZone ?? DEFAULT_TIME_ZONE);

export const brandingQuery = queryOptions({
  queryKey: ['branding'],
  queryFn: async (): Promise<BrandingInfo> => {
    const info = await api.get<BrandingInfo>('/branding');
    setAppTimeZone(info.timeZone);
    try {
      localStorage.setItem(KEY, JSON.stringify(info));
    } catch {
      // Storage unavailable: the names of the application are read again next time.
    }
    return info;
  },
  staleTime: 5 * 60_000,
  retry: false,
});

export function useBranding(): BrandingInfo {
  const { data } = useQuery({ ...brandingQuery, placeholderData: readCached });
  return data ?? DEFAULT_BRANDING_INFO;
}

/** Applies the branding to the page: title, colour of the browser bar, icon, accent colour. */
export function BrandingEffects() {
  const b = useBranding();
  useEffect(() => {
    setAppTimeZone(b.timeZone);
    document.title = b.appName;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', b.accentColor);
    if (b.customLogo) {
      const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
      if (link) {
        link.href = b.logoUrl;
        link.removeAttribute('type');
      }
    }
    // The accent colour replaces the green of the buttons and links, in the light theme: its
    // contrast against white is checked when it is saved. The dark theme keeps its own.
    let style = document.getElementById('branding-style') as HTMLStyleElement | null;
    if (!style) {
      style = document.createElement('style');
      style.id = 'branding-style';
      document.head.append(style);
    }
    style.textContent =
      b.accentColor.toLowerCase() === DEFAULT_BRANDING.accentColor
        ? ''
        : `:root:not(.dark){--primary:${b.accentColor};--ring:${b.accentColor}}`;
  }, [b.appName, b.accentColor, b.customLogo, b.logoUrl, b.timeZone]);
  return null;
}
