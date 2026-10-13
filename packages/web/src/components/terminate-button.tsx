import { useMutation } from '@tanstack/react-query';
import { Square } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';

/** Two-step button: first click arms it, second click terminates. */
export function TerminateButton({ sessionId }: { sessionId: string }) {
  const [armed, setArmed] = useState(false);
  const kill = useMutation({ mutationFn: () => api.killSession(sessionId) });
  return (
    <Button
      size="sm"
      variant={armed ? 'destructive' : 'ghost'}
      className="h-7"
      disabled={kill.isPending}
      onClick={() => {
        if (!armed) {
          setArmed(true);
          window.setTimeout(() => setArmed(false), 3000);
          return;
        }
        kill.mutate();
      }}
    >
      <Square /> {armed ? 'Confirm' : 'Terminate'}
    </Button>
  );
}
