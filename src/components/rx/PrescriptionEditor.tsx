import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';

import {
  FOOD_TIMINGS,
  instructionLine,
  MEDICINE_FORMS,
  medicineTitle,
  TIMES_OF_DAY,
  TIMING_PRESETS,
  withLegacyFields,
} from '../../lib/rx';
import type { FoodTiming, MedicineForm, PrescriptionDrug, TimeOfDay } from '../../lib/types';
import Button from '../ui/Button';

interface Props {
  signing: boolean;
  error: string | null;
  onSign: (items: PrescriptionDrug[], adviceEn: string, adviceHi: string) => void;
}

const INPUT = 'w-full rounded-2xl border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-500';

const EMPTY = {
  name: '',
  strength: '',
  form: 'tablet' as MedicineForm,
  dose: '1',
  times: [] as TimeOfDay[],
  asNeeded: false,
  food: 'after_food' as FoodTiming,
  days: '5',
  noteEn: '',
  noteHi: '',
};

// The doctor's e-prescription form. Each medicine is built from choices
// (form, dose, times of day, food, days) so the patient gets the same
// instructions in English and Hindi (src/lib/rx.ts); notes and general advice
// are typed by the doctor in each language.
export default function PrescriptionEditor({ signing, error, onSign }: Props) {
  const [items, setItems] = useState<PrescriptionDrug[]>([]);
  const [draft, setDraft] = useState(EMPTY);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [adviceEn, setAdviceEn] = useState('');
  const [adviceHi, setAdviceHi] = useState('');

  const set = <K extends keyof typeof EMPTY>(key: K, value: (typeof EMPTY)[K]) => {
    setDraftError(null);
    setDraft((d) => ({ ...d, [key]: value }));
  };

  const toggleTime = (t: TimeOfDay) =>
    set('times', draft.times.includes(t) ? draft.times.filter((x) => x !== t) : [...draft.times, t]);

  const draftItem = (): PrescriptionDrug =>
    withLegacyFields({
      name: draft.name.trim(),
      strength: draft.strength.trim() || undefined,
      form: draft.form,
      dose: draft.form === 'ointment' ? undefined : draft.dose.trim() || undefined,
      times: draft.times,
      asNeeded: draft.asNeeded || undefined,
      food: draft.food,
      durationDays: Number(draft.days) || 0,
      noteEn: draft.noteEn.trim() || undefined,
      noteHi: draft.noteHi.trim() || undefined,
      dosage: '',
      frequency: '',
    });

  const addItem = () => {
    if (!draft.name.trim()) {
      setDraftError('Enter the medicine name.');
      return;
    }
    if (draft.times.length === 0 && !draft.asNeeded) {
      setDraftError('Choose when to take it, or tick "Only when needed".');
      return;
    }
    const days = Number(draft.days);
    if (!draft.asNeeded && (!Number.isInteger(days) || days < 1 || days > 365)) {
      setDraftError('Enter the number of days (1 to 365).');
      return;
    }
    if (draft.asNeeded && draft.days && (!Number.isInteger(days) || days < 0 || days > 365)) {
      setDraftError('Days must be a whole number up to 365.');
      return;
    }
    setItems((prev) => [...prev, draftItem()]);
    setDraft(EMPTY);
  };

  const editItem = (index: number) => {
    const it = items[index];
    setItems((prev) => prev.filter((_, i) => i !== index));
    setDraft({
      name: it.name,
      strength: it.strength ?? '',
      form: it.form ?? 'tablet',
      dose: it.dose ?? '1',
      times: it.times ?? [],
      asNeeded: !!it.asNeeded,
      food: it.food ?? 'after_food',
      days: it.durationDays ? String(it.durationDays) : '',
      noteEn: it.noteEn ?? '',
      noteHi: it.noteHi ?? '',
    });
  };

  const preview = draft.name.trim() || draft.times.length || draft.asNeeded ? draftItem() : null;

  return (
    <div className="mt-3 space-y-4">
      {items.length > 0 && (
        <ol className="space-y-2">
          {items.map((it, i) => (
            <li key={i} className="flex items-start gap-2 rounded-xl bg-slate-50 px-3 py-2.5">
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-slate-900">
                  {i + 1}. {medicineTitle(it)}
                </span>
                <span className="block text-xs text-slate-600">{instructionLine(it, 'en')}</span>
                <span lang="hi" className="block text-xs text-slate-600">
                  {instructionLine(it, 'hi')}
                </span>
              </span>
              <button
                type="button"
                onClick={() => editItem(i)}
                aria-label={`Edit ${it.name}`}
                title="Edit"
                className="rounded-lg p-1.5 text-slate-500 hover:bg-white hover:text-slate-800"
              >
                <Pencil size={15} />
              </button>
              <button
                type="button"
                onClick={() => setItems((prev) => prev.filter((_, n) => n !== i))}
                aria-label={`Remove ${it.name}`}
                title="Remove"
                className="rounded-lg p-1.5 text-red-500 hover:bg-white hover:text-red-700"
              >
                <Trash2 size={15} />
              </button>
            </li>
          ))}
        </ol>
      )}

      <div className="space-y-3 rounded-2xl border border-slate-200 p-3">
        <p className="text-xs font-bold uppercase tracking-wide text-slate-400">
          {items.length > 0 ? 'Add another medicine' : 'Add a medicine'}
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="rx-name" className="text-xs font-medium text-slate-600">
              Medicine name
            </label>
            <input id="rx-name" value={draft.name} onChange={(e) => set('name', e.target.value)} className={`mt-1 ${INPUT}`} />
          </div>
          <div>
            <label htmlFor="rx-strength" className="text-xs font-medium text-slate-600">
              Strength (optional)
            </label>
            <input
              id="rx-strength"
              value={draft.strength}
              onChange={(e) => set('strength', e.target.value)}
              placeholder="e.g. 500 mg"
              className={`mt-1 ${INPUT}`}
            />
          </div>
          <div>
            <label htmlFor="rx-form" className="text-xs font-medium text-slate-600">
              Form
            </label>
            <select
              id="rx-form"
              value={draft.form}
              onChange={(e) => set('form', e.target.value as MedicineForm)}
              className={`mt-1 bg-white ${INPUT}`}
            >
              {MEDICINE_FORMS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.en} / {f.hi}
                </option>
              ))}
            </select>
          </div>
          {draft.form !== 'ointment' && (
            <div>
              <label htmlFor="rx-dose" className="text-xs font-medium text-slate-600">
                Dose each time
              </label>
              <input
                id="rx-dose"
                value={draft.dose}
                onChange={(e) => set('dose', e.target.value)}
                placeholder={draft.form === 'syrup' ? 'e.g. 5 (ml)' : 'e.g. 1 or 1/2'}
                className={`mt-1 ${INPUT}`}
              />
            </div>
          )}
        </div>

        <fieldset>
          <legend className="text-xs font-medium text-slate-600">When to take it</legend>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {TIMES_OF_DAY.map((t) => (
              <button
                key={t.value}
                type="button"
                aria-pressed={draft.times.includes(t.value)}
                onClick={() => toggleTime(t.value)}
                className={`rounded-xl border px-3 py-1.5 text-xs font-semibold ${
                  draft.times.includes(t.value)
                    ? 'border-brand-600 bg-brand-600 text-white'
                    : 'border-slate-200 bg-white text-slate-600'
                }`}
              >
                {t.en} · <span lang="hi">{t.hi}</span>
              </button>
            ))}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-slate-400">Quick:</span>
            {TIMING_PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => set('times', p.times)}
                className="rounded-lg bg-slate-100 px-2 py-1 font-mono text-[11px] font-semibold text-slate-600 hover:bg-slate-200"
              >
                {p.label}
              </button>
            ))}
          </div>
          <label className="mt-2 flex items-center gap-2 text-xs text-slate-700">
            <input type="checkbox" checked={draft.asNeeded} onChange={(e) => set('asNeeded', e.target.checked)} />
            Only when needed (SOS) · <span lang="hi">ज़रूरत पड़ने पर</span>
          </label>
        </fieldset>

        <fieldset>
          <legend className="text-xs font-medium text-slate-600">Food</legend>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {FOOD_TIMINGS.map((f) => (
              <button
                key={f.value}
                type="button"
                aria-pressed={draft.food === f.value}
                onClick={() => set('food', f.value)}
                className={`rounded-xl border px-3 py-1.5 text-xs font-semibold ${
                  draft.food === f.value
                    ? 'border-brand-600 bg-brand-600 text-white'
                    : 'border-slate-200 bg-white text-slate-600'
                }`}
              >
                {f.en} · <span lang="hi">{f.hi}</span>
              </button>
            ))}
          </div>
        </fieldset>

        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label htmlFor="rx-days" className="text-xs font-medium text-slate-600">
              For how many days
            </label>
            <input
              id="rx-days"
              type="number"
              inputMode="numeric"
              min={draft.asNeeded ? 0 : 1}
              max={365}
              value={draft.days}
              onChange={(e) => set('days', e.target.value)}
              className={`mt-1 ${INPUT}`}
            />
          </div>
          <div>
            <label htmlFor="rx-note-en" className="text-xs font-medium text-slate-600">
              Extra note (English)
            </label>
            <input
              id="rx-note-en"
              value={draft.noteEn}
              onChange={(e) => set('noteEn', e.target.value)}
              placeholder="e.g. With warm water"
              className={`mt-1 ${INPUT}`}
            />
          </div>
          <div>
            <label htmlFor="rx-note-hi" className="text-xs font-medium text-slate-600">
              Extra note (हिंदी)
            </label>
            <input
              id="rx-note-hi"
              lang="hi"
              value={draft.noteHi}
              onChange={(e) => set('noteHi', e.target.value)}
              placeholder="जैसे: गुनगुने पानी के साथ"
              className={`mt-1 ${INPUT}`}
            />
          </div>
        </div>

        {preview && (
          <div className="rounded-xl bg-brand-50 px-3 py-2 text-xs text-slate-700">
            <p className="font-semibold text-slate-900">{medicineTitle(preview) || 'Medicine'}</p>
            <p>{instructionLine(preview, 'en') || '—'}</p>
            <p lang="hi">{instructionLine(preview, 'hi') || '—'}</p>
          </div>
        )}

        {draftError && <p className="text-sm text-red-600">{draftError}</p>}
        <Button variant="secondary" onClick={addItem}>
          <Plus size={16} /> Add medicine
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="rx-advice-en" className="text-xs font-medium text-slate-600">
            Advice (English, optional)
          </label>
          <textarea
            id="rx-advice-en"
            value={adviceEn}
            onChange={(e) => setAdviceEn(e.target.value)}
            rows={3}
            maxLength={2000}
            placeholder="e.g. Drink plenty of water. Avoid oily food."
            className={`mt-1 ${INPUT}`}
          />
        </div>
        <div>
          <label htmlFor="rx-advice-hi" className="text-xs font-medium text-slate-600">
            सलाह (हिंदी, optional)
          </label>
          <textarea
            id="rx-advice-hi"
            lang="hi"
            value={adviceHi}
            onChange={(e) => setAdviceHi(e.target.value)}
            rows={3}
            maxLength={2000}
            placeholder="जैसे: खूब पानी पिएं। तला हुआ खाना न खाएं।"
            className={`mt-1 ${INPUT}`}
          />
        </div>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
      <Button
        onClick={() => {
          if (items.length === 0) {
            setDraftError(draft.name.trim() ? 'Tap "Add medicine" first, then sign.' : 'Add at least one medicine before signing.');
            return;
          }
          onSign(items, adviceEn.trim(), adviceHi.trim());
        }}
        disabled={signing}
      >
        {signing ? 'Signing...' : 'Sign & attach prescription'}
      </Button>
    </div>
  );
}
