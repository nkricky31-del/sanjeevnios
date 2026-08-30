import { useState } from 'react';

import { cancelAndRescheduleFullDay, type FullDayCancelResult } from '../lib/queue';

interface Props {
  doctorId: string;
  date: string;
  onDone: () => void;
  onClose: () => void;
}

export default function FullDayCancelForm({ doctorId, date, onDone, onClose }: Props) {
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<FullDayCancelResult | null>(null);

  const submit = async () => {
    setError(null);
    const trimmedReason = reason.trim();
    if (!trimmedReason) {
      setError('Enter a reason - patients will see this (e.g. "Doctor unavailable today").');
      return;
    }
    setSaving(true);
    const outcome = await cancelAndRescheduleFullDay(doctorId, date, trimmedReason);
    setSaving(false);
    setResult(outcome);
    onDone();
  };

  if (result) {
    return (
      <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
        {result.rescheduledCount === 0 ? (
          <p className="font-semibold">Nothing to cancel - no pending or accepted bookings on {date}.</p>
        ) : (
          <p className="font-semibold">
            Rescheduled {result.rescheduledCount} appointment{result.rescheduledCount === 1 ? '' : 's'} to the next
            day this doctor is available, and notified every patient.
          </p>
        )}
        {result.unplacedCount > 0 && (
          <p className="mt-1 text-red-700">
            {result.unplacedCount} couldn't be placed automatically (no open slots found in the next month) -
            please contact them directly.
          </p>
        )}
        <button onClick={onClose} className="mt-2 text-sm font-medium text-amber-700 underline">
          Close
        </button>
      </div>
    );
  }

  return (
    <div className="mt-3 space-y-2 rounded-xl border border-red-200 bg-red-50 p-4">
      <p className="text-sm font-semibold text-red-900">Cancel all bookings for {date}?</p>
      <p className="text-sm text-red-800">
        Every pending and accepted appointment for this doctor on this date will be moved to the next day the
        doctor is available, in token order, and every affected patient will be notified. Appointments already
        in progress or done today are left alone.
      </p>
      <label className="text-sm font-medium text-red-900">Reason (shown to patients)</label>
      <textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder='e.g. "Doctor unavailable today"'
        rows={2}
        className="w-full rounded-lg border border-red-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-red-400"
      />
      {error && <p className="text-sm text-red-700">{error}</p>}
      <div className="flex gap-2">
        <button
          onClick={submit}
          disabled={saving}
          className="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
        >
          {saving ? 'Cancelling & rescheduling...' : 'Confirm cancel & reschedule day'}
        </button>
        <button onClick={onClose} className="px-3 py-1.5 text-sm text-slate-500">
          Back
        </button>
      </div>
    </div>
  );
}
