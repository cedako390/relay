import { isActiveSessionStatus, type Session, type Task } from '@orch/shared';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { ChevronRight, FolderPlus, ListChecks, Plus } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ContextMenu, type ContextMenuItem } from '@/components/context-menu';
import { CreateSessionDialog } from '@/components/create-session-dialog';
import { SessionStatusDot } from '@/components/status-badge';
import { useNow } from '@/hooks/use-now';
import { api } from '@/lib/api';
import { isPlainClick, useOpenSession } from '@/hooks/use-open-session';
import { launchMenuItems, useStartSession } from '@/hooks/use-start-session';
import { sessionTitle } from '@/lib/session-title';
import { cn, folderName, shortId, timeAgo } from '@/lib/utils';
import { useLive } from '@/store/live';
import { useProject } from '@/store/project';
import { SIDEBAR_DEFAULT, useLayout } from '@/store/layout';
import { useTabs } from '@/store/tabs';

const row = 'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground';

interface Group {
  cwd: string;
  /** Sessions open in tabs (newest first), except the ones nested under another session. */
  sessions: Session[];
  latest: number;
}

interface Tree {
  groups: Group[];
  /** Session id -> the sessions it started (workers of its tasks, nested orchestrators), oldest first. */
  children: Map<string, Session[]>;
}

/** Whoever started the session: the orchestrator that created it, or the creator of its task. */
function parentId(s: Session, tasks: Record<string, Task | undefined>): string | null {
  return s.parentSessionId ?? (s.taskId ? (tasks[s.taskId]?.creatorSessionId ?? null) : null);
}

/**
 * The sidebar lists what is open in the tab bar, grouped by working directory (old sessions are not here).
 * Projects stay even when nothing is open in them. Projects in the manual order keep it; the ones not in it
 * yet (new) come first, most recent on top.
 * A running session started by a listed one (a worker, a nested orchestrator) hangs under it even without
 * a tab of its own, and also when its directory differs (workers run in worktrees), so it is not a project of its own.
 */
function buildTree(
  sessions: Session[],
  tasks: Record<string, Task | undefined>,
  open: string[],
  projects: string[],
  order: string[],
  archived: Record<string, true>,
): Tree {
  const tabs = new Set(open);
  const shown = new Set<string>();
  const children = new Map<string, Session[]>();
  const nested = new Set<string>();
  // Oldest first: a parent is always created before its children, so one pass sees it already listed.
  for (const s of [...sessions].sort((a, b) => a.startedAt - b.startedAt)) {
    const p = parentId(s, tasks);
    const parentShown = !!p && p !== s.id && shown.has(p);
    if (!tabs.has(s.id) && !(parentShown && isActiveSessionStatus(s.status))) continue;
    shown.add(s.id);
    if (!parentShown) continue;
    nested.add(s.id);
    children.set(p, [...(children.get(p) ?? []), s]);
  }

  // Known projects are listed even with no sessions; removed (archived) ones are not.
  const groups = new Map<string, Group>();
  for (const cwd of projects) if (!archived[cwd]) groups.set(cwd, { cwd, sessions: [], latest: 0 });
  for (const s of sessions) {
    if (!shown.has(s.id) || nested.has(s.id) || archived[s.cwd]) continue;
    const g = groups.get(s.cwd) ?? { cwd: s.cwd, sessions: [], latest: 0 };
    g.sessions.push(s);
    g.latest = Math.max(g.latest, s.startedAt);
    groups.set(s.cwd, g);
  }
  for (const g of groups.values()) g.sessions.sort((a, b) => b.startedAt - a.startedAt);
  const sorted = [...groups.values()].sort((a, b) => {
    const ra = order.indexOf(a.cwd);
    const rb = order.indexOf(b.cwd);
    if (ra < 0 && rb < 0) return b.latest - a.latest;
    if (ra < 0) return -1;
    if (rb < 0) return 1;
    return ra - rb;
  });
  return { groups: sorted, children };
}

function SessionRow({
  session,
  title,
  now,
  nested,
  onMenu,
}: {
  session: Session;
  title: string;
  now: number;
  nested: boolean;
  onMenu: (x: number, y: number) => void;
}) {
  const active = isActiveSessionStatus(session.status);
  const open = useOpenSession();
  return (
    <Link
      to="/sessions/$sessionId"
      params={{ sessionId: session.id }}
      title={`${session.model ?? 'default'} · ${shortId(session.id)}${session.activeSubagents > 0 ? ` · +${session.activeSubagents} sub` : ''}`}
      onClick={(e) => {
        if (!isPlainClick(e.nativeEvent)) return;
        e.preventDefault();
        void open(session.id);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e.clientX, e.clientY);
      }}
      className={cn('flex items-center gap-2 rounded-md py-1.5 pr-2 transition-colors hover:bg-accent/60', nested ? 'pl-2' : 'pl-5')}
      activeProps={{ className: 'bg-accent' }}
    >
      <SessionStatusDot status={session.status} />
      <span className={cn('min-w-0 flex-1 truncate text-[13px]', active ? 'font-medium text-foreground' : 'text-muted-foreground')}>{title}</span>
      <span className="shrink-0 text-[11px] text-muted-foreground/70">{timeAgo(session.startedAt, now)}</span>
    </Link>
  );
}

interface SessionNodeProps {
  session: Session;
  childrenOf: Map<string, Session[]>;
  tasks: Record<string, Task | undefined>;
  now: number;
  nested: boolean;
  onSessionMenu: (id: string, x: number, y: number) => void;
}

/** A session row with the sessions it started below it, indented behind a guide line. */
function SessionNode({ session, childrenOf, tasks, now, nested, onSessionMenu }: SessionNodeProps) {
  const kids = childrenOf.get(session.id);
  return (
    <div className="space-y-0.5">
      <SessionRow session={session} title={sessionTitle(session, tasks)} now={now} nested={nested} onMenu={(x, y) => onSessionMenu(session.id, x, y)} />
      {kids && (
        <div className={cn('space-y-0.5 border-l border-border', nested ? 'ml-4' : 'ml-6')}>
          {kids.map((k) => (
            <SessionNode key={k.id} session={k} childrenOf={childrenOf} tasks={tasks} now={now} nested onSessionMenu={onSessionMenu} />
          ))}
        </div>
      )}
    </div>
  );
}

interface ProjectGroupProps {
  group: Group;
  childrenOf: Map<string, Session[]>;
  name: string;
  expanded: boolean;
  now: number;
  creating: boolean;
  onToggle: () => void;
  /** Opens the launch menu (Claude Code / terminal) at the given point. */
  onCreate: (x: number, y: number) => void;
  onMenu: (x: number, y: number) => void;
  onSessionMenu: (id: string, x: number, y: number) => void;
}

function ProjectGroup({ group, childrenOf, name, expanded, now, creating, onToggle, onCreate, onMenu, onSessionMenu }: ProjectGroupProps) {
  const tasksById = useLive((s) => s.tasks);
  return (
    <div>
      <div
        className="flex items-center rounded-md transition-colors hover:bg-accent/60"
        onContextMenu={(e) => {
          e.preventDefault();
          onMenu(e.clientX, e.clientY);
        }}
      >
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          title={group.cwd}
          className="flex min-w-0 flex-1 items-center gap-1 px-2 py-1.5 text-left text-sm text-foreground"
        >
          <span className="truncate">{name}</span>
          <ChevronRight className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-90')} />
        </button>
        <button
          type="button"
          title={`Новая сессия в «${name}»`}
          aria-label="Новая сессия в этом проекте"
          aria-haspopup="menu"
          disabled={creating}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            onCreate(r.left, r.bottom + 4);
          }}
          className="mr-1 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
        >
          <Plus className="size-4" />
        </button>
      </div>
      {expanded && (
        <div className="space-y-0.5 pt-0.5 pb-1">
          {group.sessions.length === 0 && <p className="py-1 pl-5 text-xs text-muted-foreground/70">Нет открытых сессий</p>}
          {group.sessions.map((s) => (
            <SessionNode key={s.id} session={s} childrenOf={childrenOf} tasks={tasksById} now={now} nested={false} onSessionMenu={onSessionMenu} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Drag handle on the sidebar's right edge; double click restores the default width. */
function ResizeHandle() {
  const setWidth = useLayout((s) => s.setSidebarWidth);
  const [dragging, setDragging] = useState(false);
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Изменить ширину панели"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault(); // no text selection while dragging
        e.currentTarget.setPointerCapture(e.pointerId);
        setDragging(true);
      }}
      onPointerMove={(e) => {
        if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
        // The sidebar starts at the window's left edge, so the pointer position is the width.
        setWidth(e.clientX);
      }}
      onPointerUp={(e) => {
        e.currentTarget.releasePointerCapture(e.pointerId);
        setDragging(false);
      }}
      onPointerCancel={() => setDragging(false)}
      onDoubleClick={() => setWidth(SIDEBAR_DEFAULT)}
      className={cn('absolute inset-y-0 -right-1 z-10 w-2 cursor-col-resize transition-colors hover:bg-primary/30', dragging && 'bg-primary/40')}
    />
  );
}

export function Sidebar() {
  const width = useLayout((s) => s.sidebarWidth);
  const names = useProject((s) => s.names);
  const order = useProject((s) => s.order);
  const expanded = useProject((s) => s.expanded);
  const projects = useProject((s) => s.projects);
  const archived = useProject((s) => s.archived);
  const { setOrder, setExpanded, archive } = useProject.getState();
  const openTabs = useTabs((s) => s.open);
  const sessionsById = useLive((s) => s.sessions);
  const tasksById = useLive((s) => s.tasks);
  const now = useNow();
  const { groups, children: childrenOf } = useMemo(
    () => buildTree(Object.values(sessionsById), tasksById, openTabs, projects, order, archived),
    [sessionsById, tasksById, openTabs, projects, order, archived],
  );

  // Projects the user has worked in are remembered (this also picks up the ones from before the list existed).
  useEffect(() => {
    const cwds = Object.values(sessionsById)
      .filter((s) => s.kind === 'orchestrator' && !s.parentSessionId && !archived[s.cwd] && (s.promptedAt !== null || openTabs.includes(s.id)))
      .map((s) => s.cwd);
    useProject.getState().addProjects(cwds);
  }, [sessionsById, openTabs, archived]);
  const projectName = (cwd: string) => names[cwd] || folderName(cwd);
  const [menu, setMenu] = useState<{ cwd: string; sessionId?: string; launch?: boolean; x: number; y: number } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const navigate = useNavigate();
  const createSession = useStartSession();

  // Opening a session from elsewhere (link, new session) brings its project into view.
  const { sessionId } = useParams({ strict: false });
  const openedCwd = sessionId ? sessionsById[sessionId]?.cwd : undefined;
  useEffect(() => {
    if (openedCwd) useProject.getState().setExpanded([openedCwd], true);
  }, [openedCwd]);

  const cwds = groups.map((g) => g.cwd);
  const menuGroup = menu ? groups.find((g) => g.cwd === menu.cwd) : undefined;
  const move = (cwd: string, delta: -1 | 1) => {
    const next = [...cwds];
    const i = next.indexOf(cwd);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j]!, next[i]!];
    setOrder(next);
  };
  /** "Delete" ends the process if it is still running and closes the tab; the database rows stay. */
  const removeOne = (id: string) => {
    const session = sessionsById[id];
    if (session && isActiveSessionStatus(session.status)) void api.killSession(id).catch(() => undefined);
    useTabs.getState().closeTab(id);
    if (id === sessionId) void navigate({ to: '/' });
  };
  /** Closes the tabs of every session in the project (the processes keep running). */
  const closeProjectTabs = (cwd: string) => {
    const ids = Object.values(sessionsById).filter((s) => s.cwd === cwd).map((s) => s.id);
    for (const id of ids) useTabs.getState().closeTab(id);
    if (sessionId && ids.includes(sessionId)) void navigate({ to: '/' });
  };
  const menuItems = (g: Group, id?: string, launch?: boolean): ContextMenuItem[] => {
    if (id) return [{ label: 'Удалить', onSelect: () => removeOne(id) }];
    if (launch) return launchMenuItems((kind) => createSession.mutate({ cwd: g.cwd, kind }));
    const i = cwds.indexOf(g.cwd);
    return [
      { label: 'Новая сессия', onSelect: () => createSession.mutate({ cwd: g.cwd, kind: 'orchestrator' }) },
      { label: 'Новый терминал', onSelect: () => createSession.mutate({ cwd: g.cwd, kind: 'terminal' }) },
      'separator',
      { label: 'Переместить вверх', disabled: i <= 0, onSelect: () => move(g.cwd, -1) },
      { label: 'Переместить вниз', disabled: i >= cwds.length - 1, onSelect: () => move(g.cwd, 1) },
      { label: 'Сортировать от А до Я', onSelect: () => setOrder([...cwds].sort((a, b) => projectName(a).localeCompare(projectName(b), undefined, { sensitivity: 'base' }))) },
      'separator',
      { label: 'Свернуть все', onSelect: () => setExpanded(cwds, false) },
      { label: 'Развернуть все', onSelect: () => setExpanded(cwds, true) },
      'separator',
      { label: `Закрыть вкладки проекта (${g.sessions.length})`, disabled: g.sessions.length === 0, onSelect: () => closeProjectTabs(g.cwd) },
      {
        label: 'Удалить проект',
        onSelect: () => {
          closeProjectTabs(g.cwd);
          archive(g.cwd);
        },
      },
    ];
  };

  return (
    <aside style={{ width }} className="relative flex h-full shrink-0 flex-col border-r bg-sidebar">
      <ResizeHandle />
      <div className="space-y-0.5 border-b p-2">
        <CreateSessionDialog>
          <button type="button" className={row}>
            <FolderPlus className="size-4" /> New project
          </button>
        </CreateSessionDialog>
        <Link to="/tasks" className={row} activeProps={{ className: cn(row, 'bg-accent text-foreground') }}>
          <ListChecks className="size-4" /> Tasks
        </Link>
      </div>

      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2">
        {createSession.error && <p className="px-2 pb-1 text-xs text-destructive">{createSession.error.message}</p>}
        {groups.length === 0 && <p className="px-2 py-4 text-xs text-muted-foreground">No sessions yet.</p>}
        {groups.map((g) => (
          <ProjectGroup
            key={g.cwd}
            group={g}
            childrenOf={childrenOf}
            name={projectName(g.cwd)}
            expanded={!!expanded[g.cwd]}
            now={now}
            creating={createSession.isPending}
            onToggle={() => setExpanded([g.cwd], !expanded[g.cwd])}
            onCreate={(x, y) => setMenu({ cwd: g.cwd, launch: true, x, y })}
            onMenu={(x, y) => setMenu({ cwd: g.cwd, x, y })}
            onSessionMenu={(id, x, y) => setMenu({ cwd: g.cwd, sessionId: id, x, y })}
          />
        ))}
      </div>

      {menu && menuGroup && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menuGroup, menu.sessionId, menu.launch)} onClose={closeMenu} />}
    </aside>
  );
}
