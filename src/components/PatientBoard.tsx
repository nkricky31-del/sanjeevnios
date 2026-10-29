import { CheckCircle2, ChevronLeft, ChevronRight, RefreshCw, Search, SlidersHorizontal, X, XCircle } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { addDaysISO, todayISO } from '../lib/date';
import { withPatientContacts } from '../lib/patientContact';
import { BOARD_COLUMNS, BOARD_STATUS, isCancelled, isCheckedIn, timeOf, type BoardRow } from '../lib/patientBoard';
import { bookingReference } from '../lib/queue';
import { screenCache } from '../lib/screenCache';
import { supabase } from '../lib/supabaseClient';
import { formatTimeLabel } from '../lib/time';
import PatientBoardDetail from './PatientBoardDetail';
import StatusPill from './ui/StatusPill';

type Arrival = 'all' | 'in' | 'out';
type SortKey = 'slot' | 'checkin' | 'name' | 'doctor';
const PAGE_SIZE = 25;

interface Props {
  clinicId: string;
  doctors: { id: string; name: string }[];
}

// The clinic's day board: every patient booked for a date, across all
// doctors, with a tick (checked in) or a cross (not yet), their appointment
// time, when they checked in, and the doctor. Tapping a patient opens their
// details in a slide-over (PatientBoardDetail).
export default function PatientBoard({ clinicId, doctors }: Props) {
  const [date, setDate] = useState(todayISO);
  // Shown at once from the last look at today's board (lib/screenCache.ts).
  const cachedRows = screenCache.get<BoardRow[]>(`board:${clinicId}:${todayISO()}`);
  const [rows, setRows] = useState<BoardRow[]>(cachedRows ?? []);
  const [loading, setLoading] = useState(!cachedRows);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [doctorFilter, setDoctorFilter] = useState<string>('all');
  const [arrival, setArrival] = useState<Arrival>('all');
  const [showCancelled, setShowCancelled] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'slot', dir: 1 });
  const [page, setPage] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const isToday = date === todayISO();

  const load = useCallback(async () => {
    setError(null);
    const { data, error: loadError } = await supabase
      .from('appointments')
      .select(BOARD_COLUMNS)
      .eq('clinic_id', clinicId)
      .eq('date', date)
      .order('slot_time', { ascending: true });
    if (loadError) {
      setError("Couldn't load the patient list.");
      setLoading(false);
      return;
    }
    const fresh = await withPatientContacts((data ?? []) as unknown as Omit<BoardRow, 'family_members'>[]);
    setRows(fresh);
    setLoading(false);
    screenCache.set(`board:${clinicId}:${date}`, fresh);
  }, [clinicId, date]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  // Switching day shows the loading rows and starts from page 1.
  const goToDate = (d: string) => {
    if (!d || d === date) return;
    setLoading(true);
    setPage(0);
    setDate(d);
  };

  // Today's board keeps itself current as patients arrive.
  useEffect(() => {
    if (!isToday) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [isToday, load]);

  // "/" jumps to search, unless the person is already typing somewhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const doctorName = (id: string) => doctors.find((d) => d.id === id)?.name ?? 'Doctor';

  const dayRows = rows.filter((r) => showCancelled || !isCancelled(r));
  const counted = rows.filter((r) => !isCancelled(r));
  const checkedInCount = counted.filter(isCheckedIn).length;

  const visible = (() => {
    const q = search.trim().toLowerCase();
    const filtered = dayRows.filter((r) => {
      if (doctorFilter !== 'all' && r.doctor_id !== doctorFilter) return false;
      if (arrival === 'in' && !isCheckedIn(r)) return false;
      if (arrival === 'out' && isCheckedIn(r)) return false;
      if (!q) return true;
      const p = r.family_members;
      return [p?.name, p?.phone, p?.mrn, bookingReference(r.id), r.token_number?.toString()]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q));
    });
    const key = (r: BoardRow): string => {
      switch (sort.key) {
        case 'checkin':
          return r.checked_in_at ?? '￿';
        case 'name':
          return (r.family_members?.name ?? '').toLowerCase();
        case 'doctor':
          return (r.doctors?.name ?? doctorName(r.doctor_id)).toLowerCase() + r.slot_time;
        default:
          return r.slot_time;
      }
    };
    return [...filtered].sort((a, b) => (key(a) < key(b) ? -sort.dir : key(a) > key(b) ? sort.dir : 0));
  })();

  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = visible.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  const chips: { label: string; clear: () => void }[] = [];
  if (doctorFilter !== 'all') chips.push({ label: `Doctor: ${doctorName(doctorFilter)}`, clear: () => setDoctorFilter('all') });
  if (arrival !== 'all')
    chips.push({ label: arrival === 'in' ? 'Checked in' : 'Not checked in', clear: () => setArrival('all') });
  if (showCancelled) chips.push({ label: 'Including cancelled', clear: () => setShowCancelled(false) });
  const clearAll = () => {
    setDoctorFilter('all');
    setArrival('all');
    setShowCancelled(false);
    setSearch('');
  };

  const toggleSort = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: 1 }));
  const ariaSort = (key: SortKey) => (sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none');
  const sortHead = (k: SortKey, children: string, extra = '') => (
    <th scope="col" aria-sort={ariaSort(k)} className={`px-3 py-2.5 ${extra}`}>
      <button
        type="button"
        onClick={() => toggleSort(k)}
        className="inline-flex items-center gap-1 font-semibold uppercase tracking-wide outline-none hover:text-slate-700 focus-visible:text-slate-900"
      >
        {children}
        <span aria-hidden className={sort.key === k ? 'text-brand-600' : 'text-transparent'}>
          {sort.dir === 1 ? '▲' : '▼'}
        </span>
      </button>
    </th>
  );

  const prettyDate = new Date(date + 'T00:00:00').toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
  const openRow = rows.find((r) => r.id === openId) ?? null;

  return (
    <div className="mx-auto max-w-6xl">
      {/* Header: title, one sentence, and the day being shown */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-bold text-slate-900">Patient board</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Every patient booked for the day, across all doctors — who has checked in and who hasn't.
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => goToDate(addDaysISO(date, -1))}
            aria-label="Previous day"
            title="Previous day"
            className="rounded-xl border border-slate-200 bg-white p-2 text-slate-600 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            <ChevronLeft size={16} />
          </button>
          <label className="sr-only" htmlFor="board-date">
            Date
          </label>
          <input
            id="board-date"
            type="date"
            value={date}
            onChange={(e) => goToDate(e.target.value)}
            className="rounded-xl border border-slate-200 bg-white px-2.5 py-1.5 text-sm font-semibold text-slate-800 outline-none focus:ring-2 focus:ring-brand-500"
          />
          <button
            type="button"
            onClick={() => goToDate(addDaysISO(date, 1))}
            aria-label="Next day"
            title="Next day"
            className="rounded-xl border border-slate-200 bg-white p-2 text-slate-600 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            <ChevronRight size={16} />
          </button>
          {!isToday && (
            <button
              type="button"
              onClick={() => goToDate(todayISO())}
              aria-label="Go to today"
              className="rounded-xl px-2.5 py-1.5 text-sm font-semibold text-brand-600 outline-none hover:bg-brand-50 focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              Today
            </button>
          )}
        </div>
      </div>

      <p className="mt-3 text-sm text-slate-600" aria-live="polite">
        <span className="font-semibold text-slate-900">{prettyDate}</span>
        {!loading && !error && (
          <>
            {' '}· {counted.length} patient{counted.length === 1 ? '' : 's'} ·{' '}
            <span className="font-semibold text-emerald-700">{checkedInCount} checked in</span> ·{' '}
            <span className="font-semibold text-rose-600">{counted.length - checkedInCount} not checked in</span>
          </>
        )}
      </p>

      {/* Toolbar: search, one Filters control, refresh */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <label className="flex min-w-[220px] flex-1 items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 focus-within:ring-2 focus-within:ring-brand-500">
          <Search size={16} className="shrink-0 text-slate-400" aria-hidden />
          <span className="shrink-0 text-sm font-medium text-slate-500">Search</span>
          <input
            ref={searchRef}
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(0);
            }}
            placeholder="Name, phone, MRN or booking ref"
            className="w-full min-w-0 bg-transparent py-2 text-sm outline-none placeholder:text-slate-400"
          />
          <kbd className="hidden shrink-0 rounded border border-slate-200 px-1.5 text-[11px] text-slate-400 sm:inline">/</kbd>
        </label>
        <button
          type="button"
          onClick={() => setFiltersOpen((o) => !o)}
          aria-expanded={filtersOpen}
          aria-controls="board-filters"
          className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-2 text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
            filtersOpen || chips.length > 0 ? 'border-brand-600 text-brand-700' : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
          }`}
        >
          <SlidersHorizontal size={15} /> Filters{chips.length > 0 ? ` (${chips.length})` : ''}
        </button>
        <button
          type="button"
          onClick={() => {
            setLoading(true);
            void load();
          }}
          aria-label="Refresh list"
          title="Refresh list"
          className="rounded-xl border border-slate-200 bg-white p-2 text-slate-600 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {filtersOpen && (
        <div id="board-filters" className="mt-2 grid gap-3 rounded-2xl border border-slate-200 bg-white p-3 sm:grid-cols-3">
          <div>
            <label htmlFor="board-doctor" className="text-xs font-semibold text-slate-600">
              Doctor
            </label>
            <select
              id="board-doctor"
              value={doctorFilter}
              onChange={(e) => {
                setDoctorFilter(e.target.value);
                setPage(0);
              }}
              className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-2.5 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-500"
            >
              <option value="all">All doctors</option>
              {doctors.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="board-arrival" className="text-xs font-semibold text-slate-600">
              Check-in
            </label>
            <select
              id="board-arrival"
              value={arrival}
              onChange={(e) => {
                setArrival(e.target.value as Arrival);
                setPage(0);
              }}
              className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-2.5 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-500"
            >
              <option value="all">Everyone</option>
              <option value="in">Checked in</option>
              <option value="out">Not checked in</option>
            </select>
          </div>
          <label className="flex items-center gap-2 self-end pb-2 text-sm text-slate-700">
            <input type="checkbox" checked={showCancelled} onChange={(e) => setShowCancelled(e.target.checked)} />
            Show cancelled bookings
          </label>
        </div>
      )}

      {chips.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {chips.map((c) => (
            <button
              key={c.label}
              type="button"
              onClick={c.clear}
              className="inline-flex items-center gap-1 rounded-full bg-brand-50 px-2.5 py-1 text-xs font-semibold text-brand-700 hover:bg-brand-100"
            >
              {c.label} <X size={12} aria-label="Remove filter" />
            </button>
          ))}
          <button type="button" onClick={clearAll} className="text-xs font-semibold text-slate-500 underline">
            Clear all
          </button>
        </div>
      )}

      {/* The list - always inside its frame, empty and loading states too */}
      <div className="mt-3 overflow-hidden rounded-2xl border border-slate-200 bg-white">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="sticky top-0 z-[1] bg-slate-50 text-xs text-slate-500">
              <tr>
                {sortHead('name', 'Patient', 'sticky left-0 z-[2] bg-slate-50')}
                {sortHead('slot', 'Appointment')}
                {sortHead('checkin', 'Checked in')}
                {sortHead('doctor', 'Doctor')}
                <th scope="col" className="px-3 py-2.5 font-semibold uppercase tracking-wide">
                  Status
                </th>
                <th scope="col" className="px-3 py-2.5 font-semibold uppercase tracking-wide">
                  Token
                </th>
                <th scope="col" className="w-8 px-2 py-2.5">
                  <span className="sr-only">Open</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading &&
                rows.length === 0 &&
                [0, 1, 2].map((i) => (
                  <tr key={i} aria-hidden>
                    {[0, 1, 2, 3, 4, 5, 6].map((c) => (
                      <td key={c} className="px-3 py-3">
                        <span className="block h-3.5 w-full max-w-[120px] animate-pulse rounded bg-slate-100" />
                      </td>
                    ))}
                  </tr>
                ))}

              {!loading && error && (
                <tr>
                  <td colSpan={7} className="px-3 py-8 text-center text-sm text-slate-500">
                    {error}{' '}
                    <button type="button" onClick={() => void load()} className="font-semibold text-brand-600 underline">
                      Try again
                    </button>
                  </td>
                </tr>
              )}

              {!loading && !error && visible.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-10 text-center">
                    {dayRows.length === 0 ? (
                      <p className="text-sm text-slate-500">No patients are booked for {prettyDate}.</p>
                    ) : (
                      <p className="text-sm text-slate-500">
                        No patients match.{' '}
                        <button type="button" onClick={clearAll} className="font-semibold text-brand-600 underline">
                          Clear search and filters
                        </button>
                      </p>
                    )}
                  </td>
                </tr>
              )}

              {!error &&
                pageRows.map((r) => {
                  const inNow = isCheckedIn(r);
                  const cancelled = isCancelled(r);
                  const st = BOARD_STATUS[r.status];
                  const p = r.family_members;
                  return (
                    <tr
                      key={r.id}
                      onClick={() => setOpenId(r.id)}
                      className={`group cursor-pointer hover:bg-brand-50/40 ${cancelled ? 'opacity-60' : ''}`}
                    >
                      <td className="sticky left-0 z-[1] bg-white px-3 py-2.5 group-hover:bg-brand-50/40">
                        <div className="flex items-center gap-2.5">
                          {inNow ? (
                            <CheckCircle2 size={20} className="shrink-0 text-emerald-600" aria-hidden />
                          ) : (
                            <XCircle size={20} className={`shrink-0 ${cancelled ? 'text-slate-400' : 'text-rose-500'}`} aria-hidden />
                          )}
                          {/* The icon is decorative to screen readers; this says it. */}
                          <span className="sr-only">{inNow ? 'Checked in' : 'Not checked in'}</span>
                          <span className="min-w-0">
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setOpenId(r.id);
                              }}
                              className="block max-w-[200px] truncate text-left font-semibold text-brand-700 underline-offset-2 outline-none hover:underline focus-visible:underline"
                            >
                              {p?.name ?? 'Patient'}
                            </button>
                            <span className="block truncate text-xs text-slate-500">
                              {[p?.mrn, p?.age != null ? `${p.age}y` : null, p?.gender].filter(Boolean).join(' · ')}
                            </span>
                          </span>
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5 font-medium text-slate-800">{formatTimeLabel(r.slot_time)}</td>
                      <td className="whitespace-nowrap px-3 py-2.5">
                        {r.checked_in_at ? (
                          <span className="font-medium text-emerald-700">
                            {timeOf(r.checked_in_at)}
                            {r.was_late && <span className="ml-1 text-xs font-normal text-amber-600">(late)</span>}
                          </span>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-slate-700">{r.doctors?.name ?? doctorName(r.doctor_id)}</td>
                      <td className="whitespace-nowrap px-3 py-2.5">
                        <StatusPill label={st.label} tone={st.tone} />
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5 font-mono font-bold text-slate-800">
                        {r.token_number != null ? `#${r.token_number}` : <span className="font-sans font-normal text-slate-400">—</span>}
                      </td>
                      <td className="px-2 py-2.5 text-slate-300 group-hover:text-brand-500">
                        <ChevronRight size={16} aria-hidden />
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>

        {/* Pagination - always shown */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 px-3 py-2.5 text-xs text-slate-500">
          <span>
            {visible.length === 0
              ? 'Showing 0 of 0'
              : `Showing ${safePage * PAGE_SIZE + 1}–${Math.min((safePage + 1) * PAGE_SIZE, visible.length)} of ${visible.length}`}
          </span>
          <span className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setPage((n) => Math.max(0, n - 1))}
              disabled={safePage === 0}
              className="rounded-lg border border-slate-200 px-2.5 py-1 font-semibold text-slate-700 disabled:text-slate-400"
            >
              Previous
            </button>
            <span>
              Page {safePage + 1} of {pageCount}
            </span>
            <button
              type="button"
              onClick={() => setPage((n) => Math.min(pageCount - 1, n + 1))}
              disabled={safePage >= pageCount - 1}
              className="rounded-lg border border-slate-200 px-2.5 py-1 font-semibold text-slate-700 disabled:text-slate-400"
            >
              Next
            </button>
          </span>
        </div>
      </div>

      {openRow && <PatientBoardDetail key={openRow.id} row={openRow} clinicId={clinicId} onClose={() => setOpenId(null)} />}
    </div>
  );
}
