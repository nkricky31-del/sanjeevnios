// Cloudflare Turnstile bot check - shared bits.
//
// The SITE key is public (it ships in the bundle, like the Supabase anon key);
// the SECRET key lives only in Supabase (Auth > Attack Protection for login /
// OTP, and the TURNSTILE_SECRET_KEY function secret for booking).
//
// With no site key configured (local dev, preview builds) the widget renders
// nothing and CAPTCHA_ENABLED is false, so nothing waits on a token. In
// production the key is set, so the checks are real.
import { supabase } from './supabaseClient';

export const TURNSTILE_SITE_KEY: string | undefined = import.meta.env.VITE_TURNSTILE_SITE_KEY;
export const CAPTCHA_ENABLED = Boolean(TURNSTILE_SITE_KEY);

// Booking bot check: trade a solved Turnstile token for a short-lived server-side
// "pass" (edge function verify-captcha -> migration 75's trigger).
export async function redeemBookingCaptcha(token: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data, error } = await supabase.functions.invoke('verify-captcha', { body: { token } });
  if (error || !data?.ok) {
    return { ok: false, error: data?.error ?? 'Bot check failed. Please try again.' };
  }
  return { ok: true };
}
