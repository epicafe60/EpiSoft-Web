import { afterEach, describe, expect, it } from 'vitest';
import {
  appTimeZone,
  DEFAULT_TIME_ZONE,
  isValidTimeZone,
  setAppTimeZone,
  shopFormat,
  timeZoneLiteral,
} from './timezone';
import { shopDay } from './controls';
import { settingSchemas } from './settings';

afterEach(() => setAppTimeZone(DEFAULT_TIME_ZONE));

describe('time zone of the shop', () => {
  it('is Europe/Paris by default', () => {
    expect(appTimeZone()).toBe('Europe/Paris');
    expect(timeZoneLiteral()).toBe("'Europe/Paris'");
  });

  it('accepts a real zone and refuses anything else, injection included', () => {
    for (const ok of ['Europe/Paris', 'America/Martinique', 'Indian/Reunion', 'UTC'])
      expect(isValidTimeZone(ok), ok).toBe(true);
    for (const bad of ['', 'Mars/Olympus', "Europe/Paris'; --", 'Europe Paris', '../etc'])
      expect(isValidTimeZone(bad), bad).toBe(false);
    expect(settingSchemas['app.timezone'].safeParse({ timeZone: 'Mars/Olympus' }).success).toBe(
      false,
    );
  });

  it('keeps the previous zone when a bad one is given', () => {
    setAppTimeZone('Not/AZone');
    expect(appTimeZone()).toBe('Europe/Paris');
  });

  it('changes the calendar day of a moment', () => {
    const late = new Date('2026-11-15T23:30:00Z');
    expect(shopDay(late)).toBe('2026-11-16'); // Paris, UTC+1
    setAppTimeZone('America/Martinique'); // UTC-4
    expect(shopDay(late)).toBe('2026-11-15');
    expect(shopFormat('fr-FR', { hour: '2-digit', hour12: false }).format(late)).toContain('19');
  });
});
