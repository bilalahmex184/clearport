// ============================================================================
// /reset-password — Password reset flow
// ============================================================================
// Two states:
//   1. Request reset: user enters email → supabase.auth.resetPasswordForEmail()
//   2. Confirm reset: user arrives from email link with a session → enters new
//      password → supabase.auth.updateUser({ password })
// ============================================================================

'use client';

import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { Shield, Loader2, AlertCircle, Mail, KeyRound, CheckCircle2 } from 'lucide-react';

function ResetPasswordContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = React.useState('');
  const [newPassword, setNewPassword] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [success, setSuccess] = React.useState<string | null>(null);

  // Check if we arrived from a reset email link (Supabase puts a recovery
  // session in the URL hash/fragment). If so, show the "set new password" form
  // instead of the "request reset" form.
  const [hasRecoverySession, setHasRecoverySession] = React.useState(false);

  React.useEffect(() => {
    // Supabase sends the user back to the redirect URL with a type=recovery
    // parameter and a session in the hash fragment. The onAuthStateChange
    // listener fires with PASSWORD_RECOVERY event.
    const checkSession = async () => {
      const { data: { session } } = await supabase?.auth.getSession() ?? { data: { session: null } };
      if (session) {
        // Check if this is a recovery session (the search params will have
        // type=recovery, or we can check the user's app_metadata)
        const type = searchParams.get('type');
        if (type === 'recovery' || session.user?.aud === 'authenticated') {
          setHasRecoverySession(true);
        }
      }
    };
    checkSession();

    // Also listen for the PASSWORD_RECOVERY event
    const { data: { subscription } } = supabase?.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY') {
        setHasRecoverySession(true);
      }
    }) ?? { data: { subscription: null } };

    return () => {
      subscription?.unsubscribe();
    };
  }, [searchParams]);

  const handleRequestReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setSuccess(null);

    try {
      const { error } = await supabase!.auth.resetPasswordForEmail(email.trim(), {
        redirectTo: `${window.location.origin}/reset-password?type=recovery`,
      });

      if (error) {
        setError(error.message);
        return;
      }

      setSuccess('Password reset link sent! Check your email and click the link to set a new password.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An unexpected error occurred.');
    } finally {
      setLoading(false);
    }
  };

  const handleConfirmReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setSuccess(null);

    if (newPassword.length < 6) {
      setError('Password must be at least 6 characters long.');
      setLoading(false);
      return;
    }

    try {
      const { error } = await supabase!.auth.updateUser({ password: newPassword });

      if (error) {
        setError(error.message);
        return;
      }

      setSuccess('Password updated successfully! Redirecting to login...');
      setTimeout(() => router.push('/login'), 2000);
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
          <h1 className="text-2xl font-bold text-white tracking-tight">Reset Password</h1>
        </div>

        {/* Reset card */}
        <div className="bg-[#0c0d12] border border-gray-900 rounded-xl p-6 sm:p-8">
          {!hasRecoverySession ? (
            <>
              <div className="flex items-center gap-2 mb-6">
                <Mail className="w-5 h-5 text-amber-500" />
                <h2 className="text-sm font-bold text-gray-200 uppercase tracking-wider">Request Reset Link</h2>
              </div>

              <form onSubmit={handleRequestReset} className="space-y-4">
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

                {error && (
                  <div className="p-3 rounded-lg bg-red-950/30 border border-red-900/40 text-red-400 text-xs flex items-start gap-2">
                    <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                    <span>{error}</span>
                  </div>
                )}

                {success && (
                  <div className="p-3 rounded-lg bg-emerald-950/30 border border-emerald-900/40 text-emerald-400 text-xs flex items-start gap-2">
                    <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
                    <span>{success}</span>
                  </div>
                )}

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full bg-amber-500 hover:bg-amber-600 disabled:opacity-50 disabled:cursor-not-allowed text-black font-bold py-2.5 rounded-lg text-sm uppercase tracking-wider transition-all flex items-center justify-center gap-2 cursor-pointer"
                >
                  {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mail className="w-4 h-4" />}
                  {loading ? 'Sending...' : 'Send Reset Link'}
                </button>
              </form>
            </>
          ) : (
            <>
              <div className="flex items-center gap-2 mb-6">
                <KeyRound className="w-5 h-5 text-amber-500" />
                <h2 className="text-sm font-bold text-gray-200 uppercase tracking-wider">Set New Password</h2>
              </div>

              <form onSubmit={handleConfirmReset} className="space-y-4">
                <div>
                  <label className="block text-xs font-mono text-gray-400 uppercase tracking-wider mb-1.5">
                    New Password
                  </label>
                  <input
                    type="password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    required
                    autoComplete="new-password"
                    autoFocus
                    minLength={6}
                    className="w-full bg-black/40 border border-gray-900 rounded-lg px-3 py-2.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-amber-500/50 focus:ring-1 focus:ring-amber-500/30 transition-all"
                    placeholder="At least 6 characters"
                  />
                </div>

                {error && (
                  <div className="p-3 rounded-lg bg-red-950/30 border border-red-900/40 text-red-400 text-xs flex items-start gap-2">
                    <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                    <span>{error}</span>
                  </div>
                )}

                {success && (
                  <div className="p-3 rounded-lg bg-emerald-950/30 border border-emerald-900/40 text-emerald-400 text-xs flex items-start gap-2">
                    <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
                    <span>{success}</span>
                  </div>
                )}

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full bg-amber-500 hover:bg-amber-600 disabled:opacity-50 disabled:cursor-not-allowed text-black font-bold py-2.5 rounded-lg text-sm uppercase tracking-wider transition-all flex items-center justify-center gap-2 cursor-pointer"
                >
                  {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <KeyRound className="w-4 h-4" />}
                  {loading ? 'Updating...' : 'Update Password'}
                </button>
              </form>
            </>
          )}

          {/* Links */}
          <div className="mt-6 pt-4 border-t border-gray-900 text-center">
            <button
              onClick={() => router.push('/login')}
              className="text-xs text-gray-500 hover:text-gray-300 transition-colors cursor-pointer"
            >
              Back to sign in
            </button>
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

export default function ResetPasswordPage() {
  return (
    <React.Suspense fallback={<div className="min-h-screen bg-[#06070a] flex items-center justify-center"><Loader2 className="w-8 h-8 text-amber-500 animate-spin" /></div>}>
      <ResetPasswordContent />
    </React.Suspense>
  );
}
