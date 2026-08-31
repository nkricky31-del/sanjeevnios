import { useEffect, useState } from 'react';

import AdminAuditLog from '../components/AdminAuditLog';
import AdminDashboard from '../components/AdminDashboard';
import AdminDocumentReview from '../components/AdminDocumentReview';
import AdminFraud from '../components/AdminFraud';
import AdminPayments from '../components/AdminPayments';
import AdminRejectForm from '../components/AdminRejectForm';
import AdminSubscriptions from '../components/AdminSubscriptions';
import PatientLookup from '../components/PatientLookup';
import AppHeader from '../components/ui/AppHeader';
import Button from '../components/ui/Button';
import Card from '../components/ui/Card';
import StatusPill from '../components/ui/StatusPill';
import { recordAdminDecision } from '../lib/audit';
import { useAuth } from '../lib/AuthContext';
import { hasUnresolvedRejection } from '../lib/documents';
import { openVerificationDoc } from '../lib/storage';
import { supabase } from '../lib/supabaseClient';
import type { DocumentRow } from '../lib/types';

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

// Groups a flat list of documents (spanning many owners) by owner_id and
// returns the set of owner_ids where hasUnresolvedRejection is true for
// their own documents.
function rejectedOwnerIds(documents: DocumentRow[]): Set<string> {
  const byOwner = new Map<string, DocumentRow[]>();
  for (const d of documents) {
    const list = byOwner.get(d.owner_id) ?? [];
    list.push(d);
    byOwner.set(d.owner_id, list);
  }
  const result = new Set<string>();
  for (const [ownerId, docs] of byOwner) {
    if (hasUnresolvedRejection(docs)) result.add(ownerId);
  }
  return result;
}

export default function AdminConsole() {
  const { session } = useAuth();
  const [view, setView] = useState<
    'dashboard' | 'verification' | 'subscriptions' | 'payments' | 'fraud' | 'audit' | 'patients'
  >('dashboard');
  const [clinics, setClinics] = useState<PendingClinic[]>([]);
  const [doctors, setDoctors] = useState<PendingDoctor[]>([]);
  const [loading, setLoading] = useState(true);
  const [rejectClinicId, setRejectClinicId] = useState<string | null>(null);
  const [rejectDoctorId, setRejectDoctorId] = useState<string | null>(null);
  const [clinicDocsOpenFor, setClinicDocsOpenFor] = useState<string | null>(null);
  const [doctorDocsOpenFor, setDoctorDocsOpenFor] = useState<string | null>(null);
  const [clinicsWithRejection, setClinicsWithRejection] = useState<Set<string>>(new Set());
  const [doctorsWithRejection, setDoctorsWithRejection] = useState<Set<string>>(new Set());
  const [actionError, setActionError] = useState<string | null>(null);
  const [approvedClinics, setApprovedClinics] = useState<PendingClinic[]>([]);
  const [approvedDoctors, setApprovedDoctors] = useState<PendingDoctor[]>([]);
  const [approvedClinicDocsOpenFor, setApprovedClinicDocsOpenFor] = useState<string | null>(null);
  const [approvedDoctorDocsOpenFor, setApprovedDoctorDocsOpenFor] = useState<string | null>(null);

  const loadPending = async () => {
    setLoading(true);
    // is_verified is orthogonal to status - a clinic/doctor that's already
    // approved (and thus invisible to the "pending" queries below) still
    // needs a way to reach its verification checklist, hence the separate
    // approved-status queries further down.
    const [{ data: clinicData }, { data: doctorData }, { data: approvedClinicData }, { data: approvedDoctorData }] =
      await Promise.all([
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
      ]);
    setClinics((clinicData ?? []) as PendingClinic[]);
    setDoctors((doctorData ?? []) as unknown as PendingDoctor[]);
    setApprovedClinics((approvedClinicData ?? []) as PendingClinic[]);
    setApprovedDoctors((approvedDoctorData ?? []) as unknown as PendingDoctor[]);

    // Approve should be blocked while any document's LATEST upload is still
    // rejected (a resolved-and-re-uploaded one doesn't count) - fetched
    // up front so the button is correctly disabled even before the admin
    // opens "Review documents" for that row.
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
    setClinicsWithRejection(rejectedOwnerIds((clinicDocs ?? []) as DocumentRow[]));
    setDoctorsWithRejection(rejectedOwnerIds((doctorDocs ?? []) as DocumentRow[]));

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
    if (!session) return;
    const { error } = await supabase
      .from('clinics')
      .update({ status: 'approved', reject_reason: null })
      .eq('id', c.id);
    if (error) {
      setActionError(error.message);
      return;
    }
    await recordAdminDecision(
      session.user.id,
      'approve_clinic',
      c.id,
      c.owner_id,
      `Your clinic "${c.name}" has been approved! It's now visible to patients and can accept bookings.`
    );
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

  const TABS: { key: typeof view; label: string }[] = [
    { key: 'dashboard', label: 'Dashboard' },
    { key: 'verification', label: 'Verification' },
    { key: 'subscriptions', label: 'Subscriptions' },
    { key: 'payments', label: 'Payments' },
    { key: 'fraud', label: 'Fraud' },
    { key: 'audit', label: 'Audit log' },
    { key: 'patients', label: 'Patients' },
  ];

  return (
    <div>
      <AppHeader title="Admin" subtitle="Admin console" />
      <div className="mx-auto max-w-md px-4 py-6">
        <div className="flex flex-wrap gap-1.5 rounded-2xl bg-slate-100 p-1.5">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setView(t.key)}
              className={`whitespace-nowrap rounded-full px-3.5 py-2 text-sm font-bold transition ${
                view === t.key ? 'bg-brand-600 text-white' : 'text-slate-500 hover:bg-slate-100'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

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

        {view === 'verification' && (
          <>
            {actionError && <p className="mb-3 mt-4 text-sm text-red-600">{actionError}</p>}

            <div className="mt-4 flex items-center justify-between">
              <h2 className="text-lg font-bold text-slate-900">Pending clinics</h2>
              <button onClick={loadPending} className="text-sm font-medium text-brand-600">
                Refresh
              </button>
            </div>
            <div className="mt-2 space-y-2">
              {loading && <p className="text-sm text-slate-400">Loading...</p>}
              {!loading && clinics.length === 0 && <p className="text-sm text-slate-400">Nothing pending.</p>}
              {clinics.map((c) => (
                <Card key={c.id}>
                  <div className="flex items-center justify-between">
                    <p className="font-semibold text-slate-900">{c.name}</p>
                    <StatusPill label="Pending" tone="warning" />
                  </div>
                  <p className="text-sm text-slate-500">Reg. {c.reg_no ?? '—'}</p>
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
                    <Button onClick={() => approveClinic(c)} disabled={clinicsWithRejection.has(c.id)}>
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
                  {clinicsWithRejection.has(c.id) && (
                    <p className="mt-1 text-xs font-medium text-red-600">
                      Can't approve - this clinic has a rejected document. Review documents below.
                    </p>
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
                      onChanged={loadPending}
                    />
                  )}
                </Card>
              ))}
            </div>

            <div className="mt-6 flex items-center justify-between">
              <h2 className="text-lg font-bold text-slate-900">Pending doctors</h2>
            </div>
            <div className="mt-2 space-y-2">
              {loading && <p className="text-sm text-slate-400">Loading...</p>}
              {!loading && doctors.length === 0 && <p className="text-sm text-slate-400">Nothing pending.</p>}
              {doctors.map((d) => (
                <Card key={d.id}>
                  <div className="flex items-center justify-between">
                    <p className="font-semibold text-slate-900">{d.name}</p>
                    <StatusPill label="Pending" tone="warning" />
                  </div>
                  {d.specialty && <p className="text-sm text-brand-600">{d.specialty}</p>}
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
                    <Button onClick={() => approveDoctor(d)} disabled={doctorsWithRejection.has(d.id)}>
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
                  {doctorsWithRejection.has(d.id) && (
                    <p className="mt-1 text-xs font-medium text-red-600">
                      Can't approve - this doctor has a rejected document. Review documents below.
                    </p>
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
                      onChanged={loadPending}
                    />
                  )}
                </Card>
              ))}
            </div>

            <div className="mt-6 flex items-center justify-between">
              <h2 className="text-lg font-bold text-slate-900">Approved clinics — verification</h2>
            </div>
            <p className="mt-1 text-xs text-slate-400">
              Already approved and visible to patients. Verify every item below to earn the VERIFIED badge.
            </p>
            <div className="mt-2 space-y-2">
              {!loading && approvedClinics.length === 0 && (
                <p className="text-sm text-slate-400">No approved clinics yet.</p>
              )}
              {approvedClinics.map((c) => (
                <Card key={c.id}>
                  <div className="flex items-center justify-between">
                    <p className="font-semibold text-slate-900">{c.name}</p>
                    <StatusPill label={c.is_verified ? 'Verified' : 'Not verified'} tone={c.is_verified ? 'live' : 'neutral'} />
                  </div>
                  <p className="text-sm text-slate-500">Reg. {c.reg_no ?? '—'}</p>
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
                      onChanged={loadPending}
                    />
                  )}
                </Card>
              ))}
            </div>

            <div className="mt-6 flex items-center justify-between">
              <h2 className="text-lg font-bold text-slate-900">Approved doctors — verification</h2>
            </div>
            <div className="mt-2 space-y-2">
              {!loading && approvedDoctors.length === 0 && (
                <p className="text-sm text-slate-400">No approved doctors yet.</p>
              )}
              {approvedDoctors.map((d) => (
                <Card key={d.id}>
                  <div className="flex items-center justify-between">
                    <p className="font-semibold text-slate-900">{d.name}</p>
                    <StatusPill label={d.is_verified ? 'Verified' : 'Not verified'} tone={d.is_verified ? 'live' : 'neutral'} />
                  </div>
                  {d.specialty && <p className="text-sm text-brand-600">{d.specialty}</p>}
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
