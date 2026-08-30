import { supabase } from './supabaseClient';

// Records an admin decision (who did what, when) and notifies the affected
// clinic owner - used by the verification console (approve/reject a clinic
// or doctor) and the subscriptions console (tier changes, activate/deactivate).
export async function recordAdminDecision(
  actorId: string,
  action: string,
  targetId: string,
  notifyUserId: string,
  message: string
): Promise<void> {
  await supabase.from('audit_log').insert({ actor: actorId, action, target: targetId });
  await supabase.from('notifications').insert({ user_id: notifyUserId, type: action, message });
}
