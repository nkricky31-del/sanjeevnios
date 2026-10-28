import { useState } from 'react';

import { appointmentCancelledByClinicMessage, notifyPatient } from '../lib/notify';
import { findNextBestSlot } from '../lib/queue';
import { supabase } from '../lib/supabaseClient';
import type { AppointmentPaymentStatus } from '../lib/types';

interface Props {
  appointmentId: string;
  doctorId: string;
  date: string;
  patientName: string;
  patientAccountId: string | null;
  paymentStatus: AppointmentPaymentStatus;
  onCancelled: () => void;
  onClose: () => void;
}

// The clinic cancelling ONE confirmed booking (doctor unavailable, emergency).
// Bookings are confirmed the moment they're made (migration 85), so this is
// the clinic's only per-booking "no" - a reason is required and the patient
// is told, with the next open slot. handle_appointment_status_change()
// refunds an online payment as part of the same update.
export default function CancelBookingForm({
  appointmentId,
  doctorId,
  date,
  patientName,
  patientAccountId,
  paymentStatus,
  onCancelled,
  onClose,
}: Props) {
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    const trimmed = reason.trim();
    if (!trimmed) {
      setError('Add a reason - the patient will see it.');
      return;
    }
    setSaving(true);
    const { data: updated, error: updateError } = await supabase
      .from('appointments')
      .update({ status: 'cancelled', reject_reason: trimmed })
      .eq('id', appointmentId)
      .eq('status', 'accepted')
      .select('id')
      .maybeSingle();
    if (updateError) {
      setSaving(false);
      setError(updateError.message);
      return;
    }
    if (!updated) {
      setSaving(false);
      setError('This booking has already changed (checked in or cancelled) - refreshing.');
      onCancelled();
      return;
    }

    if (patientAccountId) {
      const suggestion = await findNextBestSlot(doctorId, date);
      await notifyPatient({
        userId: patientAccountId,
        appointmentId,
        type: 'appointment_cancelled_by_clinic',
        message: appointmentCancelledByClinicMessage(trimmed, paymentStatus === 'paid_online', suggestion),
      });
    }
    setSaving(false);
    onCancelled();
  };

  return (
    <div className="mt-3 space-y-2 rounded-xl border border-red-200 bg-red-50 p-3">
      <p className="text-sm font-semibold text-red-900">Cancel {patientName}'s booking?</p>
      <label htmlFor={`cancel-reason-${appointmentId}`} className="block text-xs font-medium text-red-900">
        Reason (shown to the patient)
      </label>
      <textarea
        id={`cancel-reason-${appointmentId}`}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder='e.g. "Doctor called away for an emergency"'
        rows={2}
        className="w-full rounded-lg border border-red-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-red-400"
      />
      {error && <p className="text-sm text-red-700">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={saving}
          className="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
        >
          {saving ? 'Cancelling...' : 'Cancel booking & notify patient'}
        </button>
        <button type="button" onClick={onClose} className="px-3 py-1.5 text-sm text-slate-500">
          Keep booking
        </button>
      </div>
    </div>
  );
}
