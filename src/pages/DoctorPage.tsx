import { ArrowLeft, Stethoscope } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import BookingForm from '../components/BookingForm';
import Card from '../components/ui/Card';
import { addDaysISO, todayISO } from '../lib/date';
import { supabase } from '../lib/supabaseClient';
import { computeSlots, formatTimeLabel } from '../lib/time';
import type { DoctorAvailability } from '../lib/types';

interface DoctorWithClinic {
  id: string;
  name: string;
  specialty: string | null;
  consultation_fee: number;
  clinic_id: string;
  clinics: { name: string; address: string | null } | null;
}

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAYS_TO_SHOW = 14;

export default function DoctorPage() {
  const { doctorId } = useParams<{ doctorId: string }>();
  const [doctor, setDoctor] = useState<DoctorWithClinic | null>(null);
  const [availability, setAvailability] = useState<DoctorAvailability[]>([]);
  const [date, setDate] = useState(todayISO);
  const [takenSlots, setTakenSlots] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [selectedSlot, setSelectedSlot] = useState<string | null>(null);

  useEffect(() => {
    if (!doctorId) return;
    (async () => {
      setLoading(true);
      const [{ data: doctorData }, { data: availData }] = await Promise.all([
        supabase.from('doctors').select('*, clinics(name, address)').eq('id', doctorId).single(),
        supabase.from('doctor_availability').select('*').eq('doctor_id', doctorId),
      ]);
      setDoctor(doctorData as DoctorWithClinic | null);
      setAvailability(availData ?? []);
      setLoading(false);
    })();
  }, [doctorId]);

  useEffect(() => {
    if (!doctorId || !date) return;
    setSelectedSlot(null);
    (async () => {
      const { data } = await supabase.rpc('get_taken_slots', { p_doctor_id: doctorId, p_date: date });
      setTakenSlots(new Set((data ?? []).map((r: { slot_time: string }) => r.slot_time)));
    })();
  }, [doctorId, date]);

  if (loading) return <p className="p-6 text-slate-400">Loading...</p>;
  if (!doctor) return <p className="p-6 text-slate-400">Doctor not found.</p>;

  const weekday = new Date(date + 'T00:00:00').getDay();
  const windowsToday = availability.filter((a) => a.weekday === weekday);
  const allSlots = computeSlots(windowsToday);
  // Dedupe: rounding in computeSlots can occasionally land two starts on the
  // same minute for a very tight capacity/window combo.
  const openSlots = Array.from(new Set(allSlots.filter((s) => !takenSlots.has(s))));

  const dayOptions = Array.from({ length: DAYS_TO_SHOW }, (_, i) => {
    const iso = addDaysISO(todayISO(), i);
    const d = new Date(iso + 'T00:00:00');
    return { iso, dayLabel: DAY_LABELS[d.getDay()], dateNum: d.getDate() };
  });

  return (
    <div>
      <div className="border-b border-slate-100 bg-white px-4 py-4">
        <Link to="/" className="inline-flex items-center gap-1 text-sm font-medium text-slate-500">
          <ArrowLeft size={16} /> Back to search
        </Link>
      </div>

      <div className="mx-auto max-w-md px-4 py-6">
        <Card>
          <div className="flex items-center gap-3">
            <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-brand-50 text-brand-600">
              <Stethoscope size={24} />
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-lg font-bold text-slate-900">{doctor.name}</h1>
              {doctor.specialty && <p className="text-sm font-medium text-coral-600">{doctor.specialty}</p>}
            </div>
          </div>
          <p className="mt-3 text-sm text-slate-500">{doctor.clinics?.name}</p>
          {doctor.clinics?.address && <p className="text-xs text-slate-400">{doctor.clinics.address}</p>}
          <span className="mt-2 inline-block rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700">
            ₹{doctor.consultation_fee} consultation fee
          </span>
        </Card>

        <div className="mt-5">
          <p className="text-xs font-bold uppercase tracking-wide text-slate-400">Select day</p>
          <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
            {dayOptions.map((d) => (
              <button
                key={d.iso}
                onClick={() => setDate(d.iso)}
                className={`flex shrink-0 flex-col items-center rounded-2xl px-4 py-2.5 text-sm font-semibold ${
                  date === d.iso ? 'bg-brand-600 text-white' : 'bg-white text-slate-600 border border-slate-200'
                }`}
              >
                <span className="text-xs opacity-80">{d.dayLabel}</span>
                <span className="text-base">{d.dateNum}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="mt-5">
          <p className="text-xs font-bold uppercase tracking-wide text-slate-400">Available slots</p>
          {windowsToday.length === 0 && (
            <p className="mt-2 text-sm text-slate-400">Doctor doesn't work on this day.</p>
          )}
          {windowsToday.length > 0 && openSlots.length === 0 && (
            <p className="mt-2 text-sm text-red-600">Fully booked for this date.</p>
          )}
          <div className="mt-2 grid grid-cols-2 gap-2">
            {openSlots.map((s) => (
              <button
                key={s}
                onClick={() => setSelectedSlot(s)}
                className={`rounded-2xl border px-3 py-2.5 text-sm font-semibold ${
                  selectedSlot === s
                    ? 'border-brand-600 bg-brand-600 text-white'
                    : 'border-slate-200 bg-white text-slate-700 hover:border-brand-300'
                }`}
              >
                {formatTimeLabel(s)}
              </button>
            ))}
          </div>
        </div>

        {selectedSlot && (
          <BookingForm
            doctorId={doctor.id}
            clinicId={doctor.clinic_id}
            date={date}
            slotTime={selectedSlot}
            consultationFee={doctor.consultation_fee}
            onCancel={() => setSelectedSlot(null)}
          />
        )}
      </div>
    </div>
  );
}
