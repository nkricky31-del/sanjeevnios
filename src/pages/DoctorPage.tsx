import { Stethoscope } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';

import BookingForm from '../components/BookingForm';
import ClinicLocationPreview from '../components/ClinicLocationPreview';
import SlotPicker from '../components/SlotPicker';
import Card from '../components/ui/Card';
import ScreenHeader from '../components/ui/ScreenHeader';
import VerifiedBadge from '../components/VerifiedBadge';
import { supabase } from '../lib/supabaseClient';

interface DoctorWithClinic {
  id: string;
  name: string;
  specialty: string | null;
  consultation_fee: number;
  clinic_id: string;
  clinics: { name: string; address: string | null; lat: number | null; lng: number | null; formatted_address: string | null } | null;
}

export default function DoctorPage() {
  const { doctorId } = useParams<{ doctorId: string }>();
  const [doctor, setDoctor] = useState<DoctorWithClinic | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [selectedSlot, setSelectedSlot] = useState<string | null>(null);
  // Bumped when a slot turns out to have filled up already (SLOT_FULL) so
  // SlotPicker remounts and re-fetches taken slots for the day instead of
  // showing the now-stale grid it loaded with.
  const [slotPickerKey, setSlotPickerKey] = useState(0);
  const [doctorVerified, setDoctorVerified] = useState(false);
  const [clinicVerified, setClinicVerified] = useState(false);

  useEffect(() => {
    if (!doctorId) return;
    (async () => {
      setLoading(true);
      const { data: doctorData } = await supabase
        .from('doctors')
        .select('*, clinics(name, address, lat, lng, formatted_address)')
        .eq('id', doctorId)
        .single();
      setDoctor(doctorData as DoctorWithClinic | null);
      setLoading(false);

      // Live-computed, not read off the row above - see is_currently_verified()
      // in schema.sql for why (a lapsed certificate must hide the badge even
      // if nobody has re-reviewed this doctor/clinic since it expired).
      if (doctorData) {
        const [{ data: docVerified }, { data: clinicVerifiedData }] = await Promise.all([
          supabase.rpc('is_currently_verified', { p_owner_type: 'doctor', p_owner_id: doctorId }),
          supabase.rpc('is_currently_verified', {
            p_owner_type: 'clinic',
            p_owner_id: (doctorData as DoctorWithClinic).clinic_id,
          }),
        ]);
        setDoctorVerified(!!docVerified);
        setClinicVerified(!!clinicVerifiedData);
      }
    })();
  }, [doctorId]);

  if (loading) return <p className="p-6 text-slate-400">Loading...</p>;
  if (!doctor) return <p className="p-6 text-slate-400">Doctor not found.</p>;

  return (
    <div>
      <ScreenHeader title="Doctor" back="/search" />

      <div className="mx-auto max-w-md px-4 py-4">
        <Card>
          <div className="flex items-center gap-3">
            <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-brand-50 text-brand-600">
              <Stethoscope size={24} />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <h1 className="truncate text-lg font-bold text-slate-900">{doctor.name}</h1>
                <VerifiedBadge verified={doctorVerified} ownerType="doctor" />
              </div>
              {doctor.specialty && <p className="text-sm font-medium text-brand-600">{doctor.specialty}</p>}
            </div>
          </div>
          <div className="mt-3 flex items-center gap-1.5">
            <p className="text-sm text-slate-500">{doctor.clinics?.name}</p>
            <VerifiedBadge verified={clinicVerified} ownerType="clinic" />
          </div>
          {doctor.clinics?.address && <p className="text-xs text-slate-400">{doctor.clinics.address}</p>}
          <span className="mt-2 inline-block rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700">
            ₹{doctor.consultation_fee} consultation fee
          </span>
        </Card>

        <ClinicLocationPreview
          lat={doctor.clinics?.lat ?? null}
          lng={doctor.clinics?.lng ?? null}
          formattedAddress={doctor.clinics?.formatted_address ?? null}
          clinicName={doctor.clinics?.name}
        />

        <div className="mt-5">
          <SlotPicker
            key={slotPickerKey}
            doctorId={doctor.id}
            clinicId={doctor.clinic_id}
            selectedDate={selectedDate}
            selectedSlot={selectedSlot}
            onSelect={(pickedDate, pickedSlot) => {
              setSelectedDate(pickedDate);
              setSelectedSlot(pickedSlot);
            }}
          />
        </div>

        {selectedDate && selectedSlot && (
          <BookingForm
            doctorId={doctor.id}
            doctorName={doctor.name}
            clinicId={doctor.clinic_id}
            date={selectedDate}
            slotTime={selectedSlot}
            consultationFee={doctor.consultation_fee}
            onCancel={() => {
              setSelectedDate(null);
              setSelectedSlot(null);
            }}
            onSlotFull={() => {
              // Keep the date so they land back on the same day; only the
              // slot they picked is stale.
              setSelectedSlot(null);
              setSlotPickerKey((k) => k + 1);
            }}
          />
        )}
      </div>
    </div>
  );
}
