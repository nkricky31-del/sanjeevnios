import { formLabel, instructionLine, medicineTitle, noteFor, type RxLanguage } from '../../lib/rx';
import type { PrescriptionDrug } from '../../lib/types';

const LANG_OPTIONS: { value: RxLanguage; label: string }[] = [
  { value: 'en', label: 'English' },
  { value: 'hi', label: 'हिंदी' },
  { value: 'both', label: 'Both' },
];

export function RxLanguageToggle({ value, onChange }: { value: RxLanguage; onChange: (l: RxLanguage) => void }) {
  return (
    <div role="group" aria-label="Prescription language" className="inline-flex rounded-full bg-slate-100 p-0.5">
      {LANG_OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={`rounded-full px-3 py-1 text-xs font-semibold outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
            value === o.value ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

interface Props {
  items: PrescriptionDrug[];
  adviceEn?: string | null;
  adviceHi?: string | null;
  language: RxLanguage;
  // Print layout: no card chrome, slightly larger type.
  variant?: 'card' | 'print';
}

// The medicine list in English, Hindi or both. A Hindi line only exists for
// prescriptions written with the structured form; older free-text ones stay
// English, as written.
export default function PrescriptionItems({ items, adviceEn, adviceHi, language, variant = 'card' }: Props) {
  const showEn = language !== 'hi';
  const showHi = language !== 'en';
  const print = variant === 'print';
  const advEn = (adviceEn ?? '').trim();
  const advHi = (adviceHi ?? '').trim();

  return (
    <div>
      <ol className={print ? 'space-y-3' : 'space-y-2'}>
        {items.map((item, i) => {
          const en = instructionLine(item, 'en');
          const hi = instructionLine(item, 'hi');
          // A Hindi-only view of an old prescription still needs its English text.
          const enShown = showEn || !hi;
          return (
            <li
              key={i}
              className={print ? 'border-b border-slate-200 pb-3 last:border-b-0' : 'rounded-xl bg-white px-3 py-2.5 ring-1 ring-slate-100'}
            >
              <p className={`font-semibold text-slate-900 ${print ? 'text-base' : 'text-sm'}`}>
                <span className="text-slate-400">{i + 1}.</span> {medicineTitle(item)}
                {formLabel(item, showEn ? 'en' : 'hi') && (
                  <span className="ml-1.5 text-xs font-medium text-slate-500">
                    ({formLabel(item, showEn ? 'en' : 'hi')}
                    {showEn && showHi && formLabel(item, 'hi') ? ` / ${formLabel(item, 'hi')}` : ''})
                  </span>
                )}
              </p>
              {enShown && en && <p className={`mt-0.5 text-slate-700 ${print ? 'text-sm' : 'text-xs'}`}>{en}</p>}
              {showHi && hi && (
                <p lang="hi" className={`mt-0.5 text-slate-700 ${print ? 'text-sm' : 'text-xs'}`}>
                  {hi}
                </p>
              )}
              {showEn && noteFor(item, 'en') && (
                <p className="mt-0.5 text-xs italic text-slate-500">{noteFor(item, 'en')}</p>
              )}
              {showHi && noteFor(item, 'hi') && (
                <p lang="hi" className="mt-0.5 text-xs italic text-slate-500">
                  {noteFor(item, 'hi')}
                </p>
              )}
            </li>
          );
        })}
      </ol>

      {((showEn && advEn) || (showHi && advHi) || (!showEn && advEn && !advHi)) && (
        <div className={print ? 'mt-5' : 'mt-3 rounded-xl bg-amber-50/70 px-3 py-2.5'}>
          <p className="text-xs font-bold uppercase tracking-wide text-slate-500">
            {showEn ? 'Advice' : ''}
            {showEn && showHi ? ' / ' : ''}
            {showHi ? <span lang="hi">सलाह</span> : ''}
          </p>
          {(showEn || !advHi) && advEn && <p className="mt-1 whitespace-pre-line text-sm text-slate-700">{advEn}</p>}
          {showHi && advHi && (
            <p lang="hi" className="mt-1 whitespace-pre-line text-sm text-slate-700">
              {advHi}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
