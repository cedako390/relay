import type { SessionStatus, TaskStatus } from '@orch/shared';
import { TriangleAlert } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

const SESSION_STYLES: Record<SessionStatus, string> = {
  starting: 'border-sky-500/30 bg-sky-500/10 text-sky-300',
  idle: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  busy: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  waiting: 'border-violet-500/30 bg-violet-500/10 text-violet-300',
  shell: 'border-teal-500/30 bg-teal-500/10 text-teal-300',
  closed: 'border-zinc-500/30 bg-zinc-500/10 text-zinc-400',
  dead: 'border-red-500/30 bg-red-500/10 text-red-300',
};

const TASK_STYLES: Record<TaskStatus, string> = {
  pending: 'border-zinc-500/30 bg-zinc-500/10 text-zinc-300',
  queued: 'border-sky-500/30 bg-sky-500/10 text-sky-300',
  running: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  done: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  failed: 'border-red-500/30 bg-red-500/10 text-red-300',
  cancelled: 'border-zinc-500/30 bg-zinc-500/10 text-zinc-500',
};

const DOT_STYLES: Record<SessionStatus, string> = {
  starting: 'bg-sky-400',
  idle: 'bg-emerald-400',
  busy: 'bg-amber-400 animate-pulse',
  waiting: 'bg-violet-400 animate-pulse',
  shell: 'bg-teal-400',
  closed: 'bg-zinc-500',
  dead: 'bg-red-400',
};

/** Compact status marker for the sidebar and tabs. */
export function SessionStatusDot({ status, className }: { status: SessionStatus; className?: string }) {
  return <span title={status} className={cn('inline-block size-2 shrink-0 rounded-full', DOT_STYLES[status], className)} />;
}

export function SessionStatusBadge({ status, suspicious = false }: { status: SessionStatus; suspicious?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <Badge variant="outline" className={cn(SESSION_STYLES[status])}>
        <span className={cn('size-1.5 rounded-full bg-current', status === 'busy' && 'animate-pulse')} />
        {status}
      </Badge>
      {suspicious && (
        <span title="Busy with no activity for over 10 minutes" className="text-amber-400">
          <TriangleAlert className="size-4" />
        </span>
      )}
    </span>
  );
}

export function TaskStatusBadge({ status }: { status: TaskStatus }) {
  return (
    <Badge variant="outline" className={cn(TASK_STYLES[status])}>
      {status}
    </Badge>
  );
}
