// ============================================================================
// /accept-invite — Accept an org invite (tied to real accounts)
// ============================================================================
// Flow:
//   1. If already logged in → accept the invite immediately
//   2. If not logged in → show login/signup options, then accept after auth
//
// This ensures every accepted invite results in a real, named account being
// added to organization_members — not an anonymous session.
// ============================================================================

'use client';

import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { supabase, decideInviteAction } from '@/lib/supabase';
import { CheckCircle2, AlertCircle, Loader2, LogIn, UserPlus, Mail } from 'lucide-react';

function AcceptInviteContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get('token');
  const [status, setStatus] = React.useState<'checking' | 'accepting' | 'success' | 'error' | 'needs-auth'>('checking');
  const [message, setMessage] = React.useState('');
  // Store the needs-auth redirect URLs from decideInviteAction so the
  // needs-auth UI can use them (avoids re-deriving the URLs inline).
  const [authUrls, setAuthUrls] = React.useState<{ signupUrl: string; loginUrl: string }>({ signupUrl: '', loginUrl: '' });

  React.useEffect(() => {
    if (!token) {
      setStatus('error');
      setMessage('No invite token provided. Check your invite link and try again.');
      return;
    }

    (async () => {
      try {
        // Check if already authenticated
        const { data: { session } } = await supabase?.auth.getSession() ?? { data: { session: null } };
        const demoMode = process.env.NEXT_PUBLIC_DEMO_MODE === 'true';

        // Use the shared decision function (extracted from supabase.ts) so the
        // invite-redirect logic is testable without rendering the page.
        const decision = decideInviteAction(token, !!session, demoMode);

        if (decision.action === 'error') {
          setStatus('error');
          setMessage('No invite token provided. Check your invite link and try again.');
          return;
        }

        if (decision.action === 'needs_auth') {
          setAuthUrls({ signupUrl: decision.signupUrl, loginUrl: decision.loginUrl });
          setStatus('needs-auth');
          return;
        }

        // decision.action === 'accept' — call /api/invites/accept
        setStatus('accepting');
        const response = await fetch('/api/invites/accept', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: decision.token }),
        });

        const data = await response.json();

        if (response.ok && data.success) {
          setStatus('success');
          setMessage(`You've joined ${data.orgName} as ${data.role}.`);
          setTimeout(() => router.push('/'), 2000);
        } else {
          setStatus('error');
          setMessage(data.error || 'Failed to accept invite.');
        }
      } catch (err) {
        setStatus('error');
        setMessage(err instanceof Error ? err.message : 'An unexpected error occurred.');
      }
    })();
  }, [token, router]);

  // Needs-auth state: show login/signup options
  if (status === 'needs-auth') {
    return (
      <div className="min-h-screen bg-[#06070a] flex items-center justify-center p-4 font-sans">
        <div className="max-w-md w-full bg-[#0c0d12] border border-gray-900 rounded-xl p-8 text-center">
          <div className="w-14 h-14 bg-amber-500 rounded-2xl flex items-center justify-center font-bold text-black text-2xl tracking-tighter mx-auto mb-4 shadow-xl">
            CP
          </div>
          <Mail className="w-10 h-10 text-amber-500 mx-auto mb-4" />
          <h2 className="text-sm font-bold text-gray-200 uppercase tracking-wider mb-2">You&apos;ve Been Invited!</h2>
          <p className="text-xs text-gray-500 mt-2 mb-6">
            Create an account or sign in to accept your invitation and join the organization.
          </p>
          <div className="space-y-3">
            <button
              onClick={() => router.push(authUrls.signupUrl)}
              className="w-full bg-amber-500 hover:bg-amber-600 text-black font-bold py-2.5 rounded-lg text-sm uppercase tracking-wider transition-all flex items-center justify-center gap-2 cursor-pointer"
            >
              <UserPlus className="w-4 h-4" />
              Create Account
            </button>
            <button
              onClick={() => router.push(authUrls.loginUrl)}
              className="w-full bg-transparent border border-gray-700 hover:border-gray-600 text-gray-300 font-bold py-2.5 rounded-lg text-sm uppercase tracking-wider transition-all flex items-center justify-center gap-2 cursor-pointer"
            >
              <LogIn className="w-4 h-4" />
              I Already Have an Account
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#06070a] flex items-center justify-center p-4 font-sans">
      <div className="max-w-md w-full bg-[#0c0d12] border border-gray-900 rounded-xl p-8 text-center">
        {status === 'checking' && (
          <>
            <Loader2 className="w-12 h-12 text-amber-500 animate-spin mx-auto mb-4" />
            <h2 className="text-sm font-bold text-gray-200 uppercase tracking-wider">Checking Invite...</h2>
            <p className="text-xs text-gray-500 mt-2">Please wait while we verify your invitation.</p>
          </>
        )}
        {status === 'accepting' && (
          <>
            <Loader2 className="w-12 h-12 text-amber-500 animate-spin mx-auto mb-4" />
            <h2 className="text-sm font-bold text-gray-200 uppercase tracking-wider">Accepting Invite...</h2>
            <p className="text-xs text-gray-500 mt-2">Adding you to the organization.</p>
          </>
        )}
        {status === 'success' && (
          <>
            <CheckCircle2 className="w-12 h-12 text-emerald-400 mx-auto mb-4" />
            <h2 className="text-sm font-bold text-emerald-400 uppercase tracking-wider">Welcome aboard!</h2>
            <p className="text-xs text-gray-400 mt-2">{message}</p>
            <p className="text-[10px] text-gray-600 mt-4 font-mono">Redirecting to dashboard...</p>
          </>
        )}
        {status === 'error' && (
          <>
            <AlertCircle className="w-12 h-12 text-red-400 mx-auto mb-4" />
            <h2 className="text-sm font-bold text-red-400 uppercase tracking-wider">Invite Error</h2>
            <p className="text-xs text-gray-400 mt-2">{message}</p>
            <button onClick={() => router.push('/login')} className="mt-6 text-xs bg-amber-500 hover:bg-amber-600 text-black font-bold px-4 py-2 rounded-lg transition-all cursor-pointer">
              Go to Login
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export default function AcceptInvitePage() {
  return (
    <React.Suspense fallback={<div className="min-h-screen bg-[#06070a] flex items-center justify-center"><Loader2 className="w-8 h-8 text-amber-500 animate-spin" /></div>}>
      <AcceptInviteContent />
    </React.Suspense>
  );
}
