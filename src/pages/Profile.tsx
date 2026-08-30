import { useEffect, useState } from 'react';

import FamilyMemberForm from '../components/FamilyMemberForm';
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

export default function Profile() {
  const { session, profile, refreshProfile } = useAuth();
  const [members, setMembers] = useState<FamilyMember[]>([]);
  const [loadingMembers, setLoadingMembers] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState(profile?.name ?? '');
  const [savingName, setSavingName] = useState(false);

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

  return (
    <div>
      <AppHeader title="My profile" />
      <div className="mx-auto max-w-md px-4 py-6">
        <Card>
          <label className="text-sm font-medium text-slate-700">Name</label>
          <div className="mt-1 flex gap-2">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Add your name"
              className="w-full rounded-xl border border-slate-300 px-3 py-2 outline-none focus:ring-2 focus:ring-blue-500"
            />
            <Button onClick={saveName} disabled={savingName || name === (profile.name ?? '')}>
              Save
            </Button>
          </div>

          <p className="mt-4 text-sm font-medium text-slate-700">Phone</p>
          <p className="text-slate-900">{profile.phone}</p>
        </Card>

        <div className="mt-6 flex items-center justify-between">
          <h2 className="text-lg font-bold text-slate-900">My family</h2>
          <button onClick={() => setShowForm((s) => !s)} className="text-sm font-semibold text-blue-600">
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

        <div className="mt-4 space-y-2">
          {loadingMembers && <p className="text-sm text-slate-400">Loading...</p>}
          {!loadingMembers && members.length === 0 && (
            <p className="text-sm text-slate-400">No family members added yet.</p>
          )}
          {members.map((m) => (
            <Card key={m.id}>
              <div className="flex items-center justify-between">
                <p className="font-semibold text-slate-900">{m.name}</p>
                <span className="text-xs font-medium text-slate-500">
                  {(m.relation && RELATION_LABEL[m.relation]) ?? m.relation ?? '—'}
                </span>
              </div>
              <p className="text-sm text-slate-500">DOB: {m.dob ?? '—'}</p>
            </Card>
          ))}
        </div>

        <Button variant="ghost" onClick={signOut} className="mt-6">
          Sign out
        </Button>
      </div>
    </div>
  );
}
