import { describeFunctionError } from './razorpay';
import { supabase } from './supabaseClient';

// Deleting an account (migration 91). Patients delete their own (the
// delete-account edge function); clinic owners, clinic staff numbers and
// SanjeevniOS staff send a request that an admin handles.

export interface DeletionStatus {
  /** 'self': can delete now. 'request': must ask (clinic / staff accounts). */
  mode: 'self' | 'request';
  /** Appointments still to come - they must be cancelled first. */
  upcoming: number;
  pending_request: { id: string; created_at: string } | null;
}

export async function getDeletionStatus(): Promise<DeletionStatus> {
  const { data, error } = await supabase.rpc('account_deletion_status');
  if (error || !data) throw new Error(error?.message ?? 'Could not load your account.');
  return data as DeletionStatus;
}

/** Deletes the signed-in patient's account. On success the login no longer
    exists; the caller signs out locally (see signOutDeleted). */
export async function deleteMyAccount(): Promise<{ ok: true } | { error: string }> {
  const { data, error } = await supabase.functions.invoke('delete-account', { body: { confirm: 'DELETE' } });
  if (error) return { error: await describeFunctionError(error) };
  if (!data?.deleted) return { error: 'Your account could not be deleted. Please try again.' };
  return { ok: true };
}

/** After a deletion: forget the session on this device only (the server side
    is already gone). */
export function signOutDeleted(): Promise<unknown> {
  return supabase.auth.signOut({ scope: 'local' });
}

export async function requestAccountClosure(reason: string): Promise<{ ok: true } | { error: string }> {
  const { error } = await supabase.rpc('request_account_deletion', { p_reason: reason.trim() || null });
  return error ? { error: error.message } : { ok: true };
}

export async function withdrawAccountClosure(): Promise<{ ok: true } | { error: string }> {
  const { error } = await supabase.rpc('withdraw_account_deletion_request');
  return error ? { error: error.message } : { ok: true };
}
