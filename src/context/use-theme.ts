'use client';
// ============================================================================
// use-theme.ts — Theme state + toggle
// ============================================================================
// Extracted from ClearPortContext.tsx (FIX5-7-SPLIT — behavior-preserving).
//
// Self-contained: no dependencies on other context hooks. Reads the saved
// theme from localStorage lazily on first render (avoids setState-in-effect
// flash) and persists changes on user action.
// ============================================================================

import * as React from 'react';

export interface UseThemeResult {
  theme: 'dark' | 'light';
  toggleTheme: () => void;
}

/**
 * Manages the dark/light theme. The theme is initialized lazily from
 * localStorage so the first render is correct (no flash, no double render
 * from a mount effect).
 */
export function useTheme(): UseThemeResult {
  const [theme, setTheme] = React.useState<'dark' | 'light'>(() => {
    // Lazy initializer — read localStorage at first render, not in a mount
    // effect. This avoids a setState-in-effect (which causes a double render)
    // and prevents a flash of the wrong theme on initial load.
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('clearport-theme');
      if (saved === 'light' || saved === 'dark') return saved;
    }
    return 'dark';
  });

  // Theme is initialized lazily via useState(() => ...) above — no mount
  // effect needed. The toggleTheme callback persists changes to localStorage
  // on user action.
  const toggleTheme = React.useCallback(() => {
    setTheme(prev => {
      const next = prev === 'dark' ? 'light' : 'dark';
      if (typeof window !== 'undefined') localStorage.setItem('clearport-theme', next);
      return next;
    });
  }, []);

  return { theme, toggleTheme };
}
