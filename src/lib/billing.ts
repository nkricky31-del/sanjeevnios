import type { PaymentMethod } from './types';

// Flat platform convenience fee, online payments only - there's no gateway
// to charge a processing fee for on a cash-at-clinic booking. Must match the
// literal in create_payment_with_coupon() (migration_41_coupons_and_razorpay.sql) -
// that function is the one that actually charges anyone, this is only for
// the live preview shown before it runs.
export const PLATFORM_CONVENIENCE_FEE = 10;

export interface Bill {
  consultationFee: number;
  convenienceFee: number;
  grossAmount: number;
  discountAmount: number;
  netAmount: number;
}

// The bill shown on the booking screen. discountAmount comes from an applied
// coupon's reserve_coupon() response (0 when none is applied) - this never
// recomputes a coupon's own math, it only assembles the total around it.
export function computeBill(consultationFee: number, method: PaymentMethod, discountAmount = 0): Bill {
  const convenienceFee = method === 'online' ? PLATFORM_CONVENIENCE_FEE : 0;
  const grossAmount = consultationFee + convenienceFee;
  // Mirrors create_payment_with_coupon()'s own floor: never discount to zero.
  const netAmount = Math.max(grossAmount - discountAmount, 1);
  return { consultationFee, convenienceFee, grossAmount, discountAmount, netAmount };
}
