import type { Session } from '@supabase/supabase-js';
import { createContext, useContext, useEffect, useRef, useState, type PropsWithChildren } from 'react';

import { clearActingMode, getStoredActingMode } from './actingMode';
import { idleRoleFor, isIdleExpired, markActive, signOutForInactivity } from './idleTimeout';
import { screenCache } from './screenCache';
import { supabase } from './supabaseClient';
import type { Profile } from './types';

interface AuthContextValue {
  session: Session | null;
  profile: Profile | null;
  loading: boolean;
  refreshProfile: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: PropsWithChildren) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  // Whose profile is on hand. Auth events for the SAME person - the hourly
  // token refresh, coming back to the tab - don't need it fetched again.
  const profileFor = useRef<string | null>(null);
  // claim_walk_in_records runs once per person per app load, not per event.
  const claimedFor = useRef<string | null>(null);

  const loadProfile = async (userId: string): Promise<Profile | null> => {
    const { data } = await supabase.from('profiles').select('*').eq('id', userId).single();
    // A different person on this device: drop whatever screens the last one saw.
    if (profileFor.current && profileFor.current !== userId) screenCache.clear();
    setProfile(data ?? null);
    profileFor.current = data ? userId : null;

    // Best-effort, fire-and-forget: pulls any walk-in visit history filed
    // under this same (now-verified) phone number onto this account. Cheap
    // no-op on every login after the first successful claim. Not swallowed
    // silently, though - if this RPC errors (RLS, a DB-side exception), the
    // patient would otherwise see no visit history with zero indication why,
    // so at least log it somewhere a developer can find it.
    if (data?.role === 'patient' && claimedFor.current !== userId) {
      claimedFor.current = userId;
      supabase.rpc('claim_walk_in_records').then(({ error }) => {
        if (error) {
          claimedFor.current = null; // try again next time
          console.error('claim_walk_in_records failed:', error.message);
        }
      });
    }
    return (data as Profile | null) ?? null;
  };

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data }) => {
      let current = data.session;
      if (current) {
        const loaded = await loadProfile(current.user.id);
        // Opening the app after too long without using it (lib/idleTimeout.ts):
        // sign this device out BEFORE anything is shown - the splash screen
        // is up until `loading` turns false below. Otherwise opening the app
        // counts as activity.
        const role = idleRoleFor(loaded?.role, getStoredActingMode());
        if (isIdleExpired(role)) {
          await signOutForInactivity(role);
          current = null;
          setProfile(null);
        } else {
          markActive();
        }
      }
      setSession(current);
      setLoading(false);
    });

    const { data: subscription } = supabase.auth.onAuthStateChange((event, newSession) => {
      setSession(newSession);
      if (newSession) {
        // INITIAL_SESSION is the startup load above. Otherwise fetch the
        // profile for a new person (sign-in) or a changed one (USER_UPDATED).
        const samePerson = profileFor.current === newSession.user.id;
        if (event !== 'INITIAL_SESSION' && (event === 'USER_UPDATED' || !samePerson)) {
          loadProfile(newSession.user.id);
        }
      } else {
        profileFor.current = null;
        screenCache.clear();
        setProfile(null);
        // Otherwise a stale 'clinic' (or 'patient') choice from whoever was
        // just signed in would silently misroute the NEXT sign-in on this
        // same tab (sessionStorage survives a sign-out within one tab -
        // only closing it clears it on its own).
        clearActingMode();
      }
    });

    return () => subscription.subscription.unsubscribe();
  }, []);

  const refreshProfile = async () => {
    if (session) await loadProfile(session.user.id);
  };

  return (
    <AuthContext.Provider value={{ session, profile, loading, refreshProfile }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
