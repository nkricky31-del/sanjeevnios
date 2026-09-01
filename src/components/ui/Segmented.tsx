interface Props<T extends string> {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  /** 'pill' = the boxed toggle (Login with Mobile / MRN); 'underline' = the
      tab bar with an active underline (Upcoming / Completed / Cancelled);
      'scroll' = a horizontally scrollable pill row, for the console screens
      that carry more tabs than fit across one line. */
  variant?: 'pill' | 'underline' | 'scroll';
}

export default function Segmented<T extends string>({ options, value, onChange, variant = 'pill' }: Props<T>) {
  if (variant === 'scroll') {
    return (
      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            className={`shrink-0 whitespace-nowrap rounded-full px-4 py-2 text-sm font-bold transition ${
              value === o.value
                ? 'bg-brand-600 text-white shadow-sm shadow-brand-600/25'
                : 'border border-slate-200 bg-white text-slate-600 hover:border-brand-200 hover:text-brand-600'
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
    );
  }

  if (variant === 'underline') {
    return (
      <div className="flex border-b border-slate-100">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            className={`flex-1 border-b-2 pb-2.5 text-sm font-bold transition ${
              value === o.value ? 'border-brand-600 text-brand-600' : 'border-transparent text-slate-400'
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="flex gap-1 rounded-2xl border border-slate-100 bg-white p-1">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`flex-1 whitespace-nowrap rounded-xl px-3 py-2.5 text-sm font-bold transition ${
            value === o.value ? 'bg-brand-50 text-brand-600' : 'text-slate-500'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
