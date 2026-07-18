'use client';

import * as React from 'react';
import { useClearPort } from '@/context/ClearPortContext';
import { UserPlus, Trash2, Mail, Clock, Check, X, Loader2, Users } from 'lucide-react';

interface Invite {
  id: string;
  email: string;
  role: string;
  token: string;
  accepted_at: string | null;
  expires_at: string;
  created_at: string;
}

export default function TeamManagement() {
  const { theme, userRole, currentOrgId, apiFetchOrg, userOrgs } = useClearPort();
  const [invites, setInvites] = React.useState<Invite[]>([]);
  const [email, setEmail] = React.useState('');
  const [role, setRole] = React.useState<'admin' | 'operator' | 'viewer'>('viewer');
  const [isLoading, setIsLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [success, setSuccess] = React.useState<string | null>(null);

  const canManage = userRole === 'admin';
  const currentOrg = userOrgs.find(o => o.org_id === currentOrgId);

  const loadInvites = React.useCallback(async () => {
    if (!currentOrgId || !canManage) return;
    try {
      const data = await apiFetchOrg<{ invites: Invite[] }>(`/api/organizations/${currentOrgId}/invites`);
      setInvites(data.invites || []);
    } catch {
      // Ignore
    }
  }, [currentOrgId, canManage, apiFetchOrg]);

  React.useEffect(() => {
    loadInvites();
  }, [loadInvites]);

  const sendInvite = async () => {
    if (!email || !currentOrgId) return;
    setIsLoading(true);
    setError(null);
    try {
      const data = await apiFetchOrg<{ inviteUrl: string; message: string }>(`/api/organizations/${currentOrgId}/invites`, {
        method: 'POST',
        body: JSON.stringify({ email, role }),
      });
      setSuccess(`Invite sent to ${email}. Share this link: ${data.inviteUrl}`);
      setEmail('');
      await loadInvites();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send invite');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="space-y-4 sm:space-y-6 overflow-y-auto h-full pb-6 sm:pb-8 pr-1 sm:pr-2 p-3 sm:p-4 md:p-6 font-sans">
      <div className="bg-[#0c0d12] border border-gray-900 rounded-xl p-5">
        <span className="font-mono text-xs text-amber-500 tracking-wider">TEAM MANAGEMENT</span>
        <h2 className="text-xl font-bold text-gray-100 tracking-tight mt-1">
          {currentOrg?.org_name || 'Organization'} — Team
        </h2>
        <p className="text-xs text-gray-400 mt-2 leading-relaxed">
          Invite teammates by email. They'll receive a link to join your organization with the role you assign.
          Only admins can send invites.
        </p>
      </div>

      {error && (
        <div className="bg-red-950/20 border border-red-900/40 text-red-400 text-xs rounded-lg px-4 py-2 flex items-center gap-2">
          <X className="w-4 h-4 shrink-0" />
          <span>{error}</span>
          <button onClick={() => setError(null)} className="ml-auto"><X className="w-3 h-3" /></button>
        </div>
      )}

      {success && (
        <div className="bg-emerald-950/20 border border-emerald-900/40 text-emerald-400 text-xs rounded-lg px-4 py-2 flex items-start gap-2">
          <Check className="w-4 h-4 shrink-0 mt-0.5" />
          <span className="flex-1 break-all">{success}</span>
          <button onClick={() => setSuccess(null)} className="shrink-0"><X className="w-3 h-3" /></button>
        </div>
      )}

      {/* Invite form */}
      {canManage ? (
        <div className="bg-[#0c0d12] border border-gray-900 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-gray-200 mb-4 flex items-center gap-2">
            <UserPlus className="w-4 h-4 text-amber-500" />
            Invite a Teammate
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="md:col-span-2">
              <label className="text-[10px] font-mono text-gray-500 uppercase tracking-wider block mb-1">Email Address</label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="colleague@company.com"
                className="w-full bg-black border border-gray-800 text-gray-200 rounded-lg px-3 py-2 text-xs"
              />
            </div>
            <div>
              <label className="text-[10px] font-mono text-gray-500 uppercase tracking-wider block mb-1">Role</label>
              <select
                value={role}
                onChange={e => setRole(e.target.value as any)}
                className="w-full bg-black border border-gray-800 text-gray-200 rounded-lg px-3 py-2 text-xs"
              >
                <option value="viewer">Viewer (read-only)</option>
                <option value="operator">Operator (upload + edit)</option>
                <option value="admin">Admin (full access)</option>
              </select>
            </div>
          </div>
          <button
            onClick={sendInvite}
            disabled={!email || isLoading}
            className="mt-4 flex items-center gap-2 text-xs bg-amber-600 hover:bg-amber-500 text-black font-bold px-4 py-2 rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UserPlus className="w-3.5 h-3.5" />}
            Send Invite
          </button>
        </div>
      ) : (
        <div className="bg-[#0c0d12] border border-gray-900 rounded-xl p-5 text-center">
          <Users className="w-8 h-8 text-gray-600 mx-auto mb-2" />
          <p className="text-xs text-gray-500">Only admins can invite teammates. Contact your organization admin.</p>
        </div>
      )}

      {/* Pending invites */}
      {canManage && invites.length > 0 && (
        <div className="bg-[#0c0d12] border border-gray-900 rounded-xl overflow-hidden">
          <div className="p-4 border-b border-gray-900 bg-[#0e1017]">
            <h3 className="text-sm font-semibold text-gray-200">Sent Invites ({invites.length})</h3>
          </div>
          <div className="divide-y divide-gray-950">
            {invites.map(invite => (
              <div key={invite.id} className="p-4 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center ${
                    invite.accepted_at ? 'bg-emerald-950 text-emerald-400' : 'bg-amber-950 text-amber-400'
                  }`}>
                    {invite.accepted_at ? <Check className="w-4 h-4" /> : <Clock className="w-4 h-4" />}
                  </div>
                  <div>
                    <p className="text-xs font-semibold text-gray-200">{invite.email}</p>
                    <p className="text-[10px] text-gray-500 font-mono">
                      {invite.role.toUpperCase()} • {invite.accepted_at ? 'Accepted' : new Date(invite.expires_at) > new Date() ? 'Expires ' + new Date(invite.expires_at).toLocaleDateString() : 'Expired'}
                    </p>
                  </div>
                </div>
                {!invite.accepted_at && (
                  <button
                    onClick={() => {
                      const url = `${window.location.origin}/accept-invite?token=${invite.token}`;
                      navigator.clipboard.writeText(url);
                      setSuccess(`Invite link copied: ${url}`);
                    }}
                    className="text-xs text-gray-400 hover:text-amber-400 font-mono"
                  >
                    Copy Link
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Current role */}
      {currentOrg && (
        <div className="bg-[#0c0d12] border border-gray-900 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-gray-200 mb-3">Your Membership</h3>
          <div className="flex items-center justify-between p-3 bg-black/40 rounded-lg border border-gray-950">
            <div>
              <span className="text-xs font-semibold text-gray-300 block">{currentOrg.org_name}</span>
              <span className="text-[10px] text-gray-500 font-mono">Your role: {currentOrg.role.toUpperCase()}</span>
            </div>
            <span className={`text-[9px] font-mono px-2 py-1 rounded border ${
              currentOrg.role === 'admin' ? 'bg-amber-950 text-amber-400 border-amber-900/40' :
              currentOrg.role === 'operator' ? 'bg-blue-950 text-blue-400 border-blue-900/40' :
              'bg-gray-950 text-gray-400 border-gray-800'
            }`}>
              {currentOrg.role.toUpperCase()}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
