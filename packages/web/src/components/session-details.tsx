// Message queue and hook-event cards from the previous session page. Not rendered right now: the right
// panel is intentionally empty. Mount them there (see SessionPage) to bring them back.
import type { Message, SessionEvent } from '@orch/shared';
import { useMutation } from '@tanstack/react-query';
import { Send } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/input';
import { api } from '@/lib/api';
import { useLive } from '@/store/live';

const EMPTY_MESSAGES: Message[] = [];
const EMPTY_EVENTS: SessionEvent[] = [];

/** One-line description of a raw hook payload. */
function describeEvent(e: SessionEvent): string {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  if (typeof p.tool_name === 'string') return p.tool_name;
  if (typeof p.message === 'string') return p.message;
  if (typeof p.agent_type === 'string') return p.agent_type;
  if (typeof p.prompt === 'string') return p.prompt.slice(0, 80);
  if (typeof p.source === 'string') return p.source;
  if (typeof p.reason === 'string') return p.reason;
  return '';
}

export function MessagesCard({ sessionId, active }: { sessionId: string; active: boolean }) {
  const messages = useLive((s) => s.messages[sessionId]) ?? EMPTY_MESSAGES;
  const [text, setText] = useState('');
  const send = useMutation({
    mutationFn: (body: string) => api.postMessage(sessionId, body),
    onSuccess: () => setText(''),
  });
  const submit = (): void => {
    if (text.trim() && !send.isPending) send.mutate(text);
  };

  return (
    <Card className="min-h-0">
      <CardHeader>
        <CardTitle>Message queue</CardTitle>
        <span className="text-xs text-muted-foreground">{messages.filter((m) => m.status === 'queued').length} waiting</span>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="max-h-44 space-y-1.5 overflow-y-auto">
          {messages.length === 0 && <p className="text-xs text-muted-foreground">Nothing queued.</p>}
          {[...messages].reverse().map((m) => (
            <div key={m.id} className="rounded-md border bg-background/40 px-2 py-1.5 text-xs">
              <div className="mb-0.5 flex items-center justify-between text-[10px] text-muted-foreground">
                <span className={m.status === 'queued' ? 'text-amber-300' : 'text-emerald-300'}>{m.status}</span>
                <span>{new Date(m.deliveredAt ?? m.createdAt).toLocaleTimeString()}</span>
              </div>
              <p className="line-clamp-3 break-words whitespace-pre-wrap">{m.body}</p>
            </div>
          ))}
        </div>
        <div className="space-y-2">
          <Textarea
            value={text}
            disabled={!active}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={active ? 'Message for the agent (delivered when idle)…  Ctrl+Enter to queue' : 'Session has ended'}
            className="min-h-20 text-xs"
          />
          {send.error && <p className="text-xs text-destructive">{send.error.message}</p>}
          <Button size="sm" className="w-full" disabled={!active || !text.trim() || send.isPending} onClick={submit}>
            <Send /> Queue message
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function EventsCard({ sessionId }: { sessionId: string }) {
  const events = useLive((s) => s.events[sessionId]) ?? EMPTY_EVENTS;
  return (
    <Card className="min-h-0 flex-1">
      <CardHeader>
        <CardTitle>Recent events</CardTitle>
        <span className="text-xs text-muted-foreground">hooks</span>
      </CardHeader>
      <CardContent className="min-h-0 flex-1 overflow-y-auto">
        {events.length === 0 && <p className="text-xs text-muted-foreground">No events yet.</p>}
        <ul className="space-y-1">
          {events.slice(0, 40).map((e) => (
            <li key={e.id} className="flex gap-2 text-xs">
              <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{new Date(e.ts).toLocaleTimeString()}</span>
              <span className="shrink-0 font-medium">{e.type}</span>
              <span className="truncate text-muted-foreground" title={describeEvent(e)}>
                {describeEvent(e)}
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
