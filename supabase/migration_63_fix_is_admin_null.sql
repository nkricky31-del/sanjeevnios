-- ============================================================================
-- 63. SECURITY FIX: is_admin() returned NULL (not false) for an anonymous
--     caller, silently defeating every `if not public.is_admin() then
--     raise exception` guard built on top of it
-- ============================================================================
-- Found by live-testing every new admin-only RPC from migrations 59-61
-- directly against the anon key (no session at all), the way an attacker
-- calling the REST endpoint outside this app would:
--
--   curl .../rest/v1/rpc/release_settlement -H "apikey: <anon key>" \
--     -d '{"p_settlement_id": "00000000-0000-0000-0000-000000000000"}'
--   -> expected: "Only an admin can release a payout."
--   -> actually got: "This payment is not currently eligible for release."
--
-- That second message only prints if execution got PAST the admin check -
-- it did. Root cause: is_admin() is `select current_role() = 'admin'`, and
-- current_role() is `select role from profiles where id = auth.uid()`. For
-- an anonymous caller auth.uid() is NULL, so current_role() returns NULL,
-- and `null = 'admin'` is NULL in SQL - not false. PL/pgSQL's
-- `IF NOT <condition> THEN` treats a NULL condition as "not true", exactly
-- like false, so `IF NOT is_admin() THEN RAISE EXCEPTION` never actually
-- raises for an anonymous caller - it silently falls through to whatever
-- the function does next.
--
-- Every RLS POLICY that reads is_admin() (`using (... or is_admin())`,
-- the large majority of its call sites in this schema) was NEVER actually
-- vulnerable to this - RLS itself already treats a non-TRUE USING/WITH
-- CHECK result as "deny", so NULL and FALSE were always equivalent there.
-- Nor was is_own_clinic()/is_clinic() affected - both are built on EXISTS()/
-- IS NOT NULL, which are null-safe by construction. The actual exposure was
-- narrow but real: every SECURITY DEFINER function whose ONLY access check
-- was a bare `if not is_admin()` inside its own body, callable directly as
-- an RPC with no RLS in front of it at all - release_settlement(),
-- release_eligible_settlements(), set_settlement_hold(),
-- resolve_settlement_hold(), mark_settlement_settled() (migrations 59-60),
-- moderate_review(), delete_review() (migration 61), and one pre-existing
-- instance of the identical pattern, review_name_change_request()
-- (migration 53) - all narrowed to "an anonymous caller who already knows
-- the target row's uuid" (RLS still hides every row's id from anon in the
-- first place - see each table's own *_select policy), but a defense-in-
-- depth failure regardless, and the exact opposite of what every one of
-- those functions' own error messages claims to guarantee.
--
-- Fixed at the ROOT rather than patching nine call sites: is_admin() itself
-- now always returns a real boolean, never NULL, so every existing AND
-- future `if not is_admin()` anywhere in this schema is safe by
-- construction - none of the functions listed above need editing at all.
-- ============================================================================

create or replace function public.is_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select coalesce(public.current_role() = 'admin', false);
$$;
