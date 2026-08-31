import { useEffect, useState } from 'react';

import { recordAdminDecision } from '../lib/audit';
import { useAuth } from '../lib/AuthContext';
import { docTypesFor } from '../lib/documentTypes';
import { openVerificationDoc } from '../lib/storage';
import { supabase } from '../lib/supabaseClient';
import type { Consent, DocumentRow, OwnerType } from '../lib/types';
import AdminRejectForm from './AdminRejectForm';
import ClinicLocationPreview from './ClinicLocationPreview';
import StatusPill from './ui/StatusPill';

interface ClinicLocation {
  lat: number | null;
  lng: number | null;
  formatted_address: string | null;
  name: string;
}

interface Props {
  ownerType: OwnerType;
  ownerId: string;
  notifyUserId: string;
  label: string;
  onChanged?: () => void;
}

const STATUS_TONE: Record<'pending' | 'verified' | 'rejected', 'live' | 'warning' | 'info'> = {
  pending: 'info',
  verified: 'live',
  rejected: 'warning',
};

export default function AdminDocumentReview({ ownerType, ownerId, notifyUserId, label, onChanged }: Props) {
  const { session } = useAuth();
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [consent, setConsent] = useState<Consent | null>(null);
  const [clinicLocation, setClinicLocation] = useState<ClinicLocation | null>(null);
  const [loading, setLoading] = useState(true);
  const [rejectOpenFor, setRejectOpenFor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    const { data } = await supabase
      .from('documents')
      .select('*')
      .eq('owner_type', ownerType)
      .eq('owner_id', ownerId)
      .order('created_at', { ascending: false });
    setDocuments((data ?? []) as DocumentRow[]);

    if (ownerType === 'doctor') {
      const { data: consentData } = await supabase
        .from('consents')
        .select('*')
        .eq('doctor_id', ownerId)
        .order('agreed_at', { ascending: false })
        .limit(1);
      setConsent((consentData ?? [])[0] ?? null);
    }

    if (ownerType === 'clinic') {
      const { data: clinicData } = await supabase
        .from('clinics')
        .select('lat, lng, formatted_address, name')
        .eq('id', ownerId)
        .single();
      setClinicLocation((clinicData as ClinicLocation | null) ?? null);
    }

    setLoading(false);
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownerType, ownerId]);

  const latestFor = (key: string) => documents.find((d) => d.doc_type === key);

  const verify = async (doc: DocumentRow, docLabel: string) => {
    setError(null);
    if (!session) return;
    const { error: updateError } = await supabase
      .from('documents')
      .update({ status: 'verified', reviewed_by: session.user.id, reviewed_at: new Date().toISOString() })
      .eq('id', doc.id);
    if (updateError) {
      setError(updateError.message);
      return;
    }
    await recordAdminDecision(session.user.id, 'verify_document', doc.id, notifyUserId, `${docLabel} has been verified.`);
    load();
    onChanged?.();
  };

  const reject = async (doc: DocumentRow, docLabel: string, reason: string) => {
    setError(null);
    if (!session) return;
    const { error: updateError } = await supabase
      .from('documents')
      .update({
        status: 'rejected',
        review_note: reason,
        reviewed_by: session.user.id,
        reviewed_at: new Date().toISOString(),
      })
      .eq('id', doc.id);
    if (updateError) {
      setError(updateError.message);
      return;
    }
    await recordAdminDecision(
      session.user.id,
      'reject_document',
      doc.id,
      notifyUserId,
      `${docLabel} was rejected: "${reason}"`
    );
    setRejectOpenFor(null);
    load();
    onChanged?.();
  };

  const view = async (path: string) => {
    const url = await openVerificationDoc(path);
    if (!url) setError('Could not open document.');
  };

  const configs = docTypesFor(ownerType);

  return (
    <div className="mt-3 rounded-2xl border border-slate-200 p-3">
      <p className="text-sm font-bold text-slate-900">{label}</p>
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
      {loading && <p className="mt-2 text-xs text-slate-400">Loading...</p>}

      {ownerType === 'doctor' && !loading && (
        <div className="mt-2 rounded-xl bg-slate-50 p-2.5">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-bold text-slate-800">Written consent</p>
            <StatusPill label={consent ? 'Signed' : 'Not signed'} tone={consent ? 'live' : 'neutral'} />
          </div>
          {consent && (
            <>
              <p className="mt-1 text-xs text-slate-500">
                {consent.signature_name} · v{consent.agreement_version} · {new Date(consent.agreed_at).toLocaleString()}
                {consent.ip && ` · IP ${consent.ip}`}
              </p>
              {consent.file_url && (
                <button onClick={() => view(consent.file_url!)} className="mt-1 text-xs font-semibold text-brand-600">
                  View signed copy
                </button>
              )}
            </>
          )}
        </div>
      )}

      <div className="mt-2 space-y-2">
        {configs.map((config) => {
          const doc = latestFor(config.key);
          return (
            <div key={config.key} className="rounded-xl bg-slate-50 p-2.5">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-bold text-slate-800">
                  {config.label}
                  {config.requiredForVerification && <span className="text-coral-500"> *</span>}
                </p>
                <StatusPill
                  label={!doc ? 'Not uploaded' : doc.not_applicable ? `N/A · ${doc.status}` : doc.status}
                  tone={!doc ? 'neutral' : STATUS_TONE[doc.status]}
                />
              </div>
              {config.key === 'map_location' && clinicLocation && (
                <ClinicLocationPreview
                  lat={clinicLocation.lat}
                  lng={clinicLocation.lng}
                  formattedAddress={clinicLocation.formatted_address}
                  clinicName={clinicLocation.name}
                />
              )}
              {doc?.number && <p className="mt-1 text-xs text-slate-500">Number: {doc.number}</p>}
              {doc?.not_applicable && doc.not_applicable_note && (
                <p className="mt-1 text-xs text-slate-500">Note: {doc.not_applicable_note}</p>
              )}
              {doc?.status === 'rejected' && doc.review_note && (
                <p className="mt-1 text-xs font-medium text-red-600">Reason: {doc.review_note}</p>
              )}
              {doc?.storage_path && (
                <button onClick={() => view(doc.storage_path!)} className="mt-1 text-xs font-semibold text-brand-600">
                  View file
                </button>
              )}
              {doc && doc.status === 'pending' && (
                <div className="mt-1.5 flex gap-2">
                  <button
                    onClick={() => verify(doc, config.label)}
                    className="rounded-lg bg-emerald-600 px-2.5 py-1 text-xs font-bold text-white"
                  >
                    Verify
                  </button>
                  <button
                    onClick={() => setRejectOpenFor((prev) => (prev === doc.id ? null : doc.id))}
                    className="rounded-lg bg-red-50 px-2.5 py-1 text-xs font-bold text-red-600"
                  >
                    {rejectOpenFor === doc.id ? 'Cancel' : 'Reject'}
                  </button>
                </div>
              )}
              {doc && rejectOpenFor === doc.id && (
                <AdminRejectForm
                  label={`Reason for rejecting ${config.label}`}
                  onConfirm={(reason) => reject(doc, config.label, reason)}
                  onCancel={() => setRejectOpenFor(null)}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
