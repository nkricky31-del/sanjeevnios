import { saveFile } from './native';
import { itemTextLines } from './rx';
import type { AppointmentFile, Prescription, PrescriptionDrug, Visit } from './types';

interface ExportEncounter {
  encounter_no: string;
  mrn: string;
  visit_datetime: string;
  department: string | null;
  visit_type: string;
  reason: string | null;
  status: string;
  doctorName?: string | null;
  clinicName?: string | null;
  patientName?: string | null;
}

// Plain-text export, generated entirely client-side from data already on
// the page (no server round-trip, no new dependency for PDF generation -
// out of proportion for this feature). Good enough for "here's a copy of
// this record I can keep/hand over", the actual ask behind "Export /
// Download".
export function downloadEncounterSummary(
  encounter: ExportEncounter,
  visit: Visit | null,
  prescription: Prescription | null,
  files: AppointmentFile[]
) {
  const lines: string[] = [];
  lines.push('SanjeevniOS - Encounter Record');
  lines.push('='.repeat(40));
  lines.push(`Encounter No.: ${encounter.encounter_no}`);
  lines.push(`MRN: ${encounter.mrn}`);
  if (encounter.patientName) lines.push(`Patient: ${encounter.patientName}`);
  lines.push(`Clinic: ${encounter.clinicName ?? '-'}`);
  lines.push(`Doctor: ${encounter.doctorName ?? '-'}`);
  lines.push(`Department: ${encounter.department ?? '-'}`);
  lines.push(`Visit date/time: ${new Date(encounter.visit_datetime).toLocaleString()}`);
  lines.push(`Visit type: ${encounter.visit_type}`);
  lines.push(`Status: ${encounter.status}`);
  lines.push(`Reason for visit: ${encounter.reason ?? '-'}`);
  lines.push('');
  lines.push('Clinical notes');
  lines.push('-'.repeat(40));
  lines.push(`Diagnosis: ${visit?.diagnosis ?? '-'}`);
  lines.push(`Notes: ${visit?.notes ?? '-'}`);
  lines.push(`Follow-up: ${visit?.follow_up_date ?? '-'}`);
  lines.push('');
  lines.push('Prescription');
  lines.push('-'.repeat(40));
  if (prescription && prescription.items.length > 0) {
    prescription.items.forEach((item, i) => lines.push(...itemTextLines(item, i)));
    lines.push(...adviceLines(prescription));
  } else {
    lines.push('No prescription recorded.');
  }
  lines.push('');
  lines.push('Files');
  lines.push('-'.repeat(40));
  if (files.length > 0) {
    for (const f of files) lines.push(`- ${f.type ?? 'file'} (${f.storage_path})`);
  } else {
    lines.push('No files attached.');
  }

  return saveFile(lines.join('\n'), `encounter-${encounter.encounter_no}.txt`, 'text/plain;charset=utf-8');
}

function adviceLines(p: { advice_en?: string | null; advice_hi?: string | null }): string[] {
  const out: string[] = [];
  if (p.advice_en?.trim()) out.push('', `Advice: ${p.advice_en.trim()}`);
  if (p.advice_hi?.trim()) out.push(`सलाह: ${p.advice_hi.trim()}`);
  return out;
}

// One prescription as a plain-text copy the patient can keep or hand over -
// each medicine in English, then Hindi (src/lib/rx.ts).
export function downloadPrescriptionText(
  p: {
    id: string;
    items: PrescriptionDrug[];
    advice_en?: string | null;
    advice_hi?: string | null;
    signed_by: string | null;
    status: string;
    created_at: string;
  },
  meta: { doctor?: string | null; clinic?: string | null; patient?: string | null }
) {
  const lines = [
    'SanjeevniOS - Prescription',
    '='.repeat(40),
    `Date: ${new Date(p.created_at).toLocaleDateString()}`,
    `Doctor: ${meta.doctor ?? '-'}`,
    `Clinic: ${meta.clinic ?? '-'}`,
    ...(meta.patient ? [`Patient: ${meta.patient}`] : []),
    ...(p.signed_by && meta.doctor ? [`Signed by: ${meta.doctor}`] : []),
    '',
    'Medicines / दवाइयाँ',
    '-'.repeat(40),
    ...(p.items.length ? p.items.flatMap((item, i) => itemTextLines(item, i)) : ['None recorded.']),
    ...adviceLines(p),
  ];
  return saveFile(lines.join('\n'), `prescription-${p.id.slice(0, 8)}.txt`, 'text/plain;charset=utf-8');
}
