import {
  BadgeCheck,
  Bell,
  CalendarDays,
  ChevronRight,
  FileText,
  FlaskConical,
  HeartPulse,
  Info,
  LogOut,
  Plus,
  ShieldCheck,
  UserRound,
  Users,
  Wallet,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import FamilyMemberForm from '../components/FamilyMemberForm';
import KnownConditionsForm from '../components/KnownConditionsForm';
import PatientProfile from '../components/PatientProfile';
import AppHeader from '../components/ui/AppHeader';
import Button from '../components/ui/Button';
import Card from '../components/ui/Card';
import IconTile, { type IconTone } from '../components/ui/IconTile';
import ScreenHeader from '../components/ui/ScreenHeader';
import SectionTitle from '../components/ui/SectionTitle';
import { useAuth } from '../lib/AuthContext';
import { supabase } from '../lib/supabaseClient';
import type { FamilyMember } from '../lib/types';
import { useUnreadNotifications } from '../lib/useUnreadNotifications';

const RELATION_LABEL: Record<string, string> = {
  self: 'Self',
  spouse: 'Spouse',
  child: 'Child',
  parent: 'Parent',
};

// Cycled across family member avatars purely for visual variety - not tied
// to identity or status.
const AVATAR_TONES: IconTone[] = ['brand', 'emerald', 'amber', 'pink'];

type Panel = 'personal' | 'family' | 'medical' | 'privacy' | 'about' | null;

export default function Profile() {
  const { session, profile, refreshProfile } = useAuth();
  const navigate = useNavigate();
  const hasUnread = useUnreadNotifications();
  const [members, setMembers] = useState<FamilyMember[]>([]);
  const [loadingMembers, setLoadingMembers] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState(profile?.name ?? '');
  const [savingName, setSavingName] = useState(false);
  const [viewingMrn, setViewingMrn] = useState<string | null>(null);
  const [conditionsFor, setConditionsFor] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [stats, setStats] = useState({ appointments: 0, records: 0, labReports: 0, spent: 0 });

  const loadMembers = async () => {
    setLoadingMembers(true);
    const { data } = await supabase.from('family_members').select('*').order('created_at', { ascending: true });
    setMembers(data ?? []);
    setLoadingMembers(false);
  };

  useEffect(() => {
    loadMembers();
  }, []);

  // The four counters across the top of the profile card, each a plain
  // head-count query rather than a fetch of the rows themselves.
  useEffect(() => {
    (async () => {
      const [{ count: appointments }, { count: labReports }, { data: payments }, { count: records }] =
        await Promise.all([
          supabase.from('appointments').select('id', { count: 'exact', head: true }),
          supabase.from('files').select('id', { count: 'exact', head: true }).eq('type', 'lab_report'),
          supabase.from('payments').select('amount, status'),
          supabase.from('files').select('id', { count: 'exact', head: true }),
        ]);
      const spent = ((payments ?? []) as { amount: number; status: string }[])
        .filter((p) => p.status === 'captured')
        .reduce((sum, p) => sum + Number(p.amount), 0);
      setStats({
        appointments: appointments ?? 0,
        records: records ?? 0,
        labReports: labReports ?? 0,
        spent,
      });
    })();
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
  const togglePanel = (p: Panel) => setPanel((prev) => (prev === p ? null : p));

  if (viewingMrn) {
    return (
      <div>
        <ScreenHeader title="Patient record" onBack={() => setViewingMrn(null)} />
        <div className="mx-auto max-w-md px-4 py-4">
          <PatientProfile mrn={viewingMrn} />
        </div>
      </div>
    );
  }

  const selfMember = members.find((m) => m.relation === 'self') ?? members[0];

  return (
    <div>
      <AppHeader title="Profile" centered bellDot={hasUnread} onBellClick={() => navigate('/notifications')} />

      <div className="mx-auto max-w-md px-4 pb-6">
        {/* Identity card + stats */}
        <Card className="!p-0">
          <div className="flex items-center gap-3 p-4">
            <span className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-brand-100 text-2xl font-extrabold text-brand-700">
              {(profile.name ?? selfMember?.name ?? '?').charAt(0).toUpperCase()}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-lg font-bold text-slate-900">{profile.name ?? 'Add your name'}</p>
              <p className="truncate text-sm text-slate-500">+{profile.phone}</p>
              <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-brand-50 px-2.5 py-1 text-xs font-bold text-brand-700">
                <BadgeCheck size={13} /> Verified Patient
              </span>
            </div>
          </div>

          <div className="grid grid-cols-4 divide-x divide-slate-100 border-t border-slate-100">
            {[
              { icon: CalendarDays, value: stats.appointments, label: 'Appointments' },
              { icon: FileText, value: stats.records, label: 'Records' },
              { icon: FlaskConical, value: stats.labReports, label: 'Lab Reports' },
              { icon: Wallet, value: `₹${stats.spent.toLocaleString('en-IN')}`, label: 'Total Spent' },
            ].map((s) => (
              <div key={s.label} className="px-1 py-3 text-center">
                <s.icon size={17} className="mx-auto text-brand-600" />
                <p className="mt-1 text-sm font-extrabold text-slate-900">{s.value}</p>
                <p className="text-[10px] font-semibold leading-tight text-slate-500">{s.label}</p>
              </div>
            ))}
          </div>
        </Card>

        {/* My Information */}
        <SectionTitle className="mt-6">My Information</SectionTitle>
        <Card className="mt-2 !p-0">
          <button
            onClick={() => togglePanel('personal')}
            className="flex w-full items-center gap-3 px-4 py-3.5 text-left hover:bg-slate-50"
          >
            <IconTile icon={UserRound} />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-bold text-slate-900">Personal Details</span>
              <span className="block text-xs text-slate-500">View and update your personal information</span>
            </span>
            <ChevronRight size={18} className={`shrink-0 text-slate-300 ${panel === 'personal' ? 'rotate-90' : ''}`} />
          </button>
          {panel === 'personal' && (
            <div className="border-t border-slate-100 bg-slate-50/60 p-4">
              <label className="text-sm font-bold text-slate-700">Name</label>
              <div className="mt-1.5 flex gap-2">
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Add your name"
                  className="w-full rounded-2xl border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-brand-500"
                />
                <Button onClick={saveName} disabled={savingName || name === (profile.name ?? '')}>
                  Save
                </Button>
              </div>
              <p className="mt-3 text-sm font-bold text-slate-700">Phone</p>
              <p className="text-sm text-slate-600">+{profile.phone}</p>
              {selfMember?.mrn && (
                <>
                  <p className="mt-3 text-sm font-bold text-slate-700">Medical record number</p>
                  <button
                    onClick={() => setViewingMrn(selfMember.mrn)}
                    className="font-mono text-sm font-semibold text-brand-600 underline"
                  >
                    {selfMember.mrn}
                  </button>
                </>
              )}
            </div>
          )}

          <button
            onClick={() => togglePanel('family')}
            className="flex w-full items-center gap-3 border-t border-slate-100 px-4 py-3.5 text-left hover:bg-slate-50"
          >
            <IconTile icon={Users} tone="emerald" />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-bold text-slate-900">My Family</span>
              <span className="block text-xs text-slate-500">
                {members.length} {members.length === 1 ? 'person' : 'people'} you can book for
              </span>
            </span>
            <ChevronRight size={18} className={`shrink-0 text-slate-300 ${panel === 'family' ? 'rotate-90' : ''}`} />
          </button>
          {panel === 'family' && (
            <div className="border-t border-slate-100 bg-slate-50/60 p-4">
              {showForm ? (
                <FamilyMemberForm
                  accountId={session.user.id}
                  onAdded={() => {
                    setShowForm(false);
                    loadMembers();
                  }}
                  onCancel={() => setShowForm(false)}
                />
              ) : (
                <>
                  <div className="grid grid-cols-3 gap-3">
                    {loadingMembers && <p className="col-span-3 text-sm text-slate-400">Loading...</p>}
                    {!loadingMembers && members.length === 0 && (
                      <p className="col-span-3 text-sm text-slate-400">No family members yet.</p>
                    )}
                    {members.map((m, i) => (
                      <div key={m.id} className="flex flex-col items-center text-center">
                        <span
                          className={`flex h-14 w-14 items-center justify-center rounded-2xl text-lg font-extrabold ${
                            AVATAR_TONES[i % AVATAR_TONES.length] === 'brand'
                              ? 'bg-brand-100 text-brand-700'
                              : AVATAR_TONES[i % AVATAR_TONES.length] === 'emerald'
                                ? 'bg-emerald-100 text-emerald-700'
                                : AVATAR_TONES[i % AVATAR_TONES.length] === 'amber'
                                  ? 'bg-amber-100 text-amber-700'
                                  : 'bg-pink-100 text-pink-700'
                          }`}
                        >
                          {m.name.charAt(0).toUpperCase()}
                        </span>
                        <p className="mt-1.5 max-w-full truncate text-xs font-bold text-slate-900">{m.name}</p>
                        <p className="text-[11px] text-slate-500">
                          {(m.relation && RELATION_LABEL[m.relation]) ?? '—'}
                        </p>
                        <button
                          onClick={() => setViewingMrn(m.mrn)}
                          className="mt-0.5 font-mono text-[10px] text-brand-600 underline"
                        >
                          {m.mrn}
                        </button>
                        <button
                          onClick={() => setConditionsFor((prev) => (prev === m.id ? null : m.id))}
                          className="mt-0.5 text-[10px] font-semibold text-slate-500 underline"
                        >
                          {conditionsFor === m.id ? 'Hide health info' : 'Health info'}
                        </button>
                      </div>
                    ))}
                    <button
                      onClick={() => setShowForm(true)}
                      className="flex flex-col items-center gap-1.5 text-center text-brand-600"
                    >
                      <span className="flex h-14 w-14 items-center justify-center rounded-2xl border-2 border-dashed border-brand-200 bg-white">
                        <Plus size={22} />
                      </span>
                      <span className="text-xs font-bold">Add</span>
                    </button>
                  </div>

                  {conditionsFor && (
                    <div className="mt-4">
                      <KnownConditionsForm patientId={conditionsFor} onSaved={loadMembers} />
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          <button
            onClick={() => {
              togglePanel('medical');
              if (selfMember) setConditionsFor(selfMember.id);
            }}
            className="flex w-full items-center gap-3 border-t border-slate-100 px-4 py-3.5 text-left hover:bg-slate-50"
          >
            <IconTile icon={HeartPulse} tone="pink" />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-bold text-slate-900">Medical Information</span>
              <span className="block text-xs text-slate-500">Known conditions, blood group and more</span>
            </span>
            <ChevronRight size={18} className={`shrink-0 text-slate-300 ${panel === 'medical' ? 'rotate-90' : ''}`} />
          </button>
          {panel === 'medical' && (
            <div className="border-t border-slate-100 bg-slate-50/60 p-4">
              {selfMember ? (
                <KnownConditionsForm patientId={selfMember.id} onSaved={loadMembers} />
              ) : (
                <p className="text-sm text-slate-500">Add yourself under "My Family" first.</p>
              )}
            </div>
          )}
        </Card>

        {/* Account & Preferences */}
        <SectionTitle className="mt-6">Account & Preferences</SectionTitle>
        <Card className="mt-2 !p-0">
          <button
            onClick={() => navigate('/notifications')}
            className="flex w-full items-center gap-3 px-4 py-3.5 text-left hover:bg-slate-50"
          >
            <IconTile icon={Bell} tone="amber" />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-bold text-slate-900">Notifications</span>
              <span className="block text-xs text-slate-500">Your booking and queue updates</span>
            </span>
            {hasUnread && <span className="h-2 w-2 rounded-full bg-coral-500" />}
            <ChevronRight size={18} className="shrink-0 text-slate-300" />
          </button>

          <button
            onClick={() => togglePanel('privacy')}
            className="flex w-full items-center gap-3 border-t border-slate-100 px-4 py-3.5 text-left hover:bg-slate-50"
          >
            <IconTile icon={ShieldCheck} tone="sky" />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-bold text-slate-900">Privacy & Security</span>
              <span className="block text-xs text-slate-500">Who can see your health data</span>
            </span>
            <ChevronRight size={18} className={`shrink-0 text-slate-300 ${panel === 'privacy' ? 'rotate-90' : ''}`} />
          </button>
          {panel === 'privacy' && (
            <div className="border-t border-slate-100 bg-slate-50/60 p-4 text-xs leading-relaxed text-slate-600">
              Your health records are visible only to you, the clinics you have actually visited, and Sanjeevni
              admins. Clinics can read your known conditions but cannot edit them. Every change to your health
              information is logged.
            </div>
          )}

          <button
            onClick={() => togglePanel('about')}
            className="flex w-full items-center gap-3 border-t border-slate-100 px-4 py-3.5 text-left hover:bg-slate-50"
          >
            <IconTile icon={Info} tone="slate" />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-bold text-slate-900">About the App</span>
              <span className="block text-xs text-slate-500">SanjeevniOS</span>
            </span>
            <ChevronRight size={18} className={`shrink-0 text-slate-300 ${panel === 'about' ? 'rotate-90' : ''}`} />
          </button>
          {panel === 'about' && (
            <div className="border-t border-slate-100 bg-slate-50/60 p-4 text-xs leading-relaxed text-slate-600">
              SanjeevniOS connects you to clinics near you: book appointments, hold your place in the live queue,
              and keep every prescription, lab report and visit summary in one place under a single medical record
              number.
            </div>
          )}
        </Card>

        <button
          onClick={signOut}
          className="mt-5 flex w-full items-center justify-center gap-2 rounded-2xl border border-red-200 bg-red-50 py-3.5 text-sm font-bold text-red-600"
        >
          <LogOut size={17} /> Log Out
        </button>
      </div>
    </div>
  );
}
