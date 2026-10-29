import { forgetThisPhone } from './push';
import { supabase } from './supabaseClient';

/** Every Sign out button: this phone stops getting the account's alerts
    (lib/push.ts), then the account signs out. The sign-out after a long idle
    spell (idleTimeout.ts) doesn't come here on purpose: a patient waiting in
    the queue must still get "It's your turn". */
export async function signOut(): Promise<void> {
  await forgetThisPhone();
  await supabase.auth.signOut();
}
