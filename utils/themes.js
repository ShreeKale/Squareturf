/*
 * Colour themes for the public turf website.
 * Each theme replaces the page's accent colour (the "blue" shades) with its own palette.
 */
const SHADES = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];

const palette = (values) => Object.fromEntries(SHADES.map((shade, i) => [shade, values[i]]));

/*
 * mode "light" or "dark" tells the public website how to colour its surfaces
 * (dark gives dark backgrounds and light text; the colours below are then the accent).
 */
const THEMES = {
  green: {
    label: 'Green',
    mode: 'light',
    colors: palette(['#ecfdf5', '#d1fae5', '#a7f3d0', '#6ee7b7', '#34d399', '#10b981', '#059669', '#047857', '#065f46', '#064e3b', '#022c22'])
  },
  dark: {
    label: 'Dark',
    mode: 'dark',
    colors: palette(['#1e1b4b', '#2e2a6b', '#c7d2fe', '#a5b4fc', '#818cf8', '#6366f1', '#6366f1', '#8b93f7', '#a5b4fc', '#c7d2fe', '#e0e7ff'])
  },
  blue: {
    label: 'Blue',
    mode: 'light',
    colors: palette(['#eff6ff', '#dbeafe', '#bfdbfe', '#93c5fd', '#60a5fa', '#3b82f6', '#2563eb', '#1d4ed8', '#1e40af', '#1e3a8a', '#172554'])
  },
  orange: {
    label: 'Orange',
    mode: 'light',
    colors: palette(['#fff7ed', '#ffedd5', '#fed7aa', '#fdba74', '#fb923c', '#f97316', '#ea580c', '#c2410c', '#9a3412', '#7c2d12', '#431407'])
  },
  violet: {
    label: 'Purple',
    mode: 'light',
    colors: palette(['#f5f3ff', '#ede9fe', '#ddd6fe', '#c4b5fd', '#a78bfa', '#8b5cf6', '#7c3aed', '#6d28d9', '#5b21b6', '#4c1d95', '#2e1065'])
  },
  rose: {
    label: 'Red',
    mode: 'light',
    colors: palette(['#fff1f2', '#ffe4e6', '#fecdd3', '#fda4af', '#fb7185', '#f43f5e', '#e11d48', '#be123c', '#9f1239', '#881337', '#4c0519'])
  },
  light: {
    label: 'Light',
    mode: 'light',
    colors: palette(['#f8fafc', '#f1f5f9', '#e2e8f0', '#cbd5e1', '#94a3b8', '#64748b', '#334155', '#1e293b', '#0f172a', '#020617', '#020617'])
  }
};

const DEFAULT_THEME = 'blue';

/* The theme for a saved key; unknown or old values fall back to blue */
function themeFor(key) {
  const theme = THEMES[key] || THEMES[DEFAULT_THEME];
  return { key: THEMES[key] ? key : DEFAULT_THEME, ...theme };
}

module.exports = { THEMES, DEFAULT_THEME, themeFor };