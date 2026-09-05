import { ShieldAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { useAuth } from '../lib/AuthContext';
import { computeBill } from '../lib/billing';
import {
  DEFAULT_POLICY,
  getBookingPolicy,
  getNextAvailableDay,
  isFullDayError,
  isSameDayCutoffError,
  isSlotFullError,
  joinWaitlist,
  type BookingPolicy,
} from '../lib/bookingPolicy';
import { getCurrentCoords } from '../lib/checkIn';
import { createPaymentWithCoupon, releaseCouponReservation, reserveCoupon } from '../lib/coupons';
import { todayISO } from '../lib/date';
import { DPDP_CONSENT_TEXT } from '../lib/dpdpConsent';
import { bookingReceivedMessage, notifyPatient } from '../lib/notify';
import { EMERGENCY_NOTE, PATIENT_DECLARATION_TEXT, PLATFORM_DISCLAIMER_SHORT } from '../lib/platformDisclaimer';
import { createRazorpayOrder, loadRazorpayScript, openRazorpayCheckout, verifyRazorpayPayment } from '../lib/razorpay';
import { supabase } from '../lib/supabaseClient';
import { formatTimeLabel } from '../lib/time';
import type { FamilyMember, PaymentMethod } from '../lib/types';
import { useDpdpConsentStatus, usePatientDeclarationStatus } from '../lib/usePatientConsent';
import Button from './ui/Button';
import Card from './ui/Card';

interface Props {
  doctorId: string;
  doctorName: string;
  clinicId: string;
  date: string;
  slotTime: string;
  consultationFee: number;
  onCancel: () => void;
  // Someone else took this slot's last seat between the picker loading and
  // Confirm being pressed (schema.sql section 36.4's SLOT_FULL). Distinct
  // from onCancel: the caller should also refresh the slot grid, since this
  // exact time is now stale.
  onSlotFull: () => void;
}

interface AppliedCoupon {
  code: string;
  redemptionId: string;
  discountAmount: number;
}

export default function BookingForm({
  doctorId,
  doctorName,
  clinicId,
  date,
  slotTime,
  consultationFee,
  onCancel,
  onSlotFull,
}: Props) {
  const { session, profile } = useAuth();
  const navigate = useNavigate();
  const [members, setMembers] = useState<FamilyMember[]>([]);
  const [memberId, setMemberId] = useState('');
  const [reason, setReason] = useState('');
  const [method, setMethod] = useState<PaymentMethod>('online');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The day filled up. Not an error state - a choice between waiting for a
  // seat here or taking the next day that has one.
  const [fullDay, setFullDay] = useState(false);
  const [nextDay, setNextDay] = useState<string | null>(null);
  const [waitlistPlace, setWaitlistPlace] = useState<number | null>(null);
  // This exact slot filled up between loading the picker and confirming -
  // not the whole day, so there's nothing to offer but "go pick again."
  const [slotFull, setSlotFull] = useState(false);
  // This exact same-day slot slid inside the clinic's cutoff between loading
  // the picker and confirming (schema.sql section 37.3) - same "go pick
  // again" outcome as slotFull, just a different reason to explain.
  const [sameDayCutoff, setSameDayCutoff] = useState(false);
  const { status: declarationStatus, accept: acceptDeclaration } = usePatientDeclarationStatus();
  const [declarationChecked, setDeclarationChecked] = useState(false);
  const { status: dpdpStatus, accept: acceptDpdp } = useDpdpConsentStatus();
  const [dpdpChecked, setDpdpChecked] = useState(false);
  // Whether this clinic would actually DO anything with a location fix on a
  // same-day booking (schema.sql section 37.4) - gates both the note below
  // and whether it's worth asking the browser for location at all. Most
  // clinics never will, so defaulting to DEFAULT_POLICY (false) is the safe
  // "don't ask, don't promise" starting state while this loads.
  const [policy, setPolicy] = useState<BookingPolicy>(DEFAULT_POLICY);

  // Coupon box (section 41). appliedCoupon holds a RESERVED redemption - the
  // discount is locked in server-side the moment Apply succeeds, not just a
  // client-side guess. Switching payment method changes the gross amount
  // (the convenience fee only applies online), so it releases whatever was
  // applied and asks the patient to re-apply against the new total.
  const [couponInput, setCouponInput] = useState('');
  const [couponApplying, setCouponApplying] = useState(false);
  const [couponError, setCouponError] = useState<string | null>(null);
  const [appliedCoupon, setAppliedCoupon] = useState<AppliedCoupon | null>(null);

  const bill = computeBill(consultationFee, method, appliedCoupon?.discountAmount ?? 0);

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

  useEffect(() => {
    getBookingPolicy(clinicId).then(setPolicy);
  }, [clinicId]);

  const sameDayAutoCheckin = date === todayISO() && policy.mode === 'appointment_only' && policy.sameDayBookingEnabled && policy.autoCheckinVerifiedSameDay;

  const applyCoupon = async () => {
    setCouponError(null);
    const code = couponInput.trim();
    if (!code) {
      setCouponError('Enter a code.');
      return;
    }
    if (!session) {
      setCouponApplying(false);
      setCouponError('You must be signed in to apply a coupon.');
      return;
    }
    setCouponApplying(true);
    // The gross amount THIS coupon would apply to is a preview only -
    // validate_and_price() uses it just to quote a discount and check the
    // minimum order value; create_payment_with_coupon() re-derives the real
    // gross from the doctor's actual fee when the booking is confirmed, so a
    // stale or manipulated figure here can never change what's actually
    // charged.
    const result = await reserveCoupon(code, session.user.id, clinicId, computeBill(consultationFee, method).grossAmount);
    setCouponApplying(false);
    if (!result.valid || !result.redemptionId) {
      setCouponError(result.reason ?? 'Could not apply this code.');
      return;
    }
    setAppliedCoupon({ code: code.toUpperCase(), redemptionId: result.redemptionId, discountAmount: result.discountAmount });
  };

  const removeCoupon = async () => {
    if (appliedCoupon) await releaseCouponReservation(appliedCoupon.redemptionId);
    setAppliedCoupon(null);
    setCouponInput('');
    setCouponError(null);
  };

  const changeMethod = (m: PaymentMethod) => {
    if (m === method) return;
    if (appliedCoupon) {
      releaseCouponReservation(appliedCoupon.redemptionId);
      setAppliedCoupon(null);
      setCouponError('Payment method changed - please re-apply your code.');
    }
    setMethod(m);
  };

  // A booking whose appointment row exists but never ends up with a real,
  // verified payment (Razorpay order/verification failed, or the patient
  // dismissed Checkout) shouldn't sit around as a live 'booked' request -
  // cancelling it runs the exact same trigger that a clinic rejection does,
  // which releases the payment hold and any coupon reservation together.
  const cancelOrphanBooking = async (appointmentId: string) => {
    await supabase.from('appointments').update({ status: 'cancelled' }).eq('id', appointmentId);
  };

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
    if (dpdpStatus === 'needed' && !dpdpChecked) {
      setError('Please accept the data-sharing consent above to continue.');
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
    if (dpdpStatus === 'needed') {
      const dpdpError = await acceptDpdp();
      if (dpdpError) {
        setLoading(false);
        setError(dpdpError);
        return;
      }
    }

    // A location fix, only sought when this clinic would actually act on one
    // (sameDayAutoCheckin) - it's what lets the server tell "booked while
    // standing at the clinic" apart from "booked from home" and auto-check-in
    // only the former (schema.sql section 37.4). Best-effort: getCurrentCoords()
    // resolves to null rather than rejecting when the patient declines or the
    // device can't get a fix, and a null fix just means this booking is
    // treated like any other advance one - it never blocks the booking itself.
    // Never requested for a clinic that wouldn't use it - asking for location
    // access for no reason is its own bad UX.
    const coords = sameDayAutoCheckin ? await getCurrentCoords() : null;

    const { data: appointment, error: apptError } = await supabase
      .from('appointments')
      .insert({
        member_id: memberId,
        doctor_id: doctorId,
        clinic_id: clinicId,
        date,
        slot_time: slotTime,
        reason: reason.trim() || null,
        // 'booked' = waiting for the clinic to confirm. No token is issued
        // here - the patient collects one when they arrive and check in,
        // UNLESS this is a same-day booking the clinic can auto-check-in
        // from the location fix above (still decided server-side).
        status: 'booked',
        // Payment is recorded, and that is ALL it does: paying online buys no
        // queue priority and does not check anyone in. It only means there's
        // nothing to collect at the counter. See schema.sql section 30.
        payment_status: method === 'online' ? 'paid_online' : 'pay_at_clinic',
        // Only referenced at all when there's an actual fix to record - an
        // ordinary booking (no location sought, or the patient declined/no
        // fix available) never touches these columns, so it can never be
        // held hostage by them.
        ...(coords ? { booking_lat: coords.lat, booking_lng: coords.lng } : {}),
      })
      .select()
      .single();

    if (apptError || !appointment) {
      setLoading(false);
      // A day that filled up between the patient opening the picker and
      // pressing Confirm is not a failure to apologise for - it's a fork in
      // the road, so offer the two ways forward instead of a raw error.
      if (isFullDayError(apptError?.message)) {
        setFullDay(true);
        setNextDay(await getNextAvailableDay(clinicId));
        setError(null);
        return;
      }
      if (isSlotFullError(apptError?.message)) {
        setSlotFull(true);
        setError(null);
        return;
      }
      if (isSameDayCutoffError(apptError?.message)) {
        setSameDayCutoff(true);
        setError(null);
        return;
      }
      setError(apptError?.message ?? 'Could not create the booking.');
      return;
    }

    // The real charge: gross amount looked up server-side from the doctor's
    // fee, coupon re-validated and re-derived against it - see
    // create_payment_with_coupon() in migration_41. This is what places the
    // HOLD (an online 'hold' row) or records what's due at the desk (a COD
    // 'pending' row).
    const paymentResult = await createPaymentWithCoupon(appointment.id, method, appliedCoupon?.redemptionId ?? null);
    if ('error' in paymentResult) {
      setLoading(false);
      setError(paymentResult.error);
      if (appliedCoupon) releaseCouponReservation(appliedCoupon.redemptionId);
      await cancelOrphanBooking(appointment.id);
      return;
    }

    if (method === 'cod') {
      // BOOKING RECEIVED - see notify.ts. Best-effort: a failure here must
      // never strand the patient on a stuck "Booking..." button when the
      // booking + payment above already succeeded.
      if (session) {
        await notifyPatient({
          userId: session.user.id,
          appointmentId: appointment.id,
          type: 'booking_received',
          message: bookingReceivedMessage(doctorName, date, method, paymentResult.netAmount),
        });
      }
      setLoading(false);
      navigate(`/bookings/${appointment.id}`);
      return;
    }

    // Online: open Razorpay Checkout against the order this creates. Nothing
    // charges yet - razorpay-create-order authorizes only (payment_capture: 0),
    // the actual hold. Capture only ever happens later, when the clinic taps
    // Accept (ClinicQueue.tsx).
    const scriptOk = await loadRazorpayScript();
    if (!scriptOk) {
      setLoading(false);
      setError('Could not load the payment gateway. Check your connection and try again.');
      if (appliedCoupon) releaseCouponReservation(appliedCoupon.redemptionId);
      await cancelOrphanBooking(appointment.id);
      return;
    }

    const order = await createRazorpayOrder(appointment.id);
    if ('error' in order) {
      setLoading(false);
      setError(order.error);
      if (appliedCoupon) releaseCouponReservation(appliedCoupon.redemptionId);
      await cancelOrphanBooking(appointment.id);
      return;
    }

    openRazorpayCheckout({
      keyId: order.keyId,
      orderId: order.orderId,
      amountPaise: order.amountPaise,
      patientPhone: profile?.phone,
      onSuccess: async (result) => {
        const verify = await verifyRazorpayPayment(appointment.id, result);
        if (!verify.verified) {
          setLoading(false);
          setError(verify.error ?? 'Payment could not be verified. Please try booking again.');
          await cancelOrphanBooking(appointment.id);
          return;
        }
        if (session) {
          await notifyPatient({
            userId: session.user.id,
            appointmentId: appointment.id,
            type: 'booking_received',
            message: bookingReceivedMessage(doctorName, date, method, paymentResult.netAmount),
          });
        }
        setLoading(false);
        navigate(`/bookings/${appointment.id}`);
      },
      onDismiss: async () => {
        setLoading(false);
        setError('Payment was not completed - this booking has been cancelled. You can try again.');
        await cancelOrphanBooking(appointment.id);
      },
    });
    // Checkout continues asynchronously via the callbacks above - nothing
    // further to do on this call stack.
  };

  if (!session) return null;

  // This same-day slot slid inside the clinic's cutoff while the form was
  // open - same "go pick again" outcome as slotFull, different reason.
  if (sameDayCutoff) {
    return (
      <Card className="mt-4 !rounded-3xl">
        <p className="text-base font-bold text-slate-900">That time is too close now</p>
        <p className="mt-1 text-sm text-slate-500">
          Same-day booking for {formatTimeLabel(slotTime)} has closed - it's too close to start now. Pick a later
          time below.
        </p>
        <Button full className="mt-4" onClick={onSlotFull}>
          Pick another slot
        </Button>
      </Card>
    );
  }

  // Just this slot filled up - the day itself is fine, so send them straight
  // back to a freshly-refreshed picker rather than offering a waitlist.
  if (slotFull) {
    return (
      <Card className="mt-4 !rounded-3xl">
        <p className="text-base font-bold text-slate-900">That time just filled up</p>
        <p className="mt-1 text-sm text-slate-500">
          Someone took the last seat for {formatTimeLabel(slotTime)} on{' '}
          {new Date(date + 'T00:00:00').toLocaleDateString(undefined, {
            weekday: 'short',
            day: 'numeric',
            month: 'short',
          })}
          . Pick another time below.
        </p>
        <Button full className="mt-4" onClick={onSlotFull}>
          Pick another slot
        </Button>
      </Card>
    );
  }

  // The day filled up. Offer the two real options - wait for a seat here, or
  // take the next day that has one - rather than a dead end.
  if (fullDay) {
    return (
      <Card className="mt-4 !rounded-3xl">
        <p className="text-base font-bold text-slate-900">That day just filled up</p>
        <p className="mt-1 text-sm text-slate-500">
          Someone took the last seat for{' '}
          {new Date(date + 'T00:00:00').toLocaleDateString(undefined, {
            weekday: 'short',
            day: 'numeric',
            month: 'short',
          })}
          . Here's where you can go from here.
        </p>

        {waitlistPlace != null ? (
          <div className="mt-4 rounded-2xl bg-emerald-50 p-4 text-sm text-emerald-800">
            <p className="font-bold">You're on the waitlist — number {waitlistPlace} in line.</p>
            <p className="mt-1 text-xs leading-relaxed">
              If someone cancels we'll notify you. Seats are first come, first served — the alert is an invitation
              to book, not a reserved seat.
            </p>
          </div>
        ) : (
          <Button
            full
            className="mt-4"
            onClick={async () => {
              const result = await joinWaitlist(clinicId, memberId, date, doctorId);
              if (result.error) setError(result.error);
              else setWaitlistPlace(result.place ?? null);
            }}
          >
            Join the waitlist for this day
          </Button>
        )}

        {nextDay && (
          <div className="mt-3 rounded-2xl border border-slate-200 p-4">
            <p className="text-sm font-bold text-slate-900">Next day with room</p>
            <p className="mt-0.5 text-sm text-slate-500">
              {new Date(nextDay + 'T00:00:00').toLocaleDateString(undefined, {
                weekday: 'long',
                day: 'numeric',
                month: 'long',
              })}
            </p>
            <Button variant="outline" full className="mt-2" onClick={onCancel}>
              Pick a slot on that day
            </Button>
          </div>
        )}
        {!nextDay && (
          <p className="mt-3 text-sm text-slate-500">
            Every day this clinic is currently taking bookings for is full. The waitlist is your best route in.
          </p>
        )}

        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
        <button onClick={onCancel} className="mt-3 w-full text-center text-sm font-medium text-slate-500">
          Back to the calendar
        </button>
      </Card>
    );
  }

  return (
    <Card className="mt-4 !rounded-3xl">
      <p className="text-base font-bold text-slate-900">Book appointment</p>

      <div className="mt-4 space-y-2 border-b border-slate-100 pb-4">
        <div className="flex items-center justify-between text-sm">
          <span className="text-slate-500">Doctor's fee</span>
          <span className="font-semibold text-slate-900">₹{bill.consultationFee}</span>
        </div>
        {bill.convenienceFee > 0 && (
          <div className="flex items-center justify-between text-sm">
            <span className="text-slate-500">Platform convenience fee</span>
            <span className="font-semibold text-slate-900">₹{bill.convenienceFee}</span>
          </div>
        )}
        {bill.discountAmount > 0 && (
          <div className="flex items-center justify-between text-sm">
            <span className="text-emerald-600">Coupon discount ({appliedCoupon?.code})</span>
            <span className="font-semibold text-emerald-600">-₹{bill.discountAmount}</span>
          </div>
        )}
        <div className="flex items-center justify-between text-base font-bold">
          <span className="text-slate-900">Total</span>
          <span className="text-slate-900">₹{bill.netAmount}</span>
        </div>
        {method === 'cod' && <p className="text-xs text-slate-400">Pay ₹{bill.netAmount} in cash at the clinic.</p>}
      </div>

      <div className="mt-4">
        <p className="text-sm font-semibold text-slate-700">Coupon code</p>
        {appliedCoupon ? (
          <div className="mt-1 flex items-center justify-between rounded-2xl border border-emerald-200 bg-emerald-50 px-3 py-2.5">
            <div>
              <p className="text-sm font-bold text-emerald-800">{appliedCoupon.code} applied</p>
              <p className="text-xs text-emerald-600">You saved ₹{appliedCoupon.discountAmount}</p>
            </div>
            <button onClick={removeCoupon} className="text-xs font-bold text-emerald-700 underline">
              Remove
            </button>
          </div>
        ) : (
          <div className="mt-1 flex gap-2">
            <input
              type="text"
              value={couponInput}
              onChange={(e) => setCouponInput(e.target.value.toUpperCase())}
              placeholder="Enter code"
              className="min-w-0 flex-1 rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-brand-500"
            />
            <Button variant="outline" onClick={applyCoupon} disabled={couponApplying || !couponInput.trim()}>
              {couponApplying ? 'Applying...' : 'Apply'}
            </Button>
          </div>
        )}
        {couponError && <p className="mt-1 text-xs text-red-600">{couponError}</p>}
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

      {sameDayAutoCheckin && (
        <p className="mt-4 rounded-xl bg-slate-50 p-3 text-xs leading-relaxed text-slate-500">
          This is a same-day booking. If you're already at the clinic, allow location access when your browser asks
          — you may be checked in immediately with a token. Booking from elsewhere is fine too; you'll collect your
          token at the counter when you arrive.
        </p>
      )}
      {!sameDayAutoCheckin && date === todayISO() && (
        <p className="mt-4 rounded-xl bg-slate-50 p-3 text-xs leading-relaxed text-slate-500">
          This is a same-day booking. You'll collect your token when you arrive and check in at the clinic.
        </p>
      )}

      <div className="mt-4">
        <p className="text-sm font-semibold text-slate-700">Reason for visit (optional)</p>
        <input
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. Fever, follow-up, routine checkup"
          className="mt-1 w-full rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-brand-500"
        />
      </div>

      <div className="mt-4">
        <p className="text-sm font-semibold text-slate-700">Payment method</p>
        <div className="mt-1.5 flex gap-2">
          <button
            onClick={() => changeMethod('online')}
            className={`flex-1 rounded-2xl border px-3 py-2.5 text-sm font-semibold ${
              method === 'online' ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-slate-200 text-slate-500'
            }`}
          >
            Pay online
          </button>
          <button
            onClick={() => changeMethod('cod')}
            className={`flex-1 rounded-2xl border px-3 py-2.5 text-sm font-semibold ${
              method === 'cod' ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-slate-200 text-slate-500'
            }`}
          >
            Cash at clinic
          </button>
        </div>
        {/* What paying online does and does not buy, said up front - so
            nobody arrives expecting to be seen sooner for it. */}
        {method === 'online' ? (
          <p className="mt-1.5 text-xs leading-relaxed text-slate-500">
            You'll complete payment via Razorpay (UPI/card). This only places a <strong>hold</strong> — nothing is
            charged until the clinic accepts your booking. It does <strong>not</strong> move you up the queue — turn
            order follows appointment time, then arrival.
          </p>
        ) : (
          <p className="mt-1.5 text-xs leading-relaxed text-slate-500">
            You'll check in at the counter when you pay. Your place in the queue is the same either way.
          </p>
        )}
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

      {dpdpStatus === 'needed' && (
        <div className="mt-3 rounded-xl border border-slate-200 p-3">
          <p className="text-xs font-bold text-slate-800">Data-sharing consent</p>
          <div className="mt-1 max-h-32 overflow-y-auto whitespace-pre-line text-xs leading-relaxed text-slate-600">
            {DPDP_CONSENT_TEXT}
          </div>
          <label className="mt-2 flex items-start gap-2 text-xs text-slate-700">
            <input
              type="checkbox"
              checked={dpdpChecked}
              onChange={(e) => setDpdpChecked(e.target.checked)}
              className="mt-0.5"
            />
            I consent to this.
          </label>
        </div>
      )}

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      <div className="mt-5 flex gap-2">
        <Button
          onClick={submit}
          disabled={
            loading ||
            members.length === 0 ||
            (declarationStatus === 'needed' && !declarationChecked) ||
            (dpdpStatus === 'needed' && !dpdpChecked)
          }
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
