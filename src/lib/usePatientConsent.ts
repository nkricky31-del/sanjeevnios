import { useEffect, useState } from 'react';

import { useAuth } from './AuthContext';
import { getClientIp } from './consent';
import { DPDP_CONSENT_VERSION } from './dpdpConsent';
import { PATIENT_DECLARATION_VERSION } from './platformDisclaimer';
import { supabase } from './supabaseClient';

export type ConsentStatus = 'loading' | 'needed' | 'accepted';

// Shared by PatientDeclarationGate.tsx (full-screen, at app entry) and
// BookingForm.tsx (inline, on the booking-confirmation screen) - both need
// the same "has this patient accepted the CURRENT version of consent_type X"
// check and the same accept-and-record action, just rendered differently.
// One generic hook, parameterized by consent_type/version, backs both the
// platform declaration and the DPDP data consent below - they're tracked as
// entirely independent rows (see schema.sql section 22), so accepting one
// never counts as accepting the other.
export function usePatientConsentStatus(consentType: string, version: string) {
  const { session } = useAuth();
  const [status, setStatus] = useState<ConsentStatus>('loading');

  const check = async () => {
    if (!session) return;
    setStatus('loading');
    const { data } = await supabase
      .from('patient_declarations')
      .select('declaration_version')
      .eq('patient_id', session.user.id)
      .eq('consent_type', consentType)
      .order('accepted_at', { ascending: false })
      .limit(1);
    const latest = (data ?? [])[0] as { declaration_version: string } | undefined;
    setStatus(latest?.declaration_version === version ? 'accepted' : 'needed');
  };

  useEffect(() => {
    check();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user.id, consentType, version]);

  // Returns an error message on failure, or null on success.
  const accept = async (): Promise<string | null> => {
    if (!session) return 'Not signed in.';
    const ip = await getClientIp();
    const { error } = await supabase.from('patient_declarations').insert({
      patient_id: session.user.id,
      declaration_version: version,
      consent_type: consentType,
      ip,
    });
    if (error) return error.message;
    setStatus('accepted');
    return null;
  };

  return { status, accept };
}

export function usePatientDeclarationStatus() {
  return usePatientConsentStatus('platform_disclaimer', PATIENT_DECLARATION_VERSION);
}

export function useDpdpConsentStatus() {
  return usePatientConsentStatus('dpdp_data_consent', DPDP_CONSENT_VERSION);
}
