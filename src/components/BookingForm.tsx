import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { useAuth } from '../lib/AuthContext';
import { supabase } from '../lib/supabaseClient';
import type { FamilyMember, PaymentMethod } from '../lib/types';

interface Props {
  doctorId: string;
  clinicId: string;
  date: string;
  slotTime: string;
  consultationFee: number;
  onCancel: () => void;
}

export default function BookingForm({ doctorId, clinicId, date, slotTime, consultationFee, onCancel }: Props) {
  const { session } = useAuth();
  const navigate = useNavigate();
  const [members, setMembers] = useState<FamilyMember[]>([]);
  const [memberId, setMemberId] = useState('');
  const [method, setMethod] = useState<PaymentMethod>('online');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    supabase
      .from('family_members')
      .select('*')
      .order('created_at', { ascending: true })
      .then(({ data }) => {
        const list = data ?? [];
        setMembers(list);
        const self = list.find((m) => m.relation === 'self');
        setMemberId(self?.id ?? list[0]?.id ?? '');
      });
  }, []);

  const submit = async () => {
    setError(null);
    if (!memberId) {
      setError('Add a family member on your profile first.');
      return;
    }

    setLoading(true);

    const { data: appointment, error: apptError } = await supabase
      .from('appointments')
      .insert({
        member_id: memberId,
        doctor_id: doctorId,
        clinic_id: clinicId,
        date,
        slot_time: slotTime,
        status: 'pending',
        payment_status: method === 'online' ? 'hold' : 'cod',
      })
      .select()
      .single();

    if (apptError || !appointment) {
      setLoading(false);
      setError(apptError?.message ?? 'Could not create the booking.');
      return;
    }

    const { error: paymentError } = await supabase.from('payments').insert({
      appointment_id: appointment.id,
      amount: consultationFee,
      method,
      status: method === 'online' ? 'hold' : 'pending',
    });

    setLoading(false);

    if (paymentError) {
      setError(paymentError.message);
      return;
    }

    navigate(`/bookings/${appointment.id}`);
  };

  if (!session) return null;

  return (
    <div className="mt-4 space-y-4 rounded-xl border border-slate-200 p-4">
      <div>
        <p className="text-sm font-medium text-slate-700">Booking for</p>
        {members.length === 0 ? (
          <p className="mt-1 text-sm text-red-600">
            No family members yet — add one on your profile before booking.
          </p>
        ) : (
          <select
            value={memberId}
            onChange={(e) => setMemberId(e.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 outline-none focus:ring-2 focus:ring-blue-500"
          >
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} ({m.relation})
              </option>
            ))}
          </select>
        )}
      </div>

      <div>
        <p className="text-sm font-medium text-slate-700">Payment</p>
        <div className="mt-1 flex gap-4">
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input type="radio" checked={method === 'online'} onChange={() => setMethod('online')} />
            Online (₹{consultationFee}) — demo hold only, no real charge
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input type="radio" checked={method === 'cod'} onChange={() => setMethod('cod')} />
            Cash at clinic
          </label>
        </div>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="flex gap-2">
        <button
          onClick={submit}
          disabled={loading || members.length === 0}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {loading ? 'Booking...' : 'Confirm booking'}
        </button>
        <button onClick={onCancel} className="px-4 py-2 text-sm text-slate-500">
          Cancel
        </button>
      </div>
    </div>
  );
}
