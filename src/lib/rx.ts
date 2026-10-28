// Prescription wording in English and Hindi.
//
// The doctor picks the medicine's form, dose, times of day, food timing and
// number of days; both languages are generated from those choices, so the
// patient gets the same instructions in either. Free-text notes are written
// by the doctor in each language. Older prescriptions (free-text dosage /
// frequency only) are shown as they were written, English only.

import type { FoodTiming, MedicineForm, PrescriptionDrug, TimeOfDay } from './types';

export type RxLanguage = 'en' | 'hi' | 'both';

export const MEDICINE_FORMS: { value: MedicineForm; en: string; hi: string }[] = [
  { value: 'tablet', en: 'Tablet', hi: 'गोली' },
  { value: 'capsule', en: 'Capsule', hi: 'कैप्सूल' },
  { value: 'syrup', en: 'Syrup', hi: 'सिरप' },
  { value: 'drops', en: 'Drops', hi: 'ड्रॉप्स' },
  { value: 'injection', en: 'Injection', hi: 'इंजेक्शन' },
  { value: 'ointment', en: 'Ointment / cream', hi: 'मलहम / क्रीम' },
  { value: 'inhaler', en: 'Inhaler', hi: 'इनहेलर' },
  { value: 'sachet', en: 'Sachet / powder', hi: 'पाउच / पाउडर' },
  { value: 'other', en: 'Other', hi: 'अन्य' },
];

export const TIMES_OF_DAY: { value: TimeOfDay; en: string; hi: string }[] = [
  { value: 'morning', en: 'Morning', hi: 'सुबह' },
  { value: 'afternoon', en: 'Afternoon', hi: 'दोपहर' },
  { value: 'evening', en: 'Evening', hi: 'शाम' },
  { value: 'night', en: 'Night', hi: 'रात' },
];

export const FOOD_TIMINGS: { value: FoodTiming; en: string; hi: string }[] = [
  { value: 'after_food', en: 'After food', hi: 'खाने के बाद' },
  { value: 'before_food', en: 'Before food', hi: 'खाने से पहले' },
  { value: 'with_food', en: 'With food', hi: 'खाने के साथ' },
  { value: 'empty_stomach', en: 'Empty stomach', hi: 'खाली पेट' },
  { value: 'any', en: 'Any time', hi: 'किसी भी समय' },
];

// Quick picks for the usual Indian dose patterns (morning-afternoon-night).
export const TIMING_PRESETS: { label: string; times: TimeOfDay[] }[] = [
  { label: '1-0-0', times: ['morning'] },
  { label: '0-0-1', times: ['night'] },
  { label: '1-0-1', times: ['morning', 'night'] },
  { label: '1-1-1', times: ['morning', 'afternoon', 'night'] },
];

const UNIT: Record<MedicineForm, { en: [string, string]; hi: string } | null> = {
  tablet: { en: ['tablet', 'tablets'], hi: 'गोली' },
  capsule: { en: ['capsule', 'capsules'], hi: 'कैप्सूल' },
  syrup: { en: ['ml', 'ml'], hi: 'मि.ली.' },
  drops: { en: ['drop', 'drops'], hi: 'बूँद' },
  injection: { en: ['injection', 'injections'], hi: 'इंजेक्शन' },
  ointment: null,
  inhaler: { en: ['puff', 'puffs'], hi: 'पफ' },
  sachet: { en: ['sachet', 'sachets'], hi: 'पाउच' },
  other: null,
};

const TIMES_PER_DAY_EN = ['', 'once a day', 'twice a day', '3 times a day', '4 times a day'];
const TIMES_PER_DAY_HI = ['', 'दिन में एक बार', 'दिन में दो बार', 'दिन में तीन बार', 'दिन में चार बार'];

// "0.5" / "1/2" -> "½"; anything else as typed.
function prettyQty(dose: string): string {
  const d = dose.trim();
  if (d === '0.5' || d === '1/2') return '½';
  if (d === '1.5' || d === '1 1/2') return '1½';
  if (d === '0.25' || d === '1/4') return '¼';
  return d;
}

const isPlainQty = (d: string) => /^[\d.½¼/\s]+$/.test(d.trim());

function doseText(item: PrescriptionDrug, lang: 'en' | 'hi'): string {
  const form = item.form ?? 'other';
  if (form === 'ointment') return lang === 'en' ? 'Apply a thin layer' : 'पतली परत लगाएँ';
  const dose = (item.dose ?? '').trim();
  if (!dose) return '';
  if (!isPlainQty(dose)) return dose; // e.g. "5 ml", written by the doctor
  const unit = UNIT[form];
  const qty = prettyQty(dose);
  if (!unit) return qty;
  if (lang === 'hi') return `${qty} ${unit.hi}`;
  const n = Number(dose);
  return `${qty} ${Number.isFinite(n) && n > 1 ? unit.en[1] : unit.en[0]}`;
}

function joinList(parts: string[], lang: 'en' | 'hi'): string {
  if (parts.length <= 1) return parts.join('');
  const and = lang === 'en' ? ' and ' : ' और ';
  return `${parts.slice(0, -1).join(', ')}${and}${parts[parts.length - 1]}`;
}

function timesText(item: PrescriptionDrug, lang: 'en' | 'hi'): string {
  const times = TIMES_OF_DAY.filter((t) => item.times?.includes(t.value));
  const named = times.map((t) => (lang === 'en' ? t.en : t.hi));
  const parts: string[] = [];
  if (named.length > 0) {
    const label = lang === 'en' ? joinList(named, 'en') : joinList(named, 'hi');
    const perDay = (lang === 'en' ? TIMES_PER_DAY_EN : TIMES_PER_DAY_HI)[named.length] ?? '';
    parts.push(perDay ? `${label} (${perDay})` : label);
  }
  if (item.asNeeded) parts.push(lang === 'en' ? 'only when needed' : 'ज़रूरत पड़ने पर ही');
  const s = parts.join(lang === 'en' ? ', ' : ', ');
  return lang === 'en' && s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function foodText(item: PrescriptionDrug, lang: 'en' | 'hi'): string {
  if (!item.food || item.food === 'any') return '';
  const f = FOOD_TIMINGS.find((x) => x.value === item.food);
  return f ? (lang === 'en' ? f.en : f.hi) : '';
}

function durationText(item: PrescriptionDrug, lang: 'en' | 'hi'): string {
  const d = item.durationDays;
  if (!d || d <= 0) return '';
  if (lang === 'en') return `${d} day${d === 1 ? '' : 's'}`;
  return `${d} दिन`;
}

// Whether this item was written with the structured form (vs the old free text).
export function isStructured(item: PrescriptionDrug): boolean {
  return !!(item.form || item.dose || (item.times && item.times.length) || item.asNeeded || item.food);
}

// One line of instructions, e.g.
//   en: "1 tablet · Morning and Night (twice a day) · After food · 5 days"
//   hi: "1 गोली · सुबह और रात (दिन में दो बार) · खाने के बाद · 5 दिन"
export function instructionLine(item: PrescriptionDrug, lang: 'en' | 'hi'): string {
  if (!isStructured(item)) {
    if (lang === 'hi') return '';
    return [item.dosage, item.frequency, item.durationDays ? `${item.durationDays} day${item.durationDays === 1 ? '' : 's'}` : '']
      .filter((x) => x && String(x).trim())
      .join(' · ');
  }
  return [doseText(item, lang), timesText(item, lang), foodText(item, lang), durationText(item, lang)]
    .filter(Boolean)
    .join(' · ');
}

export function noteFor(item: PrescriptionDrug, lang: 'en' | 'hi'): string {
  return ((lang === 'en' ? item.noteEn : item.noteHi) ?? '').trim();
}

export function formLabel(item: PrescriptionDrug, lang: 'en' | 'hi'): string {
  const f = MEDICINE_FORMS.find((x) => x.value === item.form);
  if (!f || f.value === 'other') return '';
  return lang === 'en' ? f.en : f.hi;
}

// "Paracetamol 500 mg"
export function medicineTitle(item: PrescriptionDrug): string {
  return [item.name, item.strength].filter((x) => x && x.trim()).join(' ');
}

// Fills the legacy dosage/frequency fields from the structured choices, so
// anything still reading those (older exports, older app versions) shows
// sensible English.
export function withLegacyFields(item: PrescriptionDrug): PrescriptionDrug {
  return {
    ...item,
    dosage: doseText(item, 'en'),
    frequency: [timesText(item, 'en'), foodText(item, 'en')].filter(Boolean).join(', '),
  };
}

// Plain-text lines for downloads: English, then Hindi under it when present.
export function itemTextLines(item: PrescriptionDrug, index: number): string[] {
  const lines = [`${index + 1}. ${medicineTitle(item)}${formLabel(item, 'en') ? ` (${formLabel(item, 'en')})` : ''}`];
  const en = instructionLine(item, 'en');
  const hi = instructionLine(item, 'hi');
  if (en) lines.push(`   ${en}`);
  if (hi) lines.push(`   ${hi}`);
  if (noteFor(item, 'en')) lines.push(`   Note: ${noteFor(item, 'en')}`);
  if (noteFor(item, 'hi')) lines.push(`   नोट: ${noteFor(item, 'hi')}`);
  return lines;
}

// The viewer's preferred language for prescriptions - a per-device
// convenience only, so storage failures just fall back to both.
const LANG_KEY = 'sanjeevni.rxLanguage';
export function loadRxLanguage(): RxLanguage {
  try {
    const v = localStorage.getItem(LANG_KEY);
    return v === 'en' || v === 'hi' || v === 'both' ? v : 'both';
  } catch {
    return 'both';
  }
}
export function saveRxLanguage(lang: RxLanguage): void {
  try {
    localStorage.setItem(LANG_KEY, lang);
  } catch {
    // ignore - private mode etc.
  }
}
