import type { QueueStatusRow } from './types';

export function computeNowServing(dayQueue: QueueStatusRow[]): number | null {
  const active = dayQueue.filter((r) => ['accepted', 'in_progress', 'done'].includes(r.status));
  if (active.length === 0) return null;

  const inProgress = active.find((r) => r.status === 'in_progress');
  if (inProgress) return inProgress.token_no;

  const doneTokens = active.filter((r) => r.status === 'done').map((r) => r.token_no);
  if (doneTokens.length > 0) return Math.max(...doneTokens) + 1;

  return Math.min(...active.map((r) => r.token_no));
}
