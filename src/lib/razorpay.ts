import { supabase } from './supabaseClient';

// supabase-js's own error.message for a non-2xx function response is always
// the generic "Edge Function returned a non-2xx status code" - the actual
// reason (what each razorpay-* function put in its own JSON error body) is
// only reachable via error.context, the raw fetch Response. Every call site
// below was silently discarding that until now, which is exactly why "Edge
// Function returned a non-2xx status code" with no further detail was all
// that ever surfaced to a user - this reads the real body instead.
async function describeFunctionError(error: unknown): Promise<string> {
  const context = (error as { context?: unknown } | null)?.context;
  if (context instanceof Response) {
    try {
      const body = await context.clone().json();
      if (typeof body?.error === 'string') return body.error;
    } catch {
      // Not JSON (or already consumed) - fall through to the text body.
    }
    try {
      const text = await context.clone().text();
      if (text) return text;
    } catch {
      // Body unreadable - fall through to the generic message below.
    }
  }
  return error instanceof Error ? error.message : 'Something went wrong.';
}

// Minimal shape of the global Checkout.js exposes - not an official types
// package, just the handful of fields this app actually uses.
declare global {
  interface Window {
    Razorpay?: new (options: RazorpayCheckoutOptions) => { open: () => void };
  }
}

interface RazorpayCheckoutOptions {
  key: string;
  // Exactly one of these two pairs is set - order_id/amount for a one-off
  // payment (booking checkout), subscription_id for a recurring mandate
  // (clinic billing).
  order_id?: string;
  amount?: number;
  subscription_id?: string;
  currency: string;
  name: string;
  description?: string;
  prefill?: { contact?: string };
  handler: (response: RazorpaySuccessResult) => void;
  modal?: { ondismiss?: () => void };
}

export interface RazorpaySuccessResult {
  razorpay_payment_id: string;
  // Present for a one-off order checkout.
  razorpay_order_id?: string;
  // Present for a subscription checkout instead.
  razorpay_subscription_id?: string;
  razorpay_signature: string;
}

const CHECKOUT_SCRIPT_URL = 'https://checkout.razorpay.com/v1/checkout.js';
let loadPromise: Promise<boolean> | null = null;

// Loaded on demand, not from index.html - most visits never open Checkout at
// all (COD, or just browsing), so there's no reason to fetch Razorpay's
// script on every page load.
export function loadRazorpayScript(): Promise<boolean> {
  if (window.Razorpay) return Promise.resolve(true);
  if (loadPromise) return loadPromise;
  loadPromise = new Promise((resolve) => {
    const script = document.createElement('script');
    script.src = CHECKOUT_SCRIPT_URL;
    script.onload = () => resolve(true);
    script.onerror = () => resolve(false);
    document.body.appendChild(script);
  });
  return loadPromise;
}

interface OpenCheckoutArgs {
  keyId: string;
  orderId: string;
  amountPaise: number;
  patientPhone?: string | null;
  onSuccess: (result: RazorpaySuccessResult) => void;
  onDismiss: () => void;
}

export function openRazorpayCheckout(args: OpenCheckoutArgs): void {
  if (!window.Razorpay) {
    args.onDismiss();
    return;
  }
  const rzp = new window.Razorpay({
    key: args.keyId,
    order_id: args.orderId,
    amount: args.amountPaise,
    currency: 'INR',
    name: 'Sanjeevnios',
    description: 'Appointment booking',
    prefill: args.patientPhone ? { contact: args.patientPhone } : undefined,
    handler: args.onSuccess,
    modal: { ondismiss: args.onDismiss },
  });
  rzp.open();
}

interface OpenSubscriptionCheckoutArgs {
  keyId: string;
  subscriptionId: string;
  planName: string;
  ownerPhone?: string | null;
  onSuccess: (result: RazorpaySuccessResult) => void;
  onDismiss: () => void;
}

// Subscription checkout only ever sets up the recurring mandate (UPI Autopay
// or a card e-mandate) - it does not, by itself, prove anything to this app.
// The handler below is purely a UX nicety ("thanks, confirming now..."); the
// only thing that actually flips billing state is razorpay-webhook once
// Razorpay's own subscription.charged event lands - see that function's
// header for why a client-side callback is never trusted for this.
export function openRazorpaySubscriptionCheckout(args: OpenSubscriptionCheckoutArgs): void {
  if (!window.Razorpay) {
    args.onDismiss();
    return;
  }
  const rzp = new window.Razorpay({
    key: args.keyId,
    subscription_id: args.subscriptionId,
    currency: 'INR',
    name: 'Sanjeevnios',
    description: `${args.planName} plan subscription`,
    prefill: args.ownerPhone ? { contact: args.ownerPhone } : undefined,
    handler: args.onSuccess,
    modal: { ondismiss: args.onDismiss },
  });
  rzp.open();
}

export type CreateSubscriptionResult =
  | { subscriptionId: string; keyId: string; assignedDirectly?: false }
  // A free (₹0) plan never touches Razorpay - see razorpay-create-subscription's
  // own comment on why. The caller should skip opening Checkout entirely.
  | { assignedDirectly: true };

export async function createRazorpaySubscription(
  clinicId: string,
  planId: string
): Promise<CreateSubscriptionResult | { error: string }> {
  const { data, error } = await supabase.functions.invoke('razorpay-create-subscription', {
    body: { clinicId, planId },
  });
  if (error) return { error: await describeFunctionError(error) };
  const result = data as { subscriptionId?: string; keyId?: string; assignedDirectly?: boolean; error?: string };
  if (result.error) return { error: result.error };
  if (result.assignedDirectly) return { assignedDirectly: true };
  if (!result.subscriptionId || !result.keyId) return { error: 'Could not start the subscription.' };
  return { subscriptionId: result.subscriptionId, keyId: result.keyId };
}

export interface CreateOrderResult {
  orderId: string;
  amountPaise: number;
  keyId: string;
}

export async function createRazorpayOrder(appointmentId: string): Promise<CreateOrderResult | { error: string }> {
  const { data, error } = await supabase.functions.invoke('razorpay-create-order', {
    body: { appointmentId },
  });
  if (error) return { error: await describeFunctionError(error) };
  const result = data as { orderId?: string; amount?: number; keyId?: string; error?: string };
  if (result.error || !result.orderId || !result.keyId) {
    return { error: result.error ?? 'Could not start online payment.' };
  }
  return { orderId: result.orderId, amountPaise: result.amount ?? 0, keyId: result.keyId };
}

export async function verifyRazorpayPayment(
  appointmentId: string,
  success: RazorpaySuccessResult
): Promise<{ verified: boolean; error?: string }> {
  const { data, error } = await supabase.functions.invoke('razorpay-verify-payment', {
    body: {
      appointmentId,
      razorpayOrderId: success.razorpay_order_id,
      razorpayPaymentId: success.razorpay_payment_id,
      razorpaySignature: success.razorpay_signature,
    },
  });
  if (error) return { verified: false, error: await describeFunctionError(error) };
  const result = data as { verified?: boolean; error?: string };
  return { verified: !!result.verified, error: result.error };
}

// Called from ClinicQueue.tsx's acceptAppointment, before the appointment's
// status is flipped to 'accepted'. See razorpay-capture-payment's own header
// comment for why the ordering matters.
export async function captureRazorpayPayment(appointmentId: string): Promise<{ captured: boolean; error?: string }> {
  const { data, error } = await supabase.functions.invoke('razorpay-capture-payment', {
    body: { appointmentId },
  });
  if (error) return { captured: false, error: await describeFunctionError(error) };
  const result = data as { captured?: boolean; error?: string };
  return { captured: !!result.captured, error: result.error };
}
