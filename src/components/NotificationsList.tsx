import Loading from './ui/Loading';
import { Bell, CheckCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { useAuth } from '../lib/AuthContext';
import { screenCache } from '../lib/screenCache';
import { supabase } from '../lib/supabaseClient';
import type { Notification } from '../lib/types';
import ScreenHeader from './ui/ScreenHeader';

// A directly-addressable "/notifications" page (see App.tsx, same pattern
// as EncounterDetail.tsx) - reachable by any role via the bell icon on
// every AppHeader. Shows this account's full notification history, newest
// first; tapping one marks it read (and, for a patient with an
// appointment-linked one, jumps straight to that booking).
export default function NotificationsList() {
  const { session, profile } = useAuth();
  const navigate = useNavigate();
  // Shown at once from the last visit (lib/screenCache.ts), refreshed below.
  const cachedRows = screenCache.get<Notification[]>('notifications');
  const [rows, setRows] = useState<Notification[]>(cachedRows ?? []);
  const [loading, setLoading] = useState(!cachedRows);

  const load = async () => {
    if (!session) return;
    if (rows.length === 0) setLoading(true);
    // A lifecycle notice that also went out over WhatsApp/SMS logs a second
    // row for that channel (see notify.ts) purely as a delivery record - this
    // screen only ever shows the in-app copy, so the same message never
    // appears to double up here.
    const { data } = await supabase
      .from('notifications')
      .select('*')
      .eq('user_id', session.user.id)
      .eq('channel', 'in_app')
      .order('at', { ascending: false })
      .limit(200);
    const fresh = (data ?? []) as Notification[];
    setRows(fresh);
    setLoading(false);
    screenCache.set('notifications', fresh);
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user.id]);

  const markRead = async (n: Notification) => {
    if (!n.read) {
      await supabase.from('notifications').update({ read: true }).eq('id', n.id);
      const next = rows.map((r) => (r.id === n.id ? { ...r, read: true } : r));
      setRows(next);
      screenCache.set('notifications', next);
    }
    if (profile?.role === 'patient' && n.appointment_id) {
      navigate(`/bookings/${n.appointment_id}`);
    }
  };

  const markAllRead = async () => {
    if (!session) return;
    const unreadIds = rows.filter((r) => !r.read).map((r) => r.id);
    if (unreadIds.length === 0) return;
    await supabase.from('notifications').update({ read: true }).in('id', unreadIds);
    const next = rows.map((r) => ({ ...r, read: true }));
    setRows(next);
    screenCache.set('notifications', next);
  };

  const unreadCount = rows.filter((r) => !r.read).length;

  return (
    <div>
      <ScreenHeader
        title="Notifications"
        back={-1}
        action={
          unreadCount > 0 ? (
            <button type="button" onClick={markAllRead} aria-label="Mark all read" title="Mark all read" className="cursor-pointer rounded-full bg-white/15 p-1.5 text-white ring-1 ring-white/25 outline-none transition hover:bg-white/25 focus-visible:ring-2 focus-visible:ring-white">
              <CheckCheck size={20} aria-hidden />
            </button>
          ) : undefined
        }
      />

      <div className="mx-auto max-w-3xl px-4 py-4">
        {loading && <p className="mt-3 text-sm text-slate-400"><Loading /></p>}
        {!loading && rows.length === 0 && (
          <div className="mt-8 flex flex-col items-center text-center text-slate-400">
            <Bell size={28} />
            <p className="mt-2 text-sm">No notifications yet.</p>
          </div>
        )}

        <div className="mt-3 space-y-2">
          {rows.map((n) => (
            <button
              key={n.id}
              onClick={() => markRead(n)}
              className={`block w-full rounded-2xl border p-3 text-left text-sm ${
                n.read ? 'border-slate-100 bg-white text-slate-500' : 'border-brand-200 bg-brand-50 text-slate-800'
              }`}
            >
              <div className="flex items-start gap-2">
                {!n.read && <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-600" />}
                <div className="min-w-0 flex-1">
                  <p className={n.read ? '' : 'font-semibold'}>{n.message}</p>
                  <p className="mt-1 text-xs text-slate-400">{new Date(n.at).toLocaleString()}</p>
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
