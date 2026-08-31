import { Eye, Info } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { useAuth } from '../lib/AuthContext';
import { ageFromDob } from '../lib/date';
import { supabase } from '../lib/supabaseClient';
import type { FamilyMember } from '../lib/types';
import StatusPill from './ui/StatusPill';

interface Props {
  mrn: string;
}

interface EncounterRow {
  id: string;
  encounter_no: string;
  visit_datetime: string;
  department: string | null;
  visit_type: string;
  reason: string | null;
  status: string;
  doctors: { name: string; specialty: string | null } | null;
  clinics: { name: string } | null;
}

interface MergedProfile {
  name: string;
  gender: string | null;
  dob: string | null;
  phone: string | null;
  email: string | null;
  blood_group: string | null;
  city: string | null;
  registered_on: string;
}

const AVATAR_COLORS = ['bg-brand-500', 'bg-coral-500', 'bg-emerald-500', 'bg-amber-500'];

// Same mrn can legitimately be shared by several family_members rows (the
// same human registered at different clinics - see schema.sql section 18),
// and RLS may only let this viewer see SOME of those rows. Merge whatever
// is visible into one profile: earliest row's value wins for each field,
// falling back to a later row's value if the earliest left it blank.
function mergeProfile(rows: FamilyMember[]): MergedProfile | null {
  if (rows.length === 0) return null;
  const sorted = [...rows].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const pick = <K extends keyof FamilyMember>(key: K): FamilyMember[K] | null => {
    for (const r of sorted) {
      if (r[key] !== null && r[key] !== undefined && r[key] !== '') return r[key];
    }
    return null;
  };
  return {
    name: (pick('name') as string) ?? 'Unknown',
    gender: pick('gender') as string | null,
    dob: pick('dob') as string | null,
    phone: pick('phone') as string | null,
    email: pick('email') as string | null,
    blood_group: pick('blood_group') as string | null,
    city: pick('city') as string | null,
    registered_on: sorted[0].created_at,
  };
}

export default function PatientProfile({ mrn }: Props) {
  const { profile: viewerProfile } = useAuth();
  const [rows, setRows] = useState<FamilyMember[]>([]);
  const [encounters, setEncounters] = useState<EncounterRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      supabase.from('family_members').select('*').eq('mrn', mrn),
      supabase
        .from('encounters')
        .select('id, encounter_no, visit_datetime, department, visit_type, reason, status, doctors(name, specialty), clinics(name)')
        .eq('mrn', mrn)
        .order('visit_datetime', { ascending: false }),
    ]).then(([memberRes, encounterRes]) => {
      setRows((memberRes.data ?? []) as FamilyMember[]);
      setEncounters((encounterRes.data ?? []) as unknown as EncounterRow[]);
      setLoading(false);
    });
  }, [mrn]);

  if (loading) return <p className="text-sm text-slate-400">Loading patient...</p>;

  const profile = mergeProfile(rows);

  if (!profile && encounters.length === 0) {
    return (
      <p className="text-sm text-slate-400">
        No patient found for {mrn}, or you don't have access to view them.
      </p>
    );
  }

  const initial = (profile?.name ?? '?').charAt(0).toUpperCase();
  const avatarColor = AVATAR_COLORS[mrn.charCodeAt(mrn.length - 1) % AVATAR_COLORS.length];

  return (
    <div>
      <div className="rounded-3xl border border-slate-200 bg-white p-5">
        <div className="flex flex-wrap items-start gap-4">
          <div
            className={`flex h-16 w-16 shrink-0 items-center justify-center rounded-3xl text-2xl font-bold text-white ${avatarColor}`}
          >
            {initial}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-lg font-bold text-slate-900">{profile?.name ?? 'Unknown'}</p>
              <span className="rounded-full bg-brand-50 px-2.5 py-1 font-mono text-xs font-bold text-brand-700">
                {mrn}
              </span>
            </div>
            <p className="mt-0.5 text-sm text-slate-500">
              {profile?.gender ?? '—'}
              {profile?.dob && ` · ${ageFromDob(profile.dob)}y`}
            </p>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 border-t border-slate-100 pt-4 text-sm">
          <p>
            <span className="text-slate-400">Phone:</span> {profile?.phone ? `+${profile.phone}` : '—'}
          </p>
          <p>
            <span className="text-slate-400">Email:</span> {profile?.email ?? '—'}
          </p>
          <p>
            <span className="text-slate-400">Date of birth:</span> {profile?.dob ?? '—'}
          </p>
          <p>
            <span className="text-slate-400">Blood group:</span> {profile?.blood_group ?? '—'}
          </p>
          <p>
            <span className="text-slate-400">City:</span> {profile?.city ?? '—'}
          </p>
          <p>
            <span className="text-slate-400">Registered on:</span>{' '}
            {profile ? new Date(profile.registered_on).toLocaleDateString() : '—'}
          </p>
        </div>
      </div>

      {viewerProfile?.role === 'clinic' && (
        <div className="mt-3 flex items-start gap-2 rounded-xl bg-amber-50 p-3 text-xs font-medium text-amber-800">
          <Info size={15} className="mt-0.5 shrink-0" />
          You are viewing only the encounters of this patient at your clinic. Encounters from other clinics are not
          visible.
        </div>
      )}

      <p className="mt-3 text-xs text-slate-400">
        How it works: open a patient by MRN, see their encounters below, click the eye icon on any row to view its
        full details.
      </p>

      <div className="mt-4 flex items-center justify-between">
        <h3 className="text-base font-bold text-slate-900">Encounters / Visits</h3>
        <p className="text-xs text-slate-400">
          {encounters.length === 0
            ? 'No visits.'
            : `Showing 1 to ${encounters.length} of ${encounters.length} visits`}
        </p>
      </div>

      <div className="mt-2 overflow-x-auto rounded-2xl border border-slate-200">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead className="bg-slate-50 text-xs font-bold uppercase tracking-wide text-slate-400">
            <tr>
              <th className="px-3 py-2">Encounter No.</th>
              <th className="px-3 py-2">Visit Date &amp; Time</th>
              <th className="px-3 py-2">Doctor / Department</th>
              <th className="px-3 py-2">Clinic</th>
              <th className="px-3 py-2">Visit Type</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {encounters.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-slate-400">
                  No encounters visible for this patient.
                </td>
              </tr>
            )}
            {encounters.map((e) => (
              <tr key={e.id} className="hover:bg-slate-50">
                <td className="px-3 py-2 font-mono text-xs font-bold text-brand-700">{e.encounter_no}</td>
                <td className="px-3 py-2 text-slate-600">{new Date(e.visit_datetime).toLocaleString()}</td>
                <td className="px-3 py-2 text-slate-600">
                  {e.doctors?.name ?? '—'}
                  {e.department && <span className="text-slate-400"> · {e.department}</span>}
                </td>
                <td className="px-3 py-2 text-slate-600">{e.clinics?.name ?? '—'}</td>
                <td className="px-3 py-2 text-slate-600">{e.visit_type}</td>
                <td className="px-3 py-2">
                  <StatusPill label={e.status} tone="info" />
                </td>
                <td className="px-3 py-2">
                  <Link
                    to={`/encounters/${e.id}`}
                    className="inline-flex rounded-lg p-1.5 text-slate-500 hover:bg-brand-50 hover:text-brand-600"
                    aria-label={`View encounter ${e.encounter_no}`}
                  >
                    <Eye size={16} />
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
