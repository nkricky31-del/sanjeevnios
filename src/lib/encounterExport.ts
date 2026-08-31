import type { AppointmentFile, Prescription, Visit } from './types';

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
    for (const item of prescription.items) {
      lines.push(`- ${item.name} - ${item.dosage} - ${item.frequency} - ${item.durationDays}d`);
    }
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

  const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `encounter-${encounter.encounter_no}.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
