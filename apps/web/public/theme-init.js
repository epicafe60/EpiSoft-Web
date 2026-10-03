// Applies the saved theme before the first paint (§5.1).
try {
  const theme = localStorage.getItem('theme');
  if (theme === 'dark' || (!theme && matchMedia('(prefers-color-scheme: dark)').matches)) {
    document.documentElement.classList.add('dark');
  }
} catch {
  // Storage unavailable: keep the light theme.
}
