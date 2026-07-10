/**
 * Theme preference (light/dark/system), per browser. The `.dark` class on
 * <html> drives Tailwind's dark: variant; index.html applies it pre-hydration
 * so there is no flash, and this module keeps it in sync afterwards.
 */
export type ThemePref = 'system' | 'light' | 'dark';

const KEY = 'companion.theme';

export function getThemePref(): ThemePref {
  const v = localStorage.getItem(KEY);
  return v === 'light' || v === 'dark' ? v : 'system';
}

export function setThemePref(pref: ThemePref): void {
  if (pref === 'system') localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, pref);
  apply();
}

function apply(): void {
  const pref = getThemePref();
  const dark = pref === 'dark' || (pref === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
}

/** Follow OS scheme changes while the preference is "system". */
export function initTheme(): void {
  apply();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (getThemePref() === 'system') apply();
  });
}
