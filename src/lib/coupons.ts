import { supabase } from './supabaseClient';

export interface CouponResult {
  valid: boolean;
  // Machine-readable outcome (e.g. 'EXPIRED', 'PER_USER_LIMIT_REACHED') -
  // see validate_and_price() in migration_42_coupon_engine.sql for the full
  // list. Null when valid.
  reasonCode: string | null;
  reason: string | null;
  discountAmount: number;
  netAmount: number;
  // Set only when valid - the coupon_redemptions row id to pass through to
  // create_payment_with_coupon() at booking time, or to
  // release_coupon_redemption() if the booking is abandoned instead.
  redemptionId: string | null;
}

interface ValidateAndPriceRow {
  valid: boolean;
  reason_code: string | null;
  reason: string | null;
  discount_amount: number;
  net_amount: number;
  redemption_id: string | null;
}

// The Apply button - validates AND reserves in one atomic, row-locked
// server-side step (migration_42's validate_and_price()). There is no
// separate "just check it" call: per spec, applying a coupon IS reserving it.
export async function reserveCoupon(
  code: string,
  patientId: string,
  clinicId: string,
  grossAmount: number
): Promise<CouponResult> {
  const { data, error } = await supabase.rpc('validate_and_price', {
    p_code: code.trim(),
    p_patient_id: patientId,
    p_clinic_id: clinicId,
    p_gross_amount: grossAmount,
  });
  if (error) {
    return { valid: false, reasonCode: null, reason: error.message, discountAmount: 0, netAmount: grossAmount, redemptionId: null };
  }
  const row = ((data ?? []) as ValidateAndPriceRow[])[0];
  if (!row) {
    return { valid: false, reasonCode: null, reason: 'Could not validate this code.', discountAmount: 0, netAmount: grossAmount, redemptionId: null };
  }
  return {
    valid: row.valid,
    reasonCode: row.reason_code,
    reason: row.reason,
    discountAmount: row.discount_amount ?? 0,
    netAmount: row.net_amount ?? grossAmount,
    redemptionId: row.redemption_id,
  };
}

// Frees a reservation back up - the "Remove" button, and BookingForm's own
// cleanup when a reserved coupon never made it into a real booking (slot
// filled, payment step failed, Razorpay checkout dismissed). Best-effort:
// an unlinked reservation also self-expires after 15 minutes on its own
// (see migration_41), so a failure here is never the last line of defense.
export async function releaseCouponReservation(redemptionId: string): Promise<void> {
  await supabase.rpc('release_coupon_redemption', { p_redemption_id: redemptionId });
}

export interface CreatePaymentResult {
  paymentId: string;
  grossAmount: number;
  discountAmount: number;
  netAmount: number;
}

// Replaces the old plain `insert into payments` - this is where the charge
// actually gets computed, server-side, from the doctor's real fee (see
// create_payment_with_coupon() in migration_41/42).
export async function createPaymentWithCoupon(
  appointmentId: string,
  method: 'online' | 'cod',
  redemptionId: string | null
): Promise<CreatePaymentResult | { error: string }> {
  const { data, error } = await supabase.rpc('create_payment_with_coupon', {
    p_appointment_id: appointmentId,
    p_method: method,
    p_redemption_id: redemptionId,
  });
  if (error) return { error: error.message };
  const row = ((data ?? []) as {
    payment_id: string;
    gross_amount: number;
    discount_amount: number;
    net_amount: number;
  }[])[0];
  if (!row) return { error: 'Could not record payment for this booking.' };
  return {
    paymentId: row.payment_id,
    grossAmount: row.gross_amount,
    discountAmount: row.discount_amount,
    netAmount: row.net_amount,
  };
}
