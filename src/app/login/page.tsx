// ============================================================================
// /login — Email + password login page
// ============================================================================
// Replaces the anonymous sign-in path. Calls supabase.auth.signInWithPassword().
// Redirects to / on success. Links to /signup and /reset-password.
// ============================================================================

'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { supabase, isDemoMode } from '@/lib/supabase';
import { Shield, Loader2, AlertCircle, LogIn } from 'lucide-react';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

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

    try {
      const { data, error } = await supabase!.auth.signInWithPassword({
        email: email.trim(),
        password,
      });

      if (error) {
        // Surface Supabase Auth's built-in rate limiting + error messages
        // rather than swallowing them
        setError(error.message);
        return;
      }

      if (data.session) {
        router.replace('/');
        router.refresh();
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
          <h1 className="text-2xl font-bold text-white tracking-tight">ClearPort</h1>
          <p className="text-sm text-gray-500 mt-1">Customs Compliance Platform</p>
        </div>

        {/* Login card */}
        <div className="bg-[#0c0d12] border border-gray-900 rounded-xl p-6 sm:p-8">
          <div className="flex items-center gap-2 mb-6">
            <LogIn className="w-5 h-5 text-amber-500" />
            <h2 className="text-sm font-bold text-gray-200 uppercase tracking-wider">Sign In</h2>
          </div>

          {isDemoMode() && (
            <div className="mb-4 p-3 rounded-lg bg-amber-950/30 border border-amber-900/40 text-amber-400 text-xs flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>Demo mode is active — anonymous sessions are enabled.</span>
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
                autoComplete="current-password"
                className="w-full bg-black/40 border border-gray-900 rounded-lg px-3 py-2.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-amber-500/50 focus:ring-1 focus:ring-amber-500/30 transition-all"
                placeholder="••••••••"
              />
            </div>

            {error && (
              <div className="p-3 rounded-lg bg-red-950/30 border border-red-900/40 text-red-400 text-xs flex items-start gap-2">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-amber-500 hover:bg-amber-600 disabled:opacity-50 disabled:cursor-not-allowed text-black font-bold py-2.5 rounded-lg text-sm uppercase tracking-wider transition-all flex items-center justify-center gap-2 cursor-pointer"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <LogIn className="w-4 h-4" />}
              {loading ? 'Signing in...' : 'Sign In'}
            </button>
          </form>

          {/* Links */}
          <div className="mt-6 pt-4 border-t border-gray-900 space-y-2 text-center">
            <button
              onClick={() => router.push('/reset-password')}
              className="text-xs text-gray-500 hover:text-gray-300 transition-colors cursor-pointer"
            >
              Forgot your password?
            </button>
            <div className="text-xs text-gray-600">
              Don&apos;t have an account?{' '}
              <button
                onClick={() => router.push('/signup')}
                className="text-amber-500 hover:text-amber-400 font-semibold transition-colors cursor-pointer"
              >
                Sign up
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
