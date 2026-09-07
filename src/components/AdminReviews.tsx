import { Star, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';

import { supabase } from '../lib/supabaseClient';
import type { Review } from '../lib/types';
import AdminRejectForm from './AdminRejectForm';
import Button from './ui/Button';
import Card from './ui/Card';
import SectionTitle from './ui/SectionTitle';
import StatusPill from './ui/StatusPill';

interface Row extends Review {
  doctors: { name: string } | null;
  clinics: { name: string } | null;
}

const FETCH_LIMIT = 100;

// Moderation queue for migration_61_reviews.sql - reviews aren't held for
// approval before going live (unlike name changes), so this is a spot-check
// list rather than a pending queue: every visible review, newest first, with
// Hide (reason required, mirrors AdminRejectForm's existing shape) and a
// separate Hidden tab for anything already moderated off, with Unhide to
// reverse it. Delete is the one irreversible action - a second click to
// confirm, no separate form.
export default function AdminReviews() {
  const [tab, setTab] = useState<'visible' | 'hidden'>('visible');
  const [visible, setVisible] = useState<Row[]>([]);
  const [hidden, setHidden] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [hideOpenFor, setHideOpenFor] = useState<string | null>(null);
  const [deleteConfirmFor, setDeleteConfirmFor] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    const select = '*, doctors(name), clinics(name)';
    const [{ data: visibleData }, { data: hiddenData }] = await Promise.all([
      supabase.from('reviews').select(select).eq('status', 'visible').order('created_at', { ascending: false }).limit(FETCH_LIMIT),
      supabase.from('reviews').select(select).eq('status', 'hidden').order('hidden_at', { ascending: false }).limit(FETCH_LIMIT),
    ]);
    setVisible((visibleData ?? []) as unknown as Row[]);
    setHidden((hiddenData ?? []) as unknown as Row[]);
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, []);

  const hide = async (r: Row, reason: string) => {
    setError(null);
    setBusy(r.id);
    const { error: rpcError } = await supabase.rpc('moderate_review', {
      p_review_id: r.id,
      p_action: 'hide',
      p_reason: reason,
    });
    setBusy(null);
    if (rpcError) {
      setError(rpcError.message);
      return;
    }
    setHideOpenFor(null);
    load();
  };

  const unhide = async (r: Row) => {
    setError(null);
    setBusy(r.id);
    const { error: rpcError } = await supabase.rpc('moderate_review', { p_review_id: r.id, p_action: 'unhide' });
    setBusy(null);
    if (rpcError) {
      setError(rpcError.message);
      return;
    }
    load();
  };

  const remove = async (r: Row) => {
    setError(null);
    setBusy(r.id);
    const { error: rpcError } = await supabase.rpc('delete_review', { p_review_id: r.id });
    setBusy(null);
    if (rpcError) {
      setError(rpcError.message);
      return;
    }
    setDeleteConfirmFor(null);
    load();
  };

  const card = (r: Row, hiddenTab: boolean) => (
    <Card key={r.id}>
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-bold text-slate-900">
            {r.doctors?.name ?? 'Unknown doctor'} · {r.clinics?.name ?? 'Unknown clinic'}
          </p>
          <p className="text-xs text-slate-400">{new Date(r.created_at).toLocaleString()}</p>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {[1, 2, 3, 4, 5].map((n) => (
            <Star key={n} size={13} className={r.rating >= n ? 'fill-amber-400 text-amber-400' : 'text-slate-200'} />
          ))}
        </div>
      </div>

      {r.comment && <p className="mt-2 text-sm text-slate-700">{r.comment}</p>}

      <p className="mt-1.5 text-xs text-slate-400">
        {r.reviewer_name ?? 'Unnamed patient'}
        {r.anonymous && ' (posted anonymously - not shown to other patients)'}
      </p>

      {hiddenTab && (
        <div className="mt-2 rounded-xl bg-red-50 p-2.5 text-xs text-red-700">
          <p className="font-semibold">Hidden{r.hidden_at ? ` ${new Date(r.hidden_at).toLocaleString()}` : ''}</p>
          {r.hidden_reason && <p className="mt-0.5">{r.hidden_reason}</p>}
        </div>
      )}

      <div className="mt-2 flex flex-wrap gap-2">
        {hiddenTab ? (
          <Button onClick={() => unhide(r)} disabled={busy === r.id}>
            Unhide
          </Button>
        ) : (
          <Button variant="danger" onClick={() => setHideOpenFor((prev) => (prev === r.id ? null : r.id))} disabled={busy === r.id}>
            {hideOpenFor === r.id ? 'Cancel' : 'Hide'}
          </Button>
        )}
        {deleteConfirmFor === r.id ? (
          <>
            <Button variant="danger" onClick={() => remove(r)} disabled={busy === r.id}>
              {busy === r.id ? 'Deleting...' : 'Confirm delete'}
            </Button>
            <Button variant="ghost" onClick={() => setDeleteConfirmFor(null)}>
              Cancel
            </Button>
          </>
        ) : (
          <Button variant="ghost" onClick={() => setDeleteConfirmFor(r.id)} disabled={busy === r.id}>
            <Trash2 size={14} /> Delete
          </Button>
        )}
      </div>

      {hideOpenFor === r.id && (
        <AdminRejectForm
          label="Reason for hiding this review (kept for your own records, not shown to the reviewer)"
          onConfirm={(reason) => hide(r, reason)}
          onCancel={() => setHideOpenFor(null)}
        />
      )}
    </Card>
  );

  return (
    <div>
      {error && <p className="mb-3 text-sm text-red-600">{error}</p>}

      <SectionTitle actionLabel="Refresh" onAction={load}>
        Reviews
      </SectionTitle>
      <div className="mt-2 flex gap-1 rounded-2xl border border-slate-100 bg-white p-1">
        <button
          onClick={() => setTab('visible')}
          className={`flex-1 rounded-xl px-3 py-2 text-sm font-bold ${tab === 'visible' ? 'bg-brand-50 text-brand-600' : 'text-slate-500'}`}
        >
          Visible ({visible.length})
        </button>
        <button
          onClick={() => setTab('hidden')}
          className={`flex-1 rounded-xl px-3 py-2 text-sm font-bold ${tab === 'hidden' ? 'bg-brand-50 text-brand-600' : 'text-slate-500'}`}
        >
          Hidden ({hidden.length})
        </button>
      </div>

      <div className="mt-2 space-y-2">
        {loading && <p className="text-sm text-slate-400">Loading...</p>}
        {!loading && tab === 'visible' && visible.length === 0 && <p className="text-sm text-slate-400">No reviews yet.</p>}
        {!loading && tab === 'hidden' && hidden.length === 0 && <p className="text-sm text-slate-400">Nothing hidden.</p>}
        {!loading && tab === 'visible' && visible.map((r) => card(r, false))}
        {!loading && tab === 'hidden' && hidden.map((r) => card(r, true))}
      </div>

      <p className="mt-4 text-xs text-slate-400">
        <StatusPill label="Note" tone="neutral" /> Hiding or deleting a review updates that doctor's and clinic's
        rating immediately - both only ever count visible reviews.
      </p>
    </div>
  );
}
