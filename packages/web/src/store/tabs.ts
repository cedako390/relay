import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface TabsState {
  /** Session ids shown in the tab bar, in opening order. Closing a tab never touches the session itself. */
  open: string[];
  openTab: (id: string) => void;
  closeTab: (id: string) => void;
}

export const useTabs = create<TabsState>()(
  persist(
    (set) => ({
      open: [],
      openTab: (id) => set((s) => (s.open.includes(id) ? s : { open: [...s.open, id] })),
      closeTab: (id) => set((s) => ({ open: s.open.filter((x) => x !== id) })),
    }),
    { name: 'orch.tabs' },
  ),
);
