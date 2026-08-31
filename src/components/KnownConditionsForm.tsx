import { useEffect, useState } from 'react';

import { supabase } from '../lib/supabaseClient';
import type { ConditionRef, HasKnownConditions } from '../lib/types';

interface Props {
  patientId: string; // family_members.id
  onSaved?: () => void;
}

const ANSWER_OPTIONS: { value: HasKnownConditions; label: string }[] = [
  { value: 'not_answered', label: 'Not answered' },
  { value: 'no', label: 'No known conditions' },
  { value: 'yes', label: 'Yes, has known condition(s)' },
];

// Patient-editable (or admin) - see patient_conditions RLS in schema.sql
// section 24, which deliberately does NOT let a clinic write this, only
// read it (surfaced read-only in PatientProfile.tsx instead). Every save
// here is logged server-side by the audit triggers in that same section -
// nothing extra needed on the client for that part.
export default function KnownConditionsForm({ patientId, onSaved }: Props) {
  const [allConditions, setAllConditions] = useState<ConditionRef[]>([]);
  const [answer, setAnswer] = useState<HasKnownConditions>('not_answered');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [otherText, setOtherText] = useState('');
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = async () => {
    setLoading(true);
    const [{ data: conditions }, { data: member }, { data: chosen }] = await Promise.all([
      supabase.from('conditions_ref').select('*').eq('is_active', true).order('name', { ascending: true }),
      supabase
        .from('family_members')
        .select('has_known_conditions, known_conditions_other, conditions_updated_at')
        .eq('id', patientId)
        .single(),
      supabase.from('patient_conditions').select('condition_id').eq('patient_id', patientId),
    ]);
    setAllConditions((conditions ?? []) as ConditionRef[]);
    setAnswer((member?.has_known_conditions as HasKnownConditions) ?? 'not_answered');
    setOtherText(member?.known_conditions_other ?? '');
    setUpdatedAt(member?.conditions_updated_at ?? null);
    setSelected(new Set(((chosen ?? []) as { condition_id: string }[]).map((c) => c.condition_id)));
    setLoading(false);
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patientId]);

  const toggle = (conditionId: string) => {
    setSaved(false);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(conditionId)) next.delete(conditionId);
      else next.add(conditionId);
      return next;
    });
  };

  const submit = async () => {
    setError(null);
    setSaving(true);

    const { error: memberError } = await supabase
      .from('family_members')
      .update({
        has_known_conditions: answer,
        known_conditions_other: otherText.trim() || null,
      })
      .eq('id', patientId);
    if (memberError) {
      setSaving(false);
      setError(memberError.message);
      return;
    }

    const { data: existing } = await supabase
      .from('patient_conditions')
      .select('condition_id')
      .eq('patient_id', patientId);
    const existingIds = new Set(((existing ?? []) as { condition_id: string }[]).map((c) => c.condition_id));

    const toAdd = [...selected].filter((id) => !existingIds.has(id));
    const toRemove = [...existingIds].filter((id) => !selected.has(id));

    if (toAdd.length > 0) {
      const { error: insertError } = await supabase
        .from('patient_conditions')
        .insert(toAdd.map((condition_id) => ({ patient_id: patientId, condition_id })));
      if (insertError) {
        setSaving(false);
        setError(insertError.message);
        return;
      }
    }
    if (toRemove.length > 0) {
      const { error: deleteError } = await supabase
        .from('patient_conditions')
        .delete()
        .eq('patient_id', patientId)
        .in('condition_id', toRemove);
      if (deleteError) {
        setSaving(false);
        setError(deleteError.message);
        return;
      }
    }

    setSaving(false);
    setSaved(true);
    await load();
    onSaved?.();
  };

  if (loading) return <p className="text-sm text-slate-400">Loading...</p>;

  return (
    <div className="rounded-2xl border border-slate-200 p-4">
      <p className="text-sm font-bold text-slate-900">Known conditions</p>
      <p className="mt-0.5 text-xs text-slate-400">
        Only you, the clinics you visit, and Sanjeevni admins can see this.
        {updatedAt && ` Last updated ${new Date(updatedAt).toLocaleString()}.`}
      </p>

      <div className="mt-3 flex flex-wrap gap-2">
        {ANSWER_OPTIONS.map((o) => (
          <button
            key={o.value}
            type="button"
            onClick={() => {
              setAnswer(o.value);
              setSaved(false);
            }}
            className={`rounded-full px-3 py-1.5 text-xs font-bold ${
              answer === o.value ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-600'
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>

      {answer === 'yes' && (
        <>
          <div className="mt-3 grid grid-cols-2 gap-2">
            {allConditions.map((c) => (
              <label key={c.id} className="flex items-center gap-2 text-sm text-slate-700">
                <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggle(c.id)} />
                {c.name}
              </label>
            ))}
          </div>

          <div className="mt-3">
            <label className="text-xs font-semibold text-slate-700">Other (not in the list above)</label>
            <textarea
              value={otherText}
              onChange={(e) => {
                setOtherText(e.target.value);
                setSaved(false);
              }}
              rows={2}
              placeholder="Any other known condition"
              className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>
        </>
      )}

      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      {saved && !error && <p className="mt-2 text-xs font-medium text-emerald-600">Saved.</p>}

      <button
        onClick={submit}
        disabled={saving}
        className="mt-3 rounded-xl bg-brand-600 px-4 py-2 text-sm font-bold text-white disabled:opacity-50"
      >
        {saving ? 'Saving...' : 'Save'}
      </button>
    </div>
  );
}
