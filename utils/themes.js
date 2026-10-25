/*
 * Colour themes for the public turf website.
 * Each theme replaces the page's accent colour (the "blue" shades) with its own palette.
 */
const SHADES = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];

const palette = (values) => Object.fromEntries(SHADES.map((shade, i) => [shade, values[i]]));

const THEMES = {
  blue: {
    label: 'Ocean blue',
    colors: palette(['#eff6ff', '#dbeafe', '#bfdbfe', '#93c5fd', '#60a5fa', '#3b82f6', '#2563eb', '#1d4ed8', '#1e40af', '#1e3a8a', '#172554'])
  },
  green: {
    label: 'Turf green',
    colors: palette(['#ecfdf5', '#d1fae5', '#a7f3d0', '#6ee7b7', '#34d399', '#10b981', '#059669', '#047857', '#065f46', '#064e3b', '#022c22'])
  },
  orange: {
    label: 'Sunset orange',
    colors: palette(['#fff7ed', '#ffedd5', '#fed7aa', '#fdba74', '#fb923c', '#f97316', '#ea580c', '#c2410c', '#9a3412', '#7c2d12', '#431407'])
  },
  violet: {
    label: 'Royal violet',
    colors: palette(['#f5f3ff', '#ede9fe', '#ddd6fe', '#c4b5fd', '#a78bfa', '#8b5cf6', '#7c3aed', '#6d28d9', '#5b21b6', '#4c1d95', '#2e1065'])
  },
  rose: {
    label: 'Stadium red',
    colors: palette(['#fff1f2', '#ffe4e6', '#fecdd3', '#fda4af', '#fb7185', '#f43f5e', '#e11d48', '#be123c', '#9f1239', '#881337', '#4c0519'])
  }
};

const DEFAULT_THEME = 'blue';

/* The theme for a saved key; unknown or old values fall back to blue */
function themeFor(key) {
  const theme = THEMES[key] || THEMES[DEFAULT_THEME];
  return { key: THEMES[key] ? key : DEFAULT_THEME, ...theme };
}

module.exports = { THEMES, DEFAULT_THEME, themeFor };