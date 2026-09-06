import { FileText, User, Users } from 'lucide-react';
import { useEffect, useState } from 'react';

import { openIdDocument } from '../lib/storage';
import { supabase } from '../lib/supabaseClient';
import type { NameChangeRequest } from '../lib/types';
import AdminRejectForm from './AdminRejectForm';
import Button from './ui/Button';
import Card from './ui/Card';
import IconTile from './ui/IconTile';
import SectionTitle from './ui/SectionTitle';
import StatusPill from './ui/StatusPill';

interface Row extends NameChangeRequest {
  account: { name: string | null; phone: string | null } | null;
  member: { name: string; mrn: string } | null;
}

const STATUS_TONE: Record<string, 'warning' | 'live' | 'danger'> = {
  pending: 'warning',
  approved: 'live',
  rejected: 'danger',
};

// The admin queue for schema.sql section 53 - the ONLY screen that can
// actually change a locked name (via review_name_change_request(), which
// itself does the write under app.name_change_write). Mirrors
// AdminDocumentReview's "view proof, approve/reject" shape.
export default function AdminNameChanges() {
  const [pending, setPending] = useState<Row[]>([]);
  const [recent, setRecent] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [finalNames, setFinalNames] = useState<Record<string, string>>({});
  const [rejectOpenFor, setRejectOpenFor] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    const select = '*, account:account_id(name, phone), member:member_id(name, mrn)';
    const [{ data: pendingData }, { data: recentData }] = await Promise.all([
      supabase
        .from('name_change_requests')
        .select(select)
        .eq('status', 'pending')
        .order('created_at', { ascending: true }),
      supabase
        .from('name_change_requests')
        .select(select)
        .in('status', ['approved', 'rejected'])
        .order('reviewed_at', { ascending: false })
        .limit(20),
    ]);
    setPending((pendingData ?? []) as unknown as Row[]);
    setRecent((recentData ?? []) as unknown as Row[]);
    setFinalNames((prev) => {
      const next = { ...prev };
      for (const r of (pendingData ?? []) as unknown as Row[]) {
        if (next[r.id] === undefined) next[r.id] = r.requested_name ?? '';
      }
      return next;
    });
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, []);

  const view = async (path: string) => {
    const url = await openIdDocument(path);
    if (!url) setError('Could not open the ID document.');
  };

  const approve = async (r: Row) => {
    setError(null);
    setBusy(r.id);
    const { error: rpcError } = await supabase.rpc('review_name_change_request', {
      p_request_id: r.id,
      p_approve: true,
      p_final_name: finalNames[r.id]?.trim() || null,
    });
    setBusy(null);
    if (rpcError) {
      setError(rpcError.message);
      return;
    }
    load();
  };

  const reject = async (r: Row, reason: string) => {
    setError(null);
    setBusy(r.id);
    const { error: rpcError } = await supabase.rpc('review_name_change_request', {
      p_request_id: r.id,
      p_approve: false,
      p_reject_reason: reason,
    });
    setBusy(null);
    if (rpcError) {
      setError(rpcError.message);
      return;
    }
    setRejectOpenFor(null);
    load();
  };

  return (
    <div>
      {error && <p className="mb-3 text-sm text-red-600">{error}</p>}

      <SectionTitle actionLabel="Refresh" onAction={load}>
        Pending name changes
      </SectionTitle>
      <div className="mt-2 space-y-2">
        {loading && <p className="text-sm text-slate-400">Loading...</p>}
        {!loading && pending.length === 0 && <p className="text-sm text-slate-400">Nothing pending.</p>}
        {pending.map((r) => {
          const who = r.member ? r.member.name : (r.account?.name ?? 'Unnamed patient');
          const sub = r.member ? `Family member · MRN ${r.member.mrn}` : `Account holder · +${r.account?.phone ?? '—'}`;
          return (
            <Card key={r.id}>
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2.5">
                  <IconTile icon={r.member ? Users : User} size="sm" />
                  <div className="min-w-0">
                    <p className="truncate font-bold text-slate-900">{who}</p>
                    <p className="truncate text-xs text-slate-400">{sub}</p>
                  </div>
                </div>
                <StatusPill label="Pending" tone="warning" />
              </div>

              <div className="mt-2 grid grid-cols-2 gap-2 text-sm">
                <div>
                  <p className="text-xs font-semibold text-slate-500">Current name</p>
                  <p className="text-slate-800">{r.current_name ?? '—'}</p>
                </div>
                <div>
                  <p className="text-xs font-semibold text-slate-500">Patient requested</p>
                  <p className="text-slate-800">{r.requested_name ?? '(left to admin)'}</p>
                </div>
              </div>

              <button
                onClick={() => view(r.id_document_path)}
                className="mt-2 flex items-center gap-1.5 text-xs font-semibold text-brand-600"
              >
                <FileText size={13} /> View government ID
              </button>

              <div className="mt-2">
                <label className="text-xs font-bold text-slate-700">Name to save</label>
                <input
                  type="text"
                  value={finalNames[r.id] ?? ''}
                  onChange={(e) => setFinalNames((prev) => ({ ...prev, [r.id]: e.target.value }))}
                  placeholder="Type the corrected name as it appears on the ID"
                  className="mt-1 w-full rounded-2xl border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-500"
                />
              </div>

              <div className="mt-2 flex flex-wrap gap-2">
                <Button onClick={() => approve(r)} disabled={busy === r.id || !finalNames[r.id]?.trim()}>
                  Approve
                </Button>
                <Button
                  variant="danger"
                  onClick={() => setRejectOpenFor((prev) => (prev === r.id ? null : r.id))}
                  disabled={busy === r.id}
                >
                  {rejectOpenFor === r.id ? 'Cancel' : 'Reject'}
                </Button>
              </div>

              {rejectOpenFor === r.id && (
                <AdminRejectForm
                  label="Reason for rejecting this name change"
                  onConfirm={(reason) => reject(r, reason)}
                  onCancel={() => setRejectOpenFor(null)}
                />
              )}
            </Card>
          );
        })}
      </div>

      <SectionTitle className="mt-6">Recently reviewed</SectionTitle>
      <div className="mt-2 space-y-2">
        {!loading && recent.length === 0 && <p className="text-sm text-slate-400">Nothing reviewed yet.</p>}
        {recent.map((r) => {
          const who = r.member ? r.member.name : (r.account?.name ?? 'Unnamed patient');
          return (
            <Card key={r.id}>
              <div className="flex items-center justify-between gap-2">
                <p className="truncate font-bold text-slate-900">{who}</p>
                <StatusPill label={r.status} tone={STATUS_TONE[r.status]} />
              </div>
              <p className="mt-1 text-sm text-slate-500">
                {r.current_name ?? '—'} → {r.requested_name ?? '—'}
              </p>
              {r.status === 'rejected' && r.reject_reason && (
                <p className="mt-1 text-xs font-medium text-red-600">Reason: {r.reject_reason}</p>
              )}
              {r.reviewed_at && (
                <p className="mt-1 text-xs text-slate-400">{new Date(r.reviewed_at).toLocaleString()}</p>
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}
