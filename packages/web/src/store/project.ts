import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface ProjectState {
  /** User-given project names by working directory; a project without an entry is named after its folder. */
  names: Record<string, string>;
  /** Manual project order (working directories). Projects missing here are new and come first, newest on top. */
  order: string[];
  /** Expanded projects; the rest are collapsed. */
  expanded: Record<string, true>;
  /**
   * Archived projects are hidden from the sidebar. Their sessions stay in the database, so a project that is
   * added again (same working directory) is unarchived and brings its old sessions back.
   */
  archived: Record<string, true>;
  /** Sessions removed from the sidebar by the user: the same hiding as a project archive, nothing is deleted or stopped. */
  archivedSessions: Record<string, true>;
  /** Known projects (working directories). A project stays in the sidebar when it has no open sessions. */
  projects: string[];
  addProjects: (cwds: string[]) => void;
  setName: (cwd: string, name: string) => void;
  archiveSession: (id: string) => void;
  /** Replaces the order of the visible projects; archived ones keep their place after them. */
  setOrder: (visible: string[]) => void;
  setExpanded: (cwds: string[], value: boolean) => void;
  archive: (cwd: string) => void;
  unarchive: (cwd: string) => void;
}

export const useProject = create<ProjectState>()(
  persist(
    (set) => ({
      names: {},
      order: [],
      expanded: {},
      archived: {},
      archivedSessions: {},
      projects: [],
      addProjects: (cwds) =>
        set((s) => {
          const fresh = cwds.filter((c, i) => !s.projects.includes(c) && cwds.indexOf(c) === i);
          return fresh.length > 0 ? { projects: [...s.projects, ...fresh] } : s;
        }),
      archiveSession: (id) => set((s) => (s.archivedSessions[id] ? s : { archivedSessions: { ...s.archivedSessions, [id]: true } })),
      setName: (cwd, name) =>
        set((s) => {
          const names = { ...s.names };
          if (name) names[cwd] = name;
          else delete names[cwd];
          return { names };
        }),
      setOrder: (visible) => set((s) => ({ order: [...visible, ...s.order.filter((c) => !visible.includes(c))] })),
      setExpanded: (cwds, value) =>
        set((s) => {
          const expanded = { ...s.expanded };
          for (const cwd of cwds) {
            if (value) expanded[cwd] = true;
            else delete expanded[cwd];
          }
          return { expanded };
        }),
      archive: (cwd) => set((s) => (s.archived[cwd] ? s : { archived: { ...s.archived, [cwd]: true } })),
      unarchive: (cwd) =>
        set((s) => {
          if (!s.archived[cwd]) return s;
          const archived = { ...s.archived };
          delete archived[cwd];
          return { archived };
        }),
    }),
    { name: 'orch.project' },
  ),
);
