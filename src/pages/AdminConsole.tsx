import { Building2, Stethoscope } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import AdminAuditLog from '../components/AdminAuditLog';
import AdminBilling from '../components/AdminBilling';
import AdminConditions from '../components/AdminConditions';
import AdminCoupons from '../components/AdminCoupons';
import AdminDashboard from '../components/AdminDashboard';
import AdminDocumentReview from '../components/AdminDocumentReview';
import AdminFraud from '../components/AdminFraud';
import AdminNameChanges from '../components/AdminNameChanges';
import AdminPayments from '../components/AdminPayments';
import AdminRejectForm from '../components/AdminRejectForm';
import AdminSubscriptions from '../components/AdminSubscriptions';
import AdminVerificationRequirements from '../components/AdminVerificationRequirements';
import PatientLookup from '../components/PatientLookup';
import AppHeader from '../components/ui/AppHeader';
import Button from '../components/ui/Button';
import Card from '../components/ui/Card';
import IconTile from '../components/ui/IconTile';
import SectionTitle from '../components/ui/SectionTitle';
import Segmented from '../components/ui/Segmented';
import StatusPill from '../components/ui/StatusPill';
import { recordAdminDecision } from '../lib/audit';
import { useAuth } from '../lib/AuthContext';
import { openVerificationDoc } from '../lib/storage';
import { supabase } from '../lib/supabaseClient';
import type { DocumentRow, VerificationRequirement } from '../lib/types';
import { useUnreadNotifications } from '../lib/useUnreadNotifications';
import { approvalBlockers, loadVerificationRequirements } from '../lib/verificationRequirements';

interface PendingClinic {
  id: string;
  name: string;
  reg_no: string | null;
  address: string | null;
  registration_doc_path: string | null;
  owner_id: string;
  created_at: string;
  is_verified: boolean;
}

interface PendingDoctor {
  id: string;
  name: string;
  reg_no: string | null;
  specialty: string | null;
  registration_doc_path: string | null;
  clinic_id: string;
  created_at: string;
  is_verified: boolean;
  clinics: { name: string; owner_id: string; status: string } | null;
}

// Computes each owner's own approval blockers (schema.sql section 49) - the
// exact same rule the server enforces, just so the reasons can be listed,
// not only whether Approve is disabled. Takes the full list of owner_ids
// (not just the ones with at least one document row) - an owner with ZERO
// documents uploaded is exactly the case this whole feature exists to catch,
// so it must still get every required item listed as missing, not be
// skipped for having nothing to group.
function blockersByOwner(
  ownerType: 'clinic' | 'doctor',
  ownerIds: string[],
  documents: DocumentRow[],
  requirements: VerificationRequirement[]
): Map<string, string[]> {
  const byOwner = new Map<string, DocumentRow[]>();
  for (const d of documents) {
    const list = byOwner.get(d.owner_id) ?? [];
    list.push(d);
    byOwner.set(d.owner_id, list);
  }
  const result = new Map<string, string[]>();
  for (const ownerId of ownerIds) {
    result.set(ownerId, approvalBlockers(ownerType, requirements, byOwner.get(ownerId) ?? []));
  }
  return result;
}

export default function AdminConsole() {
  const { session } = useAuth();
  const navigate = useNavigate();
  const hasUnread = useUnreadNotifications();
  const [view, setView] = useState<
    | 'dashboard'
    | 'verification'
    | 'subscriptions'
    | 'payments'
    | 'coupons'
    | 'billing'
    | 'fraud'
    | 'audit'
    | 'patients'
    | 'conditions'
    | 'requirements'
    | 'names'
  >('dashboard');
  const [clinics, setClinics] = useState<PendingClinic[]>([]);
  const [doctors, setDoctors] = useState<PendingDoctor[]>([]);
  const [loading, setLoading] = useState(true);
  const [rejectClinicId, setRejectClinicId] = useState<string | null>(null);
  const [rejectDoctorId, setRejectDoctorId] = useState<string | null>(null);
  const [clinicDocsOpenFor, setClinicDocsOpenFor] = useState<string | null>(null);
  const [doctorDocsOpenFor, setDoctorDocsOpenFor] = useState<string | null>(null);
  const [requirements, setRequirements] = useState<VerificationRequirement[]>([]);
  // Every reason approval is currently blocked, per owner - an empty array
  // means ready to approve. schema.sql section 49: exactly what the server
  // itself checks, computed here so the Approve button and the list of
  // reasons shown next to it can never disagree.
  const [clinicBlockers, setClinicBlockers] = useState<Map<string, string[]>>(new Map());
  const [doctorBlockers, setDoctorBlockers] = useState<Map<string, string[]>>(new Map());
  const [actionError, setActionError] = useState<string | null>(null);
  const [approvedClinics, setApprovedClinics] = useState<PendingClinic[]>([]);
  const [approvedDoctors, setApprovedDoctors] = useState<PendingDoctor[]>([]);
  const [approvedClinicDocsOpenFor, setApprovedClinicDocsOpenFor] = useState<string | null>(null);
  const [approvedDoctorDocsOpenFor, setApprovedDoctorDocsOpenFor] = useState<string | null>(null);
  // Set right after approveClinic() succeeds - shown once, right on this
  // screen, so the admin never has to go hunting for the Clinic ID they just
  // issued (schema.sql migration 57 mints it the moment status -> 'approved').
  const [justApproved, setJustApproved] = useState<{ name: string; code: string } | null>(null);

  const loadPending = async () => {
    setLoading(true);

    // Best-effort - closes the "no cron job" gap for a required document
    // whose expiry_date has simply passed with no other event to trigger a
    // resync (schema.sql section 49), the same "sweep on load" pattern
    // auto_mark_no_shows()/sweep_follow_up_reminders() already use. Awaited
    // first so anything it drops back to 'pending' shows up correctly in
    // the very same load, not a stale "still approved" row.
    await supabase.rpc('sweep_expired_verifications');

    // is_verified is orthogonal to status - a clinic/doctor that's already
    // approved (and thus invisible to the "pending" queries below) still
    // needs a way to reach its verification checklist, hence the separate
    // approved-status queries further down.
    const [
      { data: clinicData },
      { data: doctorData },
      { data: approvedClinicData },
      { data: approvedDoctorData },
      loadedRequirements,
    ] = await Promise.all([
      supabase.from('clinics').select('*').eq('status', 'pending').order('created_at', { ascending: true }),
      supabase
        .from('doctors')
        .select('*, clinics(name, owner_id, status)')
        .eq('status', 'pending')
        .order('created_at', { ascending: true }),
      supabase.from('clinics').select('*').eq('status', 'approved').order('name', { ascending: true }),
      supabase
        .from('doctors')
        .select('*, clinics(name, owner_id, status)')
        .eq('status', 'approved')
        .order('name', { ascending: true }),
      loadVerificationRequirements(),
    ]);
    setClinics((clinicData ?? []) as PendingClinic[]);
    setDoctors((doctorData ?? []) as unknown as PendingDoctor[]);
    setApprovedClinics((approvedClinicData ?? []) as PendingClinic[]);
    setApprovedDoctors((approvedDoctorData ?? []) as unknown as PendingDoctor[]);
    setRequirements(loadedRequirements);

    // Approve must be blocked until every REQUIRED item (schema.sql section
    // 49 - admin-controlled, via verification_requirements) is both uploaded
    // and verified - fetched up front so the button is correctly disabled,
    // and the reasons why are visible, even before the admin opens "Review
    // documents" for that row.
    const clinicIds = (clinicData ?? []).map((c) => c.id);
    const doctorIds = (doctorData ?? []).map((d) => d.id);
    const [{ data: clinicDocs }, { data: doctorDocs }] = await Promise.all([
      clinicIds.length
        ? supabase.from('documents').select('*').eq('owner_type', 'clinic').in('owner_id', clinicIds)
        : Promise.resolve({ data: [] as DocumentRow[] }),
      doctorIds.length
        ? supabase.from('documents').select('*').eq('owner_type', 'doctor').in('owner_id', doctorIds)
        : Promise.resolve({ data: [] as DocumentRow[] }),
    ]);
    setClinicBlockers(blockersByOwner('clinic', clinicIds, (clinicDocs ?? []) as DocumentRow[], loadedRequirements));
    setDoctorBlockers(blockersByOwner('doctor', doctorIds, (doctorDocs ?? []) as DocumentRow[], loadedRequirements));

    setLoading(false);
  };

  useEffect(() => {
    loadPending();
  }, []);

  const viewDoc = async (path: string) => {
    const url = await openVerificationDoc(path);
    if (!url) setActionError('Could not open document.');
  };

  const approveClinic = async (c: PendingClinic) => {
    setActionError(null);
    setJustApproved(null);
    if (!session) return;
    // .select() so the row this update trigger just stamped a clinic_code
    // onto (on_clinic_approve_assign_code, schema.sql migration 57) comes
    // straight back - no second round trip needed just to learn the ID.
    const { data: updated, error } = await supabase
      .from('clinics')
      .update({ status: 'approved', reject_reason: null })
      .eq('id', c.id)
      .select('clinic_code')
      .single();
    if (error) {
      setActionError(error.message);
      return;
    }
    const clinicCode = updated?.clinic_code ?? null;
    await recordAdminDecision(
      session.user.id,
      'approve_clinic',
      c.id,
      c.owner_id,
      clinicCode
        ? `Your clinic "${c.name}" has been approved! It's now visible to patients and can accept bookings. Your Clinic ID for staff login is ${clinicCode} - it's also shown in your console header and under the "Login & staff" tab.`
        : `Your clinic "${c.name}" has been approved! It's now visible to patients and can accept bookings.`
    );
    if (clinicCode) {
      setJustApproved({ name: c.name, code: clinicCode });
      // Best-effort SMS/email of the same Clinic ID - quietly no-ops on
      // either channel if its gateway isn't configured server-side (see
      // supabase/functions/send-clinic-approval-notice). Never blocks this
      // screen: the in-app notification above already landed regardless.
      supabase.functions.invoke('send-clinic-approval-notice', { body: { clinicId: c.id } }).catch((err) => {
        console.error('send-clinic-approval-notice failed:', err);
      });
    }
    loadPending();
  };

  const rejectClinic = async (c: PendingClinic, reason: string) => {
    setActionError(null);
    if (!session) return;
    const { error } = await supabase.from('clinics').update({ status: 'rejected', reject_reason: reason }).eq('id', c.id);
    if (error) {
      setActionError(error.message);
      return;
    }
    await recordAdminDecision(
      session.user.id,
      'reject_clinic',
      c.id,
      c.owner_id,
      `Your clinic "${c.name}" was rejected: "${reason}"`
    );
    setRejectClinicId(null);
    loadPending();
  };

  const approveDoctor = async (d: PendingDoctor) => {
    setActionError(null);
    if (!session || !d.clinics) return;
    const { error } = await supabase
      .from('doctors')
      .update({ status: 'approved', reject_reason: null })
      .eq('id', d.id);
    if (error) {
      setActionError(error.message);
      return;
    }
    await recordAdminDecision(
      session.user.id,
      'approve_doctor',
      d.id,
      d.clinics.owner_id,
      `${d.name} has been approved and is now visible to patients.`
    );
    loadPending();
  };

  const rejectDoctor = async (d: PendingDoctor, reason: string) => {
    setActionError(null);
    if (!session || !d.clinics) return;
    const { error } = await supabase.from('doctors').update({ status: 'rejected', reject_reason: reason }).eq('id', d.id);
    if (error) {
      setActionError(error.message);
      return;
    }
    await recordAdminDecision(session.user.id, 'reject_doctor', d.id, d.clinics.owner_id, `${d.name} was rejected: "${reason}"`);
    setRejectDoctorId(null);
    loadPending();
  };

  const signOut = () => supabase.auth.signOut();

  const TABS: { value: typeof view; label: string }[] = [
    { value: 'dashboard', label: 'Dashboard' },
    { value: 'verification', label: 'Verification' },
    { value: 'subscriptions', label: 'Subscriptions' },
    { value: 'payments', label: 'Payments' },
    { value: 'coupons', label: 'Coupons' },
    { value: 'billing', label: 'Billing' },
    { value: 'fraud', label: 'Fraud' },
    { value: 'audit', label: 'Audit log' },
    { value: 'patients', label: 'Patients' },
    { value: 'conditions', label: 'Conditions' },
    { value: 'requirements', label: 'Requirements' },
    { value: 'names', label: 'Name changes' },
  ];

  return (
    <div>
      <AppHeader
        title="Admin"
        subtitle="Admin console"
        bellDot={hasUnread}
        onBellClick={() => navigate('/notifications')}
      />
      <div className="mx-auto max-w-md px-4 pb-6">
        <Segmented options={TABS} value={view} onChange={setView} variant="scroll" />

        {view === 'dashboard' && (
          <div className="mt-4">
            <AdminDashboard />
          </div>
        )}

        {view === 'subscriptions' && (
          <div className="mt-4">
            <AdminSubscriptions />
          </div>
        )}

        {view === 'payments' && (
          <div className="mt-4">
            <AdminPayments />
          </div>
        )}

        {view === 'coupons' && (
          <div className="mt-4">
            <AdminCoupons />
          </div>
        )}

        {view === 'billing' && (
          <div className="mt-4">
            <AdminBilling />
          </div>
        )}

        {view === 'fraud' && (
          <div className="mt-4">
            <AdminFraud />
          </div>
        )}

        {view === 'audit' && (
          <div className="mt-4">
            <AdminAuditLog />
          </div>
        )}

        {view === 'patients' && (
          <div className="mt-4">
            <PatientLookup />
          </div>
        )}

        {view === 'conditions' && (
          <div className="mt-4">
            <AdminConditions />
          </div>
        )}

        {view === 'requirements' && (
          <div className="mt-4">
            <AdminVerificationRequirements />
          </div>
        )}

        {view === 'names' && (
          <div className="mt-4">
            <AdminNameChanges />
          </div>
        )}

        {view === 'verification' && (
          <>
            {actionError && <p className="mb-3 mt-4 text-sm text-red-600">{actionError}</p>}

            {justApproved && (
              <div className="mt-4 flex items-start justify-between gap-3 rounded-2xl bg-emerald-50 p-3.5 text-sm text-emerald-800">
                <p>
                  <strong>{justApproved.name}</strong> approved. Clinic ID:{' '}
                  <span className="font-mono font-bold">{justApproved.code}</span> — sent to the clinic by SMS/email
                  where configured.
                </p>
                <button
                  onClick={() => setJustApproved(null)}
                  className="shrink-0 text-xs font-semibold text-emerald-600 underline"
                >
                  Dismiss
                </button>
              </div>
            )}

            <SectionTitle className="mt-5" actionLabel="Refresh" onAction={loadPending}>
              Pending clinics
            </SectionTitle>
            <div className="mt-2 space-y-2">
              {loading && <p className="text-sm text-slate-400">Loading...</p>}
              {!loading && clinics.length === 0 && <p className="text-sm text-slate-400">Nothing pending.</p>}
              {clinics.map((c) => (
                <Card key={c.id}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <IconTile icon={Building2} size="sm" />
                      <p className="truncate font-bold text-slate-900">{c.name}</p>
                    </div>
                    <StatusPill label="Pending" tone="warning" />
                  </div>
                  <p className="mt-2 text-sm text-slate-500">Reg. {c.reg_no ?? '—'}</p>
                  {c.address && <p className="text-xs text-slate-400">{c.address}</p>}
                  {c.registration_doc_path && (
                    <button
                      onClick={() => viewDoc(c.registration_doc_path!)}
                      className="mt-1 text-xs font-medium text-brand-600"
                    >
                      View legacy document
                    </button>
                  )}
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button onClick={() => approveClinic(c)} disabled={(clinicBlockers.get(c.id)?.length ?? 0) > 0}>
                      Approve
                    </Button>
                    <Button variant="danger" onClick={() => setRejectClinicId((prev) => (prev === c.id ? null : c.id))}>
                      {rejectClinicId === c.id ? 'Cancel' : 'Reject'}
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => setClinicDocsOpenFor((prev) => (prev === c.id ? null : c.id))}
                    >
                      {clinicDocsOpenFor === c.id ? 'Hide documents' : 'Review documents'}
                    </Button>
                  </div>
                  {(clinicBlockers.get(c.id)?.length ?? 0) > 0 && (
                    <div className="mt-1.5 rounded-xl bg-red-50 p-2 text-xs font-medium text-red-600">
                      <p>Can't approve yet:</p>
                      <ul className="ml-4 list-disc">
                        {clinicBlockers.get(c.id)!.map((reason) => (
                          <li key={reason}>{reason}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {rejectClinicId === c.id && (
                    <AdminRejectForm
                      label="Reason for rejecting this clinic"
                      onConfirm={(reason) => rejectClinic(c, reason)}
                      onCancel={() => setRejectClinicId(null)}
                    />
                  )}
                  {clinicDocsOpenFor === c.id && (
                    <AdminDocumentReview
                      ownerType="clinic"
                      ownerId={c.id}
                      notifyUserId={c.owner_id}
                      label="Clinic documents"
                      requirements={requirements}
                      onChanged={loadPending}
                    />
                  )}
                </Card>
              ))}
            </div>

            <SectionTitle className="mt-6">Pending doctors</SectionTitle>
            <div className="mt-2 space-y-2">
              {loading && <p className="text-sm text-slate-400">Loading...</p>}
              {!loading && doctors.length === 0 && <p className="text-sm text-slate-400">Nothing pending.</p>}
              {doctors.map((d) => (
                <Card key={d.id}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <IconTile icon={Stethoscope} size="sm" />
                      <p className="truncate font-bold text-slate-900">{d.name}</p>
                    </div>
                    <StatusPill label="Pending" tone="warning" />
                  </div>
                  {d.specialty && <p className="mt-2 text-sm font-medium text-brand-600">{d.specialty}</p>}
                  <p className="text-sm text-slate-500">Reg. {d.reg_no ?? '—'}</p>
                  <p className="text-xs text-slate-400">
                    {d.clinics?.name}
                    {d.clinics && d.clinics.status !== 'approved' && ` (clinic ${d.clinics.status})`}
                  </p>
                  {d.registration_doc_path && (
                    <button
                      onClick={() => viewDoc(d.registration_doc_path!)}
                      className="mt-1 text-xs font-medium text-brand-600"
                    >
                      View legacy document
                    </button>
                  )}
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button onClick={() => approveDoctor(d)} disabled={(doctorBlockers.get(d.id)?.length ?? 0) > 0}>
                      Approve
                    </Button>
                    <Button variant="danger" onClick={() => setRejectDoctorId((prev) => (prev === d.id ? null : d.id))}>
                      {rejectDoctorId === d.id ? 'Cancel' : 'Reject'}
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => setDoctorDocsOpenFor((prev) => (prev === d.id ? null : d.id))}
                    >
                      {doctorDocsOpenFor === d.id ? 'Hide documents' : 'Review documents'}
                    </Button>
                  </div>
                  {(doctorBlockers.get(d.id)?.length ?? 0) > 0 && (
                    <div className="mt-1.5 rounded-xl bg-red-50 p-2 text-xs font-medium text-red-600">
                      <p>Can't approve yet:</p>
                      <ul className="ml-4 list-disc">
                        {doctorBlockers.get(d.id)!.map((reason) => (
                          <li key={reason}>{reason}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {rejectDoctorId === d.id && (
                    <AdminRejectForm
                      label="Reason for rejecting this doctor"
                      onConfirm={(reason) => rejectDoctor(d, reason)}
                      onCancel={() => setRejectDoctorId(null)}
                    />
                  )}
                  {doctorDocsOpenFor === d.id && d.clinics && (
                    <AdminDocumentReview
                      ownerType="doctor"
                      ownerId={d.id}
                      notifyUserId={d.clinics.owner_id}
                      label="Doctor documents & consent"
                      requirements={requirements}
                      onChanged={loadPending}
                    />
                  )}
                </Card>
              ))}
            </div>

            <SectionTitle className="mt-6">Approved clinics — verification</SectionTitle>
            <p className="mt-1 text-xs text-slate-400">
              Already approved and visible to patients. Verify every item below to earn the VERIFIED badge.
            </p>
            <div className="mt-2 space-y-2">
              {!loading && approvedClinics.length === 0 && (
                <p className="text-sm text-slate-400">No approved clinics yet.</p>
              )}
              {approvedClinics.map((c) => (
                <Card key={c.id}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <IconTile icon={Building2} size="sm" tone={c.is_verified ? 'emerald' : 'slate'} />
                      <p className="truncate font-bold text-slate-900">{c.name}</p>
                    </div>
                    <StatusPill label={c.is_verified ? 'Verified' : 'Not verified'} tone={c.is_verified ? 'live' : 'neutral'} />
                  </div>
                  <p className="mt-2 text-sm text-slate-500">Reg. {c.reg_no ?? '—'}</p>
                  <div className="mt-2">
                    <Button
                      variant="secondary"
                      onClick={() => setApprovedClinicDocsOpenFor((prev) => (prev === c.id ? null : c.id))}
                    >
                      {approvedClinicDocsOpenFor === c.id ? 'Hide checklist' : 'Review verification checklist'}
                    </Button>
                  </div>
                  {approvedClinicDocsOpenFor === c.id && (
                    <AdminDocumentReview
                      ownerType="clinic"
                      ownerId={c.id}
                      notifyUserId={c.owner_id}
                      label="Clinic verification checklist"
                      requirements={requirements}
                      onChanged={loadPending}
                    />
                  )}
                </Card>
              ))}
            </div>

            <SectionTitle className="mt-6">Approved doctors — verification</SectionTitle>
            <div className="mt-2 space-y-2">
              {!loading && approvedDoctors.length === 0 && (
                <p className="text-sm text-slate-400">No approved doctors yet.</p>
              )}
              {approvedDoctors.map((d) => (
                <Card key={d.id}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <IconTile icon={Stethoscope} size="sm" tone={d.is_verified ? 'emerald' : 'slate'} />
                      <p className="truncate font-bold text-slate-900">{d.name}</p>
                    </div>
                    <StatusPill label={d.is_verified ? 'Verified' : 'Not verified'} tone={d.is_verified ? 'live' : 'neutral'} />
                  </div>
                  {d.specialty && <p className="mt-2 text-sm font-medium text-brand-600">{d.specialty}</p>}
                  <p className="text-xs text-slate-400">{d.clinics?.name}</p>
                  <div className="mt-2">
                    <Button
                      variant="secondary"
                      onClick={() => setApprovedDoctorDocsOpenFor((prev) => (prev === d.id ? null : d.id))}
                    >
                      {approvedDoctorDocsOpenFor === d.id ? 'Hide checklist' : 'Review verification checklist'}
                    </Button>
                  </div>
                  {approvedDoctorDocsOpenFor === d.id && d.clinics && (
                    <AdminDocumentReview
                      ownerType="doctor"
                      ownerId={d.id}
                      notifyUserId={d.clinics.owner_id}
                      requirements={requirements}
                      label="Doctor verification checklist"
                      onChanged={loadPending}
                    />
                  )}
                </Card>
              ))}
            </div>
          </>
        )}

        <Button variant="ghost" onClick={signOut} className="mt-6">
          Sign out
        </Button>
      </div>
    </div>
  );
}
