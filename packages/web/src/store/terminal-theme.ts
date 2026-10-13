import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { TerminalAccent } from '@/lib/terminal-recolor';

interface TerminalThemeState {
  accent: TerminalAccent;
  setAccent: (accent: TerminalAccent) => void;
}

export const useTerminalTheme = create<TerminalThemeState>()(
  persist(
    (set) => ({
      accent: 'blue',
      setAccent: (accent) => set({ accent }),
    }),
    { name: 'orch.terminal-theme' },
  ),
);
