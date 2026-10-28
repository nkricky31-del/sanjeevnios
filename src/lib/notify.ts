import { supabase } from './supabaseClient';
import { formatTimeLabel, reportingTimeFor } from './time';
import type { AppointmentPaymentStatus, NotificationChannel } from './types';

// How close to the reporting time (not the slot time) the one-shot "please
// head over" nudge fires - see BookingStatus.tsx's reminder effect and
// migration_40_reporting_time.sql's dedup widening.
export const REPORTING_REMINDER_LEAD_MINUTES = 60;

interface NotifyArgs {
  userId: string;
  appointmentId: string;
  type: string;
  message: string;
}

// Writes one notifications row for the given channel via the
// log_notification() RPC (migration 39) instead of a plain insert. For the
// three one-shot lifecycle events this is about (booking_received,
// appointment_confirmed, appointment_rejected) that function upserts against
// a partial unique index on (appointment_id, type, channel) and reports back
// whether a row was actually inserted. That round trip through the database
// is the only reliable way to detect "already sent" from here: a clinic
// sending on a patient's behalf can never SELECT that patient's own
// notifications row back afterwards to check for itself (notifications_select
// only ever lets you read your own rows), so a client-side "insert, then
// re-select" dedup check would silently look like a duplicate every single
// time a clinic sent one.
async function logChannel(args: NotifyArgs, channel: NotificationChannel): Promise<boolean> {
  const { data, error } = await supabase.rpc('log_notification', {
    p_user_id: args.userId,
    p_appointment_id: args.appointmentId,
    p_type: args.type,
    p_channel: channel,
    p_message: args.message,
  });
  if (error) throw error;
  return !!data;
}

// Sends the in-app notice, then a best-effort WhatsApp/SMS if a gateway is
// configured server-side (see supabase/functions/send-patient-message - it
// reports { sent: false } on its own when nothing is configured, and this
// never calls it again once it has). Never throws: a notification is a side
// effect of booking/accepting/rejecting an appointment, not something that
// should ever roll back or block that action, so every failure here is
// swallowed rather than surfaced to the caller.
export async function notifyPatient(args: NotifyArgs): Promise<void> {
  try {
    const sentInApp = await logChannel(args, 'in_app');
    if (!sentInApp) return; // already notified for this appointment + type

    const { data } = await supabase.functions.invoke('send-patient-message', {
      body: { userId: args.userId, appointmentId: args.appointmentId, message: args.message },
    });
    const result = data as { sent?: boolean; channel?: NotificationChannel } | null;
    if (result?.sent && result.channel) {
      await logChannel(args, result.channel);
    }
  } catch (err) {
    console.error('notifyPatient failed', err);
  }
}

// ----------------------------------------------------------------------------
// Message templates for the two-step confirmation flow. Worded to match the
// vocabulary already shown elsewhere in the app - "On hold" / "Paid" / "Due
// at clinic" (Payments.tsx's STATUS_LABEL) and the reject flow's existing
// "next best slot" suggestion (lib/queue.ts's findNextBestSlot).
// ----------------------------------------------------------------------------

// How this clinic checks patients in - decides the one line of instructions
// in the confirmation (migration 84/85 clinic settings).
export type CheckInHow = 'clinic_qr' | 'patient_qr' | 'desk';

export function checkInHowFor(clinic: { selfCheckinEnabled: boolean; patientQrEnabled: boolean }): CheckInHow {
  if (clinic.selfCheckinEnabled) return 'clinic_qr';
  if (clinic.patientQrEnabled) return 'patient_qr';
  return 'desk';
}

const CHECK_IN_LINE: Record<CheckInHow, string> = {
  clinic_qr: "When you arrive, open this booking and scan the clinic's QR at reception to check in.",
  patient_qr: 'Show the QR on your booking at the desk to check in.',
  desk: 'Give your name or booking ref at the desk to check in.',
};

// The confirmation, sent the moment a booking is made - bookings no longer
// wait for the clinic to accept them (migration 85). For an online payment
// it's sent once the payment has gone through. reportBeforeMinutes is the
// clinic's own setting (section 40), clamped inside reportingTimeFor so the
// quoted time can never fall outside the check-in window.
export function appointmentConfirmedMessage(
  slotTime: string,
  bookingRef: string,
  paymentStatus: AppointmentPaymentStatus,
  reportBeforeMinutes: number,
  checkInHow: CheckInHow = 'desk',
  details?: { doctorName?: string; date?: string; amountDue?: number }
): string {
  const reportBy = formatTimeLabel(reportingTimeFor(slotTime, reportBeforeMinutes));
  const paymentNote =
    paymentStatus === 'free_followup'
      ? "This is a free follow-up visit, so there's nothing to pay."
      : paymentStatus === 'paid_online' || paymentStatus === 'paid_at_clinic'
        ? "You've already paid, so there's nothing to pay at the desk."
        : details?.amountDue != null
          ? `Please pay ₹${details.amountDue} at the clinic.`
          : 'Payment is due at the desk when you arrive.';
  const who = details?.doctorName ? ` with ${details.doctorName}` : '';
  const when = details?.date ? ` on ${details.date}` : '';
  return `Confirmed! Your appointment${who}${when} at ${formatTimeLabel(slotTime)} is booked. Please reach the clinic by ${reportBy} (your reporting time). ${CHECK_IN_LINE[checkInHow]} Booking ref ${bookingRef}. ${paymentNote}`;
}

// The single "reporting time is approaching" nudge (see BookingStatus.tsx) -
// reportingTime here is already the clamped value from get_checkin_options(),
// not recomputed.
export function reportingTimeReminderMessage(reportingTime: string, slotTime: string): string {
  return `Reminder: please aim to reach the clinic by ${formatTimeLabel(reportingTime)} (your reporting time) for your ${formatTimeLabel(
    slotTime
  )} slot.`;
}

// Sent when the clinic cancels a confirmed booking (doctor unavailable, etc.).
export function appointmentCancelledByClinicMessage(
  reason: string,
  refunded: boolean,
  suggestion: { date: string; slotTime: string } | null
): string {
  const refundLine = refunded ? 'Your payment is refunded.' : 'Nothing was collected.';
  const nextLine = suggestion
    ? `The next open slot with this doctor is ${suggestion.date} at ${formatTimeLabel(suggestion.slotTime)}.`
    : 'Please book another slot or doctor when convenient.';
  return `Sorry, the clinic had to cancel your appointment (${reason}). ${refundLine} ${nextLine}`;
}

// Sent only when the clinic taps Reject (bookings from before instant
// confirmation, migration 85). `refunded` should reflect whether
// there was actually money on hold to give back (an online booking) - a COD
// booking never had anything collected, so it gets the "no payment was
// collected" line instead of a refund claim that isn't true.
export function appointmentRejectedMessage(
  reason: string,
  refunded: boolean,
  suggestion: { date: string; slotTime: string } | null
): string {
  const refundLine = refunded ? 'Your payment is refunded.' : 'No payment was collected.';
  const nextLine = suggestion
    ? `Here's the next best slot: ${suggestion.date} at ${formatTimeLabel(suggestion.slotTime)}.`
    : "No open slots with this doctor in the next week - please search for another doctor or check back later.";
  return `Sorry, the clinic couldn't confirm this slot (${reason}). ${refundLine} ${nextLine}`;
}
