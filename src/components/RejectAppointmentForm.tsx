import { useState } from 'react';

import { appointmentRejectedMessage, notifyPatient } from '../lib/notify';
import { findNextBestSlot } from '../lib/queue';
import { supabase } from '../lib/supabaseClient';
import type { AppointmentPaymentStatus } from '../lib/types';

interface Props {
  appointmentId: string;
  doctorId: string;
  date: string;
  patientAccountId: string;
  // Decides whether the rejection notice claims a refund - only an online
  // booking ever had money actually held. See notify.ts's
  // appointmentRejectedMessage.
  paymentStatus: AppointmentPaymentStatus;
  onRejected: () => void;
  onCancel: () => void;
}

export default function RejectAppointmentForm({
  appointmentId,
  doctorId,
  date,
  patientAccountId,
  paymentStatus,
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

    // The .eq('status', 'booked') guard makes this idempotent against a
    // double-tap, or a race with Accept on the same row: only the update
    // that actually lands gets a row back. handle_appointment_status_change()
    // (migration 39) auto-refunds a real held payment as part of this same
    // update - see this form's paymentStatus prop for what the notice below
    // should claim.
    const { data: updated, error: updateError } = await supabase
      .from('appointments')
      .update({ status: 'rejected', reject_reason: trimmedReason })
      .eq('id', appointmentId)
      .eq('status', 'booked')
      .select('id')
      .maybeSingle();
    if (updateError) {
      setSaving(false);
      setError(updateError.message);
      return;
    }
    if (!updated) {
      setSaving(false);
      setError('This booking was already responded to - refreshing.');
      onRejected();
      return;
    }

    // Runs AFTER the reject above, so get_taken_slots no longer counts this
    // booking's own slot as taken.
    const suggestion = await findNextBestSlot(doctorId, date);
    const refunded = paymentStatus === 'paid_online';

    await notifyPatient({
      userId: patientAccountId,
      appointmentId,
      type: 'appointment_rejected',
      message: appointmentRejectedMessage(trimmedReason, refunded, suggestion),
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
