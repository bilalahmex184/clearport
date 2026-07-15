// ============================================================================
// /terms — Terms of Use (server component, no 'use client')
// ============================================================================
//
// Plain legal copy. Rendered server-side so it's crawlable + lightweight.
// The dark-mode styling mirrors the rest of the app (bg-[#06070a], panels
// on bg-[#0c0d12] with border-gray-900, amber accents).
// ============================================================================

import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Terms of Use // ClearPort',
  description:
    'Terms governing use of the ClearPort AI-assisted customs compliance platform.',
};

export default function TermsPage() {
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
          Terms of Use
        </h1>
        <p className="text-xs text-gray-500 mt-2 font-mono">
          Last updated: {new Date().toISOString().slice(0, 10)}
        </p>

        <div className="mt-10 space-y-8">
          <section className="bg-[#0c0d12] border border-gray-900 rounded-xl p-6">
            <h2 className="text-lg font-semibold text-gray-100 mb-2">
              1. Service Description
            </h2>
            <p className="text-sm text-gray-400 leading-relaxed">
              ClearPort is an AI-assisted customs compliance tool that ingests
              commercial invoices, packing lists, bills of lading, and other
              trade documents, extracts structured field data using Google
              Gemini, and routes low-confidence extractions to a human reviewer
              via the Exception Desk. The Service is provided to assist
              licensed customs brokers and compliance teams in preparing
              customs filings; it is not a substitute for the judgment of a
              qualified professional.
            </p>
          </section>

          <section className="bg-[#0c0d12] border border-gray-900 rounded-xl p-6">
            <h2 className="text-lg font-semibold text-gray-100 mb-2">
              2. User Responsibilities
            </h2>
            <p className="text-sm text-gray-400 leading-relaxed mb-3">
              You are responsible for verifying all data extracted by ClearPort
              before it is used in any customs filing, financial reconciliation,
              or regulatory submission. Specifically:
            </p>
            <ul className="text-sm text-gray-400 leading-relaxed list-disc pl-5 space-y-1.5">
              <li>
                Review every field that the system flags as a low-confidence
                exception in the Exception Desk.
              </li>
              <li>
                Confirm HTS code classifications against the current Harmonized
                Tariff Schedule of the importing country before filing.
              </li>
              <li>
                Ensure declared values, weights, and party names match the
                underlying source documents and applicable regulations.
              </li>
              <li>
                Retain original source documents for the period required by the
                customs authority of the importing country.
              </li>
            </ul>
          </section>

          <section className="bg-[#0c0d12] border border-gray-900 rounded-xl p-6">
            <h2 className="text-lg font-semibold text-gray-100 mb-2">
              3. No Warranty; &quot;As Is&quot;
            </h2>
            <p className="text-sm text-gray-400 leading-relaxed">
              The Service is provided &quot;as is&quot; and &quot;as
              available&quot;, without warranty of any kind — express, implied,
              statutory, or otherwise. ClearPort disclaims all implied
              warranties including merchantability, fitness for a particular
              purpose, and non-infringement. We do not warrant that the
              extraction engine will be error-free, that every exception will be
              correctly flagged, or that the Service will meet your specific
              regulatory requirements.
            </p>
          </section>

          <section className="bg-[#0c0d12] border border-gray-900 rounded-xl p-6">
            <h2 className="text-lg font-semibold text-gray-100 mb-2">
              4. Regulatory Compliance
            </h2>
            <p className="text-sm text-gray-400 leading-relaxed">
              Compliance with the customs regulations, export controls, and
              trade sanctions of the importing and exporting countries is the
              sole responsibility of the user. ClearPort is a tool to assist
              compliance teams; it does not itself file entries with any
              customs authority, classify goods on your behalf, or assume any
              legal liability for the accuracy of filed data. You remain
              responsible for all filings made using data exported from the
              Service.
            </p>
          </section>

          <section className="bg-[#0c0d12] border border-gray-900 rounded-xl p-6">
            <h2 className="text-lg font-semibold text-gray-100 mb-2">
              5. Prohibited Uses
            </h2>
            <p className="text-sm text-gray-400 leading-relaxed mb-3">
              You agree not to:
            </p>
            <ul className="text-sm text-gray-400 leading-relaxed list-disc pl-5 space-y-1.5">
              <li>
                Use the Service for any illegal activity, including but not
                limited to customs fraud, smuggling, or violation of trade
                sanctions.
              </li>
              <li>
                Reverse engineer, decompile, or disassemble the extraction
                engine, prompt templates, or any proprietary component of the
                Service.
              </li>
              <li>
                Upload documents that contain third-party personal data without
                a lawful basis for processing and disclosure to the Gemini API.
              </li>
              <li>
                Attempt to circumvent the role-based access controls enforced
                by the Service, including the operator / admin / viewer
                permission gates.
              </li>
              <li>
                Resell, sublicense, or redistribute access to the Service
                without prior written agreement.
              </li>
            </ul>
          </section>

          <section className="bg-[#0c0d12] border border-gray-900 rounded-xl p-6">
            <h2 className="text-lg font-semibold text-gray-100 mb-2">
              6. Limitation of Liability
            </h2>
            <p className="text-sm text-gray-400 leading-relaxed">
              To the maximum extent permitted by applicable law, ClearPort and
              its affiliates shall not be liable for any indirect, incidental,
              special, consequential, or punitive damages, or any loss of
              profits or revenues, arising out of or related to your use of the
              Service — including but not limited to damages caused by
              incorrectly extracted field data, missed exceptions, or
              regulatory penalties assessed against you by a customs authority.
              The total aggregate liability of ClearPort for any claim arising
              out of these Terms shall not exceed the amount paid by you to
              ClearPort for the Service in the twelve (12) months preceding the
              claim.
            </p>
          </section>

          <section className="bg-[#0c0d12] border border-gray-900 rounded-xl p-6">
            <h2 className="text-lg font-semibold text-gray-100 mb-2">
              7. AI Disclosure
            </h2>
            <p className="text-sm text-gray-400 leading-relaxed">
              ClearPort uses Google Gemini to extract structured data from
              uploaded documents. AI extraction may contain errors, and all
              extracted data must be reviewed by a qualified customs broker
              before filing. See our{' '}
              <Link
                href="/legal"
                className="text-amber-500 hover:text-amber-400 underline"
              >
                AI Disclaimer
              </Link>{' '}
              for details.
            </p>
          </section>

          <section className="bg-[#0c0d12] border border-gray-900 rounded-xl p-6">
            <h2 className="text-lg font-semibold text-gray-100 mb-2">
              8. Changes to These Terms
            </h2>
            <p className="text-sm text-gray-400 leading-relaxed">
              We may update these Terms from time to time. We will indicate the
              most recent revision date at the top of this page. Continued use
              of the Service after a change constitutes acceptance of the
              revised Terms.
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
            <Link href="/privacy" className="hover:text-gray-300 transition-colors">
              Privacy Policy
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
