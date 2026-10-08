import { Banknote, BadgeCheck, CalendarCheck, ChevronLeft, ChevronRight, ClipboardList, Ticket, type LucideIcon } from 'lucide-react';
import { motion } from 'motion/react';
import { useCallback, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useNavigate } from 'react-router-dom';

import { Label, Reveal } from './motionKit';

interface DeckCard {
  code: string;
  title: string;
  who: string;
  tone: 'primary' | 'leaf';
  body: string;
  icon: LucideIcon;
}

// Only what the product actually does today - no invented numbers or quotes.
const CARDS: DeckCard[] = [
  { code: '01', title: 'Book', who: 'Patients', tone: 'leaf', icon: CalendarCheck,
    body: 'Search verified clinics, pick a doctor and a slot, or simply walk in. Either way you hold a place in the queue.' },
  { code: '02', title: 'Queue', who: 'Clinics & patients', tone: 'primary', icon: Ticket,
    body: 'A live token issued in arrival order. Paying online buys convenience, never a place ahead of anyone.' },
  { code: '03', title: 'Consult', who: 'Doctors', tone: 'leaf', icon: ClipboardList,
    body: 'Visit notes and prescriptions written once and saved to the patient\'s record, encrypted at rest.' },
  { code: '04', title: 'Pay', who: 'Patients & clinics', tone: 'primary', icon: Banknote,
    body: 'Pay online or at the counter. Each visit\'s payment is tracked, and clinics are paid out per completed visit.' },
  { code: '05', title: 'Verify', who: 'Admin team', tone: 'leaf', icon: BadgeCheck,
    body: 'Every clinic and doctor is document-reviewed before they ever appear in patient search.' },
];

const VISIBLE = 4; // how many cards show in the stack
const THROW_MS = 380;

// A physical deck you throw aside. Cards are stacked with a small offset across,
// up, down in scale and in rotation. Drag the top one (pointer is captured, the
// settle transition is dropped while dragging); past ~10% of the deck's width it
// is thrown out and the next card comes up. Arrow keys and the buttons do the
// same, so it works without a mouse; touch-action: pan-y keeps vertical scroll.
export default function ProductDeck() {
  const navigate = useNavigate();
  const deckRef = useRef<HTMLDivElement>(null);
  const [order, setOrder] = useState<number[]>(CARDS.map((_, i) => i));
  const [dragX, setDragX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [thrown, setThrown] = useState<{ id: number; dir: 1 | -1 } | null>(null);
  const [recycled, setRecycled] = useState<number | null>(null);
  const [incoming, setIncoming] = useState<number | null>(null);
  const startX = useRef(0);

  const width = () => deckRef.current?.offsetWidth ?? 360;

  const throwTop = useCallback((dir: 1 | -1) => {
    if (thrown) return;
    const id = order[0];
    setThrown({ id, dir });
    setDragging(false);
    window.setTimeout(() => {
      setRecycled(id);
      setOrder((o) => [...o.slice(1), o[0]]);
      setThrown(null);
      setDragX(0);
      window.setTimeout(() => setRecycled(null), 60);
    }, THROW_MS);
  }, [order, thrown]);

  // Previous: the card at the bottom of the deck comes back on top, sliding in
  // from the side it was thrown to (it starts off-screen, then settles).
  const previous = useCallback(() => {
    if (thrown) return;
    const id = order[order.length - 1];
    setIncoming(id);
    setOrder((o) => [o[o.length - 1], ...o.slice(0, -1)]);
    window.setTimeout(() => setIncoming(null), 40);
  }, [order, thrown]);

  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (thrown) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    startX.current = e.clientX;
    setDragging(true);
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (dragging) setDragX(e.clientX - startX.current);
  };
  const onUp = () => {
    if (!dragging) return;
    setDragging(false);
    if (Math.abs(dragX) > width() * 0.1) throwTop(dragX > 0 ? 1 : -1);
    else setDragX(0);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowRight') { e.preventDefault(); throwTop(1); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); previous(); }
  };

  const topId = order[0];

  return (
    <section className="overflow-x-clip bg-ground-2 py-24" aria-labelledby="deck-heading">
      <div className="mx-auto grid max-w-6xl items-center gap-14 px-5 lg:grid-cols-2">
        <div>
          <Reveal><Label accent="primary">The product</Label></Reveal>
          <Reveal delay={0.08}>
            <h2 id="deck-heading" className="mt-5 font-display text-[clamp(32px,5vw,64px)] font-extrabold leading-[1.02] tracking-[-0.03em] text-ink">
              One visit.<br />Everything in sync.
            </h2>
          </Reveal>
          <Reveal delay={0.16}>
            <p className="mt-5 max-w-md font-ui text-base leading-relaxed text-ink-2">
              Five parts of a clinic visit, in one platform. Flip through them: drag a card aside, use the arrow
              keys, or the buttons.
            </p>
          </Reveal>
          <Reveal delay={0.24} className="mt-8 flex flex-col gap-3 sm:flex-row">
            <button type="button" onClick={() => navigate('/login')}
              className="cursor-pointer rounded-full bg-primary px-6 py-3 font-ui text-sm font-semibold text-white outline-none transition hover:bg-primary-dark focus-visible:ring-2 focus-visible:ring-leaf-text focus-visible:ring-offset-2 focus-visible:ring-offset-ground-2">
              Book a visit
            </button>
            <button type="button" onClick={() => navigate('/clinic/login?mode=register')}
              className="cursor-pointer rounded-full border border-ink/40 px-6 py-3 font-ui text-sm font-semibold text-ink outline-none transition hover:border-primary hover:text-primary focus-visible:ring-2 focus-visible:ring-primary">
              Register your clinic
            </button>
          </Reveal>
        </div>

        <div>
          <div
            ref={deckRef}
            role="group"
            aria-roledescription="carousel"
            aria-label="Product cards. Use the left and right arrow keys to flip through."
            tabIndex={0}
            onKeyDown={onKey}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
            className="relative aspect-square w-[calc(100%-3.5rem)] max-w-[420px] sm:mx-auto sm:w-full cursor-grab touch-pan-y select-none rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-8 focus-visible:ring-offset-ground-2 active:cursor-grabbing"
          >
            {CARDS.map((card, id) => {
              const pos = order.indexOf(id);
              const isTop = pos === 0;
              const isThrown = thrown?.id === id;
              const W = width();
              let target;
              if (incoming === id) {
                target = { x: -W * 1.15, y: -28, rotate: -22, scale: 1, opacity: 0 };
              } else if (isThrown && thrown) {
                target = { x: thrown.dir * W * 1.15, y: -28, rotate: thrown.dir * 22, scale: 1, opacity: 0 };
              } else if (isTop && dragging) {
                target = { x: dragX, y: -Math.min(Math.abs(dragX) / 14, 14), rotate: dragX / 18, scale: 1.02, opacity: 1 };
              } else {
                target = {
                  x: pos * 16, y: -pos * 12, rotate: pos * 2.4 * (pos % 2 ? 1 : -1) * 0.8,
                  scale: 1 - pos * 0.05, opacity: pos < VISIBLE ? 1 : 0,
                };
              }
              const snap = (isTop && dragging) || recycled === id || incoming === id;
              const Icon = card.icon;
              return (
                <motion.article
                  key={card.code}
                  aria-hidden={!isTop}
                  className="absolute inset-0 flex flex-col justify-between rounded-2xl border border-hairline bg-ground p-6 shadow-[0_18px_40px_-14px_rgba(17,24,39,0.28)]"
                  style={{ zIndex: CARDS.length - pos, pointerEvents: isTop ? 'auto' : 'none' }}
                  animate={target}
                  transition={snap ? { duration: 0 } : isThrown ? { duration: THROW_MS / 1000, ease: [0.4, 0, 0.6, 1] } : { type: 'spring', stiffness: 260, damping: 26 }}
                >
                  <div className="flex items-start justify-between">
                    <Label accent={card.tone}>{card.who}</Label>
                    <span className="font-display text-sm font-bold text-ink-2">{card.code} / 0{CARDS.length}</span>
                  </div>
                  <div>
                    <Icon size={26} strokeWidth={1.5} className="text-ink" />
                    <h3 className="mt-4 font-display text-4xl font-extrabold tracking-[-0.03em] text-ink">
                      {card.title}<span className={card.tone === 'primary' ? 'text-primary' : 'text-leaf-text'}>.</span>
                    </h3>
                    <p className="mt-3 font-ui text-sm leading-relaxed text-ink-2">{card.body}</p>
                  </div>
                </motion.article>
              );
            })}
          </div>

          <div className="mt-8 flex max-w-[420px] items-center justify-between sm:mx-auto">
            <p className="font-ui text-xs text-muted">Drag, or use ← → keys</p>
            <div className="flex items-center gap-3">
              <button type="button" aria-label="Previous card" onClick={previous}
                className="cursor-pointer rounded-full border border-hairline p-2 text-ink-2 outline-none transition hover:border-ink/40 hover:text-ink focus-visible:ring-2 focus-visible:ring-primary">
                <ChevronLeft size={16} />
              </button>
              <ul className="flex items-center gap-1.5" aria-label={`Card ${topId + 1} of ${CARDS.length}`}>
                {CARDS.map((c, i) => (
                  <li key={c.code} className={`h-1.5 rounded-full transition-all ${i === topId ? 'w-5 bg-primary' : 'w-1.5 bg-ink/25'}`} />
                ))}
              </ul>
              <button type="button" aria-label="Next card" onClick={() => throwTop(1)}
                className="cursor-pointer rounded-full border border-hairline p-2 text-ink-2 outline-none transition hover:border-ink/40 hover:text-ink focus-visible:ring-2 focus-visible:ring-primary">
                <ChevronRight size={16} />
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
