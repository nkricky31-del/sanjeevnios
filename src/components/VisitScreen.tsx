import Loading from './ui/Loading';
import { ArrowLeft, Clock, Printer } from 'lucide-react';
import { useEffect, useState } from 'react';

import { notifyPatient, prescriptionReadyMessage, reportAddedMessage } from '../lib/notify';
import { supabase } from '../lib/supabaseClient';
import type { FileCategory, FollowUpInterval, PrescriptionDrug } from '../lib/types';
import FileUpload from './FileUpload';
import PrescriptionEditor from './rx/PrescriptionEditor';
import PrescriptionItems, { RxLanguageToggle } from './rx/PrescriptionItems';
import { useRxLanguage } from '../lib/useRxLanguage';
import PrescriptionSheet from './rx/PrescriptionSheet';
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
  follow_up_interval: FollowUpInterval;
  follow_up_due_date: string | null;
  no_prescription: boolean;
  // schema.sql section 54 - written only by sync_consultation_stats(),
  // never edited here.
  consultation_started_at: string | null;
  consultation_ended_at: string | null;
  duration_minutes: number | null;
  waiting_time_minutes: number | null;
  needs_review: boolean;
}

const FOLLOW_UP_OPTIONS: { value: FollowUpInterval; label: string }[] = [
  { value: 'none', label: 'No follow-up needed' },
  { value: '7', label: 'In 7 days' },
  { value: '15', label: 'In 15 days' },
  { value: '30', label: 'In 30 days' },
];

interface AttachedRxRow {
  id: string;
  items: PrescriptionDrug[];
  advice_en?: string | null;
  advice_hi?: string | null;
  signed_by: string | null;
  created_at: string;
}

export default function VisitScreen({ appointmentId, doctorId, patientName, onClose }: Props) {
  const [visit, setVisit] = useState<VisitRow | null>(null);
  const [attachedRx, setAttachedRx] = useState<AttachedRxRow | null>(null);
  const [loading, setLoading] = useState(true);
  // Set when the server refuses to open this patient's clinical record for
  // the current login (e.g. a receptionist, or a doctor this patient isn't
  // seeing) - nothing clinical is loaded in that case.
  const [accessError, setAccessError] = useState<string | null>(null);
  // Who this visit is for - used to file reports against the patient and to
  // tell them (in their app) when a prescription or report is added.
  const [patient, setPatient] = useState<{ memberId: string; accountId: string | null; date: string; doctorName: string | null } | null>(null);
  // Bumped every 20s so files the patient uploads show up while this is open.
  const [filesTick, setFilesTick] = useState(0);

  const [diagnosis, setDiagnosis] = useState('');
  const [notes, setNotes] = useState('');
  const [followUpInterval, setFollowUpInterval] = useState<FollowUpInterval>('none');
  const [noPrescription, setNoPrescription] = useState(false);
  const [savingNotes, setSavingNotes] = useState(false);
  const [notesError, setNotesError] = useState<string | null>(null);
  const [notesSaved, setNotesSaved] = useState(false);

  const [signingRx, setSigningRx] = useState(false);
  const [rxError, setRxError] = useState<string | null>(null);
  const [printing, setPrinting] = useState(false);
  const [rxLanguage, setRxLanguage] = useRxLanguage();

  const load = async () => {
    setLoading(true);
    // Opening the record is its own audited step (migration 68): the server
    // checks patient.health.read for this login and patient, logs it, and
    // only then lets the reads below return anything.
    const { error: openError } = await supabase.rpc('open_patient_health_record', { p_appointment_id: appointmentId });
    if (openError) {
      setAccessError(openError.message);
      setLoading(false);
      return;
    }
    setAccessError(null);
    // Defensive against duplicate visit rows from earlier testing (before
    // this screen enforced one visit per appointment): always take the most
    // recent one rather than .single()/.maybeSingle() erroring on >1 row.
    const { data: visitRows } = await supabase
      .from('visits')
      .select(
        'id, diagnosis:diagnosis_plain, notes:notes_plain, follow_up_interval, follow_up_due_date, no_prescription, consultation_started_at, consultation_ended_at, duration_minutes, waiting_time_minutes, needs_review'
      )
      .eq('appointment_id', appointmentId)
      .order('created_at', { ascending: false })
      .limit(1);
    const visitData = (visitRows ?? [])[0] as VisitRow | undefined;
    setVisit(visitData ?? null);

    if (visitData) {
      setDiagnosis(visitData.diagnosis ?? '');
      setNotes(visitData.notes ?? '');
      setFollowUpInterval(visitData.follow_up_interval ?? 'none');
      setNoPrescription(visitData.no_prescription);

      const { data: rxRows } = await supabase
        .from('prescriptions')
        // '*' so the advice columns (migration 85) come back when they exist.
        .select('*')
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
    let live = true;
    (async () => {
      const { data: appt } = await supabase
        .from('appointments')
        .select('member_id, date, doctors(name)')
        .eq('id', appointmentId)
        .maybeSingle();
      const a = appt as { member_id: string; date: string; doctors: { name: string } | null } | null;
      if (!a || !live) return;
      const { data: contacts } = await supabase.rpc('get_patient_contacts', { p_ids: [a.member_id] });
      const accountId = ((contacts ?? []) as { account_id: string | null }[])[0]?.account_id ?? null;
      if (live) setPatient({ memberId: a.member_id, accountId, date: a.date, doctorName: a.doctors?.name ?? null });
    })();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') setFilesTick((n) => n + 1);
    }, 20_000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [appointmentId]);

  // The patient's app shows the visit on its own; this tells them it's there.
  const tellPatient = (type: string, message: string) => {
    if (!patient?.accountId) return;
    void notifyPatient({ userId: patient.accountId, appointmentId, type, message });
  };

  const FILE_KIND: Record<FileCategory, string> = { lab_report: 'Lab report', prescription: 'Prescription', xray: 'X-ray', photo: 'Photo' };

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
      follow_up_interval: followUpInterval,
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

  const signAndAttach = async (drugs: PrescriptionDrug[], adviceEn: string, adviceHi: string) => {
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
          follow_up_interval: followUpInterval,
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
      // Only sent when written, so a database without migration 85 still
      // accepts a prescription that has no advice.
      ...(adviceEn ? { advice_en: adviceEn } : {}),
      ...(adviceHi ? { advice_hi: adviceHi } : {}),
    });

    setSigningRx(false);
    if (rxInsertError) {
      setRxError(rxInsertError.message);
      return;
    }
    if (patient) tellPatient('prescription_ready', prescriptionReadyMessage(patient.doctorName, patient.date));
    load();
  };

  const rxComplete = attachedRx != null || noPrescription;

  return (
    <div>
      <div className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-4">
        <button onClick={onClose} className="inline-flex items-center gap-1 text-sm font-medium text-slate-500">
          <ArrowLeft size={16} /> Back to queue
        </button>
        {!loading && !accessError && (
          <StatusPill
            label={attachedRx ? 'Rx attached' : noPrescription ? 'No prescription' : 'Rx pending'}
            tone={attachedRx || noPrescription ? 'live' : 'warning'}
          />
        )}
      </div>

      <div className="mx-auto max-w-3xl px-4 py-6">
        <h1 className="text-xl font-bold text-slate-900">{patientName}</h1>
        <p className="text-sm text-slate-500">Visit</p>

        {loading ? (
          <p className="mt-4 text-sm text-slate-400"><Loading /></p>
        ) : accessError ? (
          <p className="mt-4 rounded-xl bg-amber-50 p-3 text-sm text-amber-800">
            {accessError} Ask the clinic owner if you need access to this patient's clinical record.
          </p>
        ) : (
          <>
            {/* Timed automatically off the status change (Start consultation
                / Complete) - see schema.sql section 54. Only shown once a
                consultation has actually started. */}
            {visit?.consultation_started_at && (
              <Card className="mt-4 !bg-slate-50">
                <div className="flex items-center gap-2">
                  <Clock size={15} className="text-brand-600" />
                  <p className="text-sm font-semibold text-slate-900">Consultation timing</p>
                  {visit.needs_review && <StatusPill label="Needs review" tone="warning" />}
                </div>
                <div className="mt-2 grid grid-cols-2 gap-2 text-sm text-slate-600">
                  <p>
                    Started{' '}
                    {new Date(visit.consultation_started_at).toLocaleTimeString(undefined, {
                      hour: 'numeric',
                      minute: '2-digit',
                    })}
                  </p>
                  {visit.consultation_ended_at ? (
                    <p>
                      Ended{' '}
                      {new Date(visit.consultation_ended_at).toLocaleTimeString(undefined, {
                        hour: 'numeric',
                        minute: '2-digit',
                      })}
                    </p>
                  ) : (
                    <p className="text-slate-400">Still in progress</p>
                  )}
                  {visit.waiting_time_minutes != null && (
                    <p>Waited {visit.waiting_time_minutes} min after check-in</p>
                  )}
                  {visit.duration_minutes != null && (
                    <p className="font-bold text-slate-900">Duration: {visit.duration_minutes} min</p>
                  )}
                </div>
              </Card>
            )}

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
                  <label className="text-sm font-medium text-slate-700">Follow-up</label>
                  <select
                    value={followUpInterval}
                    onChange={(e) => setFollowUpInterval(e.target.value as FollowUpInterval)}
                    className="mt-1 w-full rounded-2xl border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-500"
                  >
                    {FOLLOW_UP_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  {visit?.follow_up_due_date && followUpInterval !== 'none' && (
                    <p className="mt-1 text-xs text-slate-400">
                      Due{' '}
                      {new Date(visit.follow_up_due_date + 'T00:00:00').toLocaleDateString(undefined, {
                        day: 'numeric',
                        month: 'short',
                      })}
                      . The patient will see a "Book follow-up" button on this visit once saved.
                    </p>
                  )}
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
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-semibold text-slate-900">E-prescription</p>
                {attachedRx && <RxLanguageToggle value={rxLanguage} onChange={setRxLanguage} />}
              </div>

              {attachedRx ? (
                <div className="mt-3">
                  <PrescriptionItems
                    items={attachedRx.items}
                    adviceEn={attachedRx.advice_en}
                    adviceHi={attachedRx.advice_hi}
                    language={rxLanguage}
                  />
                  <div className="mt-3 flex flex-wrap items-center gap-3">
                    <Button variant="secondary" onClick={() => setPrinting(true)}>
                      <Printer size={16} /> Print prescription
                    </Button>
                    <p className="text-xs text-slate-400">Signed and attached.</p>
                  </div>
                </div>
              ) : (
                <PrescriptionEditor signing={signingRx} error={rxError} onSign={signAndAttach} />
              )}
            </Card>

            {/* Reports & files: what the patient uploaded, plus anything the
                clinic adds here - which shows up in the patient's app. */}
            {patient && (
              <FileUpload
                appointmentId={appointmentId}
                memberId={patient.memberId}
                title="Reports & files"
                refreshKey={filesTick}
                onUploaded={(kind) => tellPatient('report_added', reportAddedMessage(FILE_KIND[kind], patient.date))}
              />
            )}
            {patient && (
              <p className="mt-1.5 text-xs text-slate-400">
                Reports the patient uploads appear here. Anything you add shows up in the patient's app, and they're
                notified.
              </p>
            )}

            {printing && attachedRx && (
              <PrescriptionSheet
                prescription={attachedRx}
                patientName={patientName}
                diagnosis={diagnosis.trim() || null}
                followUpDate={followUpInterval !== 'none' ? visit?.follow_up_due_date ?? null : null}
                onClose={() => setPrinting(false)}
              />
            )}

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
