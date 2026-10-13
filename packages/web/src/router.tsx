import { isActiveSessionStatus } from '@orch/shared';
import { createRootRoute, createRoute, createRouter, Outlet } from '@tanstack/react-router';
import { Sidebar } from '@/components/sidebar';
import { TabBar } from '@/components/tab-bar';
import { useLiveSync } from '@/hooks/use-live-sync';
import { cn } from '@/lib/utils';
import { useLive } from '@/store/live';
import { HomePage } from '@/pages/home-page';
import { SessionPage } from '@/pages/session-page';
import { TasksPage } from '@/pages/tasks-page';

function Layout() {
  const connected = useLive((s) => s.connected);
  const sessions = useLive((s) => s.sessions);
  const active = Object.values(sessions).filter((s) => isActiveSessionStatus(s.status)).length;
  useLiveSync();

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <TabBar />
          <main className="min-h-0 flex-1 overflow-auto bg-background">
            <Outlet />
          </main>
        </div>
      </div>
      <footer className="flex h-6 shrink-0 items-center gap-3 border-t bg-titlebar px-3 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1.5" title="Live updates over /ws/events">
          <span className={cn('size-1.5 rounded-full', connected ? 'bg-emerald-400' : 'animate-pulse bg-red-400')} />
          {connected ? 'live' : 'reconnecting'}
        </span>
        <span>{active} active</span>
        <span>{Object.keys(sessions).length} total</span>
      </footer>
    </div>
  );
}

const rootRoute = createRootRoute({ component: Layout });
const homeRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: HomePage });
const sessionRoute = createRoute({ getParentRoute: () => rootRoute, path: '/sessions/$sessionId', component: SessionPage });
const tasksRoute = createRoute({ getParentRoute: () => rootRoute, path: '/tasks', component: TasksPage });

const routeTree = rootRoute.addChildren([homeRoute, sessionRoute, tasksRoute]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
