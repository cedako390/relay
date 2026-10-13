import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** "just now", "5m ago", "3h ago", "2d ago" */
export function timeAgo(ts: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export const shortId = (id: string): string => id.slice(0, 8);

/** Last path segments, so long working directories stay readable. */
/** Last path segment: the default project name. */
export function folderName(p: string): string {
  return p.split(/[\\/]+/).filter(Boolean).at(-1) ?? p;
}

export function shortPath(p: string, keep = 2): string {
  const parts = p.split(/[\\/]+/).filter(Boolean);
  return parts.length <= keep ? p : `…/${parts.slice(-keep).join('/')}`;
}
