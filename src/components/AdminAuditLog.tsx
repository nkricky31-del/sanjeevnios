import Loading from './ui/Loading';
import { AuditCharts } from './Insights';
import { useEffect, useState } from 'react';

import { useAdminLive } from '../lib/adminLive';
import { supabase } from '../lib/supabaseClient';
import Card from './ui/Card';

interface AuditRow {
  id: string;
  actor: string | null;
  action: string;
  target: string | null;
  at: string;
  actor_profile: { name: string | null; phone: string | null } | null;
}

const FETCH_LIMIT = 200;

export default function AdminAuditLog() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    // No loading flag on a refresh: what's shown stays up until the new data
    // arrives, so reopening this tab (KeepTab) or pressing Refresh never blanks it.
    const { data } = await supabase
      .from('audit_log')
      .select('id, actor, action, target, at, actor_profile:profiles(name, phone)')
      .order('at', { ascending: false })
      .limit(FETCH_LIMIT);
    setRows((data ?? []) as unknown as AuditRow[]);
    setLoading(false);
  };

  // Reloads when something it shows changes, and every minute while on
  // screen (lib/adminLive.ts).
  const live = useAdminLive([]);
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live]);

  return (
    <div>
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-slate-900">Audit log</h2>
        <button onClick={load} className="text-sm font-medium text-brand-600">
          Refresh
        </button>
      </div>
      <p className="mt-1 text-xs text-slate-400">Every admin decision - who did what, and when.</p>

      <div className="mt-3"><AuditCharts rows={rows} /></div>

      <div className="mt-2 space-y-2">
        {loading && <p className="text-sm text-slate-400"><Loading /></p>}
        {!loading && rows.length === 0 && <p className="text-sm text-slate-400">No entries yet.</p>}
        {rows.map((r) => (
          <Card key={r.id}>
            <p className="font-semibold text-slate-900">{r.action}</p>
            <p className="text-xs text-slate-500">
              By {r.actor_profile?.name ?? r.actor_profile?.phone ?? r.actor ?? 'unknown'}
            </p>
            {r.target && <p className="font-mono text-xs text-slate-400">Target: {r.target}</p>}
            <p className="mt-1 text-xs text-slate-400">{new Date(r.at).toLocaleString()}</p>
          </Card>
        ))}
      </div>
    </div>
  );
}
