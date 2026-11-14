import { z } from 'zod';

// The messages zod writes itself (« Too big: expected string to have <=5 characters ») reach the
// screens next to the fields: they are in French, like the ones written by hand in the schemas.
z.config(z.locales.fr());
