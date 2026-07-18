// ============================================================================
// /signup — New account registration + optional org creation
// ============================================================================
// Calls supabase.auth.signUp(). After signup, the user can either:
//   a) Create a new organization (they become admin), or
//   b) Accept an invite token (if they arrived via an invite link)
// ============================================================================

'use client';

import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { Shield, Loader2, AlertCircle, UserPlus, Building2, Mail } from 'lucide-react';

function SignupContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const inviteToken = searchParams.get('invite');

  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [orgName, setOrgName] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [success, setSuccess] = React.useState<string | null>(null);

  // If already logged in, redirect to /
  React.useEffect(() => {
    supabase?.auth.getSession().then(({ data: { session } }) => {
      if (session) router.replace('/');
    });
  }, [router]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setSuccess(null);

    if (password.length < 6) {
      setError('Password must be at least 6 characters long.');
      setLoading(false);
      return;
    }

    try {
      // 1. Create the auth account
      const { data, error: signUpError } = await supabase!.auth.signUp({
        email: email.trim(),
        password,
      });

      if (signUpError) {
        setError(signUpError.message);
        return;
      }

      if (!data.user) {
        setError('Sign-up failed — no user returned.');
        return;
      }

      // 2. Check if email confirmation is required
      if (data.session === null) {
        setSuccess('Account created! Check your email for a verification link, then sign in.');
        setTimeout(() => router.push('/login'), 4000);
        return;
      }

      // 3. If we have a session (email confirmation disabled), create org or accept invite
      if (inviteToken) {
        // Accept the invite via the API
        const response = await fetch('/api/invites/accept', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: inviteToken }),
        });
        const inviteData = await response.json();
        if (!response.ok || !inviteData.success) {
          setError(`Account created, but invite acceptance failed: ${inviteData.error || 'Unknown error'}. You can sign in and try the invite link again.`);
          setTimeout(() => router.push('/login'), 3000);
          return;
        }
        setSuccess(`Account created! You've joined ${inviteData.orgName} as ${inviteData.role}.`);
        setTimeout(() => router.push('/'), 2000);
      } else if (orgName.trim()) {
        // Create a new organization (user becomes admin)
        const response = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/rpc/create_organization`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
            'Authorization': `Bearer ${data.session.access_token}`,
          },
          body: JSON.stringify({
            p_org_name: orgName.trim(),
            p_creator_uid: data.user.id,
          }),
        });
        const orgResult = await response.json();
        if (!response.ok) {
          setError(`Account created, but org creation failed: ${orgResult.message || 'Unknown error'}. You can sign in and create an org from the Team page.`);
          setTimeout(() => router.push('/login'), 3000);
          return;
        }
        setSuccess(`Account created! Organization "${orgName.trim()}" is ready.`);
        setTimeout(() => router.push('/'), 2000);
      } else {
        // No org name and no invite — just redirect to login
        setSuccess('Account created! You can now sign in.');
        setTimeout(() => router.push('/login'), 2000);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An unexpected error occurred.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#06070a] flex items-center justify-center p-4 font-sans">
      <div className="max-w-md w-full">
        {/* Brand header */}
        <div className="text-center mb-8">
          <div className="w-14 h-14 bg-amber-500 rounded-2xl flex items-center justify-center font-bold text-black text-2xl tracking-tighter mx-auto mb-4 shadow-xl">
            CP
          </div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Create Account</h1>
          <p className="text-sm text-gray-500 mt-1">Join ClearPort Customs Compliance Platform</p>
        </div>

        {/* Signup card */}
        <div className="bg-[#0c0d12] border border-gray-900 rounded-xl p-6 sm:p-8">
          <div className="flex items-center gap-2 mb-6">
            <UserPlus className="w-5 h-5 text-amber-500" />
            <h2 className="text-sm font-bold text-gray-200 uppercase tracking-wider">Sign Up</h2>
          </div>

          {inviteToken && (
            <div className="mb-4 p-3 rounded-lg bg-amber-950/30 border border-amber-900/40 text-amber-400 text-xs flex items-center gap-2">
              <Mail className="w-4 h-4 shrink-0" />
              <span>You&apos;re accepting an invite. Create your account to join the organization.</span>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-mono text-gray-400 uppercase tracking-wider mb-1.5">
                Email
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
                autoFocus
                className="w-full bg-black/40 border border-gray-900 rounded-lg px-3 py-2.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-amber-500/50 focus:ring-1 focus:ring-amber-500/30 transition-all"
                placeholder="you@company.com"
              />
            </div>

            <div>
              <label className="block text-xs font-mono text-gray-400 uppercase tracking-wider mb-1.5">
                Password
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="new-password"
                minLength={6}
                className="w-full bg-black/40 border border-gray-900 rounded-lg px-3 py-2.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-amber-500/50 focus:ring-1 focus:ring-amber-500/30 transition-all"
                placeholder="At least 6 characters"
              />
            </div>

            {!inviteToken && (
              <div>
                <label className="block text-xs font-mono text-gray-400 uppercase tracking-wider mb-1.5">
                  <Building2 className="w-3 h-3 inline mr-1" />
                  Organization Name (optional)
                </label>
                <input
                  type="text"
                  value={orgName}
                  onChange={(e) => setOrgName(e.target.value)}
                  className="w-full bg-black/40 border border-gray-900 rounded-lg px-3 py-2.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-amber-500/50 focus:ring-1 focus:ring-amber-500/30 transition-all"
                  placeholder="Acme Logistics Inc."
                />
                <p className="text-[10px] text-gray-600 mt-1">Leave empty to join an existing org via invite.</p>
              </div>
            )}

            {error && (
              <div className="p-3 rounded-lg bg-red-950/30 border border-red-900/40 text-red-400 text-xs flex items-start gap-2">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            {success && (
              <div className="p-3 rounded-lg bg-emerald-950/30 border border-emerald-900/40 text-emerald-400 text-xs flex items-start gap-2">
                <Shield className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{success}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-amber-500 hover:bg-amber-600 disabled:opacity-50 disabled:cursor-not-allowed text-black font-bold py-2.5 rounded-lg text-sm uppercase tracking-wider transition-all flex items-center justify-center gap-2 cursor-pointer"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserPlus className="w-4 h-4" />}
              {loading ? 'Creating account...' : 'Create Account'}
            </button>
          </form>

          {/* Links */}
          <div className="mt-6 pt-4 border-t border-gray-900 text-center">
            <div className="text-xs text-gray-600">
              Already have an account?{' '}
              <button
                onClick={() => router.push('/login')}
                className="text-amber-500 hover:text-amber-400 font-semibold transition-colors cursor-pointer"
              >
                Sign in
              </button>
            </div>
          </div>
        </div>

        {/* Security footer */}
        <div className="mt-6 flex items-center justify-center gap-1.5 text-[10px] font-mono text-gray-600 uppercase">
          <Shield className="w-3 h-3 text-emerald-500" />
          <span>Secured by Supabase Auth • Row-Level Security Enforced</span>
        </div>
      </div>
    </div>
  );
}

export default function SignupPage() {
  return (
    <React.Suspense fallback={<div className="min-h-screen bg-[#06070a] flex items-center justify-center"><Loader2 className="w-8 h-8 text-amber-500 animate-spin" /></div>}>
      <SignupContent />
    </React.Suspense>
  );
}
