import { ArrowLeft, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';

import FamilyMemberForm from '../components/FamilyMemberForm';
import PatientProfile from '../components/PatientProfile';
import AppHeader from '../components/ui/AppHeader';
import Button from '../components/ui/Button';
import Card from '../components/ui/Card';
import { useAuth } from '../lib/AuthContext';
import { supabase } from '../lib/supabaseClient';
import type { FamilyMember } from '../lib/types';

const RELATION_LABEL: Record<string, string> = {
  self: 'Self',
  spouse: 'Spouse',
  child: 'Child',
  parent: 'Parent',
};

// Cycled across family member avatars purely for visual variety - not tied
// to identity or status.
const AVATAR_COLORS = ['bg-brand-500', 'bg-coral-500', 'bg-emerald-500', 'bg-amber-500'];

export default function Profile() {
  const { session, profile, refreshProfile } = useAuth();
  const [members, setMembers] = useState<FamilyMember[]>([]);
  const [loadingMembers, setLoadingMembers] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState(profile?.name ?? '');
  const [savingName, setSavingName] = useState(false);
  const [viewingMrn, setViewingMrn] = useState<string | null>(null);

  const loadMembers = async () => {
    setLoadingMembers(true);
    const { data } = await supabase.from('family_members').select('*').order('created_at', { ascending: true });
    setMembers(data ?? []);
    setLoadingMembers(false);
  };

  useEffect(() => {
    loadMembers();
  }, []);

  useEffect(() => {
    setName(profile?.name ?? '');
  }, [profile?.name]);

  if (!session || !profile) return null;

  const saveName = async () => {
    setSavingName(true);
    await supabase.from('profiles').update({ name: name.trim() || null }).eq('id', session.user.id);
    setSavingName(false);
    await refreshProfile();
  };

  const signOut = () => supabase.auth.signOut();

  if (viewingMrn) {
    return (
      <div>
        <div className="flex items-center border-b border-slate-100 bg-white px-4 py-4">
          <button
            onClick={() => setViewingMrn(null)}
            className="inline-flex items-center gap-1 text-sm font-medium text-slate-500"
          >
            <ArrowLeft size={16} /> Back to profile
          </button>
        </div>
        <div className="mx-auto max-w-md px-4 py-6">
          <PatientProfile mrn={viewingMrn} />
        </div>
      </div>
    );
  }

  return (
    <div>
      <AppHeader title="My profile" />
      <div className="mx-auto max-w-md px-4 py-6">
        <Card>
          <label className="text-sm font-semibold text-slate-700">Name</label>
          <div className="mt-1.5 flex gap-2">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Add your name"
              className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-brand-500"
            />
            <Button onClick={saveName} disabled={savingName || name === (profile.name ?? '')}>
              Save
            </Button>
          </div>

          <p className="mt-4 text-sm font-semibold text-slate-700">Phone</p>
          <p className="text-slate-900">{profile.phone}</p>
        </Card>

        <div className="mt-6 flex items-center justify-between">
          <h2 className="text-lg font-bold text-slate-900">My family</h2>
          <button onClick={() => setShowForm((s) => !s)} className="text-sm font-bold text-coral-600">
            {showForm ? 'Cancel' : '+ Add family member'}
          </button>
        </div>

        {showForm && (
          <FamilyMemberForm
            accountId={session.user.id}
            onAdded={() => {
              setShowForm(false);
              loadMembers();
            }}
            onCancel={() => setShowForm(false)}
          />
        )}

        <div className="mt-4 grid grid-cols-2 gap-3">
          {loadingMembers && <p className="col-span-2 text-sm text-slate-400">Loading...</p>}
          {!loadingMembers && members.length === 0 && (
            <p className="col-span-2 text-sm text-slate-400">No family members added yet.</p>
          )}
          {members.map((m, i) => (
            <div key={m.id} className="flex flex-col items-center text-center">
              <div
                className={`flex h-20 w-20 items-center justify-center rounded-3xl text-2xl font-bold text-white ${AVATAR_COLORS[i % AVATAR_COLORS.length]}`}
              >
                {m.name.charAt(0).toUpperCase()}
              </div>
              <p className="mt-2 max-w-full truncate text-sm font-bold text-slate-900">{m.name}</p>
              <p className="text-xs text-slate-500">
                {(m.relation && RELATION_LABEL[m.relation]) ?? m.relation ?? '—'}
              </p>
              {m.dob && <p className="text-[11px] text-slate-400">DOB: {m.dob}</p>}
              <button
                onClick={() => setViewingMrn(m.mrn)}
                className="mt-0.5 font-mono text-[10px] text-brand-600 underline"
              >
                {m.mrn}
              </button>
            </div>
          ))}
          <button
            onClick={() => setShowForm(true)}
            className="flex flex-col items-center text-center text-coral-600"
          >
            <div className="flex h-20 w-20 items-center justify-center rounded-3xl border-2 border-dashed border-coral-300 bg-coral-50">
              <Plus size={26} />
            </div>
            <p className="mt-2 text-sm font-bold">Add profile</p>
          </button>
        </div>

        <Button variant="ghost" onClick={signOut} className="mt-6">
          Sign out
        </Button>
      </div>
    </div>
  );
}
