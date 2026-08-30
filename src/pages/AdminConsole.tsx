import { useEffect, useState } from 'react';

import AdminAuditLog from '../components/AdminAuditLog';
import AdminDashboard from '../components/AdminDashboard';
import AdminFraud from '../components/AdminFraud';
import AdminPayments from '../components/AdminPayments';
import AdminRejectForm from '../components/AdminRejectForm';
import AdminSubscriptions from '../components/AdminSubscriptions';
import AppHeader from '../components/ui/AppHeader';
import Button from '../components/ui/Button';
import Card from '../components/ui/Card';
import StatusPill from '../components/ui/StatusPill';
import { recordAdminDecision } from '../lib/audit';
import { useAuth } from '../lib/AuthContext';
import { openVerificationDoc } from '../lib/storage';
import { supabase } from '../lib/supabaseClient';

interface PendingClinic {
  id: string;
  name: string;
  reg_no: string | null;
  address: string | null;
  registration_doc_path: string | null;
  owner_id: string;
  created_at: string;
}

interface PendingDoctor {
  id: string;
  name: string;
  reg_no: string | null;
  specialty: string | null;
  registration_doc_path: string | null;
  clinic_id: string;
  created_at: string;
  clinics: { name: string; owner_id: string; status: string } | null;
}

export default function AdminConsole() {
  const { session } = useAuth();
  const [view, setView] = useState<'dashboard' | 'verification' | 'subscriptions' | 'payments' | 'fraud' | 'audit'>(
    'dashboard'
  );
  const [clinics, setClinics] = useState<PendingClinic[]>([]);
  const [doctors, setDoctors] = useState<PendingDoctor[]>([]);
  const [loading, setLoading] = useState(true);
  const [rejectClinicId, setRejectClinicId] = useState<string | null>(null);
  const [rejectDoctorId, setRejectDoctorId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const loadPending = async () => {
    setLoading(true);
    const [{ data: clinicData }, { data: doctorData }] = await Promise.all([
      supabase.from('clinics').select('*').eq('status', 'pending').order('created_at', { ascending: true }),
      supabase
        .from('doctors')
        .select('*, clinics(name, owner_id, status)')
        .eq('status', 'pending')
        .order('created_at', { ascending: true }),
    ]);
    setClinics((clinicData ?? []) as PendingClinic[]);
    setDoctors((doctorData ?? []) as unknown as PendingDoctor[]);
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
                      View document
                    </button>
                  )}
                  <div className="mt-2 flex gap-2">
                    <Button onClick={() => approveClinic(c)}>Approve</Button>
                    <Button variant="danger" onClick={() => setRejectClinicId((prev) => (prev === c.id ? null : c.id))}>
                      {rejectClinicId === c.id ? 'Cancel' : 'Reject'}
                    </Button>
                  </div>
                  {rejectClinicId === c.id && (
                    <AdminRejectForm
                      label="Reason for rejecting this clinic"
                      onConfirm={(reason) => rejectClinic(c, reason)}
                      onCancel={() => setRejectClinicId(null)}
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
                      View document
                    </button>
                  )}
                  <div className="mt-2 flex gap-2">
                    <Button onClick={() => approveDoctor(d)}>Approve</Button>
                    <Button variant="danger" onClick={() => setRejectDoctorId((prev) => (prev === d.id ? null : d.id))}>
                      {rejectDoctorId === d.id ? 'Cancel' : 'Reject'}
                    </Button>
                  </div>
                  {rejectDoctorId === d.id && (
                    <AdminRejectForm
                      label="Reason for rejecting this doctor"
                      onConfirm={(reason) => rejectDoctor(d, reason)}
                      onCancel={() => setRejectDoctorId(null)}
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
