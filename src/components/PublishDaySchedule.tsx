import { ArrowDown, ArrowUp, Coffee, RefreshCw, Send, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { issueBookingQr } from '../lib/checkIn';
import { addDaysISO, todayISO } from '../lib/date';
import {
  addScheduleBreak,
  clearReorder,
  moveInDaySchedule,
  previewDaySchedule,
  publishDaySchedule,
  removeScheduleBreak,
  type PublishedRow,
} from '../lib/schedule';
import { supabase } from '../lib/supabaseClient';
import { formatTimeLabel } from '../lib/time';
import type { Clinic, DayScheduleRow, ScheduleBreak } from '../lib/types';
import Button from './ui/Button';
import Card from './ui/Card';
import QrCode from './ui/QrCode';
import SectionTitle from './ui/SectionTitle';

interface Props {
  clinic: Clinic;
  onClinicSaved: (patch: Partial<Clinic>) => void;
}

// Statuses a booked patient can be in the night before / morning of - never
// anything past "arrived", since publishing runs on the plan, not the day
// actually happening.
const STATUS_LABEL: Record<string, string> = {
  booked: 'Pending approval',
  accepted: 'Confirmed',
  checked_in: 'Already checked in',
  called: 'Already checked in',
  in_consultation: 'Already checked in',
};

// The night-before batch: preview the running order for one day, let the
// clinic reorder people or block out breaks, then publish in one action.
// Publishing only ever assigns a sequence number, an estimated time, and a
// notification - see publish_day_schedule() in schema.sql section 34. It
// never sets checked_in_at or token_number, so nothing here can ever make a
// patient "present" - that still only happens at actual check-in (the
// Today tab).
export default function PublishDaySchedule({ clinic, onClinicSaved }: Props) {
  const [date, setDate] = useState(() => addDaysISO(todayISO(), 1));
  const [rows, setRows] = useState<DayScheduleRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [breaks, setBreaks] = useState<ScheduleBreak[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const [startTime, setStartTime] = useState(clinic.publish_start_time?.slice(0, 5) ?? '09:00');
  const [avgMinutes, setAvgMinutes] = useState(String(clinic.avg_minutes_per_patient ?? 10));
  const [savingSettings, setSavingSettings] = useState(false);

  const [breakBeforeSeq, setBreakBeforeSeq] = useState('');
  const [breakMinutes, setBreakMinutes] = useState('30');
  const [breakLabel, setBreakLabel] = useState('Lunch break');

  const [publishing, setPublishing] = useState(false);
  const [published, setPublished] = useState<PublishedRow[] | null>(null);
  const [qrFor, setQrFor] = useState<string | null>(null);
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [qrError, setQrError] = useState<string | null>(null);

  const loadPreview = useCallback(async () => {
    setLoading(true);
    const previewRows = await previewDaySchedule(clinic.id, date);
    setRows(previewRows);
    setLoading(false);
  }, [clinic.id, date]);

  const loadBreaks = useCallback(async () => {
    const { data } = await supabase
      .from('clinic_schedule_breaks')
      .select('*')
      .eq('clinic_id', clinic.id)
      .eq('date', date)
      .order('before_seq', { ascending: true });
    setBreaks((data ?? []) as ScheduleBreak[]);
  }, [clinic.id, date]);

  useEffect(() => {
    setPublished(null);
    setQrFor(null);
    loadPreview();
    loadBreaks();
  }, [loadPreview, loadBreaks]);

  const saveSettings = async () => {
    setError(null);
    setNote(null);
    const minutesNum = Number(avgMinutes);
    if (!Number.isInteger(minutesNum) || minutesNum < 1) {
      setError('Average minutes per patient must be a whole number of at least 1.');
      return;
    }
    setSavingSettings(true);
    const patch = { publish_start_time: `${startTime}:00`, avg_minutes_per_patient: minutesNum };
    const { error: saveError } = await supabase.from('clinics').update(patch).eq('id', clinic.id);
    setSavingSettings(false);
    if (saveError) {
      setError(saveError.message);
      return;
    }
    onClinicSaved(patch);
    setNote('Saved.');
    loadPreview();
  };

  // See lib/schedule.ts: the target rank is half a step beyond whichever
  // neighbour this row is stepping past, computed off that neighbour's
  // freshly-loaded `seq` - never off a stale override - so this stays exact
  // no matter how many times a row gets moved.
  const move = async (row: DayScheduleRow, direction: 'up' | 'down') => {
    const idx = rows.findIndex((r) => r.appointment_id === row.appointment_id);
    const neighbor = direction === 'up' ? rows[idx - 1] : rows[idx + 1];
    if (!neighbor) return;
    const result = await moveInDaySchedule(row.appointment_id, neighbor.seq, direction);
    if (result.error) {
      setError(result.error);
      return;
    }
    loadPreview();
  };

  const resetOrder = async (row: DayScheduleRow) => {
    await clearReorder(row.appointment_id);
    loadPreview();
  };

  const addBreak = async () => {
    setError(null);
    const beforeSeqNum = Number(breakBeforeSeq);
    const minutesNum = Number(breakMinutes);
    if (!Number.isInteger(beforeSeqNum) || beforeSeqNum < 1) {
      setError('Enter the position (1, 2, 3...) the break sits in front of.');
      return;
    }
    if (!Number.isInteger(minutesNum) || minutesNum < 1) {
      setError('Break length must be at least 1 minute.');
      return;
    }
    const result = await addScheduleBreak(clinic.id, date, beforeSeqNum, minutesNum, breakLabel);
    if (result.error) {
      setError(result.error);
      return;
    }
    setBreakBeforeSeq('');
    loadBreaks();
    loadPreview();
  };

  const deleteBreak = async (id: string) => {
    await removeScheduleBreak(id);
    loadBreaks();
    loadPreview();
  };

  const publish = async () => {
    setError(null);
    setNote(null);
    setPublishing(true);
    const result = await publishDaySchedule(clinic.id, date);
    setPublishing(false);
    if ('error' in result) {
      setError(result.error);
      return;
    }
    setPublished(result.rows);
    loadPreview();
  };

  // The QR itself isn't minted at publish time - it's the same signed,
  // short-lived code issue_booking_qr() has always produced (section 28),
  // re-minted here on demand exactly like BookingPass.tsx does when the
  // patient opens their own screen. Publishing's job is the number and the
  // time; this button is just a convenient way to show the same code the
  // patient will see, e.g. to print a slip.
  const showQr = async (appointmentId: string) => {
    setQrFor((prev) => (prev === appointmentId ? null : appointmentId));
    if (qrFor === appointmentId) return;
    setQrCode(null);
    setQrError(null);
    const result = await issueBookingQr(appointmentId);
    if ('error' in result) {
      setQrError(result.error);
      return;
    }
    setQrCode(result.code);
  };

  return (
    <div>
      <SectionTitle>Publish the day's schedule</SectionTitle>
      <p className="mt-0.5 text-xs text-slate-400">
        One action, the night before (or whenever you open): every booked patient gets a sequence number, an
        estimated time, and a notification. Nobody is marked present and no token is issued — that still only
        happens when a patient actually checks in, on the Today tab.
      </p>

      <Card className="mt-3">
        <label className="text-xs font-bold text-slate-700">Day to publish</label>
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="mt-1 w-full rounded-2xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-brand-500"
        />

        <div className="mt-4 grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-bold text-slate-700">Day starts at</label>
            <input
              type="time"
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
              className="mt-1 w-full rounded-2xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>
          <div>
            <label className="text-xs font-bold text-slate-700">Avg minutes / patient</label>
            <input
              type="number"
              min={1}
              value={avgMinutes}
              onChange={(e) => setAvgMinutes(e.target.value)}
              className="mt-1 w-full rounded-2xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>
        </div>
        <Button variant="secondary" onClick={saveSettings} disabled={savingSettings} className="mt-3">
          {savingSettings ? 'Saving...' : 'Save estimate settings'}
        </Button>
      </Card>

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
      {note && !error && <p className="mt-3 text-sm font-semibold text-emerald-600">{note}</p>}

      {/* Breaks */}
      <SectionTitle
        className="mt-6"
        actionLabel="Refresh"
        onAction={() => {
          loadBreaks();
          loadPreview();
        }}
      >
        Breaks
      </SectionTitle>
      <p className="mt-0.5 text-xs text-slate-400">
        Blocks a gap in front of a position in the final order — it holds there even if you reorder people around
        it.
      </p>
      <Card className="mt-2">
        <div className="grid grid-cols-[1fr_1fr_2fr] gap-2">
          <input
            type="number"
            min={1}
            placeholder="Before #"
            value={breakBeforeSeq}
            onChange={(e) => setBreakBeforeSeq(e.target.value)}
            className="rounded-xl border border-slate-200 px-2.5 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-500"
          />
          <input
            type="number"
            min={1}
            placeholder="Minutes"
            value={breakMinutes}
            onChange={(e) => setBreakMinutes(e.target.value)}
            className="rounded-xl border border-slate-200 px-2.5 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-500"
          />
          <input
            type="text"
            placeholder="Label (optional)"
            value={breakLabel}
            onChange={(e) => setBreakLabel(e.target.value)}
            className="rounded-xl border border-slate-200 px-2.5 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>
        <Button variant="secondary" onClick={addBreak} className="mt-2">
          <Coffee size={15} /> Add break
        </Button>

        {breaks.length > 0 && (
          <div className="mt-3 space-y-1.5">
            {breaks.map((b) => (
              <div
                key={b.id}
                className="flex items-center justify-between gap-2 rounded-xl bg-slate-50 px-3 py-2 text-xs"
              >
                <span className="font-semibold text-slate-700">
                  Before #{b.before_seq} · {b.minutes}m{b.label ? ` · ${b.label}` : ''}
                </span>
                <button onClick={() => deleteBreak(b.id)} className="text-slate-400 hover:text-red-600">
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Preview / published order */}
      <SectionTitle className="mt-6" actionLabel="Refresh" onAction={loadPreview}>
        {published ? 'Published order' : 'Preview'} ({(published ?? rows).length})
      </SectionTitle>
      <p className="mt-0.5 text-xs text-slate-400">
        {published
          ? 'Everyone below has been notified of their number and estimated time. Nobody is checked in.'
          : "This is what publishing will do — nothing is saved or sent until you press Publish."}
      </p>

      <div className="mt-2 space-y-2">
        {loading && <p className="text-sm text-slate-400">Loading...</p>}
        {!loading && rows.length === 0 && !published && (
          <p className="text-sm text-slate-400">No booked patients for this day yet.</p>
        )}

        {!published &&
          rows.map((r, idx) => (
            <Card key={r.appointment_id} className="!p-3">
              <div className="flex items-center gap-3">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-brand-50 text-base font-extrabold text-brand-700">
                  {r.seq}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-sm font-bold text-slate-900">{r.member_name}</p>
                    <span className="shrink-0 text-sm font-bold text-brand-600">
                      {formatTimeLabel(r.estimated_time)}
                    </span>
                  </div>
                  <p className="truncate text-xs text-slate-400">
                    {r.doctor_name} · slot {formatTimeLabel(r.slot_time)}
                    {STATUS_LABEL[r.status] ? ` · ${STATUS_LABEL[r.status]}` : ''}
                    {r.patient_type === 'walk_in' ? ' · walk-in' : ''}
                  </p>
                </div>
                <div className="flex shrink-0 flex-col gap-1">
                  <button
                    onClick={() => move(r, 'up')}
                    disabled={idx === 0}
                    className="rounded-lg border border-slate-200 p-1 text-slate-500 disabled:opacity-30"
                  >
                    <ArrowUp size={14} />
                  </button>
                  <button
                    onClick={() => move(r, 'down')}
                    disabled={idx === rows.length - 1}
                    className="rounded-lg border border-slate-200 p-1 text-slate-500 disabled:opacity-30"
                  >
                    <ArrowDown size={14} />
                  </button>
                </div>
              </div>
              {r.day_order_override != null && (
                <button onClick={() => resetOrder(r)} className="mt-1.5 text-[11px] font-semibold text-brand-600">
                  Reordered manually · reset to slot time
                </button>
              )}
            </Card>
          ))}

        {published &&
          published.map((r) => (
            <Card key={r.appointmentId} className="!p-3">
              <div className="flex items-center gap-3">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-emerald-50 text-base font-extrabold text-emerald-700">
                  {r.seq}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-sm font-bold text-slate-900">{r.memberName}</p>
                    <span className="shrink-0 text-sm font-bold text-brand-600">
                      {formatTimeLabel(r.estimatedTime)}
                    </span>
                  </div>
                  <p className="truncate text-xs text-slate-400">
                    {r.doctorName}
                    {r.encounterNo ? ` · ${r.encounterNo}` : ''}
                  </p>
                </div>
                <Button variant="outline" onClick={() => showQr(r.appointmentId)}>
                  QR
                </Button>
              </div>
              {qrFor === r.appointmentId && (
                <div className="mt-3 flex flex-col items-center border-t border-slate-100 pt-3">
                  {qrCode ? (
                    <QrCode value={qrCode} size={160} />
                  ) : (
                    <p className="text-xs text-slate-400">{qrError ?? 'Preparing code...'}</p>
                  )}
                  <p className="mt-2 text-center text-[11px] text-slate-400">
                    Signed and short-lived, same as the code on the patient's own pass screen — good for a few
                    minutes, not for printing ahead of the day.
                  </p>
                </div>
              )}
            </Card>
          ))}
      </div>

      {!published && rows.length > 0 && (
        <Button full onClick={publish} disabled={publishing} className="mt-4">
          <Send size={16} />{' '}
          {publishing ? 'Publishing...' : `Publish ${rows.length} patient${rows.length === 1 ? '' : 's'}`}
        </Button>
      )}

      {published && (
        <Button variant="secondary" full onClick={() => setPublished(null)} className="mt-4">
          <RefreshCw size={15} /> Back to preview
        </Button>
      )}
    </div>
  );
}
