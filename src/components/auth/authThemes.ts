import {
  Building2, CalendarCheck, ClipboardList, Clock, FileCheck2, FileText, Fingerprint, HeartPulse,
  KeyRound, Lock, Pill, QrCode, Receipt, ScrollText, ShieldCheck, Stethoscope, Users,
  type LucideIcon,
} from 'lucide-react';

export type AuthRole = 'patient' | 'clinic' | 'admin';

export interface AuthTheme {
  role: AuthRole;
  /** Big word on the left stage (rendered with an accent full stop). */
  word: string;
  /** Small uppercase tag next to the wordmark. */
  tag: string;
  /** CSS colour used as --accent for the whole screen. */
  accent: string;
  headline: [string, string];
  blurb: string;
  /** Three orbits of icons: inner, middle, outer. */
  orbits: { radius: number; duration: number; reverse: boolean; icons: LucideIcon[] }[];
  /** Ring style differs per role so the screens are told apart at a glance. */
  ring: 'solid' | 'dashed' | 'dotted';
  /** The animated side panel: a deep gradient with light, glowing accents. */
  stage: { bg: string; blobA: string; blobB: string; light: string };
  badges: { icon: LucideIcon; lines: [string, string] }[];
}

// Same layout, same components, same motion - three different accents, words,
// icon sets and ring styles. Patient = indigo, clinic = emerald, admin = deep slate.
export const AUTH_THEMES: Record<AuthRole, AuthTheme> = {
  patient: {
    role: 'patient',
    word: 'Patients',
    tag: 'Patient sign-in',
    accent: 'var(--color-primary)',
    headline: ['Your visits,', 'in one place.'],
    blurb: 'Book a verified doctor, follow your live token, and keep every prescription and record together.',
    orbits: [
      { radius: 150, duration: 38, reverse: false, icons: [CalendarCheck, HeartPulse] },
      { radius: 215, duration: 52, reverse: true, icons: [Pill, QrCode, FileText] },
      { radius: 280, duration: 70, reverse: false, icons: [Stethoscope, ShieldCheck] },
    ],
    ring: 'solid',
    stage: {
      bg: 'linear-gradient(150deg, #0a1240 0%, #1d2f8f 48%, #3b5bdb 100%)',
      blobA: 'rgba(124,150,255,0.55)',
      blobB: 'rgba(16,185,129,0.30)',
      light: '#a9bcff',
    },
    badges: [
      { icon: ShieldCheck, lines: ['Secure &', 'encrypted'] },
      { icon: FileText, lines: ['Your records,', 'your consent'] },
      { icon: Lock, lines: ['Privacy', 'first'] },
    ],
  },
  clinic: {
    role: 'clinic',
    word: 'Clinics',
    tag: 'Clinic console',
    accent: 'var(--color-leaf-text)',
    headline: ['Run the', 'whole visit.'],
    blurb: 'Check-in, the live queue, consultation notes and prescriptions from the front desk to the doctor.',
    orbits: [
      { radius: 150, duration: 38, reverse: true, icons: [Clock, ClipboardList] },
      { radius: 215, duration: 52, reverse: false, icons: [Users, Receipt, FileCheck2] },
      { radius: 280, duration: 70, reverse: true, icons: [Building2, Stethoscope] },
    ],
    ring: 'dashed',
    stage: {
      bg: 'linear-gradient(150deg, #04261d 0%, #065f46 52%, #0f9f74 100%)',
      blobA: 'rgba(52,211,153,0.50)',
      blobB: 'rgba(96,165,250,0.28)',
      light: '#6ee7b7',
    },
    badges: [
      { icon: ShieldCheck, lines: ['Secure &', 'encrypted'] },
      { icon: FileCheck2, lines: ['Document', 'verified'] },
      { icon: Lock, lines: ['Clinic data', 'isolated'] },
    ],
  },
  admin: {
    role: 'admin',
    word: 'Admin',
    tag: 'Restricted',
    accent: 'var(--color-admin)',
    headline: ['Restricted', 'console.'],
    blurb: 'Authorised staff only. Sign-in needs your authenticator app, and every action is logged.',
    orbits: [
      { radius: 150, duration: 60, reverse: false, icons: [Lock, KeyRound] },
      { radius: 215, duration: 80, reverse: true, icons: [ScrollText, Fingerprint] },
      { radius: 280, duration: 100, reverse: false, icons: [ShieldCheck] },
    ],
    ring: 'dotted',
    stage: {
      bg: 'linear-gradient(150deg, #04060c 0%, #0f1729 52%, #27364d 100%)',
      blobA: 'rgba(125,211,252,0.34)',
      blobB: 'rgba(129,140,248,0.26)',
      light: '#8fd8ff',
    },
    badges: [
      { icon: KeyRound, lines: ['Restricted', 'access'] },
      { icon: ScrollText, lines: ['Every action', 'logged'] },
      { icon: Lock, lines: ['Break-glass', 'only'] },
    ],
  },
};
