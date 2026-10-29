import { CalendarClock, CreditCard, FileText, MapPin, Stethoscope, Timer, type LucideIcon } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';

import { bookingReference } from '../lib/queue';
import { openAppointmentFile } from '../lib/storage';
import { screenCache } from '../lib/screenCache';
import { supabase } from '../lib/supabaseClient';
import { formatTimeLabel } from '../lib/time';
import { PAYMENT_STATUS_LABEL, type AppointmentFile, type AppointmentPaymentStatus, type AppointmentStatus, type Prescription, type Visit } from '../lib/types';
import BillCard from './bills/BillCard';
import VisitDetails from './VisitDetails';
import Loading from './ui/Loading';
import StatusPill from './ui/StatusPill';

export interface EncounterSummary {
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

export interface LinkedAppointment {
  id: string;
  date: string;
  slot_time: string;
  status: AppointmentStatus;
  created_at: string;
  token_number: number | null;
  checked_in_at: string | null;
  reject_reason: string | null;
  payment_status: AppointmentPaymentStatus;
  paid_amount: number | null;
  doctors: { name: string; specialty: string | null; reg_no: string | null } | null;
  clinics: { name: string; address: string | null; formatted_address: string | null; contact_phone: string | null } | null;
  payments: {
    amount: number;
    net_amount: number | null;
    discount_amount: number | null;
    coupon_code: string | null;
    method: string;
  }[];
  visits: (Visit & { prescriptions: Prescription[] })[];
  files: AppointmentFile[];
}

const FILE_LABEL: Record<string, string> = {
  lab_report: 'Lab report',
  prescription: 'Prescription',
  xray: 'X-ray',
  photo: 'Photo',
};

const STATUS: Record<AppointmentStatus, { label: string; tone: 'live' | 'warning' | 'info' | 'neutral' | 'danger' }> = {
  booked: { label: 'Booked', tone: 'warning' },
  accepted: { label: 'Confirmed', tone: 'info' },
  checked_in: { label: 'Checked in', tone: 'info' },
  called: { label: 'Called in', tone: 'info' },
  in_consultation: { label: 'With the doctor', tone: 'live' },
  completed: { label: 'Completed', tone: 'live' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  rejected: { label: 'Declined', tone: 'danger' },
  no_show: { label: 'Missed', tone: 'danger' },
};

const day = (iso: string) =>
  new Date(iso.length === 10 ? `${iso}T00:00:00` : iso).toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
// The app's own 12-hour style ("6:30 PM"), whatever the device's clock setting.
const clock = (ts: string) => formatTimeLabel(new Date(ts).toTimeString().slice(0, 5));
const rupees = (n: number) => `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5">
      <dt className="shrink-0 text-xs text-slate-400">{label}</dt>
      <dd className="min-w-0 text-right text-sm font-medium text-slate-800">{children}</dd>
    </div>
  );
}

function Section({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-slate-100 bg-white p-4">
      <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-slate-400">
        <Icon size={14} aria-hidden /> {title}
      </p>
      <dl className="mt-1 divide-y divide-slate-50">{children}</dl>
    </div>
  );
}

interface Props {
  encounter: EncounterSummary;
  // Fires once the linked appointment/visit/prescription/files finish
  // loading (or resolve to "none found") - EncounterDetail.tsx uses this to
  // build the Export/Download file without re-fetching the same data.
  onLoaded?: (appointment: LinkedAppointment | null) => void;
  // For the printable prescription's header.
  patientName?: string | null;
}

// Everything about ONE visit below the encounter's own header (which the
// caller renders): the appointment itself - status, booking, timings,
// payment, doctor and clinic - then the doctor's notes, diagnosis,
// prescription, reports and the clinic's bill, all from the appointment this
// encounter belongs to (schema.sql section 18).
export default function EncounterFullDetail({ encounter, onLoaded, patientName }: Props) {
  const [appointment, setAppointment] = useState<LinkedAppointment | null | undefined>(
    screenCache.get<LinkedAppointment>(`encounter-visit:${encounter.id}`) ?? undefined
  ); // undefined = loading

  useEffect(() => {
    supabase
      .from('appointments')
      // visits!visits_appointment_id_fkey: appointments also links to visits through
      // follow_up_of (migration 46), so the embed has to name which link it means -
      // a bare visits(...) is refused as ambiguous and the whole query fails.
      .select(
        'id, date, slot_time, status, created_at, token_number, checked_in_at, reject_reason, payment_status, paid_amount, doctors(name, specialty, reg_no), clinics(name, address, formatted_address, contact_phone), payments(amount, net_amount, discount_amount, coupon_code, method), visits!visits_appointment_id_fkey(id, appointment_id, notes:notes_plain, diagnosis:diagnosis_plain, follow_up_date, follow_up_interval, follow_up_due_date, no_prescription, consultation_started_at, consultation_ended_at, duration_minutes, waiting_time_minutes, created_at, prescriptions(*)), files(id, member_id, appointment_id, type, storage_path, created_at)'
      )
      .eq('encounter_id', encounter.id)
      .limit(1)
      .then(({ data }) => {
        const found = ((data ?? [])[0] as unknown as LinkedAppointment | undefined) ?? null;
        setAppointment(found);
        if (found) screenCache.set(`encounter-visit:${encounter.id}`, found);
        onLoaded?.(found);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [encounter.id]);

  const visit = appointment?.visits[0];
  const prescription = visit?.prescriptions[0];
  const payment = appointment?.payments?.[0];
  const status = appointment ? STATUS[appointment.status] : null;
  const ended = appointment && ['cancelled', 'rejected', 'no_show'].includes(appointment.status);
  const amount = payment ? Number(payment.net_amount ?? payment.amount) : null;
  const address = appointment?.clinics?.formatted_address || appointment?.clinics?.address;

  return (
    <div className="rise-in">
      <div className="flex flex-wrap items-center gap-2">
        {status ? <StatusPill label={status.label} tone={status.tone} /> : <StatusPill label={encounter.status} tone="info" />}
        <span className="text-xs text-slate-500">
          {day(encounter.visit_datetime)} · {clock(encounter.visit_datetime)}
        </span>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 rounded-xl bg-slate-50 p-3 text-xs text-slate-600">
        <p>
          <span className="text-slate-400">Department:</span> {encounter.department ?? '—'}
        </p>
        <p>
          <span className="text-slate-400">Visit type:</span> {encounter.visit_type}
        </p>
        <p className="col-span-2">
          <span className="text-slate-400">Reason:</span> {encounter.reason ?? '—'}
        </p>
      </div>

      {appointment === undefined && <p className="mt-4 text-sm text-slate-400"><Loading /></p>}
      {appointment === null && (
        <p className="mt-4 rounded-xl bg-slate-50 p-3 text-sm text-slate-500">
          No appointment is linked to this encounter, so there are no visit details to show.
        </p>
      )}

      {appointment && (
        <>
          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            <Section icon={CalendarClock} title="Appointment">
              <Row label="Status">{status?.label ?? appointment.status}</Row>
              {ended && appointment.reject_reason && <Row label="Reason">{appointment.reject_reason}</Row>}
              <Row label="Booking ID">
                <span className="font-mono">{bookingReference(appointment.id)}</span>
              </Row>
              <Row label="Date">{day(appointment.date)}</Row>
              <Row label="Time">{formatTimeLabel(appointment.slot_time)}</Row>
              <Row label="Booked on">
                {day(appointment.created_at)}, {clock(appointment.created_at)}
              </Row>
              {appointment.token_number != null && <Row label="Token">#{appointment.token_number}</Row>}
              <Row label="Checked in">{appointment.checked_in_at ? clock(appointment.checked_in_at) : ended ? '—' : 'Not yet'}</Row>
            </Section>

            <Section icon={Timer} title="Consultation">
              <Row label="Doctor">{appointment.doctors?.name ?? encounter.doctors?.name ?? '—'}</Row>
              <Row label="Speciality">{appointment.doctors?.specialty ?? encounter.doctors?.specialty ?? 'General Physician'}</Row>
              {appointment.doctors?.reg_no && <Row label="Registration no.">{appointment.doctors.reg_no}</Row>}
              {visit?.consultation_started_at && <Row label="Started">{clock(visit.consultation_started_at)}</Row>}
              {visit?.consultation_ended_at && <Row label="Finished">{clock(visit.consultation_ended_at)}</Row>}
              {visit?.duration_minutes != null && <Row label="Duration">{visit.duration_minutes} min</Row>}
              {visit?.waiting_time_minutes != null && <Row label="Waited">{visit.waiting_time_minutes} min</Row>}
              {visit?.follow_up_due_date && <Row label="Follow-up by">{day(visit.follow_up_due_date)}</Row>}
              {!visit && <Row label="Notes">{ended ? 'The visit did not take place' : 'Added once the doctor sees the patient'}</Row>}
            </Section>

            <Section icon={CreditCard} title="Payment">
              <Row label="Status">{PAYMENT_STATUS_LABEL[appointment.payment_status] ?? appointment.payment_status}</Row>
              {amount != null && <Row label="Amount">{rupees(amount)}</Row>}
              {payment && <Row label="Method">{payment.method === 'online' ? 'Online (UPI / card)' : 'At the clinic'}</Row>}
              {payment?.coupon_code && Number(payment.discount_amount) > 0 && (
                <Row label="Coupon">
                  {payment.coupon_code} (−{rupees(Number(payment.discount_amount))})
                </Row>
              )}
              {appointment.payment_status === 'paid_at_clinic' && appointment.paid_amount != null && (
                <Row label="Paid at clinic">{rupees(Number(appointment.paid_amount))}</Row>
              )}
              {!payment && <Row label="Amount">—</Row>}
            </Section>

            <Section icon={MapPin} title="Clinic">
              <Row label="Clinic">{appointment.clinics?.name ?? encounter.clinics?.name ?? '—'}</Row>
              {address && <Row label="Address">{address}</Row>}
              {appointment.clinics?.contact_phone && (
                <Row label="Phone">
                  <a className="text-brand-700 underline-offset-2 hover:underline" href={`tel:+${appointment.clinics.contact_phone.replace(/\D/g, '')}`}>
                    {appointment.clinics.contact_phone}
                  </a>
                </Row>
              )}
            </Section>
          </div>

          {visit && (
            <div className="mt-1">
              <VisitDetails
                visit={visit}
                prescription={prescription ?? null}
                patientName={patientName}
                doctorName={encounter.doctors?.name}
                clinicName={encounter.clinics?.name}
              />
            </div>
          )}

          <div className="mt-3 rounded-2xl border border-slate-100 bg-white p-4">
            <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-slate-400">
              <FileText size={14} aria-hidden /> Tests / Reports
            </p>
            {appointment.files.length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-2">
                {appointment.files.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => openAppointmentFile(f.id)}
                    className="rounded-lg bg-brand-50 px-2.5 py-1 text-xs font-semibold text-brand-700"
                  >
                    {f.type ? FILE_LABEL[f.type] : 'File'} · {new Date(f.created_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}
                  </button>
                ))}
              </div>
            ) : (
              <p className="mt-1 text-sm text-slate-500">No reports or files for this visit.</p>
            )}
          </div>

          {appointment.status === 'completed' && <BillCard appointmentId={appointment.id} />}

          {!visit && !ended && appointment.status !== 'completed' && (
            <p className="mt-3 flex items-center gap-2 text-xs text-slate-400">
              <Stethoscope size={14} aria-hidden /> The doctor's notes and prescription appear here after the consultation.
            </p>
          )}
        </>
      )}
    </div>
  );
}
