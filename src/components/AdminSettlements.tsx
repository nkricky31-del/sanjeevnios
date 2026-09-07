import { AlertTriangle, CheckCircle2, IndianRupee, PauseCircle } from 'lucide-react';
import { useEffect, useState } from 'react';

import { supabase } from '../lib/supabaseClient';
import type { SettlementStatus } from '../lib/types';
import AdminRejectForm from './AdminRejectForm';
import Button from './ui/Button';
import Card from './ui/Card';
import IconTile from './ui/IconTile';
import Segmented from './ui/Segmented';
import StatusPill from './ui/StatusPill';

interface SettlementRow {
  id: string;
  clinic_id: string;
  appointment_id: string;
  net_amount: number;
  commission_rate: number;
  platform_fee: number;
  status: SettlementStatus;
  hold_reason: string | null;
  net_payout: number | null;
  released_at: string | null;
  settled_at: string | null;
  razorpay_transfer_id: string | null;
  payout_reference: string | null;
  created_at: string;
  clinics: { name: string } | null;
  appointments: { date: string; slot_time: string; family_members: { name: string } | null } | null;
  profiles: { name: string | null } | null;
}

interface ClinicGroup {
  clinicId: string;
  clinicName: string;
  rows: SettlementRow[];
  total: number;
}

const STATUS_TONE: Record<SettlementStatus, 'live' | 'warning' | 'info' | 'neutral' | 'danger'> = {
  collected: 'neutral',
  eligible: 'warning',
  on_hold: 'danger',
  refunded: 'neutral',
  released: 'info',
  settled: 'live',
};

// Rounds the same way payouts.ts used to - a currency amount should never
// carry more than paise-level precision after a percentage cut.
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function groupByClinic(rows: SettlementRow[]): ClinicGroup[] {
  const byClinic = new Map<string, ClinicGroup>();
  for (const r of rows) {
    const entry = byClinic.get(r.clinic_id) ?? {
      clinicId: r.clinic_id,
      clinicName: r.clinics?.name ?? 'Unknown clinic',
      rows: [],
      total: 0,
    };
    entry.rows.push(r);
    entry.total = round2(entry.total + (r.net_amount - r.platform_fee));
    byClinic.set(r.clinic_id, entry);
  }
  return Array.from(byClinic.values()).sort((a, b) => b.total - a.total);
}

type ConfirmTarget =
  | { kind: 'one'; settlementId: string; label: string; amount: number }
  | { kind: 'clinic'; clinicId: string; label: string; amount: number }
  | { kind: 'all'; label: string; amount: number };

// The Admin settlement console (schema.sql migration 59): SanjeevniOS
// collects every online payment first (settlements starts a row at
// 'collected' the moment razorpay-capture-payment actually moves that money
// - see that function's own comment), and a payment only becomes eligible
// for payout once its visit is completed. Release is a database decision
// made here, immediately and reliably; whether real money also moves is a
// separate, best-effort call to release-clinic-payout afterwards (Razorpay
// Route) - see this file's releaseIds() for exactly where that split happens.
export default function AdminSettlements() {
  const [rows, setRows] = useState<SettlementRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<'eligible' | 'on_hold' | 'released' | 'settled'>('eligible');
  const [confirmTarget, setConfirmTarget] = useState<ConfirmTarget | null>(null);
  const [releasing, setReleasing] = useState(false);
  const [holdFormFor, setHoldFormFor] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNote, setActionNote] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    const { data } = await supabase
      .from('settlements')
      .select(
        '*, clinics(name), appointments(date, slot_time, family_members(name)), profiles!settlements_released_by_fkey(name)'
      )
      .neq('status', 'collected')
      .order('created_at', { ascending: false });
    setRows((data ?? []) as unknown as SettlementRow[]);
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, []);

  const eligible = rows.filter((r) => r.status === 'eligible');
  const onHold = rows.filter((r) => r.status === 'on_hold');
  const released = rows.filter((r) => r.status === 'released');
  const settled = rows.filter((r) => r.status === 'settled');
  const eligibleGroups = groupByClinic(eligible);
  const grandTotal = round2(eligible.reduce((sum, r) => sum + (r.net_amount - r.platform_fee), 0));

  // The actual side effect for every "Release" action, one-by-one or bulk:
  // the DB transition (release_settlement / release_eligible_settlements)
  // is the reliable, immediately-testable part - the edge function call
  // right after is a best-effort attempt at the real Razorpay Route
  // transfer, and its failure (or simply not being configured yet) never
  // undoes the release that already happened. See migration 59's header.
  const attemptTransfers = (settlementIds: string[]) => {
    if (settlementIds.length === 0) return;
    supabase.functions.invoke('release-clinic-payout', { body: { settlementIds } }).catch((err) => {
      console.error('release-clinic-payout failed:', err);
    });
  };

  const runRelease = async () => {
    if (!confirmTarget) return;
    setActionError(null);
    setActionNote(null);
    setReleasing(true);
    try {
      if (confirmTarget.kind === 'one') {
        const { error } = await supabase.rpc('release_settlement', { p_settlement_id: confirmTarget.settlementId });
        if (error) throw error;
        attemptTransfers([confirmTarget.settlementId]);
      } else if (confirmTarget.kind === 'clinic') {
        const { data, error } = await supabase.rpc('release_eligible_settlements', {
          p_clinic_id: confirmTarget.clinicId,
        });
        if (error) throw error;
        attemptTransfers(((data ?? []) as SettlementRow[]).map((r) => r.id));
      } else {
        const { data, error } = await supabase.rpc('release_eligible_settlements', { p_clinic_id: null });
        if (error) throw error;
        attemptTransfers(((data ?? []) as SettlementRow[]).map((r) => r.id));
      }
      setActionNote('Released.');
      setConfirmTarget(null);
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not release this payout.');
    } finally {
      setReleasing(false);
    }
  };

  const markSettled = async (id: string) => {
    setActionError(null);
    const { error } = await supabase.rpc('mark_settlement_settled', { p_settlement_id: id });
    if (error) {
      setActionError(error.message);
      return;
    }
    load();
  };

  const putOnHold = async (id: string, reason: string) => {
    setActionError(null);
    const { error } = await supabase.rpc('set_settlement_hold', { p_settlement_id: id, p_reason: reason });
    if (error) {
      setActionError(error.message);
      return;
    }
    setHoldFormFor(null);
    load();
  };

  const resolveHold = async (id: string, resolution: 'eligible' | 'refunded') => {
    setActionError(null);
    const { error } = await supabase.rpc('resolve_settlement_hold', { p_settlement_id: id, p_resolution: resolution });
    if (error) {
      setActionError(error.message);
      return;
    }
    load();
  };

  const patientLabel = (r: SettlementRow) => r.appointments?.family_members?.name ?? 'Patient';
  const visitLabel = (r: SettlementRow) =>
    r.appointments ? `${r.appointments.date} at ${r.appointments.slot_time?.slice(0, 5)}` : '';

  return (
    <div>
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-slate-900">Settlements</h2>
        <button onClick={load} className="text-sm font-medium text-brand-600">
          Refresh
        </button>
      </div>
      <p className="mt-1 text-xs text-slate-400">
        Online payments are collected by SanjeevniOS first. A payment becomes eligible once its visit is completed -
        release it to send the clinic's net (after the platform fee) their way.
      </p>

      {actionError && <p className="mt-2 text-sm text-red-600">{actionError}</p>}
      {actionNote && !actionError && <p className="mt-2 text-sm font-semibold text-emerald-600">{actionNote}</p>}

      {confirmTarget && (
        <div className="mt-3 rounded-2xl border border-brand-200 bg-brand-50 p-3.5">
          <p className="text-sm font-bold text-brand-900">Release ₹{confirmTarget.amount.toLocaleString()}?</p>
          <p className="mt-0.5 text-xs text-brand-700">{confirmTarget.label}</p>
          <div className="mt-2.5 flex gap-2">
            <Button onClick={runRelease} disabled={releasing}>
              {releasing ? 'Releasing...' : 'Confirm release'}
            </Button>
            <Button variant="ghost" onClick={() => setConfirmTarget(null)} disabled={releasing}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      <div className="mt-4">
        <Segmented
          options={[
            { value: 'eligible', label: `Eligible (${eligible.length})` },
            { value: 'on_hold', label: `On hold (${onHold.length})` },
            { value: 'released', label: `Released (${released.length})` },
            { value: 'settled', label: `Settled (${settled.length})` },
          ]}
          value={view}
          onChange={setView}
          variant="scroll"
        />
      </div>

      {loading && <p className="mt-3 text-sm text-slate-400">Loading...</p>}

      {!loading && view === 'eligible' && (
        <>
          {eligible.length > 0 && (
            <div className="mt-3 flex items-center justify-between rounded-2xl bg-emerald-50 p-3.5">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700">Total eligible</p>
                <p className="text-lg font-extrabold text-emerald-800">₹{grandTotal.toLocaleString()}</p>
              </div>
              <Button
                onClick={() =>
                  setConfirmTarget({ kind: 'all', label: `Every eligible payment, across ${eligibleGroups.length} clinic(s)`, amount: grandTotal })
                }
              >
                Release all eligible
              </Button>
            </div>
          )}

          {eligible.length === 0 && <p className="mt-3 text-sm text-slate-400">Nothing eligible right now.</p>}

          <div className="mt-3 space-y-3">
            {eligibleGroups.map((g) => (
              <Card key={g.clinicId}>
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <IconTile icon={IndianRupee} size="sm" tone="emerald" />
                    <p className="truncate font-bold text-slate-900">{g.clinicName}</p>
                  </div>
                  <p className="shrink-0 text-sm font-extrabold text-emerald-700">₹{g.total.toLocaleString()}</p>
                </div>
                <Button
                  className="mt-2"
                  variant="secondary"
                  onClick={() =>
                    setConfirmTarget({ kind: 'clinic', clinicId: g.clinicId, label: `Every eligible payment at ${g.clinicName}`, amount: g.total })
                  }
                >
                  Release all for this clinic
                </Button>

                <div className="mt-3 divide-y divide-slate-50 border-t border-slate-100">
                  {g.rows.map((r) => {
                    const net = round2(r.net_amount - r.platform_fee);
                    return (
                      <div key={r.id} className="py-2.5">
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-semibold text-slate-800">{patientLabel(r)}</p>
                            <p className="text-xs text-slate-400">{visitLabel(r)}</p>
                          </div>
                          <p className="shrink-0 text-sm font-bold text-slate-900">₹{net.toLocaleString()}</p>
                        </div>
                        <p className="mt-0.5 text-[11px] text-slate-400">
                          Collected ₹{r.net_amount.toLocaleString()} · fee ₹{r.platform_fee.toLocaleString()} (
                          {(r.commission_rate * 100).toFixed(1)}%)
                        </p>
                        <div className="mt-1.5 flex gap-2">
                          <Button
                            variant="secondary"
                            onClick={() =>
                              setConfirmTarget({ kind: 'one', settlementId: r.id, label: `${patientLabel(r)} · ${g.clinicName}`, amount: net })
                            }
                          >
                            Release
                          </Button>
                          <Button variant="ghost" onClick={() => setHoldFormFor((prev) => (prev === r.id ? null : r.id))}>
                            {holdFormFor === r.id ? 'Cancel' : 'Put on hold'}
                          </Button>
                        </div>
                        {holdFormFor === r.id && (
                          <AdminRejectForm
                            label="Reason for holding this payout (e.g. a dispute)"
                            onConfirm={(reason) => putOnHold(r.id, reason)}
                            onCancel={() => setHoldFormFor(null)}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              </Card>
            ))}
          </div>
        </>
      )}

      {!loading && view === 'on_hold' && (
        <div className="mt-3 space-y-2">
          {onHold.length === 0 && <p className="text-sm text-slate-400">Nothing on hold.</p>}
          {onHold.map((r) => (
            <Card key={r.id}>
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2.5">
                  <IconTile icon={PauseCircle} size="sm" tone="amber" />
                  <div className="min-w-0">
                    <p className="truncate font-bold text-slate-900">
                      {r.clinics?.name} · {patientLabel(r)}
                    </p>
                    <p className="text-xs text-slate-400">{visitLabel(r)}</p>
                  </div>
                </div>
                <p className="shrink-0 text-sm font-bold text-slate-900">₹{r.net_amount.toLocaleString()}</p>
              </div>
              {r.hold_reason && (
                <p className="mt-1.5 flex items-start gap-1.5 text-xs text-amber-700">
                  <AlertTriangle size={13} className="mt-0.5 shrink-0" /> {r.hold_reason}
                </p>
              )}
              <div className="mt-2 flex gap-2">
                <Button onClick={() => resolveHold(r.id, 'eligible')}>Clear hold - eligible</Button>
                <Button variant="danger" onClick={() => resolveHold(r.id, 'refunded')}>
                  Refund instead
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      {!loading && view === 'released' && (
        <div className="mt-3 space-y-2">
          {released.length === 0 && <p className="text-sm text-slate-400">Nothing released yet.</p>}
          {released.map((r) => (
            <Card key={r.id}>
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate font-bold text-slate-900">
                    {r.clinics?.name} · {patientLabel(r)}
                  </p>
                  <p className="text-xs text-slate-400">
                    Released {r.released_at ? new Date(r.released_at).toLocaleString() : ''}
                    {r.profiles?.name ? ` by ${r.profiles.name}` : ''}
                  </p>
                </div>
                <StatusPill label="Released" tone={STATUS_TONE.released} />
              </div>
              <p className="mt-1 text-sm font-bold text-emerald-700">Net ₹{(r.net_payout ?? 0).toLocaleString()}</p>
              {r.payout_reference && (
                <p className="mt-0.5 truncate font-mono text-[11px] text-slate-400">ref: {r.payout_reference}</p>
              )}
              {r.razorpay_transfer_id ? (
                <p className="mt-0.5 truncate font-mono text-[11px] text-slate-400">transfer: {r.razorpay_transfer_id}</p>
              ) : (
                <p className="mt-0.5 text-[11px] text-slate-400">
                  No Razorpay Route transfer yet - pay this clinic through your existing process, then confirm below.
                </p>
              )}
              <Button className="mt-2" variant="secondary" onClick={() => markSettled(r.id)}>
                Mark settled
              </Button>
            </Card>
          ))}
        </div>
      )}

      {!loading && view === 'settled' && (
        <div className="mt-3 space-y-2">
          {settled.length === 0 && <p className="text-sm text-slate-400">Nothing settled yet.</p>}
          {settled.map((r) => (
            <Card key={r.id}>
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate font-bold text-slate-900">
                    {r.clinics?.name} · {patientLabel(r)}
                  </p>
                  <p className="text-xs text-slate-400">
                    Settled {r.settled_at ? new Date(r.settled_at).toLocaleString() : ''}
                  </p>
                </div>
                <StatusPill label="Settled" tone={STATUS_TONE.settled} icon={CheckCircle2} />
              </div>
              <p className="mt-1 text-sm font-bold text-emerald-700">Net ₹{(r.net_payout ?? 0).toLocaleString()}</p>
              {r.payout_reference && (
                <p className="mt-0.5 truncate font-mono text-[11px] text-slate-400">ref: {r.payout_reference}</p>
              )}
              {r.razorpay_transfer_id && (
                <p className="mt-0.5 truncate font-mono text-[11px] text-slate-400">transfer: {r.razorpay_transfer_id}</p>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
