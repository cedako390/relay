import { isActiveSessionStatus } from '@orch/shared';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { Plus, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { ContextMenu } from '@/components/context-menu';
import { CreateSessionDialog } from '@/components/create-session-dialog';
import { SessionStatusDot } from '@/components/status-badge';
import { TerminateButton } from '@/components/terminate-button';
import { isPlainClick, useOpenSession } from '@/hooks/use-open-session';
import { launchMenuItems, useStartSession } from '@/hooks/use-start-session';
import { sessionTitle } from '@/lib/session-title';
import { cn, folderName } from '@/lib/utils';
import { useLive } from '@/store/live';
import { useTabs } from '@/store/tabs';

export function TabBar() {
  const navigate = useNavigate();
  const open = useOpenSession();
  const params = useParams({ strict: false }) as { sessionId?: string };
  const activeId = params.sessionId;
  const openIds = useTabs((s) => s.open);
  const sessions = useLive((s) => s.sessions);
  const tasks = useLive((s) => s.tasks);
  const loaded = Object.keys(sessions).length > 0;

  // Visiting a session (sidebar, link, new session) opens its tab.
  useEffect(() => {
    if (activeId && sessions[activeId]) useTabs.getState().openTab(activeId);
  }, [activeId, sessions]);

  // Drop tabs whose session no longer exists, but only once the snapshot has arrived.
  const tabs = openIds.filter((id) => sessions[id]);
  useEffect(() => {
    if (!loaded) return;
    for (const id of openIds) if (!sessions[id]) useTabs.getState().closeTab(id);
  }, [loaded, openIds, sessions]);

  const close = (id: string): void => {
    const i = tabs.indexOf(id);
    useTabs.getState().closeTab(id);
    if (id !== activeId) return;
    const next = tabs[i + 1] ?? tabs[i - 1];
    if (next) void open(next);
    else void navigate({ to: '/' });
  };

  const active = activeId ? sessions[activeId] : undefined;

  // "+" starts a session in the project of the open tab (a worker runs in a worktree, so its task's folder is the project).
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const [newProject, setNewProject] = useState(false);
  const start = useStartSession();
  const projectCwd = active ? ((active.taskId ? tasks[active.taskId]?.cwd : null) ?? active.cwd) : undefined;

  return (
    <div className="flex h-9 shrink-0 items-stretch border-b bg-titlebar">
      <div className="flex min-w-0 items-stretch overflow-x-auto">
        {tabs.map((id) => {
          const s = sessions[id]!;
          const title = sessionTitle(s, tasks);
          const isActive = id === activeId;
          return (
            <div
              key={id}
              // Middle click closes the tab; mousedown is cancelled so Windows does not start autoscroll.
              onMouseDown={(e) => {
                if (e.button === 1) e.preventDefault();
              }}
              onAuxClick={(e) => {
                if (e.button !== 1) return;
                e.preventDefault();
                close(id);
              }}
              className={cn(
                'group relative flex w-44 shrink-0 items-center gap-2 border-r px-3 text-[13px]',
                isActive ? 'bg-background text-foreground' : 'text-muted-foreground hover:bg-sidebar hover:text-foreground',
              )}
            >
              <Link
                to="/sessions/$sessionId"
                params={{ sessionId: id }}
                className="flex min-w-0 flex-1 items-center gap-2"
                title={title}
                onClick={(e) => {
                  if (!isPlainClick(e.nativeEvent)) return;
                  e.preventDefault();
                  void open(id);
                }}
              >
                <SessionStatusDot status={s.status} />
                <span className="truncate">{title}</span>
              </Link>
              <button
                type="button"
                aria-label="Close tab"
                onClick={() => close(id)}
                className={cn('rounded p-0.5 hover:bg-accent', isActive ? 'opacity-70' : 'opacity-0 group-hover:opacity-70')}
              >
                <X className="size-3.5" />
              </button>
              {isActive && <span className="absolute inset-x-0 bottom-0 h-px bg-foreground/80" />}
            </div>
          );
        })}
        <button
          type="button"
          aria-label="Новая сессия"
          aria-haspopup="menu"
          title={projectCwd ? `Новая сессия в «${folderName(projectCwd)}»` : 'Новая сессия'}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setMenu({ x: r.left, y: r.bottom + 4 });
          }}
          className="flex w-9 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground"
        >
          <Plus className="size-4" />
        </button>
      </div>
      <div className="flex-1" />
      {active && isActiveSessionStatus(active.status) && (
        <div className="flex items-center px-2">
          <TerminateButton sessionId={active.id} />
        </div>
      )}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={closeMenu}
          items={[
            ...launchMenuItems((kind) => projectCwd && start.mutate({ cwd: projectCwd, kind }), !projectCwd || start.isPending),
            'separator',
            { label: 'Новый проект…', onSelect: () => setNewProject(true) },
          ]}
        />
      )}
      <CreateSessionDialog open={newProject} onOpenChange={setNewProject} />
    </div>
  );
}
