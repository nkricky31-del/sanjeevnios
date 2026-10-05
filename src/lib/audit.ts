import { supabase } from './supabaseClient';

// Records an admin decision (who did what, when) and notifies the affected
// clinic owner - used by the verification console (approve/reject a clinic
// or doctor) and the subscriptions console (tier changes, activate/deactivate).
//
// Migration 70 closed direct writes to audit_log: the row is written by the
// admin-only admin_record_decision() RPC, which stamps the actor and time on
// the server. actorId is kept so existing call sites don't change; it is
// ignored - the server uses the signed-in admin.
export async function recordAdminDecision(
  _actorId: string,
  action: string,
  targetId: string,
  notifyUserId: string,
  message: string
): Promise<void> {
  await supabase.rpc('admin_record_decision', { p_action: action, p_target: targetId });
  await supabase.from('notifications').insert({ user_id: notifyUserId, type: action, message });
}

// Reports an OTP outcome to the audit trail. Sends ONLY the event, the
// outcome and the last four digits of the phone - never the code. Best-effort:
// a logging failure must never get in the way of signing in.
export function logAuthEvent(
  event: 'otp.requested' | 'otp.verify',
  outcome: 'sent' | 'success' | 'failure',
  phone: string
): void {
  const last4 = phone.replace(/\D/g, '').slice(-4);
  void supabase
    .rpc('log_auth_event', { p_event: event, p_outcome: outcome, p_phone_last4: last4 })
    .then(() => undefined, () => undefined);
}
