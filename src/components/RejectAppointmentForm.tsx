import { useState } from 'react';

import { findNextBestSlot } from '../lib/queue';
import { supabase } from '../lib/supabaseClient';
import { formatTimeLabel } from '../lib/time';

interface Props {
  appointmentId: string;
  doctorId: string;
  date: string;
  patientAccountId: string;
  onRejected: () => void;
  onCancel: () => void;
}

export default function RejectAppointmentForm({
  appointmentId,
  doctorId,
  date,
  patientAccountId,
  onRejected,
  onCancel,
}: Props) {
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    const trimmedReason = reason.trim();
    if (!trimmedReason) {
      setError('Enter a reason - the patient will see this.');
      return;
    }

    setSaving(true);

    const { error: updateError } = await supabase
      .from('appointments')
      .update({ status: 'rejected', reject_reason: trimmedReason })
      .eq('id', appointmentId);
    if (updateError) {
      setSaving(false);
      setError(updateError.message);
      return;
    }

    // Runs AFTER the reject above, so get_taken_slots no longer counts this
    // booking's own slot as taken.
    const suggestion = await findNextBestSlot(doctorId, date);
    const message = suggestion
      ? `Your appointment on ${date} couldn't be confirmed: "${trimmedReason}". Next available slot with this doctor: ${suggestion.date} at ${formatTimeLabel(suggestion.slotTime)}.`
      : `Your appointment on ${date} couldn't be confirmed: "${trimmedReason}". No open slots with this doctor in the next week - please search for another doctor or check back later.`;

    await supabase.from('notifications').insert({
      user_id: patientAccountId,
      appointment_id: appointmentId,
      type: 'appointment_rejected',
      message,
    });

    setSaving(false);
    onRejected();
  };

  return (
    <div className="mt-2 space-y-2 rounded-lg bg-red-50 p-3">
      <label className="text-sm font-medium text-red-900">Reason for rejecting (shown to the patient)</label>
      <textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder='e.g. "Doctor only available 2 hours today"'
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
          {saving ? 'Rejecting...' : 'Confirm reject & notify patient'}
        </button>
        <button onClick={onCancel} className="px-3 py-1.5 text-sm text-slate-500">
          Cancel
        </button>
      </div>
    </div>
  );
}
