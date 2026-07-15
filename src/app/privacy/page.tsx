// ============================================================================
// /privacy — Privacy Policy (server component, no 'use client')
// ============================================================================
//
// Covers: data storage, RLS isolation, Gemini data flow, no-sale pledge,
// deletion requests, anonymous auth. Matches the actual Supabase-backed
// architecture documented in the project worklog.
// ============================================================================

import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Privacy Policy // ClearPort',
  description:
    'How ClearPort stores, processes, and protects your customs documents and extracted data.',
};

export default function PrivacyPage() {
  return (
    <main className="min-h-screen bg-[#06070a] text-gray-200 font-sans">
      <div className="max-w-3xl mx-auto px-6 py-12">
        {/* Brand header */}
        <div className="flex items-center gap-2 mb-10">
          <div className="w-7 h-7 bg-amber-500 rounded-lg flex items-center justify-center font-bold text-black text-sm tracking-tighter">
            CP
          </div>
          <span className="text-sm font-bold tracking-tight uppercase text-white">
            ClearPort
          </span>
          <span className="font-mono text-[9px] text-gray-500 ml-2">v5.0 // LEGAL</span>
        </div>

        <span className="font-mono text-xs text-amber-500 tracking-wider">
          LEGAL DOCUMENT
        </span>
        <h1 className="text-3xl font-bold text-gray-100 tracking-tight mt-1">
          Privacy Policy
        </h1>
        <p className="text-xs text-gray-500 mt-2 font-mono">
          Last updated: {new Date().toISOString().slice(0, 10)}
        </p>

        <div className="mt-10 space-y-8">
          <section className="bg-[#0c0d12] border border-gray-900 rounded-xl p-6">
            <h2 className="text-lg font-semibold text-gray-100 mb-2">
              1. Data We Collect
            </h2>
            <p className="text-sm text-gray-400 leading-relaxed mb-3">
              ClearPort processes the following categories of data:
            </p>
            <ul className="text-sm text-gray-400 leading-relaxed list-disc pl-5 space-y-1.5">
              <li>
                <span className="font-semibold text-gray-300">Uploaded documents</span> —
                commercial invoices, packing lists, bills of lading, certificates
                of origin, and other trade documents you submit for extraction.
              </li>
              <li>
                <span className="font-semibold text-gray-300">Extracted field data</span> —
                the structured fields (shipper, consignee, HTS codes, weights,
                values, etc.) produced by the Gemini extraction engine.
              </li>
              <li>
                <span className="font-semibold text-gray-300">Audit logs</span> —
                records of reviewer actions (accept / correct / reject),
                uploads, exports, and rule changes, attributed to your user ID.
              </li>
              <li>
                <span className="font-semibold text-gray-300">Authentication data</span> —
                an anonymous Supabase session token. If you later link an
                email/password, that credential is stored by Supabase Auth.
              </li>
            </ul>
          </section>

          <section className="bg-[#0c0d12] border border-gray-900 rounded-xl p-6">
            <h2 className="text-lg font-semibold text-gray-100 mb-2">
              2. How Documents Are Stored
            </h2>
            <p className="text-sm text-gray-400 leading-relaxed">
              Uploaded files are stored in <span className="font-mono text-amber-400">Supabase Storage</span>,
              which is encrypted at rest (AES-256) and in transit (TLS 1.2+).
              Storage objects are namespaced under a per-user path prefix
              (<span className="font-mono text-amber-400">{'{user_id}/...'}</span>) so
              that Row-Level Security policies can enforce isolation: every
              read of a storage object is checked against the caller&apos;s
              <span className="font-mono"> auth.uid()</span>.
            </p>
          </section>

          <section className="bg-[#0c0d12] border border-gray-900 rounded-xl p-6">
            <h2 className="text-lg font-semibold text-gray-100 mb-2">
              3. Per-User Data Isolation (Row-Level Security)
            </h2>
            <p className="text-sm text-gray-400 leading-relaxed">
              Every database table (<span className="font-mono">shipments</span>,
              <span className="font-mono"> documents</span>,
              <span className="font-mono"> document_fields</span>,
              <span className="font-mono"> exceptions</span>,
              <span className="font-mono"> operational_rules</span>,
              <span className="font-mono"> audit_logs</span>) has a
              <span className="font-mono text-amber-400"> user_id</span> column
              referencing <span className="font-mono">auth.users(id)</span>, and a
              Row-Level Security policy that restricts every query to rows
              where <span className="font-mono">user_id = auth.uid()</span>. This means
              your shipment data is never visible to any other ClearPort user —
              even an administrator of the Supabase project cannot read your
              rows through the user-scoped API client.
            </p>
          </section>

          <section className="bg-[#0c0d12] border border-gray-900 rounded-xl p-6">
            <h2 className="text-lg font-semibold text-gray-100 mb-2">
              4. Data Sent to Google Gemini
            </h2>
            <p className="text-sm text-gray-400 leading-relaxed">
              When you upload a document, the file&apos;s contents are sent to
              the <span className="font-mono text-amber-400">Google Gemini API</span> for
              OCR and structured field extraction. The Gemini API receives the
              raw document content (PDF / image / text), processes it
              transiently to produce the extracted JSON, and returns the result.
              Gemini&apos;s processing is governed by{' '}
              <a
                href="https://ai.google.dev/terms"
                target="_blank"
                rel="noopener noreferrer"
                className="text-amber-500 hover:text-amber-400 underline"
              >
                Google&apos;s AI Terms of Service
              </a>
              . ClearPort does not cache document content on Google&apos;s
              infrastructure beyond what Gemini&apos;s own policies permit.
            </p>
          </section>

          <section className="bg-[#0c0d12] border border-gray-900 rounded-xl p-6">
            <h2 className="text-lg font-semibold text-gray-100 mb-2">
              5. We Do Not Sell Your Data
            </h2>
            <p className="text-sm text-gray-400 leading-relaxed">
              ClearPort does not sell, rent, or license your uploaded documents,
              extracted field data, or audit logs to any third party. Data is
              shared only with our infrastructure providers (Supabase for
              storage + database, Google Gemini for extraction) strictly as
              needed to operate the Service, and only as permitted by their
              respective data processing agreements.
            </p>
          </section>

          <section className="bg-[#0c0d12] border border-gray-900 rounded-xl p-6">
            <h2 className="text-lg font-semibold text-gray-100 mb-2">
              6. Anonymous Authentication
            </h2>
            <p className="text-sm text-gray-400 leading-relaxed">
              When you first open ClearPort, the app creates an anonymous
              Supabase session — no email, password, or other personal
              information is collected. This anonymous session is what enables
              the no-login UX while still enforcing Row-Level Security. The
              session is tied to a stable, random UUID; if you clear your
              browser storage you will receive a new anonymous identity and
              will not be able to access shipments created under the previous
              identity unless you later link an email/password to that session.
            </p>
          </section>

          <section className="bg-[#0c0d12] border border-gray-900 rounded-xl p-6">
            <h2 className="text-lg font-semibold text-gray-100 mb-2">
              7. Data Retention &amp; Deletion
            </h2>
            <p className="text-sm text-gray-400 leading-relaxed mb-3">
              Your data is retained for as long as your account is active. You
              may request deletion of all your data at any time by:
            </p>
            <ul className="text-sm text-gray-400 leading-relaxed list-disc pl-5 space-y-1.5">
              <li>
                Deleting individual shipments via the ClearPort UI (admin role
                required) — this cascades to the shipment&apos;s documents,
                fields, exceptions, and audit logs.
              </li>
              <li>
                Emailing{' '}
                <a
                  href="mailto:compliance@clearport.corp"
                  className="text-amber-500 hover:text-amber-400 underline"
                >
                  compliance@clearport.corp
                </a>{' '}
                with a deletion request referencing your user ID (visible in the
                Supabase Sync panel). We will purge your records from the
                database, storage, and backups within 30 days.
              </li>
            </ul>
          </section>

          <section className="bg-[#0c0d12] border border-gray-900 rounded-xl p-6">
            <h2 className="text-lg font-semibold text-gray-100 mb-2">
              8. Security
            </h2>
            <p className="text-sm text-gray-400 leading-relaxed">
              All API routes require a valid JWT and enforce RLS. Edge functions
              are JWT-verified (<span className="font-mono">verify_jwt = true</span>).
              The Gemini API key is stored as a Supabase secret and never
              exposed to the browser. Audit logs record every reviewer action,
              upload, export, and rule change for traceability.
            </p>
          </section>

          <section className="bg-[#0c0d12] border border-gray-900 rounded-xl p-6">
            <h2 className="text-lg font-semibold text-gray-100 mb-2">
              9. Contact
            </h2>
            <p className="text-sm text-gray-400 leading-relaxed">
              Questions about this policy can be sent to{' '}
              <a
                href="mailto:compliance@clearport.corp"
                className="text-amber-500 hover:text-amber-400 underline"
              >
                compliance@clearport.corp
              </a>
              .
            </p>
          </section>
        </div>

        {/* Footer navigation */}
        <div className="mt-12 pt-6 border-t border-gray-900 flex items-center justify-between text-[11px] font-mono text-gray-500">
          <Link
            href="/"
            className="text-gray-400 hover:text-white transition-colors"
          >
            ← Back to ClearPort
          </Link>
          <div className="flex items-center gap-3">
            <Link href="/terms" className="hover:text-gray-300 transition-colors">
              Terms of Use
            </Link>
            <span className="text-gray-700">|</span>
            <Link href="/legal" className="hover:text-gray-300 transition-colors">
              AI Disclaimer
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}
