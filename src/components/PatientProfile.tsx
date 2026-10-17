import { ChevronDown, ExternalLink, Info } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { getStoredActingMode } from '../lib/actingMode';
import { ageFromDob } from '../lib/date';
import { supabase } from '../lib/supabaseClient';
import type { FamilyMember, HasKnownConditions } from '../lib/types';
import EncounterFullDetail from './EncounterFullDetail';
import StatusPill from './ui/StatusPill';

interface Props {
  mrn: string;
}

interface ConditionRow {
  condition_id: string;
  conditions_ref: { name: string } | null;
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
  hasKnownConditions: HasKnownConditions;
  knownConditionsOther: string | null;
}

const CONDITIONS_ANSWER_LABEL: Record<HasKnownConditions, string> = {
  yes: 'Yes',
  no: 'No known conditions',
  not_answered: 'Not answered',
};

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
  // A "yes" or explicit "no" from any visible row should win over another
  // row that simply never got asked - only fall back to 'not_answered' if
  // every visible row is still unanswered.
  const hasKnownConditions = sorted.find((r) => r.has_known_conditions !== 'not_answered')?.has_known_conditions ?? 'not_answered';

  return {
    name: (pick('name') as string) ?? 'Unknown',
    gender: pick('gender') as string | null,
    dob: pick('dob') as string | null,
    phone: pick('phone') as string | null,
    email: pick('email') as string | null,
    blood_group: pick('blood_group') as string | null,
    city: pick('city') as string | null,
    registered_on: sorted[0].created_at,
    hasKnownConditions,
    knownConditionsOther: pick('known_conditions_other') as string | null,
  };
}

export default function PatientProfile({ mrn }: Props) {
  const [rows, setRows] = useState<FamilyMember[]>([]);
  const [encounters, setEncounters] = useState<EncounterRow[]>([]);
  const [conditions, setConditions] = useState<ConditionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);
  // Encounters whose audited open has finished - clinic staff only see a
  // visit's clinical data after open_encounter_health_record (migration 68),
  // same as EncounterDetail.tsx; for a patient or admin it's a no-op.
  const [auditedIds, setAuditedIds] = useState<Set<string>>(new Set());

  const toggleEncounter = (id: string) => {
    if (openId === id) {
      setOpenId(null);
      return;
    }
    setOpenId(id);
    if (!auditedIds.has(id)) {
      supabase
        .rpc('open_encounter_health_record', { p_encounter_id: id })
        .then(() => setAuditedIds((prev) => new Set(prev).add(id)));
    }
  };

  useEffect(() => {
    setLoading(true);
    supabase
      .from('family_members')
      .select('*')
      .eq('mrn', mrn)
      .then(async ({ data: memberData }) => {
        const memberRows = (memberData ?? []) as FamilyMember[];
        setRows(memberRows);
        const memberIds = memberRows.map((r) => r.id);

        const [encounterRes, conditionsRes] = await Promise.all([
          supabase
            .from('encounters')
            .select(
              'id, encounter_no, visit_datetime, department, visit_type, reason, status, doctors(name, specialty), clinics(name)'
            )
            .eq('mrn', mrn)
            .order('visit_datetime', { ascending: false }),
          memberIds.length > 0
            ? supabase.from('patient_conditions').select('condition_id, conditions_ref(name)').in('patient_id', memberIds)
            : Promise.resolve({ data: [] as ConditionRow[] }),
        ]);

        setEncounters((encounterRes.data ?? []) as unknown as EncounterRow[]);
        setConditions((conditionsRes.data ?? []) as unknown as ConditionRow[]);
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
  const conditionNames = [...new Map(conditions.map((c) => [c.condition_id, c.conditions_ref?.name])).values()].filter(
    (n): n is string => !!n
  );

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

        {profile && (
          <div className="mt-3 border-t border-slate-100 pt-3 text-sm">
            <p>
              <span className="text-slate-400">Known conditions:</span>{' '}
              {CONDITIONS_ANSWER_LABEL[profile.hasKnownConditions]}
            </p>
            {profile.hasKnownConditions === 'yes' && (
              <>
                {conditionNames.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {conditionNames.map((n) => (
                      <span key={n} className="rounded-full bg-coral-50 px-2.5 py-1 text-xs font-semibold text-coral-700">
                        {n}
                      </span>
                    ))}
                  </div>
                )}
                {profile.knownConditionsOther && (
                  <p className="mt-1 text-xs text-slate-500">Other: {profile.knownConditionsOther}</p>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* Was `viewerProfile.role === 'clinic'` - switched to the session's
          acting mode (schema.sql migration 58) since role no longer implies
          "currently viewing as clinic staff": a dual-role account (a patient
          who's also clinic staff) keeps role 'patient' forever now, and this
          banner should only show while they're actually acting as clinic. */}
      {getStoredActingMode() === 'clinic' && (
        <div className="mt-3 flex items-start gap-2 rounded-xl bg-amber-50 p-3 text-xs font-medium text-amber-800">
          <Info size={15} className="mt-0.5 shrink-0" />
          You are viewing only the encounters of this patient at your clinic. Encounters from other clinics are not
          visible.
        </div>
      )}

      <p className="mt-3 text-xs text-slate-400">
        Tap any visit below to see its full details.
      </p>

      <div className="mt-4 flex items-center justify-between">
        <h3 className="text-base font-bold text-slate-900">Encounters / Visits</h3>
        <p className="text-xs text-slate-400">
          {encounters.length === 0 ? 'No visits.' : `${encounters.length} ${encounters.length === 1 ? 'visit' : 'visits'}`}
        </p>
      </div>

      <div className="mt-2 space-y-2">
        {encounters.length === 0 && (
          <p className="rounded-2xl border border-slate-200 px-3 py-6 text-center text-sm text-slate-400">
            No encounters visible for this patient.
          </p>
        )}
        {encounters.map((e) => {
          const isOpen = openId === e.id;
          return (
            <div key={e.id} className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
              <button
                type="button"
                onClick={() => toggleEncounter(e.id)}
                aria-expanded={isOpen}
                aria-controls={`encounter-${e.id}`}
                className="flex w-full items-start gap-3 p-3 text-left hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500"
              >
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs font-bold text-brand-700">{e.encounter_no}</span>
                    <StatusPill label={e.status} tone="info" />
                  </span>
                  <span className="mt-1 block truncate text-sm font-bold text-slate-900">
                    {e.doctors?.name ?? '—'}
                    {e.department && <span className="font-normal text-slate-400"> · {e.department}</span>}
                  </span>
                  <span className="block truncate text-xs text-slate-500">
                    {new Date(e.visit_datetime).toLocaleString()}
                    {e.clinics?.name ? ` · ${e.clinics.name}` : ''} · {e.visit_type}
                  </span>
                </span>
                <ChevronDown
                  size={18}
                  className={`mt-1 shrink-0 text-slate-400 transition-transform ${isOpen ? 'rotate-180' : ''}`}
                />
              </button>
              {isOpen && (
                <div id={`encounter-${e.id}`} className="border-t border-slate-100 p-3">
                  {auditedIds.has(e.id) ? (
                    <>
                      <EncounterFullDetail encounter={e} />
                      <Link
                        to={`/encounters/${e.id}`}
                        className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-brand-600 hover:underline"
                      >
                        Open full page <ExternalLink size={12} />
                      </Link>
                    </>
                  ) : (
                    <p className="text-sm text-slate-400">Loading visit details...</p>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
