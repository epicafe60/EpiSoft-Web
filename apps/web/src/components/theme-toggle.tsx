import { Moon, Sun } from 'lucide-react';
import { useState } from 'react';
import { Button } from './ui/button';

/** Light / dark theme (§5.1), remembered on this device. */
export function ThemeToggle() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  const toggle = () => {
    const next = !dark;
    document.documentElement.classList.toggle('dark', next);
    try {
      localStorage.setItem('theme', next ? 'dark' : 'light');
    } catch {
      // Storage unavailable (private mode): the choice lasts for this page only.
    }
    setDark(next);
  };
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={toggle}
      aria-label={dark ? 'Passer en thème clair' : 'Passer en thème sombre'}
    >
      {dark ? <Sun /> : <Moon />}
    </Button>
  );
}
