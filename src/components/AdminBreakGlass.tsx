import { useCallback, useEffect, useState, type FormEvent } from 'react';

import { supabase } from '../lib/supabaseClient';
import Button from './ui/Button';
import Card from './ui/Card';
import StatusPill from './ui/StatusPill';

// Just-in-time access to ONE patient's record for ONE reason, for a few
// minutes. Request -> a different person approves -> it works until it expires
// -> every read is logged. No other screen lets internal staff read patient
// health data (migration 79).
type StaffRole = 'ops' | 'support' | 'security_approver' | null;

interface BgRequest {
  id: string;
  requester: string;
  requester_name: string;
  mrn: string;
  reason: string;
  ticket_ref: string;
  minutes: number;
  state: 'pending' | 'approved' | 'denied' | 'revoked' | 'expired' | 'lapsed';
  requested_at: string;
  decision_note: string | null;
  expires_at: string | null;
}
interface AccessRow {
  section: string;
  row_count: number;
  at: string;
}

const SECTIONS = ['profile', 'encounters', 'visits', 'prescriptions', 'conditions', 'files'] as const;

function tone(state: BgRequest['state']): 'live' | 'warning' | 'danger' | 'neutral' {
  if (state === 'approved') return 'live';
  if (state === 'pending') return 'warning';
  if (state === 'denied' || state === 'revoked') return 'danger';
  return 'neutral';
}

function minutesLeft(iso: string | null): number {
  return iso ? Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 60000)) : 0;
}

export default function AdminBreakGlass() {
  const [role, setRole] = useState<StaffRole | undefined>(undefined);
  const [requests, setRequests] = useState<BgRequest[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [mrn, setMrn] = useState('');
  const [reason, setReason] = useState('');
  const [ticket, setTicket] = useState('');
  const [minutes, setMinutes] = useState(15);

  const [openId, setOpenId] = useState<string | null>(null);
  const [section, setSection] = useState<(typeof SECTIONS)[number]>('profile');
  const [data, setData] = useState<unknown>(null);
  const [log, setLog] = useState<AccessRow[]>([]);
  const [, setTick] = useState(0);

  const load = useCallback(async () => {
    const [{ data: r }, { data: list, error: listError }] = await Promise.all([
      supabase.rpc('staff_role'),
      supabase.rpc('list_breakglass_requests'),
    ]);
    setRole((r as StaffRole) ?? null);
    if (listError) setError(listError.message);
    setRequests((list ?? []) as BgRequest[]);
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(() => setTick((n) => n + 1), 30000); // refresh the countdowns
    return () => clearInterval(t);
  }, [load]);

  const run = async (fn: () => PromiseLike<{ error: { message: string } | null }>) => {
    setBusy(true);
    setError(null);
    const { error: e } = await fn();
    setBusy(false);
    if (e) setError(e.message.replace(/^[A-Z_]+: /, ''));
    await load();
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      const res = await supabase.rpc('request_breakglass', {
        p_mrn: mrn, p_reason: reason, p_ticket: ticket, p_minutes: minutes,
      });
      if (!res.error) {
        setMrn('');
        setReason('');
        setTicket('');
      }
      return res;
    });
  };

  const decide = (id: string, approve: boolean) => {
    let note: string | null = null;
    if (!approve) {
      note = window.prompt('Why are you denying this request?');
      if (!note) return;
    }
    run(() => supabase.rpc('decide_breakglass', { p_id: id, p_approve: approve, p_note: note }));
  };

  const read = async (id: string, s: (typeof SECTIONS)[number]) => {
    setOpenId(id);
    setSection(s);
    setBusy(true);
    setError(null);
    const { data: d, error: e } = await supabase.rpc('breakglass_open_patient', { p_request_id: id, p_section: s });
    setBusy(false);
    if (e) {
      setData(null);
      setError(e.message.replace(/^[A-Z_]+: /, ''));
    } else {
      setData(d);
    }
    const { data: l } = await supabase.rpc('list_breakglass_access', { p_request_id: id });
    setLog((l ?? []) as AccessRow[]);
    await load();
  };

  if (role === undefined) return <p className="text-sm text-slate-500">Loading...</p>;
  if (role === null) {
    return (
      <Card>
        <h2 className="text-lg font-bold text-slate-900">Patient records</h2>
        <p className="mt-1 text-sm text-slate-500">
          Your account has no internal role, so it can't request access to patient records. Ask a security approver to
          assign one.
        </p>
      </Card>
    );
  }

  const isApprover = role === 'security_approver';

  return (
    <div>
      <h2 className="text-lg font-bold text-slate-900">Patient records - break-glass access</h2>
      <p className="mt-0.5 text-xs text-slate-400">
        Patient health data is closed to staff by default. Access needs a reason and a second person's approval, lasts
        minutes, and every read is logged. Your role: <b>{role.replace('_', ' ')}</b>.
      </p>

      {error && <p className="mt-3 rounded-2xl bg-red-50 p-3 text-sm text-red-700">{error}</p>}

      {!isApprover && (
        <Card className="mt-4">
          <h3 className="text-sm font-bold text-slate-900">Request access</h3>
          <form onSubmit={submit} className="mt-2 space-y-2">
            <label className="block text-xs font-bold text-slate-700" htmlFor="bg-mrn">Patient MRN</label>
            <input id="bg-mrn" value={mrn} onChange={(e) => setMrn(e.target.value)} placeholder="MRN-00012456"
              className="w-full rounded-2xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-brand-500" required />
            <label className="block text-xs font-bold text-slate-700" htmlFor="bg-ticket">Support ticket / reference</label>
            <input id="bg-ticket" value={ticket} onChange={(e) => setTicket(e.target.value)} placeholder="SUP-1234" minLength={3} maxLength={100}
              className="w-full rounded-2xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-brand-500" required />
            <label className="block text-xs font-bold text-slate-700" htmlFor="bg-reason">Why do you need it? (at least 20 characters)</label>
            <textarea id="bg-reason" value={reason} onChange={(e) => setReason(e.target.value)} minLength={20} maxLength={1000} rows={3}
              className="w-full rounded-2xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-brand-500" required />
            <label className="block text-xs font-bold text-slate-700" htmlFor="bg-min">How long? (5-60 minutes)</label>
            <input id="bg-min" type="number" min={5} max={60} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}
              className="w-28 rounded-2xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-brand-500" required />
            <Button type="submit" variant="dark" disabled={busy} full>Request access</Button>
          </form>
        </Card>
      )}

      <h3 className="mt-5 text-sm font-bold text-slate-900">{isApprover ? 'All requests' : 'Your requests'}</h3>
      {requests.length === 0 && <p className="mt-2 text-sm text-slate-400">No requests yet.</p>}
      <div className="mt-2 space-y-3">
        {requests.map((r) => {
          const active = r.state === 'approved' && minutesLeft(r.expires_at) > 0;
          return (
            <Card key={r.id}>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-bold text-slate-900">{r.mrn} - {r.ticket_ref}</p>
                  <p className="text-xs text-slate-500">
                    {r.requester_name} - {new Date(r.requested_at).toLocaleString()} - {r.minutes} min
                  </p>
                </div>
                <StatusPill label={active ? `active - ${minutesLeft(r.expires_at)} min left` : r.state} tone={tone(r.state)} />
              </div>
              <p className="mt-2 text-sm text-slate-700">{r.reason}</p>
              {r.decision_note && <p className="mt-1 text-xs text-slate-500">Note: {r.decision_note}</p>}

              <div className="mt-3 flex flex-wrap gap-2">
                {isApprover && r.state === 'pending' && (
                  <>
                    <Button variant="dark" disabled={busy} onClick={() => decide(r.id, true)}>Approve</Button>
                    <Button variant="danger" disabled={busy} onClick={() => decide(r.id, false)}>Deny</Button>
                  </>
                )}
                {(active || r.state === 'pending') && (
                  <Button variant="outline" disabled={busy} onClick={() => run(() => supabase.rpc('revoke_breakglass', { p_id: r.id }))}>
                    {active ? 'End access now' : 'Cancel'}
                  </Button>
                )}
                {isApprover && r.state !== 'pending' && (
                  <Button variant="ghost" disabled={busy} onClick={async () => {
                    setOpenId(r.id); setData(null);
                    const { data: l } = await supabase.rpc('list_breakglass_access', { p_request_id: r.id });
                    setLog((l ?? []) as AccessRow[]);
                  }}>View access log</Button>
                )}
              </div>

              {active && !isApprover && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {SECTIONS.map((s) => (
                    <button key={s} onClick={() => read(r.id, s)} disabled={busy}
                      className={`rounded-full px-3 py-1 text-xs font-bold ${openId === r.id && section === s ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-700'}`}>
                      {s}
                    </button>
                  ))}
                </div>
              )}

              {openId === r.id && (
                <>
                  {data != null && (
                    <pre className="mt-3 max-h-80 overflow-auto rounded-2xl bg-slate-50 p-3 text-xs text-slate-800">
                      {JSON.stringify(data, null, 2)}
                    </pre>
                  )}
                  {log.length > 0 && (
                    <div className="mt-3">
                      <p className="text-xs font-bold text-slate-600">Access log (what was opened)</p>
                      <ul className="mt-1 text-xs text-slate-500">
                        {log.map((l, i) => (
                          <li key={i}>{new Date(l.at).toLocaleTimeString()} - {l.section} ({l.row_count} rows)</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </>
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}
