import { ArrowLeft } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import BookingForm from '../components/BookingForm';
import Card from '../components/ui/Card';
import { todayISO } from '../lib/date';
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
  const openSlots = allSlots.filter((s) => !takenSlots.has(s));

  return (
    <div>
      <div className="border-b border-slate-200 bg-white px-4 py-4">
        <Link to="/" className="inline-flex items-center gap-1 text-sm font-medium text-slate-500">
          <ArrowLeft size={16} /> Back to search
        </Link>
      </div>

      <div className="mx-auto max-w-md px-4 py-6">
        <Card>
          <h1 className="text-xl font-bold text-slate-900">{doctor.name}</h1>
          {doctor.specialty && <p className="text-blue-600">{doctor.specialty}</p>}
          <p className="mt-1 text-sm text-slate-500">{doctor.clinics?.name}</p>
          {doctor.clinics?.address && <p className="text-xs text-slate-400">{doctor.clinics.address}</p>}
          <p className="mt-2 text-sm font-medium text-slate-700">Consultation fee: ₹{doctor.consultation_fee}</p>
        </Card>

        <div className="mt-4">
          <label className="text-sm font-medium text-slate-700">Date</label>
          <input
            type="date"
            value={date}
            min={todayISO()}
            onChange={(e) => setDate(e.target.value)}
            className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        <div className="mt-4">
          <p className="text-sm font-medium text-slate-700">Available slots</p>
          {windowsToday.length === 0 && (
            <p className="mt-2 text-sm text-slate-400">Doctor doesn't work on this day.</p>
          )}
          {windowsToday.length > 0 && openSlots.length === 0 && (
            <p className="mt-2 text-sm text-red-600">Fully booked for this date.</p>
          )}
          <div className="mt-2 flex flex-wrap gap-2">
            {openSlots.map((s) => (
              <button
                key={s}
                onClick={() => setSelectedSlot(s)}
                className={`rounded-xl border px-3 py-2 text-sm font-medium ${
                  selectedSlot === s
                    ? 'border-blue-600 bg-blue-600 text-white'
                    : 'border-slate-300 bg-white text-slate-700 hover:border-blue-400'
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
