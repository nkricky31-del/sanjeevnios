import { ShieldAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { useAuth } from '../lib/AuthContext';
import { EMERGENCY_NOTE, PATIENT_DECLARATION_TEXT, PLATFORM_DISCLAIMER_SHORT } from '../lib/platformDisclaimer';
import { supabase } from '../lib/supabaseClient';
import type { FamilyMember, PaymentMethod } from '../lib/types';
import { usePatientDeclarationStatus } from '../lib/usePatientDeclaration';
import Button from './ui/Button';
import Card from './ui/Card';

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
  const { status: declarationStatus, accept: acceptDeclaration } = usePatientDeclarationStatus();
  const [declarationChecked, setDeclarationChecked] = useState(false);

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
    if (declarationStatus === 'needed' && !declarationChecked) {
      setError('Please accept the platform declaration above to continue.');
      return;
    }

    setLoading(true);

    if (declarationStatus === 'needed') {
      const declarationError = await acceptDeclaration();
      if (declarationError) {
        setLoading(false);
        setError(declarationError);
        return;
      }
    }

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
    <Card className="mt-4 !rounded-3xl">
      <p className="text-base font-bold text-slate-900">Book appointment</p>

      <div className="mt-4 space-y-2 border-b border-slate-100 pb-4">
        <div className="flex items-center justify-between text-sm">
          <span className="text-slate-500">Doctor's fee</span>
          <span className="font-semibold text-slate-900">₹{consultationFee}</span>
        </div>
        <div className="flex items-center justify-between text-base font-bold">
          <span className="text-slate-900">Total</span>
          <span className="text-slate-900">₹{method === 'online' ? consultationFee : 0}</span>
        </div>
        {method === 'cod' && <p className="text-xs text-slate-400">Pay ₹{consultationFee} in cash at the clinic.</p>}
      </div>

      <div className="mt-4">
        <p className="text-sm font-semibold text-slate-700">Patient</p>
        {members.length === 0 ? (
          <p className="mt-1 text-sm text-red-600">No family members yet — add one on your profile before booking.</p>
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
      </div>

      <div className="mt-4">
        <p className="text-sm font-semibold text-slate-700">Payment method</p>
        <div className="mt-1.5 flex gap-2">
          <button
            onClick={() => setMethod('online')}
            className={`flex-1 rounded-2xl border px-3 py-2.5 text-sm font-semibold ${
              method === 'online' ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-slate-200 text-slate-500'
            }`}
          >
            Pay online
          </button>
          <button
            onClick={() => setMethod('cod')}
            className={`flex-1 rounded-2xl border px-3 py-2.5 text-sm font-semibold ${
              method === 'cod' ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-slate-200 text-slate-500'
            }`}
          >
            Cash at clinic
          </button>
        </div>
        {method === 'online' && <p className="mt-1 text-xs text-slate-400">Demo hold only — no real charge.</p>}
      </div>

      <div className="mt-4 rounded-xl bg-slate-50 p-3 text-xs text-slate-500">
        {PLATFORM_DISCLAIMER_SHORT}
        <p className="mt-1.5 flex items-start gap-1.5 font-medium text-amber-700">
          <ShieldAlert size={14} className="mt-0.5 shrink-0" />
          {EMERGENCY_NOTE}
        </p>
      </div>

      {declarationStatus === 'needed' && (
        <div className="mt-3 rounded-xl border border-slate-200 p-3">
          <p className="text-xs font-bold text-slate-800">Platform declaration</p>
          <div className="mt-1 max-h-32 overflow-y-auto whitespace-pre-line text-xs leading-relaxed text-slate-600">
            {PATIENT_DECLARATION_TEXT}
          </div>
          <label className="mt-2 flex items-start gap-2 text-xs text-slate-700">
            <input
              type="checkbox"
              checked={declarationChecked}
              onChange={(e) => setDeclarationChecked(e.target.checked)}
              className="mt-0.5"
            />
            I have read and accept this declaration.
          </label>
        </div>
      )}

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      <div className="mt-5 flex gap-2">
        <Button
          onClick={submit}
          disabled={loading || members.length === 0 || (declarationStatus === 'needed' && !declarationChecked)}
          full
        >
          {loading ? 'Booking...' : 'Confirm'}
        </Button>
      </div>
      <button onClick={onCancel} className="mt-2 w-full text-center text-sm font-medium text-slate-500">
        Cancel
      </button>
    </Card>
  );
}
