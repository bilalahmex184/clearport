'use client';

import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { supabase, ensureAuthenticated } from '@/lib/supabase';
import { CheckCircle2, AlertCircle, Loader2 } from 'lucide-react';

function AcceptInviteContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get('token');
  const [status, setStatus] = React.useState<'loading' | 'success' | 'error'>('loading');
  const [message, setMessage] = React.useState('');

  React.useEffect(() => {
    if (!token) {
      setStatus('error');
      setMessage('No invite token provided. Check your invite link and try again.');
      return;
    }

    (async () => {
      try {
        await ensureAuthenticated();
        const session = await supabase?.auth.getSession();
        if (!session?.data?.session) {
          setStatus('error');
          setMessage('Please sign in first, then click the invite link again.');
          return;
        }

        const response = await fetch('/api/invites/accept', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
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

  return (
    <div className="min-h-screen bg-[#06070a] flex items-center justify-center p-6">
      <div className="max-w-md w-full bg-[#0c0d12] border border-gray-900 rounded-xl p-8 text-center">
        {status === 'loading' && (
          <>
            <Loader2 className="w-12 h-12 text-amber-500 animate-spin mx-auto mb-4" />
            <h2 className="text-sm font-bold text-gray-200 uppercase tracking-wider">Accepting Invite...</h2>
            <p className="text-xs text-gray-500 mt-2">Please wait while we process your invitation.</p>
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
            <button onClick={() => router.push('/')} className="mt-6 text-xs bg-amber-500 hover:bg-amber-600 text-black font-bold px-4 py-2 rounded-lg transition-all">
              Go to Dashboard
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
