import { useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { FolderOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input, Label, Select } from '@/components/ui/input';
import { api } from '@/lib/api';
import { canPickFolder, pickFolder } from '@/lib/native';
import { folderName } from '@/lib/utils';
import { useProject } from '@/store/project';

interface Props {
  /** The trigger element (rendered via asChild). Omit it to open the dialog from outside with `open`. */
  children?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function CreateSessionDialog({ children, open: controlledOpen, onOpenChange }: Props) {
  const navigate = useNavigate();
  const config = useQuery({ queryKey: ['config'], queryFn: api.config, staleTime: Infinity });
  const [ownOpen, setOwnOpen] = useState(false);
  const open = controlledOpen ?? ownOpen;
  const setOpen = (value: boolean): void => {
    setOwnOpen(value);
    onOpenChange?.(value);
  };
  const [name, setName] = useState('');
  const [cwd, setCwd] = useState('');
  const [model, setModel] = useState('');
  const canPick = canPickFolder();
  // Outside the desktop app there is no folder dialog, so the server's default directory is used on start.
  const startCwd = cwd || (canPick ? '' : (config.data?.defaultCwd ?? ''));

  const browse = async () => {
    // No folder yet: the desktop shell starts the dialog on the Desktop.
    const picked = await pickFolder(cwd || undefined);
    if (picked) setCwd(picked);
  };

  const create = useMutation({
    mutationFn: () => api.createSession({ cwd: startCwd, model: model || undefined }),
    onSuccess: (session) => {
      setOpen(false);
      setName('');
      setCwd('');
      const project = useProject.getState();
      project.setName(session.cwd, name.trim());
      project.unarchive(session.cwd);
      project.addProjects([session.cwd]);
      project.setExpanded([session.cwd], true);
      void navigate({ to: '/sessions/$sessionId', params: { sessionId: session.id } });
    },
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {children && <DialogTrigger asChild>{children}</DialogTrigger>}
      {/* Radix would return focus to the trigger and steal it from the freshly opened terminal. */}
      <DialogContent onCloseAutoFocus={(e) => e.preventDefault()}>
        <DialogTitle>New project</DialogTitle>
        <DialogDescription>Pick a folder; starts the interactive `claude` CLI there in a pseudo-terminal on this machine.</DialogDescription>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="project-name">Name</Label>
            <Input id="project-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder={folderName(cwd) || 'Project name'} />
          </div>
          <div className="space-y-1.5">
            <Label>Folder</Label>
            {canPick && (
              <Button type="button" variant="outline" className="w-full" onClick={() => void browse()}>
                <FolderOpen />
                Выбрать папку…
              </Button>
            )}
            <p className="truncate font-mono text-xs text-muted-foreground" title={cwd}>
              {cwd || 'Папка не выбрана'}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="model">Model</Label>
            <Select id="model" value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="">default{config.data?.defaultModel ? ` (${config.data.defaultModel})` : ''}</option>
              {config.data?.allowedModels.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </Select>
          </div>
          {create.error && <p className="text-sm text-destructive">{create.error.message}</p>}
          <div className="flex justify-end">
            <Button type="submit" disabled={create.isPending || !config.data || !startCwd}>
              {create.isPending ? 'Starting…' : 'Start session'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
