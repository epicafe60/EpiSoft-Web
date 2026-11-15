import { z } from 'zod';

// How the application presents itself: its name, the short name of the association (subjects of
// e-mails, titles of notifications), a logo and an accent colour. Every association that uses the
// software sets them in Administration › Paramètres; the values below are those of the Épicafé.

/** Contrast of a #RRGGBB colour against white (WCAG), 1 to 21. */
export function contrastWithWhite(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
  return 1.05 / (luminance + 0.05);
}

/** White text must stay readable on the colour (buttons, bars): contrast of 4.5 at least. */
export const brandingSchema = z.object({
  /** The name of the software, in the menu, the title of the pages and the messages. */
  appName: z.string().trim().min(1, 'Nom requis.').max(40),
  /** The short name of the association: « Épicafé : ticket 12 », titles of notifications. */
  shortName: z.string().trim().min(1, 'Nom requis.').max(40),
  accentColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Couleur au format #RRGGBB.')
    .refine(
      (c) => contrastWithWhite(c) >= 4.5,
      'Couleur trop claire : le texte blanc y serait illisible.',
    ),
  /** An image of the library; null: the logo shipped with the application. */
  logoImageId: z.string().uuid().nullable(),
});
export type Branding = z.infer<typeof brandingSchema>;

export const DEFAULT_BRANDING: Branding = {
  appName: 'EpiSoft',
  shortName: 'Épicafé',
  accentColor: '#14532d',
  logoImageId: null,
};

/** What the sign-in page and the shell know before anyone is signed in (public). */
export interface BrandingInfo {
  appName: string;
  shortName: string;
  /** Full name of the association (its identity). */
  associationName: string;
  accentColor: string;
  /** Address of the logo: the library image chosen, or the logo shipped with the application. */
  logoUrl: string;
  /** True when the logo is not the one shipped with the application. */
  customLogo: boolean;
  /** The time zone of the shop (IANA name). */
  timeZone: string;
}

export const DEFAULT_LOGO_URL = '/logo.png';

export const brandingLogoUrl = (imageId: string | null) =>
  imageId ? `/api/v1/branding/logo/${imageId}` : DEFAULT_LOGO_URL;
