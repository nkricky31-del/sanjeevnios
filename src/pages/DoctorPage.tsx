import { CalendarPlus, Stethoscope } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';

import BookingForm from '../components/BookingForm';
import ClinicLocationPreview from '../components/ClinicLocationPreview';
import SlotPicker from '../components/SlotPicker';
import Card from '../components/ui/Card';
import ScreenHeader from '../components/ui/ScreenHeader';
import VerifiedBadge from '../components/VerifiedBadge';
import { supabase } from '../lib/supabaseClient';
import type { FamilyMember } from '../lib/types';

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
  const [searchParams] = useSearchParams();
  // Set when this page was reached via BookingStatus.tsx's "Book follow-up"
  // button - the ORIGINAL VISIT's id (schema.sql section 46), never the
  // appointment's. Everything below just treats this as "which visit are we
  // following up on"; the actual free/paid decision is re-derived server-side
  // in create_payment_with_coupon(), never trusted from this param.
  const followUpOfVisitId = searchParams.get('followUp');
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
  // Booking is PER MEMBER (schema.sql section 47), so this is picked FIRST -
  // before date/slot - rather than buried inside BookingForm after the fact.
  // Fetched independently of doctorId so it's ready as soon as the page is.
  const [members, setMembers] = useState<FamilyMember[]>([]);
  const [membersLoading, setMembersLoading] = useState(true);
  const [memberId, setMemberId] = useState('');
  // undefined = still resolving (or nothing to resolve) - kept distinct from
  // null (resolved, no due date) so SlotPicker isn't mounted with today's
  // date as its initialDate before this fetch has had a chance to land; its
  // own initialDate is read once, on mount, and never re-applied later.
  const [followUpDueDate, setFollowUpDueDate] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    supabase
      .from('family_members')
      .select('*')
      .order('created_at', { ascending: true })
      .then(({ data }) => {
        const list = (data ?? []) as FamilyMember[];
        setMembers(list);
        const self = list.find((m) => m.relation === 'self');
        setMemberId(self?.id ?? list[0]?.id ?? '');
        setMembersLoading(false);
      });
  }, []);

  useEffect(() => {
    if (!followUpOfVisitId) {
      setFollowUpDueDate(null);
      return;
    }
    setFollowUpDueDate(undefined);
    supabase
      .from('visits')
      .select('follow_up_due_date')
      .eq('id', followUpOfVisitId)
      .maybeSingle()
      .then(({ data }) => setFollowUpDueDate((data as { follow_up_due_date: string | null } | null)?.follow_up_due_date ?? null));
  }, [followUpOfVisitId]);

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

        {/* Picked FIRST, before date/slot - booking is per member (schema.sql
            section 47), and the duplicate check the server enforces is keyed
            on member_id, so this has to be settled before anything else. */}
        <Card className="mt-4">
          <p className="text-sm font-semibold text-slate-700">Who is this booking for?</p>
          {membersLoading ? (
            <p className="mt-1 text-sm text-slate-400">Loading...</p>
          ) : members.length === 0 ? (
            <>
              <p className="mt-1 text-sm text-red-600">No family members yet — add one on your profile first.</p>
              <Link to="/profile" className="mt-2 inline-block text-sm font-bold text-brand-600">
                Add a family member →
              </Link>
            </>
          ) : (
            <select
              value={memberId}
              onChange={(e) => setMemberId(e.target.value)}
              className="mt-1 w-full rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-brand-500"
            >
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} ({m.relation})
                </option>
              ))}
            </select>
          )}
        </Card>

        <ClinicLocationPreview
          lat={doctor.clinics?.lat ?? null}
          lng={doctor.clinics?.lng ?? null}
          formattedAddress={doctor.clinics?.formatted_address ?? null}
          clinicName={doctor.clinics?.name}
        />

        {followUpOfVisitId && (
          <div className="mt-4 flex items-start gap-3 rounded-2xl bg-emerald-50 p-3.5">
            <CalendarPlus size={18} className="mt-0.5 shrink-0 text-emerald-700" />
            <p className="text-sm text-emerald-800">
              Booking a follow-up{' '}
              {followUpDueDate && (
                <>
                  — free if booked on or before{' '}
                  <strong>
                    {new Date(followUpDueDate + 'T00:00:00').toLocaleDateString(undefined, {
                      day: 'numeric',
                      month: 'short',
                    })}
                  </strong>
                </>
              )}
              . Pick any open slot below.
            </p>
          </div>
        )}

        {/* Waits for the due-date lookup above before mounting SlotPicker at
            all - its initialDate is only ever read once, at mount, so
            rendering it early (with the fetch still in flight) would seed it
            on today's date and never actually land on the due date. Also
            waits for a member to actually be chosen, so a booking is never
            started without one. */}
        {followUpDueDate !== undefined && memberId && (
          <div className="mt-5">
            <SlotPicker
              key={slotPickerKey}
              doctorId={doctor.id}
              clinicId={doctor.clinic_id}
              daysToShow={followUpOfVisitId ? 40 : undefined}
              initialDate={followUpDueDate}
              selectedDate={selectedDate}
              selectedSlot={selectedSlot}
              onSelect={(pickedDate, pickedSlot) => {
                setSelectedDate(pickedDate);
                setSelectedSlot(pickedSlot);
              }}
            />
          </div>
        )}

        {selectedDate && selectedSlot && memberId && (
          <BookingForm
            doctorId={doctor.id}
            doctorName={doctor.name}
            clinicId={doctor.clinic_id}
            memberId={memberId}
            date={selectedDate}
            slotTime={selectedSlot}
            consultationFee={doctor.consultation_fee}
            followUpOfVisitId={followUpOfVisitId}
            followUpDueDate={followUpDueDate}
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
