import { ArrowLeft, Maximize2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { useAuth } from '../lib/AuthContext';
import { todayISO } from '../lib/date';
import { supabase } from '../lib/supabaseClient';
import type { AppointmentStatus } from '../lib/types';

interface BoardRow {
  id: string;
  token_number: number | null;
  status: AppointmentStatus;
  doctor_id: string;
  doctors: { name: string } | null;
}

const LIVE_STATUSES: AppointmentStatus[] = ['checked_in', 'called', 'in_consultation'];

// The screen that faces the waiting room. Deliberately its own route rather
// than a panel inside the console: it's meant to be thrown onto a second
// monitor or a TV, so it carries no navigation, no patient names (a waiting
// room is a public space - a token number identifies you to yourself and to
// nobody else), and text large enough to read from across the room.
//
// Clinic-wide, not per-doctor: tokens are issued per clinic, and the board is
// what a patient looks up at regardless of which doctor they're waiting for.
export default function TokenBoard() {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const [clinicId, setClinicId] = useState<string | null>(null);
  const [clinicName, setClinicName] = useState('');
  const [rows, setRows] = useState<BoardRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(() => new Date());

  const today = todayISO();

  useEffect(() => {
    if (!profile) return;
    supabase
      .from('clinics')
      .select('id, name')
      .eq('owner_id', profile.id)
      .maybeSingle()
      .then(({ data }) => {
        setClinicId(data?.id ?? null);
        setClinicName(data?.name ?? '');
        if (!data) setLoading(false);
      });
  }, [profile]);

  const load = useCallback(async () => {
    if (!clinicId) return;
    // Ordered by the fair-queue rule, not by token: a punctual 3PM patient is
    // ahead of a punctual 4PM one even if the 4PM patient arrived first and
    // holds the lower number. The board must agree with the desk and the
    // patient's phone, so it sorts on the same two columns they do.
    const { data } = await supabase
      .from('appointments')
      .select('id, token_number, status, doctor_id, doctors(name)')
      .eq('clinic_id', clinicId)
      .eq('date', today)
      .in('status', LIVE_STATUSES)
      .order('effective_order_time', { ascending: true })
      .order('checked_in_at', { ascending: true });
    setRows((data ?? []) as unknown as BoardRow[]);
    setLoading(false);
  }, [clinicId, today]);

  useEffect(() => {
    load();
  }, [load]);

  // Poll as a safety net on top of the realtime channels below - a board left
  // running all day on a TV must not quietly go stale if a socket drops.
  useEffect(() => {
    const timer = setInterval(() => {
      load();
      setNow(new Date());
    }, 15000);
    return () => clearInterval(timer);
  }, [load]);

  // One channel per doctor working today: the queue broadcast is keyed by
  // doctor+date (see broadcast_appointment_queue_change in schema.sql), so a
  // clinic-wide board has to listen to each of them.
  useEffect(() => {
    if (!clinicId) return;
    const doctorIds = [...new Set(rows.map((r) => r.doctor_id))];
    if (doctorIds.length === 0) return;

    supabase.realtime.setAuth();
    const channels = doctorIds.map((id) =>
      supabase
        .channel(`queue:${id}:${today}`)
        .on('broadcast', { event: 'UPDATE' }, () => load())
        .on('broadcast', { event: 'INSERT' }, () => load())
        .subscribe()
    );
    return () => {
      channels.forEach((c) => supabase.removeChannel(c));
    };
    // rows.length keeps the subscription set in step as new doctors appear
    // without resubscribing on every single row change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clinicId, today, rows.length, load]);

  const serving = rows.filter((r) => r.status === 'called' || r.status === 'in_consultation');
  const waiting = rows.filter((r) => r.status === 'checked_in');
  const nowServing = serving[0]?.token_number ?? null;

  const goFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.();
  };

  return (
    <div className="min-h-screen bg-slate-900 text-white">
      <div className="flex items-center justify-between px-6 py-4">
        <button
          onClick={() => navigate('/')}
          className="inline-flex items-center gap-1.5 text-sm font-semibold text-white/50 hover:text-white"
        >
          <ArrowLeft size={16} /> Back to console
        </button>
        <p className="truncate text-sm font-semibold text-white/60">{clinicName}</p>
        <button
          onClick={goFullscreen}
          aria-label="Toggle fullscreen"
          className="rounded-full p-2 text-white/50 hover:bg-white/10 hover:text-white"
        >
          <Maximize2 size={18} />
        </button>
      </div>

      <div className="mx-auto max-w-4xl px-6 pb-10">
        {/* Now serving */}
        <div className="rounded-[2rem] bg-gradient-to-b from-brand-600 to-brand-700 px-6 py-10 text-center shadow-2xl shadow-brand-900/40">
          <p className="text-lg font-bold uppercase tracking-[0.2em] text-white/70">Now serving</p>
          <p className="mt-2 text-[9rem] font-extrabold leading-none tracking-tight">
            {nowServing ?? '—'}
          </p>
          {serving[0]?.doctors?.name && (
            <p className="mt-2 text-xl font-semibold text-white/80">{serving[0].doctors.name}</p>
          )}
        </div>

        {/* Also in with a doctor (a clinic can run more than one room) */}
        {serving.length > 1 && (
          <div className="mt-4 flex flex-wrap justify-center gap-3">
            {serving.slice(1).map((r) => (
              <div key={r.id} className="rounded-2xl bg-white/10 px-6 py-4 text-center">
                <p className="text-4xl font-extrabold">{r.token_number}</p>
                {r.doctors?.name && <p className="mt-1 text-sm text-white/60">{r.doctors.name}</p>}
              </div>
            ))}
          </div>
        )}

        {/* Next up */}
        <p className="mt-10 text-center text-lg font-bold uppercase tracking-[0.2em] text-white/50">Next</p>
        <div className="mt-4 flex flex-wrap justify-center gap-4">
          {loading && <p className="text-white/40">Loading...</p>}
          {!loading && waiting.length === 0 && (
            <p className="text-xl text-white/40">No one else waiting right now.</p>
          )}
          {waiting.slice(0, 6).map((r, i) => (
            <div
              key={r.id}
              className={`rounded-3xl px-8 py-6 text-center ${
                i === 0 ? 'bg-white text-brand-700' : 'bg-white/10 text-white'
              }`}
            >
              <p className="text-6xl font-extrabold leading-none">{r.token_number}</p>
              {r.doctors?.name && (
                <p className={`mt-2 text-sm ${i === 0 ? 'text-brand-600' : 'text-white/50'}`}>{r.doctors.name}</p>
              )}
            </div>
          ))}
        </div>

        {waiting.length > 6 && (
          <p className="mt-6 text-center text-white/40">+{waiting.length - 6} more waiting</p>
        )}

        <p className="mt-10 text-center text-sm text-white/30">
          Updated {now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' })} ·
          Tokens are issued in arrival order
        </p>
      </div>
    </div>
  );
}
