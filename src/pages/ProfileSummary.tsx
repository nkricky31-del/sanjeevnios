import { ArrowLeft, BadgeCheck, CalendarDays, FileText, FlaskConical, Users, Wallet, type LucideIcon } from 'lucide-react';
import { motion } from 'motion/react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { Panel } from '../components/AdminDrill';
import HeroBand from '../components/ui/HeroBand';
import { Columns, Donut } from '../components/ui/MiniCharts';
import { CountUp } from '../lib/motionKit';
import { useAuth } from '../lib/AuthContext';
import { supabase } from '../lib/supabaseClient';
import type { FamilyMember } from '../lib/types';

const monthKeys = (n: number) =>
  Array.from({ length: n }, (_, i) => {
    const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - (n - 1 - i));
    return { key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, label: d.toLocaleDateString(undefined, { month: 'short' }) };
  });

// The page behind the identity card on Profile: the same numbers, opened up
// into charts, plus the people on the account.
export default function ProfileSummary() {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const [appts, setAppts] = useState<{ date: string; status: string }[]>([]);
  const [pays, setPays] = useState<{ amount: number; status: string; created_at: string }[]>([]);
  const [files, setFiles] = useState<{ type: string | null }[]>([]);
  const [members, setMembers] = useState<FamilyMember[]>([]);

  useEffect(() => {
    (async () => {
      const [a, p, f, m] = await Promise.all([
        supabase.from('appointments').select('date, status').limit(1000),
        supabase.from('payments').select('amount, status, created_at').limit(1000),
        supabase.from('files').select('type').limit(1000),
        supabase.from('family_members').select('*').order('created_at', { ascending: true }),
      ]);
      setAppts((a.data ?? []) as typeof appts);
      setPays((p.data ?? []) as typeof pays);
      setFiles((f.data ?? []) as typeof files);
      setMembers((m.data ?? []) as FamilyMember[]);
    })();
  }, []);

  const spent = pays.filter((p) => p.status === 'captured').reduce((n, p) => n + Number(p.amount), 0);
  const labs = files.filter((f) => f.type === 'lab_report').length;
  const months = monthKeys(6);
  const outcomes = Object.entries(appts.reduce<Record<string, number>>((m, a) => { m[a.status] = (m[a.status] ?? 0) + 1; return m; }, {})).map(([k, v]) => ({
    label: k.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()), value: v,
    color: ({ completed: '#10b981', cancelled: '#f43f5e', no_show: '#94a3b8', rejected: '#fb7185', booked: '#f59e0b', accepted: '#6366f1' } as Record<string, string>)[k],
  }));
  const tiles: { icon: LucideIcon; label: string; value: number | string; to: string; grad: string }[] = [
    { icon: CalendarDays, label: 'Appointments', value: appts.length, to: '/bookings', grad: 'from-indigo-500 to-sky-500' },
    { icon: FileText, label: 'Records', value: files.length, to: '/records', grad: 'from-emerald-500 to-lime-400' },
    { icon: FlaskConical, label: 'Lab reports', value: labs, to: '/records/lab_report', grad: 'from-sky-500 to-teal-500' },
    { icon: Wallet, label: 'Total spent', value: `₹${spent.toLocaleString('en-IN')}`, to: '/payments', grad: 'from-pink-500 to-violet-500' },
  ];

  return (
    <div>
      <HeroBand>
        <button type="button" onClick={() => navigate('/profile')} className="mb-4 inline-flex cursor-pointer items-center gap-1.5 rounded-full bg-white/15 px-3 py-1.5 text-xs font-semibold text-white ring-1 ring-white/25 backdrop-blur">
          <ArrowLeft size={14} /> Profile
        </button>
        <div className="flex items-center gap-4">
          <motion.span initial={{ scale: 0, rotate: -20 }} animate={{ scale: 1, rotate: 0 }} transition={{ type: 'spring', stiffness: 240, damping: 14 }} className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-white/20 text-2xl font-extrabold ring-2 ring-white/40">
            {(profile?.name ?? '?').charAt(0).toUpperCase()}
          </motion.span>
          <div className="min-w-0">
            <h1 className="truncate font-display text-2xl font-bold tracking-[-0.02em]">{profile?.name ?? 'Your account'}</h1>
            <p className="text-sm text-white/80">+{profile?.phone}</p>
            <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-white/20 px-2.5 py-0.5 text-xs font-bold"><BadgeCheck size={13} /> Verified Patient</span>
          </div>
        </div>
      </HeroBand>

      <div className="px-4 pb-8">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {tiles.map((t, i) => (
            <motion.button
              key={t.label}
              type="button"
              onClick={() => navigate(t.to)}
              data-fx="own"
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.07 }}
              whileHover={{ y: -4, scale: 1.02 }}
              whileTap={{ scale: 0.97 }}
              className={`cursor-pointer rounded-2xl bg-gradient-to-br ${t.grad} p-4 text-left text-white shadow-lg`}
            >
              <t.icon size={20} />
              <p className="mt-2 font-display text-2xl font-extrabold">{typeof t.value === 'number' ? <CountUp value={t.value} /> : t.value}</p>
              <p className="text-xs text-white/80">{t.label}</p>
            </motion.button>
          ))}
        </div>

        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <Panel title="Visits by outcome">{outcomes.length ? <Donut data={outcomes} centre="visits" /> : <p className="text-sm text-slate-400">No visits yet.</p>}</Panel>
          <Panel title="Visits per month" delay={0.08}><Columns color="#6366f1" data={months.map((m) => ({ label: m.label, value: appts.filter((a) => a.date.startsWith(m.key)).length }))} /></Panel>
          <Panel title="Paid per month (₹)" delay={0.12}><Columns color="#ec4899" data={months.map((m) => ({ label: m.label, value: Math.round(pays.filter((p) => p.status === 'captured' && p.created_at.startsWith(m.key)).reduce((n, p) => n + Number(p.amount), 0)) }))} /></Panel>
          <Panel title="People on this account" delay={0.16}>
            <div className="space-y-2">
              {members.map((m) => (
                <button key={m.id} type="button" onClick={() => navigate('/profile')} data-fx="own" className="flex w-full cursor-pointer items-center gap-3 rounded-xl bg-slate-50 p-3 text-left transition hover:bg-indigo-50">
                  <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-500 text-white"><Users size={16} /></span>
                  <span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold text-slate-900">{m.name}</span><span className="block font-mono text-[11px] text-slate-400">{m.mrn}</span></span>
                </button>
              ))}
              {members.length === 0 && <p className="text-sm text-slate-400">No one added yet.</p>}
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}
