import type { SubscriptionTier } from './types';

export interface TierInfo {
  label: string;
  monthlyBookingLimit: number | null; // null = unlimited
  features: string[];
}

// Display-only copy. The actual enforcement (and the free-tier limit number)
// lives in the DB trigger enforce_clinic_booking_limit() in schema.sql -
// keep the 50 here in sync with the 50 there if it ever changes.
export const TIERS: Record<SubscriptionTier, TierInfo> = {
  free: { label: 'Free', monthlyBookingLimit: 50, features: ['50 bookings / month'] },
  pro: { label: 'Pro', monthlyBookingLimit: null, features: ['Unlimited bookings', 'Analytics'] },
  premium: {
    label: 'Premium',
    monthlyBookingLimit: null,
    features: ['Unlimited bookings', 'Analytics', 'AI reschedule', 'Priority support'],
  },
};

export const TIER_ORDER: SubscriptionTier[] = ['free', 'pro', 'premium'];

// Fraction of the tier's limit used, or null if the tier has no limit.
export function usageRatio(tier: SubscriptionTier, bookingsUsed: number): number | null {
  const limit = TIERS[tier].monthlyBookingLimit;
  if (limit == null) return null;
  return bookingsUsed / limit;
}

const NEAR_LIMIT_THRESHOLD = 0.8;

export type UsageStatus = 'ok' | 'near_limit' | 'over_limit';

export function usageStatus(tier: SubscriptionTier, bookingsUsed: number): UsageStatus {
  const ratio = usageRatio(tier, bookingsUsed);
  if (ratio == null) return 'ok';
  if (ratio >= 1) return 'over_limit';
  if (ratio >= NEAR_LIMIT_THRESHOLD) return 'near_limit';
  return 'ok';
}
