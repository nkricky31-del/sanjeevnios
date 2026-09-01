import { ArrowLeft } from 'lucide-react';
import { useEffect, useState } from 'react';

import { supabase } from '../lib/supabaseClient';
import type { PrescriptionDrug } from '../lib/types';
import Button from './ui/Button';
import Card from './ui/Card';
import StatusPill from './ui/StatusPill';

interface Props {
  appointmentId: string;
  doctorId: string;
  patientName: string;
  onClose: () => void;
}

interface VisitRow {
  id: string;
  diagnosis: string | null;
  notes: string | null;
  follow_up_date: string | null;
  no_prescription: boolean;
}

interface AttachedRxRow {
  id: string;
  items: PrescriptionDrug[];
  created_at: string;
}

export default function VisitScreen({ appointmentId, doctorId, patientName, onClose }: Props) {
  const [visit, setVisit] = useState<VisitRow | null>(null);
  const [attachedRx, setAttachedRx] = useState<AttachedRxRow | null>(null);
  const [loading, setLoading] = useState(true);

  const [diagnosis, setDiagnosis] = useState('');
  const [notes, setNotes] = useState('');
  const [followUpDate, setFollowUpDate] = useState('');
  const [noPrescription, setNoPrescription] = useState(false);
  const [savingNotes, setSavingNotes] = useState(false);
  const [notesError, setNotesError] = useState<string | null>(null);
  const [notesSaved, setNotesSaved] = useState(false);

  const [drugs, setDrugs] = useState<PrescriptionDrug[]>([]);
  const [drugName, setDrugName] = useState('');
  const [dosage, setDosage] = useState('');
  const [frequency, setFrequency] = useState('');
  const [duration, setDuration] = useState('');
  const [signingRx, setSigningRx] = useState(false);
  const [rxError, setRxError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    // Defensive against duplicate visit rows from earlier testing (before
    // this screen enforced one visit per appointment): always take the most
    // recent one rather than .single()/.maybeSingle() erroring on >1 row.
    const { data: visitRows } = await supabase
      .from('visits')
      .select('id, diagnosis, notes, follow_up_date, no_prescription')
      .eq('appointment_id', appointmentId)
      .order('created_at', { ascending: false })
      .limit(1);
    const visitData = (visitRows ?? [])[0] as VisitRow | undefined;
    setVisit(visitData ?? null);

    if (visitData) {
      setDiagnosis(visitData.diagnosis ?? '');
      setNotes(visitData.notes ?? '');
      setFollowUpDate(visitData.follow_up_date ?? '');
      setNoPrescription(visitData.no_prescription);

      const { data: rxRows } = await supabase
        .from('prescriptions')
        .select('id, items, created_at')
        .eq('visit_id', visitData.id)
        .eq('status', 'attached')
        .order('created_at', { ascending: false })
        .limit(1);
      setAttachedRx((rxRows ?? [])[0] as AttachedRxRow | undefined ?? null);
    } else {
      setAttachedRx(null);
    }
    setLoading(false);
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appointmentId]);

  const saveNotes = async () => {
    setNotesError(null);
    setSavingNotes(true);
    setNotesSaved(false);

    const payload = {
      appointment_id: appointmentId,
      diagnosis: diagnosis.trim() || null,
      notes: notes.trim() || null,
      follow_up_date: followUpDate || null,
      no_prescription: noPrescription,
    };

    const { error } = visit
      ? await supabase.from('visits').update(payload).eq('id', visit.id)
      : await supabase.from('visits').insert(payload);

    setSavingNotes(false);
    if (error) {
      setNotesError(error.message);
      return;
    }
    setNotesSaved(true);
    load();
  };

  const addDrug = () => {
    if (!drugName.trim()) return;
    setDrugs((prev) => [
      ...prev,
      { name: drugName.trim(), dosage: dosage.trim(), frequency: frequency.trim(), durationDays: Number(duration) || 0 },
    ]);
    setDrugName('');
    setDosage('');
    setFrequency('');
    setDuration('');
  };

  const removeDrug = (index: number) => {
    setDrugs((prev) => prev.filter((_, i) => i !== index));
  };

  const signAndAttach = async () => {
    setRxError(null);
    if (drugs.length === 0) {
      setRxError('Add at least one medicine before signing.');
      return;
    }
    setSigningRx(true);

    let visitId = visit?.id;
    if (!visitId) {
      // Notes haven't been saved yet - create the visit row now so the
      // prescription has something to attach to.
      const { data: newVisit, error: visitError } = await supabase
        .from('visits')
        .insert({
          appointment_id: appointmentId,
          diagnosis: diagnosis.trim() || null,
          notes: notes.trim() || null,
          follow_up_date: followUpDate || null,
          no_prescription: false,
        })
        .select('id')
        .single();
      if (visitError || !newVisit) {
        setSigningRx(false);
        setRxError(visitError?.message ?? 'Could not save the visit.');
        return;
      }
      visitId = newVisit.id;
    }

    const { error: rxInsertError } = await supabase.from('prescriptions').insert({
      visit_id: visitId,
      items: drugs,
      signed_by: doctorId,
      status: 'attached',
    });

    setSigningRx(false);
    if (rxInsertError) {
      setRxError(rxInsertError.message);
      return;
    }
    setDrugs([]);
    load();
  };

  const rxComplete = attachedRx != null || noPrescription;

  return (
    <div>
      <div className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-4">
        <button onClick={onClose} className="inline-flex items-center gap-1 text-sm font-medium text-slate-500">
          <ArrowLeft size={16} /> Back to queue
        </button>
        {!loading && (
          <StatusPill
            label={attachedRx ? 'Rx attached' : noPrescription ? 'No prescription' : 'Rx pending'}
            tone={attachedRx || noPrescription ? 'live' : 'warning'}
          />
        )}
      </div>

      <div className="mx-auto max-w-md px-4 py-6">
        <h1 className="text-xl font-bold text-slate-900">{patientName}</h1>
        <p className="text-sm text-slate-500">Visit</p>

        {loading ? (
          <p className="mt-4 text-sm text-slate-400">Loading...</p>
        ) : (
          <>
            <Card className="mt-4">
              <p className="text-sm font-semibold text-slate-900">Notes & diagnosis</p>
              <div className="mt-3 space-y-3">
                <div>
                  <label className="text-sm font-medium text-slate-700">Diagnosis</label>
                  <input
                    type="text"
                    value={diagnosis}
                    onChange={(e) => setDiagnosis(e.target.value)}
                    className="mt-1 w-full rounded-2xl border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-500"
                  />
                </div>
                <div>
                  <label className="text-sm font-medium text-slate-700">Notes</label>
                  <textarea
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    rows={3}
                    className="mt-1 w-full rounded-2xl border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-500"
                  />
                </div>
                <div>
                  <label className="text-sm font-medium text-slate-700">Follow-up date (optional)</label>
                  <input
                    type="date"
                    value={followUpDate}
                    onChange={(e) => setFollowUpDate(e.target.value)}
                    className="mt-1 w-full rounded-2xl border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-500"
                  />
                </div>
                {!attachedRx && (
                  <label className="flex items-start gap-2 text-sm text-slate-700">
                    <input
                      type="checkbox"
                      checked={noPrescription}
                      onChange={(e) => setNoPrescription(e.target.checked)}
                      className="mt-0.5"
                    />
                    No prescription needed for this visit
                  </label>
                )}
              </div>
              {notesError && <p className="mt-2 text-sm text-red-600">{notesError}</p>}
              {notesSaved && !notesError && <p className="mt-2 text-sm text-emerald-600">Saved.</p>}
              <Button onClick={saveNotes} disabled={savingNotes} className="mt-3">
                {savingNotes ? 'Saving...' : 'Save notes'}
              </Button>
            </Card>

            <Card className="mt-4">
              <p className="text-sm font-semibold text-slate-900">E-prescription</p>

              {attachedRx ? (
                <div className="mt-2 space-y-1">
                  {attachedRx.items.map((drug, i) => (
                    <p key={i} className="text-sm text-slate-600">
                      • {drug.name} — {drug.dosage} · {drug.frequency} · {drug.durationDays}d
                    </p>
                  ))}
                  <p className="mt-2 text-xs text-slate-400">Signed and attached.</p>
                </div>
              ) : (
                <>
                  {drugs.length > 0 && (
                    <div className="mt-2 space-y-1">
                      {drugs.map((d, i) => (
                        <div key={i} className="flex items-center justify-between text-xs text-slate-600">
                          <span>
                            • {d.name} — {d.dosage} · {d.frequency} · {d.durationDays}d
                          </span>
                          <button onClick={() => removeDrug(i)} className="font-medium text-red-600">
                            Remove
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="mt-3 flex flex-wrap gap-2">
                    <input
                      type="text"
                      placeholder="Drug"
                      value={drugName}
                      onChange={(e) => setDrugName(e.target.value)}
                      className="min-w-[100px] flex-1 rounded-2xl border border-slate-200 px-2 py-1.5 text-sm"
                    />
                    <input
                      type="text"
                      placeholder="Dosage"
                      value={dosage}
                      onChange={(e) => setDosage(e.target.value)}
                      className="w-24 rounded-2xl border border-slate-200 px-2 py-1.5 text-sm"
                    />
                    <input
                      type="text"
                      placeholder="Freq"
                      value={frequency}
                      onChange={(e) => setFrequency(e.target.value)}
                      className="w-20 rounded-2xl border border-slate-200 px-2 py-1.5 text-sm"
                    />
                    <input
                      type="text"
                      placeholder="Days"
                      inputMode="numeric"
                      value={duration}
                      onChange={(e) => setDuration(e.target.value)}
                      className="w-16 rounded-2xl border border-slate-200 px-2 py-1.5 text-sm"
                    />
                    <button onClick={addDrug} className="rounded-lg bg-slate-200 px-3 py-1.5 text-sm font-medium">
                      + Add
                    </button>
                  </div>

                  {rxError && <p className="mt-2 text-sm text-red-600">{rxError}</p>}
                  <Button onClick={signAndAttach} disabled={signingRx} className="mt-3">
                    {signingRx ? 'Signing...' : 'Sign & attach prescription'}
                  </Button>
                </>
              )}
            </Card>

            {!rxComplete && (
              <p className="mt-3 text-xs text-slate-400">
                This visit can't be marked done until a prescription is attached or "No prescription needed" is
                saved above.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
