import { useEffect, useState } from 'react';

import { useAuth } from './AuthContext';
import { getClientIp } from './consent';
import { PATIENT_DECLARATION_VERSION } from './platformDisclaimer';
import { supabase } from './supabaseClient';

export type DeclarationStatus = 'loading' | 'needed' | 'accepted';

// Shared by PatientDeclarationGate.tsx (full-screen, at app entry) and
// BookingForm.tsx (inline, on the booking-confirmation screen) - both need
// the same "has this patient accepted the CURRENT version" check and the
// same accept-and-record action, just rendered differently.
export function usePatientDeclarationStatus() {
  const { session } = useAuth();
  const [status, setStatus] = useState<DeclarationStatus>('loading');

  const check = async () => {
    if (!session) return;
    setStatus('loading');
    const { data } = await supabase
      .from('patient_declarations')
      .select('declaration_version')
      .eq('patient_id', session.user.id)
      .order('accepted_at', { ascending: false })
      .limit(1);
    const latest = (data ?? [])[0] as { declaration_version: string } | undefined;
    setStatus(latest?.declaration_version === PATIENT_DECLARATION_VERSION ? 'accepted' : 'needed');
  };

  useEffect(() => {
    check();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user.id]);

  // Returns an error message on failure, or null on success.
  const accept = async (): Promise<string | null> => {
    if (!session) return 'Not signed in.';
    const ip = await getClientIp();
    const { error } = await supabase.from('patient_declarations').insert({
      patient_id: session.user.id,
      declaration_version: PATIENT_DECLARATION_VERSION,
      ip,
    });
    if (error) return error.message;
    setStatus('accepted');
    return null;
  };

  return { status, accept };
}
