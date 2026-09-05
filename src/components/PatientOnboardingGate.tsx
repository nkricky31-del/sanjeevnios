import { ShieldAlert } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';

import { useAuth } from '../lib/AuthContext';
import { isMinorDob } from '../lib/date';
import { livePhoneDigits, normalizePhone } from '../lib/phone';
import { EMERGENCY_NOTE, PATIENT_DECLARATION_TEXT } from '../lib/platformDisclaimer';
import { supabase } from '../lib/supabaseClient';
import type { ConditionRef, FamilyMember, Gender, HasKnownConditions } from '../lib/types';
import { usePatientDeclarationStatus } from '../lib/usePatientConsent';
import Button from './ui/Button';
import Card from './ui/Card';

interface Props {
  children: ReactNode;
}

const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
const ANSWER_OPTIONS: { value: HasKnownConditions; label: string }[] = [
  { value: 'no', label: 'No known conditions' },
  { value: 'yes', label: 'Yes, has known condition(s)' },
];

// Wraps the whole patient app (see App.tsx) OUTSIDE PatientDeclarationGate -
// a brand-new patient (profiles.onboarding_complete = false) sees this
// BEFORE anything else, including the existing declaration/DPDP gate. This
// form's own submit records the platform declaration acceptance itself
// (reusing usePatientDeclarationStatus() - the exact same hook/table
// PatientDeclarationGate reads), so a new patient never sees that checkbox
// twice - by the time they reach PatientDeclarationGate afterward, only the
// separate DPDP consent (untouched by this form, per spec) is left, if
// anything.
//
// A returning patient (onboarding_complete already true - backfilled for
// everyone who already had a family member at migration time) skips this
// entirely, on every render, with zero extra queries: profile is already
// loaded by AuthContext for every other gate in this app.
export default function PatientOnboardingGate({ children }: Props) {
  const { session, profile, refreshProfile } = useAuth();
  const declaration = usePatientDeclarationStatus();

  const [loadingMember, setLoadingMember] = useState(true);
  const [existingMember, setExistingMember] = useState<FamilyMember | null>(null);
  const [existingConditionIds, setExistingConditionIds] = useState<Set<string>>(new Set());

  const [fullName, setFullName] = useState('');
  const [dob, setDob] = useState('');
  const [gender, setGender] = useState<Gender | ''>('');
  const [address, setAddress] = useState('');
  const [city, setCity] = useState('');
  const [pincode, setPincode] = useState('');
  const [emergencyName, setEmergencyName] = useState('');
  const [emergencyPhoneDigits, setEmergencyPhoneDigits] = useState('');
  const [email, setEmail] = useState('');
  const [bloodGroup, setBloodGroup] = useState('');
  const [guardianConsent, setGuardianConsent] = useState(false);

  const [allConditions, setAllConditions] = useState<ConditionRef[]>([]);
  const [conditionsAnswer, setConditionsAnswer] = useState<HasKnownConditions>('not_answered');
  const [selectedConditions, setSelectedConditions] = useState<Set<string>>(new Set());
  const [conditionsOtherText, setConditionsOtherText] = useState('');

  const [declarationChecked, setDeclarationChecked] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Prefill from an existing 'self' member if one already exists - a phone
  // number that was already registered as a walk-in before this account's
  // very first login already has one (claim_walk_in_records(), called on
  // every patient login in AuthContext.tsx) - this enriches that record
  // rather than creating a duplicate "self" row.
  useEffect(() => {
    if (!session || profile?.onboarding_complete) {
      setLoadingMember(false);
      return;
    }
    (async () => {
      const [{ data: member }, { data: conditions }] = await Promise.all([
        supabase
          .from('family_members')
          .select('*')
          .eq('account_id', session.user.id)
          .eq('relation', 'self')
          .maybeSingle(),
        supabase.from('conditions_ref').select('*').eq('is_active', true).order('name', { ascending: true }),
      ]);
      setAllConditions((conditions ?? []) as ConditionRef[]);
      if (member) {
        const m = member as FamilyMember;
        setExistingMember(m);
        setFullName(m.name ?? '');
        setDob(m.dob ?? '');
        setGender((m.gender as Gender) ?? '');
        setAddress(m.address ?? '');
        setCity(m.city ?? '');
        setPincode(m.pincode ?? '');
        setEmergencyName(m.emergency_contact_name ?? '');
        setEmergencyPhoneDigits(m.emergency_contact_phone ? m.emergency_contact_phone.replace(/^91/, '') : '');
        setEmail(m.email ?? '');
        setBloodGroup(m.blood_group ?? '');
        setGuardianConsent(m.guardian_consent);
        setConditionsAnswer(m.has_known_conditions ?? 'not_answered');
        setConditionsOtherText(m.known_conditions_other ?? '');
        const { data: chosen } = await supabase.from('patient_conditions').select('condition_id').eq('patient_id', m.id);
        const ids = new Set(((chosen ?? []) as { condition_id: string }[]).map((c) => c.condition_id));
        setExistingConditionIds(ids);
        setSelectedConditions(new Set(ids));
      }
      setLoadingMember(false);
    })();
  }, [session, profile?.onboarding_complete]);

  if (!session || !profile) return null;
  if (profile.onboarding_complete) return <>{children}</>;
  if (loadingMember || declaration.status === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
        <p className="text-slate-400">Loading...</p>
      </div>
    );
  }

  const minor = dob ? isMinorDob(dob) : false;

  const toggleCondition = (id: string) => {
    setSelectedConditions((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const submit = async () => {
    setError(null);
    if (!fullName.trim()) return setError('Enter your full name.');
    if (!dob) return setError('Enter your date of birth.');
    if (new Date(dob) > new Date()) return setError('Date of birth cannot be in the future.');
    if (!gender) return setError('Select your sex.');
    if (!address.trim()) return setError('Enter your address.');
    if (!city.trim()) return setError('Enter your city.');
    if (!/^\d{6}$/.test(pincode.trim())) return setError('Enter a valid 6-digit pincode.');
    if (!emergencyName.trim()) return setError('Enter an emergency contact name.');
    if (emergencyPhoneDigits.length !== 10) return setError('Enter a valid 10-digit emergency contact phone number.');
    if (minor && !guardianConsent) return setError("Guardian consent is required since you're under 18.");
    if (declaration.status === 'needed' && !declarationChecked) {
      return setError('Please accept the platform declaration to continue.');
    }

    setSaving(true);

    const memberPatch = {
      account_id: session.user.id,
      name: fullName.trim(),
      relation: 'self' as const,
      dob,
      gender,
      address: address.trim(),
      city: city.trim(),
      pincode: pincode.trim(),
      emergency_contact_name: emergencyName.trim(),
      emergency_contact_phone: normalizePhone(emergencyPhoneDigits),
      email: email.trim() || null,
      blood_group: bloodGroup || null,
      guardian_consent: minor ? guardianConsent : false,
      has_known_conditions: conditionsAnswer,
      known_conditions_other: conditionsOtherText.trim() || null,
    };

    const { data: member, error: memberError } = existingMember
      ? await supabase.from('family_members').update(memberPatch).eq('id', existingMember.id).select().single()
      : await supabase.from('family_members').insert(memberPatch).select().single();
    if (memberError || !member) {
      setSaving(false);
      setError(memberError?.message ?? 'Could not save your profile.');
      return;
    }

    // Diff against whatever this member already had (only ever non-empty for
    // the walk-in-claim prefill case above) rather than blindly re-inserting
    // everything, which would duplicate rows that already exist.
    const toAdd = [...selectedConditions].filter((id) => !existingConditionIds.has(id));
    const toRemove = [...existingConditionIds].filter((id) => !selectedConditions.has(id));
    if (toAdd.length > 0) {
      const { error: addError } = await supabase
        .from('patient_conditions')
        .insert(toAdd.map((condition_id) => ({ patient_id: member.id, condition_id })));
      if (addError) {
        setSaving(false);
        setError(addError.message);
        return;
      }
    }
    if (toRemove.length > 0) {
      const { error: removeError } = await supabase
        .from('patient_conditions')
        .delete()
        .eq('patient_id', member.id)
        .in('condition_id', toRemove);
      if (removeError) {
        setSaving(false);
        setError(removeError.message);
        return;
      }
    }

    if (declaration.status === 'needed') {
      const declarationError = await declaration.accept();
      if (declarationError) {
        setSaving(false);
        setError(declarationError);
        return;
      }
    }

    const { error: profileError } = await supabase
      .from('profiles')
      .update({ name: fullName.trim(), onboarding_complete: true })
      .eq('id', session.user.id);
    if (profileError) {
      setSaving(false);
      setError(profileError.message);
      return;
    }

    setSaving(false);
    // App.tsx re-renders past this gate the moment profile.onboarding_complete
    // flips to true - no local "done" state needed here at all.
    await refreshProfile();
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-b from-brand-50 via-slate-50 to-coral-50 px-4 py-8">
      <Card className="w-full max-w-sm !rounded-3xl !p-6">
        <p className="text-lg font-bold text-slate-900">Welcome — let's set up your profile</p>
        <p className="mt-1 text-sm text-slate-500">This takes a minute and only runs once.</p>

        <p className="mt-4 text-xs font-bold uppercase tracking-wide text-slate-400">Personal details</p>
        <div className="mt-2 space-y-3">
          <div>
            <label className="text-sm font-medium text-slate-700">Full name</label>
            <input
              type="text"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              className="mt-1 w-full rounded-2xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>

          <div className="flex gap-3">
            <div className="flex-1">
              <label className="text-sm font-medium text-slate-700">Date of birth</label>
              <input
                type="date"
                value={dob}
                onChange={(e) => setDob(e.target.value)}
                max={new Date().toISOString().slice(0, 10)}
                className="mt-1 w-full rounded-2xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>
            <div className="flex-1">
              <label className="text-sm font-medium text-slate-700">Sex</label>
              <select
                value={gender}
                onChange={(e) => setGender(e.target.value as Gender)}
                className="mt-1 w-full rounded-2xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-brand-500"
              >
                <option value="">Select</option>
                <option value="male">Male</option>
                <option value="female">Female</option>
                <option value="other">Other</option>
              </select>
            </div>
          </div>

          {minor && (
            <label className="flex items-start gap-2 text-xs text-slate-700">
              <input
                type="checkbox"
                checked={guardianConsent}
                onChange={(e) => setGuardianConsent(e.target.checked)}
                className="mt-0.5"
              />
              I am this person's parent/guardian and consent to this account being used on their behalf.
            </label>
          )}

          <div>
            <label className="text-sm font-medium text-slate-700">Address</label>
            <input
              type="text"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              className="mt-1 w-full rounded-2xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>

          <div className="flex gap-3">
            <div className="flex-1">
              <label className="text-sm font-medium text-slate-700">City</label>
              <input
                type="text"
                value={city}
                onChange={(e) => setCity(e.target.value)}
                className="mt-1 w-full rounded-2xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>
            <div className="w-28">
              <label className="text-sm font-medium text-slate-700">Pincode</label>
              <input
                type="text"
                inputMode="numeric"
                maxLength={6}
                value={pincode}
                onChange={(e) => setPincode(e.target.value.replace(/\D/g, ''))}
                className="mt-1 w-full rounded-2xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>
          </div>

          <div>
            <label className="text-sm font-medium text-slate-700">Emergency contact name</label>
            <input
              type="text"
              value={emergencyName}
              onChange={(e) => setEmergencyName(e.target.value)}
              className="mt-1 w-full rounded-2xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>
          <div>
            <label className="text-sm font-medium text-slate-700">Emergency contact phone</label>
            <div className="mt-1 flex items-center rounded-2xl border border-slate-200 focus-within:ring-2 focus-within:ring-brand-500">
              <span className="pl-3 text-sm text-slate-500">+91</span>
              <input
                type="tel"
                inputMode="numeric"
                maxLength={10}
                value={emergencyPhoneDigits}
                onChange={(e) => setEmergencyPhoneDigits(livePhoneDigits(e.target.value))}
                placeholder="9876543210"
                className="w-full rounded-lg px-2 py-2 text-sm outline-none"
              />
            </div>
          </div>

          <div className="flex gap-3">
            <div className="flex-1">
              <label className="text-sm font-medium text-slate-700">Email (optional)</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@example.com"
                className="mt-1 w-full rounded-2xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>
            <div className="flex-1">
              <label className="text-sm font-medium text-slate-700">Blood group (optional)</label>
              <select
                value={bloodGroup}
                onChange={(e) => setBloodGroup(e.target.value)}
                className="mt-1 w-full rounded-2xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-brand-500"
              >
                <option value="">—</option>
                {BLOOD_GROUPS.map((g) => (
                  <option key={g} value={g}>
                    {g}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <p className="text-xs text-slate-400">You can add a profile photo later from your Profile screen.</p>
        </div>

        <p className="mt-5 text-xs font-bold uppercase tracking-wide text-slate-400">Known conditions</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {ANSWER_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => setConditionsAnswer(o.value)}
              className={`rounded-full px-3 py-1.5 text-xs font-bold ${
                conditionsAnswer === o.value ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-600'
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
        {conditionsAnswer === 'yes' && (
          <>
            <div className="mt-3 grid grid-cols-2 gap-2">
              {allConditions.map((c) => (
                <label key={c.id} className="flex items-center gap-2 text-sm text-slate-700">
                  <input type="checkbox" checked={selectedConditions.has(c.id)} onChange={() => toggleCondition(c.id)} />
                  {c.name}
                </label>
              ))}
            </div>
            <div className="mt-3">
              <label className="text-xs font-semibold text-slate-700">Other (not in the list above)</label>
              <textarea
                value={conditionsOtherText}
                onChange={(e) => setConditionsOtherText(e.target.value)}
                rows={2}
                placeholder="Any other known condition"
                className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>
          </>
        )}

        {declaration.status === 'needed' && (
          <div className="mt-5">
            <p className="text-xs font-bold uppercase tracking-wide text-slate-400">Platform declaration</p>
            <div className="mt-1 max-h-32 overflow-y-auto rounded-xl bg-slate-50 p-3 text-sm leading-relaxed text-slate-600">
              {PATIENT_DECLARATION_TEXT}
            </div>
            <label className="mt-2 flex items-start gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={declarationChecked}
                onChange={(e) => setDeclarationChecked(e.target.checked)}
                className="mt-0.5"
              />
              I have read and understood this.
            </label>
          </div>
        )}

        <div className="mt-3 flex items-start gap-2 rounded-xl bg-amber-50 p-3 text-xs font-medium text-amber-800">
          <ShieldAlert size={15} className="mt-0.5 shrink-0" />
          {EMERGENCY_NOTE}
        </div>

        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

        <Button onClick={submit} disabled={saving} full className="mt-4">
          {saving ? 'Saving...' : 'Save and continue'}
        </Button>
      </Card>
    </div>
  );
}
