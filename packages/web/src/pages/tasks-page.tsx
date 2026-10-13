import type { Task } from '@orch/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Ban, CornerDownRight, Play, Plus, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { FolderInput } from '@/components/folder-input';
import { TaskStatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input, Label, Select, Textarea } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useNow } from '@/hooks/use-now';
import { api } from '@/lib/api';
import { shortId, timeAgo } from '@/lib/utils';
import { useLive } from '@/store/live';

interface Row {
  task: Task;
  depth: number;
}

/** Depth-first flattening by parent_id; tasks whose parent is missing are shown as roots. */
export function flattenTree(tasks: Task[]): Row[] {
  const byParent = new Map<string | null, Task[]>();
  const ids = new Set(tasks.map((t) => t.id));
  for (const t of [...tasks].sort((a, b) => a.createdAt - b.createdAt)) {
    const key = t.parentId && ids.has(t.parentId) ? t.parentId : null;
    byParent.set(key, [...(byParent.get(key) ?? []), t]);
  }
  const rows: Row[] = [];
  const walk = (parent: string | null, depth: number): void => {
    for (const task of byParent.get(parent) ?? []) {
      rows.push({ task, depth });
      walk(task.id, depth + 1);
    }
  };
  walk(null, 0);
  return rows;
}

function CreateTaskDialog() {
  const config = useQuery({ queryKey: ['config'], queryFn: api.config, staleTime: Infinity });
  const tasksById = useLive((s) => s.tasks);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [model, setModel] = useState('');
  const [cwd, setCwd] = useState('');
  const [parentId, setParentId] = useState('');
  const [start, setStart] = useState(false);

  const create = useMutation({
    mutationFn: () =>
      api.createTask({
        title,
        description,
        model: model || undefined,
        cwd: cwd.trim() || undefined,
        parentId: parentId || null,
        start,
      }),
    onSuccess: () => {
      setOpen(false);
      setTitle('');
      setDescription('');
    },
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus /> New task
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogTitle>New task</DialogTitle>
        <DialogDescription>A worker session is started for it when “start now” is checked (subject to the worker limit).</DialogDescription>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="t-title">Title</Label>
            <Input id="t-title" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="t-desc">Instructions for the worker</Label>
            <Textarea id="t-desc" value={description} onChange={(e) => setDescription(e.target.value)} className="min-h-24" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="t-model">Model</Label>
              <Select id="t-model" value={model} onChange={(e) => setModel(e.target.value)}>
                <option value="">default</option>
                {config.data?.allowedModels.map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="t-parent">Parent task</Label>
              <Select id="t-parent" value={parentId} onChange={(e) => setParentId(e.target.value)}>
                <option value="">none</option>
                {Object.values(tasksById).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.title}
                  </option>
                ))}
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="t-cwd">Working directory</Label>
            <FolderInput id="t-cwd" value={cwd} onChange={setCwd} placeholder={config.data?.defaultCwd ?? ''} />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={start} onChange={(e) => setStart(e.target.checked)} className="size-4 accent-emerald-500" />
            Start a worker now
          </label>
          {create.error && <p className="text-sm text-destructive">{create.error.message}</p>}
          <div className="flex justify-end">
            <Button type="submit" disabled={!title.trim() || create.isPending}>
              Create
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function TaskActions({ task }: { task: Task }) {
  const start = useMutation({ mutationFn: () => api.startTask(task.id) });
  const cancel = useMutation({ mutationFn: () => api.updateTask(task.id, { status: 'cancelled' }) });
  const remove = useMutation({ mutationFn: () => api.deleteTask(task.id) });
  const error = start.error ?? cancel.error ?? remove.error;
  const settled = task.status === 'done' || task.status === 'failed' || task.status === 'cancelled';

  return (
    <div className="flex items-center justify-end gap-1">
      {error && (
        <span className="max-w-48 truncate text-xs text-destructive" title={error.message}>
          {error.message}
        </span>
      )}
      {(task.status === 'pending' || task.status === 'queued') && (
        <Button size="sm" variant="ghost" disabled={start.isPending || task.status === 'queued'} onClick={() => start.mutate()}>
          <Play /> Start
        </Button>
      )}
      {!settled && (
        <Button size="sm" variant="ghost" disabled={cancel.isPending} onClick={() => cancel.mutate()}>
          <Ban /> Cancel
        </Button>
      )}
      {settled && (
        <Button size="sm" variant="ghost" disabled={remove.isPending} onClick={() => remove.mutate()} title="Delete (with sub-tasks)">
          <Trash2 />
        </Button>
      )}
    </div>
  );
}

export function TasksPage() {
  const tasksById = useLive((s) => s.tasks);
  const now = useNow();
  const rows = useMemo(() => flattenTree(Object.values(tasksById)), [tasksById]);
  const running = rows.filter((r) => r.task.status === 'running').length;

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Tasks</h1>
          <p className="text-sm text-muted-foreground">
            {running} running · {rows.length} total
          </p>
        </div>
        <CreateTaskDialog />
      </div>

      <div className="rounded-xl border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Title</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Model</TableHead>
              <TableHead>Session</TableHead>
              <TableHead className="w-1/3">Result</TableHead>
              <TableHead>Updated</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={7} className="py-10 text-center text-muted-foreground">
                  No tasks yet.
                </TableCell>
              </TableRow>
            )}
            {rows.map(({ task, depth }) => (
              <TableRow key={task.id}>
                <TableCell>
                  <div className="flex items-center gap-1.5" style={{ paddingLeft: depth * 20 }}>
                    {depth > 0 && <CornerDownRight className="size-3.5 shrink-0 text-muted-foreground" />}
                    <span className="font-medium">{task.title}</span>
                  </div>
                </TableCell>
                <TableCell>
                  <TaskStatusBadge status={task.status} />
                </TableCell>
                <TableCell className="text-muted-foreground">{task.model ?? 'default'}</TableCell>
                <TableCell>
                  {task.sessionId ? (
                    <Link to="/sessions/$sessionId" params={{ sessionId: task.sessionId }} className="font-mono text-xs underline-offset-4 hover:underline">
                      {shortId(task.sessionId)}
                    </Link>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="max-w-0 truncate text-xs text-muted-foreground" title={task.result ?? undefined}>
                  {task.result ?? '—'}
                </TableCell>
                <TableCell className="text-muted-foreground">{timeAgo(task.updatedAt, now)}</TableCell>
                <TableCell>
                  <TaskActions task={task} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
