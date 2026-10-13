import type { CreateSessionBody } from '@orch/shared';
import { useMutation } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import type { ContextMenuItem } from '@/components/context-menu';
import { api } from '@/lib/api';

export type LaunchKind = NonNullable<CreateSessionBody['kind']>;

/** Starts a session (Claude Code or a plain terminal) in a folder and opens it. */
export function useStartSession() {
  const navigate = useNavigate();
  return useMutation({
    mutationFn: ({ cwd, kind }: { cwd: string; kind: LaunchKind }) => api.createSession({ cwd, kind }),
    onSuccess: (session) => navigate({ to: '/sessions/$sessionId', params: { sessionId: session.id } }),
  });
}

/** The "what to launch" choice shown by every "+" button. */
export function launchMenuItems(start: (kind: LaunchKind) => void, disabled = false): ContextMenuItem[] {
  return [
    { label: 'Claude Code', disabled, onSelect: () => start('orchestrator') },
    { label: 'Терминал', disabled, onSelect: () => start('terminal') },
  ];
}
