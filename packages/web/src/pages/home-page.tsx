import { Plus, TerminalSquare } from 'lucide-react';
import { CreateSessionDialog } from '@/components/create-session-dialog';
import { Button } from '@/components/ui/button';

export function HomePage() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
      <TerminalSquare className="size-10 text-muted-foreground/60" />
      <div>
        <p className="font-medium">No session open</p>
        <p className="text-sm text-muted-foreground">Pick one from the history on the left or start a new one.</p>
      </div>
      <CreateSessionDialog>
        <Button variant="secondary">
          <Plus /> New session
        </Button>
      </CreateSessionDialog>
    </div>
  );
}
