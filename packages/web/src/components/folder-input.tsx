import { FolderOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { canPickFolder, pickFolder } from '@/lib/native';

interface Props {
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

/** Path field; inside the desktop app it also gets a button that opens the native folder dialog. */
export function FolderInput({ id, value, onChange, placeholder }: Props) {
  const browse = async () => {
    const picked = await pickFolder(value.trim() || placeholder);
    if (picked) onChange(picked);
  };

  return (
    <div className="flex gap-2">
      <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="font-mono" />
      {canPickFolder() && (
        <Button type="button" variant="outline" onClick={() => void browse()}>
          <FolderOpen />
          Выбрать…
        </Button>
      )}
    </div>
  );
}
