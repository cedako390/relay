import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export const SIDEBAR_MIN = 200;
export const SIDEBAR_MAX = 520;
export const SIDEBAR_DEFAULT = 240;

const clamp = (w: number): number => Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(w)));

interface LayoutState {
  /** Sidebar width in px; kept between launches. */
  sidebarWidth: number;
  setSidebarWidth: (width: number) => void;
}

export const useLayout = create<LayoutState>()(
  persist(
    (set) => ({
      sidebarWidth: SIDEBAR_DEFAULT,
      setSidebarWidth: (width) => set({ sidebarWidth: clamp(width) }),
    }),
    {
      name: 'orch.layout',
      // A stored value from an older build or a hand edit must not break the layout.
      merge: (persisted, current) => {
        const width = (persisted as Partial<LayoutState> | undefined)?.sidebarWidth;
        return { ...current, sidebarWidth: typeof width === 'number' && Number.isFinite(width) ? clamp(width) : current.sidebarWidth };
      },
    },
  ),
);
