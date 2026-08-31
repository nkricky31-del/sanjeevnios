import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import AppHeader from '../components/ui/AppHeader';
import Card from '../components/ui/Card';
import { openAppointmentFile } from '../lib/storage';
import { supabase } from '../lib/supabaseClient';
import type { AppointmentFile, AppointmentStatus, FamilyMember, Prescription, Visit } from '../lib/types';
import { useUnreadNotifications } from '../lib/useUnreadNotifications';

interface TimelineAppointment {
  id: string;
  date: string;
  slot_time: string;
  status: AppointmentStatus;
  doctors: { name: string; specialty: string | null } | null;
  clinics: { name: string } | null;
  visits: (Visit & { prescriptions: Prescription[] })[];
  files: AppointmentFile[];
}

const FILE_LABEL: Record<string, string> = {
  lab_report: 'Lab report',
  prescription: 'Prescription',
  xray: 'X-ray',
  photo: 'Photo',
};

export default function Timeline() {
  const navigate = useNavigate();
  const hasUnread = useUnreadNotifications();
  const [members, setMembers] = useState<FamilyMember[]>([]);
  const [memberId, setMemberId] = useState('');
  const [rows, setRows] = useState<TimelineAppointment[]>([]);
  const [loading, setLoading] = useState(true);

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
    if (!memberId) {
      setRows([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    supabase
      .from('appointments')
      .select(
        'id, date, slot_time, status, doctors(name, specialty), clinics(name), visits(id, appointment_id, notes, diagnosis, follow_up_date, created_at, prescriptions(id, visit_id, items, file_url, signed_by, status, created_at)), files(id, member_id, appointment_id, type, storage_path, created_at)'
      )
      .eq('member_id', memberId)
      .order('date', { ascending: false })
      .order('slot_time', { ascending: false })
      .then(({ data }) => {
        setRows((data ?? []) as unknown as TimelineAppointment[]);
        setLoading(false);
      });
  }, [memberId]);

  return (
    <div>
      <AppHeader title="My health timeline" bellDot={hasUnread} onBellClick={() => navigate('/notifications')} />
      <div className="mx-auto max-w-md px-4 py-6">
        {members.length > 0 && (
          <select
            value={memberId}
            onChange={(e) => setMemberId(e.target.value)}
            className="w-full rounded-xl border border-slate-300 px-3 py-2"
          >
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} ({m.relation})
              </option>
            ))}
          </select>
        )}

        <div className="mt-4 space-y-3">
          {loading && <p className="text-sm text-slate-400">Loading...</p>}
          {!loading && rows.length === 0 && <p className="text-sm text-slate-400">No visits yet.</p>}
          {rows.map((r) => {
            const visit = r.visits[0];
            const prescription = visit?.prescriptions[0];
            return (
              <Card key={r.id}>
                <div className="flex items-center justify-between">
                  <p className="font-semibold text-slate-900">{r.doctors?.name}</p>
                  <span className="text-xs font-medium text-slate-500">{r.status}</span>
                </div>
              <p className="text-sm text-slate-500">
                {r.clinics?.name} · {r.date} at {r.slot_time?.slice(0, 5)}
              </p>

              {visit && (visit.diagnosis || visit.notes) && (
                <div className="mt-2 border-t border-slate-100 pt-2">
                  {visit.diagnosis && <p className="text-sm text-brand-700">Diagnosis: {visit.diagnosis}</p>}
                  {visit.notes && <p className="text-sm text-slate-600">{visit.notes}</p>}
                </div>
              )}

              {prescription && prescription.items.length > 0 && (
                <div className="mt-2 border-t border-slate-100 pt-2">
                  <p className="text-xs font-semibold text-slate-700">Prescription</p>
                  {prescription.items.map((d, i) => (
                    <p key={i} className="text-sm text-slate-600">
                      • {d.name} — {d.dosage} · {d.frequency} · {d.durationDays}d
                    </p>
                  ))}
                </div>
              )}

              {r.files.length > 0 && (
                <div className="mt-2 border-t border-slate-100 pt-2">
                  <p className="text-xs font-semibold text-slate-700">Files</p>
                  {r.files.map((f) => (
                    <button
                      key={f.id}
                      onClick={() => openAppointmentFile(f.storage_path)}
                      className="mr-2 mt-1 text-sm font-medium text-brand-600"
                    >
                      {f.type ? FILE_LABEL[f.type] : 'File'}
                    </button>
                  ))}
                </div>
              )}
              </Card>
            );
          })}
        </div>
      </div>
    </div>
  );
}
