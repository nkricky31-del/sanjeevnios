import { Printer, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { supabase } from '../../lib/supabaseClient';
import type { PrescriptionDrug } from '../../lib/types';
import { useRxLanguage } from '../../lib/useRxLanguage';
import PrescriptionItems, { RxLanguageToggle } from './PrescriptionItems';

export interface SheetPrescription {
  id: string;
  items: PrescriptionDrug[];
  advice_en?: string | null;
  advice_hi?: string | null;
  signed_by: string | null;
  created_at: string;
}

interface Props {
  prescription: SheetPrescription;
  patientName?: string | null;
  diagnosis?: string | null;
  followUpDate?: string | null;
  // Shown if the signing doctor's details can't be loaded.
  fallbackDoctorName?: string | null;
  fallbackClinicName?: string | null;
  onClose: () => void;
}

interface SignerRow {
  name: string;
  reg_no: string | null;
  specialty: string | null;
  clinics: { name: string; formatted_address: string | null; address: string | null } | null;
}

// A printable prescription (Print / Save as PDF from the browser's print
// dialog), in English, Hindi or both. Rendered into <body> so the print rule
// in index.css can hide everything else while it's open.
export default function PrescriptionSheet({
  prescription,
  patientName,
  diagnosis,
  followUpDate,
  fallbackDoctorName,
  fallbackClinicName,
  onClose,
}: Props) {
  const [language, setLanguage] = useRxLanguage();
  const [signer, setSigner] = useState<SignerRow | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // Once, on open: hide the app for printing, move focus in, Esc closes; on
  // close, undo all three and hand focus back.
  useEffect(() => {
    document.documentElement.classList.add('rx-printing');
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.documentElement.classList.remove('rx-printing');
      window.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
  }, []);

  useEffect(() => {
    if (!prescription.signed_by) return;
    supabase
      .from('doctors')
      .select('name, reg_no, specialty, clinics(name, formatted_address, address)')
      .eq('id', prescription.signed_by)
      .maybeSingle()
      .then(({ data }) => setSigner((data as unknown as SignerRow | null) ?? null));
  }, [prescription.signed_by]);

  const doctorName = signer?.name ?? fallbackDoctorName ?? null;
  const clinicName = signer?.clinics?.name ?? fallbackClinicName ?? null;
  const clinicAddress = signer?.clinics?.formatted_address ?? signer?.clinics?.address ?? null;
  const date = new Date(prescription.created_at).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });

  return createPortal(
    <div
      data-rx-sheet
      role="dialog"
      aria-modal="true"
      aria-label="Prescription"
      className="fixed inset-0 z-[100] overflow-y-auto bg-slate-900/40 p-0 sm:p-6"
    >
      <div className="mx-auto max-w-2xl bg-white sm:rounded-2xl sm:shadow-2xl">
        <div className="rx-no-print sticky top-0 z-10 flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 bg-white px-4 py-3 sm:rounded-t-2xl">
          <RxLanguageToggle value={language} onChange={setLanguage} />
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => window.print()}
              className="inline-flex items-center gap-1.5 rounded-xl bg-brand-600 px-3.5 py-2 text-sm font-semibold text-white outline-none hover:bg-brand-700 focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
            >
              <Printer size={16} /> Print
            </button>
            <button
              ref={closeRef}
              type="button"
              onClick={onClose}
              aria-label="Close prescription"
              title="Close"
              className="rounded-xl p-2 text-slate-500 outline-none hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        <div className="px-5 py-6 sm:px-8">
          <div className="flex items-start justify-between gap-4 border-b-2 border-slate-900 pb-3">
            <div className="min-w-0">
              <p className="text-lg font-extrabold text-slate-900">{clinicName ?? 'Clinic'}</p>
              {clinicAddress && <p className="text-xs text-slate-500">{clinicAddress}</p>}
            </div>
            <div className="shrink-0 text-right">
              <p className="text-sm font-bold text-slate-900">{doctorName ?? 'Doctor'}</p>
              {signer?.specialty && <p className="text-xs text-slate-500">{signer.specialty}</p>}
              {signer?.reg_no && <p className="text-xs text-slate-500">Reg. no. {signer.reg_no}</p>}
            </div>
          </div>

          <div className="mt-3 flex flex-wrap justify-between gap-2 text-sm">
            <p>
              <span className="text-slate-500">Patient:</span>{' '}
              <span className="font-semibold text-slate-900">{patientName ?? '—'}</span>
            </p>
            <p>
              <span className="text-slate-500">Date:</span> <span className="font-semibold text-slate-900">{date}</span>
            </p>
          </div>
          {diagnosis && (
            <p className="mt-1 text-sm">
              <span className="text-slate-500">Diagnosis:</span> <span className="text-slate-900">{diagnosis}</span>
            </p>
          )}

          <p className="mt-5 text-2xl font-extrabold text-slate-900" aria-hidden>
            ℞
          </p>
          <div className="mt-2">
            {prescription.items.length > 0 ? (
              <PrescriptionItems
                items={prescription.items}
                adviceEn={prescription.advice_en}
                adviceHi={prescription.advice_hi}
                language={language}
                variant="print"
              />
            ) : (
              <p className="text-sm text-slate-500">No medicines.</p>
            )}
          </div>

          {followUpDate && (
            <p className="mt-5 text-sm">
              <span className="font-semibold text-slate-900">
                Follow-up{language !== 'en' ? ' / ' : ''}
                {language !== 'en' && <span lang="hi">दोबारा दिखाएँ</span>}:
              </span>{' '}
              {new Date(followUpDate + 'T00:00:00').toLocaleDateString(undefined, {
                day: 'numeric',
                month: 'short',
                year: 'numeric',
              })}
            </p>
          )}

          <div className="mt-10 flex justify-end">
            <div className="text-right">
              <p className="text-sm font-semibold text-slate-900">{doctorName ?? 'Doctor'}</p>
              <p className="text-xs text-slate-500">Digitally signed on SanjeevniOS</p>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
