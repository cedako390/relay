import { terminalServerFrameSchema, type TerminalClientFrame } from '@orch/shared';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import { useEffect, useRef, useState } from 'react';
import { createStreamRecolor, TERMINAL_ACCENTS, type TerminalAccent } from '@/lib/terminal-recolor';
import { useTerminalTheme } from '@/store/terminal-theme';

type Link = 'connecting' | 'live' | 'lost' | 'unavailable';

const LINK_LABEL: Record<Link, string> = {
  connecting: 'connecting…',
  live: 'live',
  lost: 'reconnecting…',
  unavailable: 'no live terminal for this session',
};

/**
 * xterm.js bound to /ws/terminal/:id. The server replays its output buffer on connect, so a fresh
 * page shows the current screen immediately. Closing the page only detaches; the session keeps running.
 */
export function TerminalView({ sessionId }: { sessionId: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [link, setLink] = useState<Link>('connecting');
  const accent = useTerminalTheme((s) => s.accent);
  const setAccent = useTerminalTheme((s) => s.setAccent);

  useEffect(() => {
    const el = host.current;
    if (!el) return;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: "'Cascadia Mono', 'JetBrains Mono', Consolas, monospace",
      fontSize: 13,
      scrollback: 5000,
      allowProposedApi: true,
      theme: { background: '#262b36', foreground: '#e6e8ec', cursor: '#e6e8ec', selectionBackground: '#434b5c' },
    });
    const recolor = createStreamRecolor(accent);
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    try {
      // GPU renderer; falls back to xterm's DOM renderer if WebGL is unavailable or the context is lost.
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {
      /* DOM renderer stays active */
    }
    const refit = (): void => {
      try {
        fit.fit();
      } catch {
        // container not laid out yet
      }
    };
    refit();
    term.focus();

    // Ctrl+Shift+C / Ctrl+Shift+V, as in any terminal; plain Ctrl+C / Ctrl+V still reach the program.
    // `code` (not `key`) so it works in any keyboard layout.
    term.attachCustomKeyEventHandler((e) => {
      if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return true;
      if (e.code !== 'KeyC' && e.code !== 'KeyV') return true;
      if (e.type === 'keydown') {
        // Also stops the browser's own action (DevTools picker for C, a second paste for V).
        e.preventDefault();
        if (e.code === 'KeyC') {
          const selection = term.getSelection();
          if (selection) void navigator.clipboard.writeText(selection).catch(() => undefined);
        } else {
          void navigator.clipboard
            .readText()
            .then((text) => text && term.paste(text))
            .catch(() => undefined);
        }
      }
      return false;
    });

    let socket: WebSocket | undefined;
    let timer: number | undefined;
    let disposed = false;
    let attempt = 0;
    let ended = false;

    const send = (frame: TerminalClientFrame): void => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
    };

    const connect = (): void => {
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(`${proto}//${window.location.host}/ws/terminal/${sessionId}`);
      socket.onopen = () => {
        attempt = 0;
        setLink('live');
        refit();
        send({ type: 'resize', cols: term.cols, rows: term.rows });
      };
      socket.onmessage = (msg: MessageEvent<string>) => {
        const frame = terminalServerFrameSchema.safeParse(JSON.parse(msg.data));
        if (!frame.success) return;
        const f = frame.data;
        if (f.type === 'snapshot') {
          term.reset();
          recolor.reset();
          term.write(recolor.write(f.data));
        } else if (f.type === 'output') {
          term.write(recolor.write(f.data));
        } else {
          ended = true;
          term.write(`\r\n\x1b[90m[process exited${f.code === null ? '' : ` with code ${f.code}`}]\x1b[0m\r\n`);
        }
      };
      socket.onclose = (e) => {
        if (disposed) return;
        if (e.code === 4404 || ended) {
          setLink('unavailable');
          return;
        }
        setLink('lost');
        attempt += 1;
        timer = window.setTimeout(connect, Math.min(5000, 400 * attempt));
      };
    };
    connect();

    const input = term.onData((data) => send({ type: 'input', data }));
    const resize = term.onResize(({ cols, rows }) => send({ type: 'resize', cols, rows }));
    const observer = new ResizeObserver(refit);
    observer.observe(el);

    return () => {
      disposed = true;
      window.clearTimeout(timer);
      observer.disconnect();
      input.dispose();
      resize.dispose();
      socket?.close();
      term.dispose();
    };
    // A new accent re-creates the terminal; the server replays its buffer, which is then recolored from scratch.
  }, [sessionId, accent]);

  const nextAccent: TerminalAccent = accent === 'blue' ? 'claude' : 'blue';

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <div ref={host} className="min-h-0 flex-1" />
      <button
        type="button"
        title={`Terminal accent: ${accent} (click for ${nextAccent})`}
        aria-label={`Switch terminal accent to ${nextAccent}`}
        onClick={() => setAccent(nextAccent)}
        className="absolute top-2 right-3 size-3.5 rounded-full border border-white/30 opacity-60 transition-opacity hover:opacity-100"
        style={{ backgroundColor: TERMINAL_ACCENTS[accent] }}
      />
      <span className="pointer-events-none absolute right-3 bottom-2 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-muted-foreground">
        {LINK_LABEL[link]}
      </span>
    </div>
  );
}
