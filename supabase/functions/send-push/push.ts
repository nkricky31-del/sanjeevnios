// What send-push does, apart from the wiring in index.ts: check the request,
// claim the alerts, turn each into a phone message, send, and forget phones
// Firebase says are gone. Kept free of Supabase and Deno.serve so it can be
// tested on its own.
import type { FcmMessage, SendOutcome } from '../_shared/fcm.ts';

export const MAX_IDS = 500;

// Queue alerts: high importance ("Queue updates" channel on Android), and the
// newest replaces the last for the same booking.
export const QUEUE_TYPES = new Set([
  'checked_in', 'queue_almost', 'queue_next', 'token_called', 'clinic_reminder', 'queue_skip',
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The only request accepted: {"ids": [1 to 500 notification ids]}. */
export function readIds(body: unknown): string[] | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== 'ids') return null;
  const ids = (body as { ids: unknown }).ids;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_IDS) return null;
  if (!ids.every((x) => typeof x === 'string' && UUID.test(x))) return null;
  return [...new Set(ids.map((x: string) => x.toLowerCase()))];
}

/** A row of claim_push_batch (migration 93): one alert for one phone. */
export interface ClaimedRow {
  notification_id: string;
  appointment_id: string | null;
  type: string;
  title: string;
  message: string;
  token: string;
  platform: 'android' | 'ios';
}

/** The text on the phone: the alert's own words, except where they would put
    medical detail on the lock screen. */
export function pushText(type: string, message: string): string {
  if (type === 'report_added') return 'The clinic added a new file to your visit. Tap to view it.';
  return message.length > 1000 ? message.slice(0, 997) + '...' : message;
}

export function toMessage(row: ClaimedRow): FcmMessage {
  const queue = QUEUE_TYPES.has(row.type);
  const urgent = queue || row.type === 'reporting_time_reminder';
  return {
    token: row.token,
    title: (row.title || 'SanjeevniOS').slice(0, 100),
    body: pushText(row.type, row.message),
    data: {
      route: row.appointment_id ? `/bookings/${row.appointment_id}` : '/notifications',
      type: row.type,
      notification_id: row.notification_id,
      ...(row.appointment_id ? { appointment_id: row.appointment_id } : {}),
    },
    group: queue && row.appointment_id ? `queue-${row.appointment_id}` : undefined,
    channelId: queue ? 'queue' : 'general',
    urgent,
    ttlSeconds: queue ? 600 : row.type === 'reporting_time_reminder' ? 3600 : 86400,
  };
}

export interface PushDeps {
  claim(ids: string[]): Promise<ClaimedRow[]>;
  forget(tokens: string[]): Promise<void>;
  send(message: FcmMessage): Promise<SendOutcome>;
  warn?(text: string): void;
}

export interface PushResult {
  alerts: number;
  sent: number;
  failed: number;
  removed: number;
}

/** Claims the alerts (each is only ever claimed once) and sends them, a few
    phones at a time. */
export async function runPush(ids: string[], deps: PushDeps): Promise<PushResult> {
  const rows = await deps.claim(ids);
  const todo = [...rows];
  const gone = new Set<string>();
  let sent = 0;
  let failed = 0;

  const worker = async () => {
    for (let row = todo.shift(); row; row = todo.shift()) {
      const out = await deps.send(toMessage(row));
      if (out.ok) {
        sent++;
        continue;
      }
      failed++;
      if (out.gone) gone.add(row.token);
      else deps.warn?.(`push ${row.notification_id} (${row.platform}) not sent: ${out.status} ${out.code} ${out.message}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, rows.length) }, worker));

  if (gone.size) await deps.forget([...gone]);
  return { alerts: new Set(rows.map((r) => r.notification_id)).size, sent, failed, removed: gone.size };
}
