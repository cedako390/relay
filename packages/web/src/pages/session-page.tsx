import { isActiveSessionStatus } from '@orch/shared';
import { useMutation } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { RotateCcw } from 'lucide-react';
import { TerminalView } from '@/components/terminal-view';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { useLive } from '@/store/live';

/** Terminal in the middle, empty panel on the right (reserved; the message queue/events cards live in session-details.tsx). */
export function SessionPage() {
  const { sessionId } = useParams({ from: '/sessions/$sessionId' });
  const session = useLive((s) => s.sessions[sessionId]);
  const resume = useMutation({ mutationFn: () => api.resumeSession(sessionId) });

  if (!session) {
    return <p className="p-6 text-sm text-muted-foreground">Session not found (or still loading).</p>;
  }
  const ended = !isActiveSessionStatus(session.status);

  return (
    <div className="flex h-full min-h-0">
      <div className="relative min-w-0 flex-1">
        {/* A resumed session gets a new process (new pid) under the same id: remount to reconnect the terminal socket. */}
        <TerminalView key={`${sessionId}:${session.pid ?? 0}`} sessionId={sessionId} />
        {ended && (
          <div className="absolute inset-x-0 top-3 mx-auto flex w-fit max-w-[90%] items-center gap-3 rounded-lg border bg-card px-4 py-2 text-sm shadow-lg">
            <span className="text-muted-foreground">Session {session.status}.</span>
            <Button size="sm" variant="secondary" disabled={resume.isPending} onClick={() => resume.mutate()}>
              <RotateCcw /> {resume.isPending ? 'Resuming…' : 'Resume'}
            </Button>
            {resume.error && <span className="text-destructive">{resume.error.message}</span>}
          </div>
        )}
      </div>
      <aside className="w-72 shrink-0 border-l bg-sidebar" />
    </div>
  );
}
