// ============================================================================
// /legal — AI Disclaimer + Legal overview (server component, no 'use client')
// ============================================================================
//
// The AI disclaimer is the most important legal page for ClearPort: customs
// data is high-stakes, and regulators (CBP, WTO, HS Committee) expect
// humans to remain accountable for classifications and valuations even
// when AI assists with extraction. This page makes that boundary explicit.
// ============================================================================

import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'AI Disclaimer & Legal Overview // ClearPort',
  description:
    'AI extraction disclaimer, human-review requirements, and legal overview for the ClearPort customs compliance platform.',
};

export default function LegalPage() {
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
          AI Disclaimer &amp; Legal Overview
        </h1>
        <p className="text-xs text-gray-500 mt-2 font-mono">
          Last updated: {new Date().toISOString().slice(0, 10)}
        </p>

        {/* Critical banner */}
        <div className="mt-8 bg-amber-950/30 border border-amber-900/60 rounded-xl p-5 flex items-start gap-3">
          <div className="w-8 h-8 bg-amber-500/20 border border-amber-500/40 rounded-lg flex items-center justify-center shrink-0">
            <span className="font-mono text-amber-400 font-bold text-lg">!</span>
          </div>
          <div>
            <h2 className="text-sm font-bold text-amber-400 uppercase tracking-wider font-mono">
              Human Review Is Mandatory
            </h2>
            <p className="text-xs text-gray-300 mt-1.5 leading-relaxed">
              All data extracted by ClearPort&apos;s AI engine MUST be reviewed
              by a qualified customs broker before it is used in any customs
              filing. AI results are suggestions, not legal advice. The
              licensed broker who signs the entry is legally accountable for
              the accuracy of every field.
            </p>
          </div>
        </div>

        <div className="mt-8 space-y-8">
          <section className="bg-[#0c0d12] border border-gray-900 rounded-xl p-6">
            <h2 className="text-lg font-semibold text-gray-100 mb-2">
              1. AI-Assisted Extraction
            </h2>
            <p className="text-sm text-gray-400 leading-relaxed">
              ClearPort uses Google Gemini — a large language model with
              multimodal vision capabilities — to extract structured field
              data from uploaded trade documents. Gemini performs optical
              character recognition (OCR) and field-level extraction in a
              single pass, then a second pass cross-validates fields across
              documents in the same shipment (e.g. invoice total vs. packing
              list total).
            </p>
          </section>

          <section className="bg-[#0c0d12] border border-gray-900 rounded-xl p-6">
            <h2 className="text-lg font-semibold text-gray-100 mb-2">
              2. AI May Make Mistakes
            </h2>
            <p className="text-sm text-gray-400 leading-relaxed mb-3">
              No AI model is perfect. Gemini may produce:
            </p>
            <ul className="text-sm text-gray-400 leading-relaxed list-disc pl-5 space-y-1.5">
              <li>
                <span className="font-semibold text-gray-300">OCR errors</span> —
                misreading digits, especially in low-quality scans, multi-page
                PDFs, or handwritten forms.
              </li>
              <li>
                <span className="font-semibold text-gray-300">Field-level hallucinations</span> —
                inferring a value where the source document is ambiguous or
                incomplete.
              </li>
              <li>
                <span className="font-semibold text-gray-300">Cross-document mismatches</span> —
                failing to flag a real discrepancy between the commercial
                invoice and the bill of lading, or flagging a false one.
              </li>
              <li>
                <span className="font-semibold text-gray-300">HTS classification errors</span> —
                the model may suggest a code based on the goods description
                but the official Harmonized Tariff Schedule is the only
                authoritative source.
              </li>
            </ul>
            <p className="text-sm text-gray-400 leading-relaxed mt-3">
              ClearPort mitigates these risks via confidence scoring,
              threshold-based exception routing, and a structured Exception
              Desk workflow — but no mitigation eliminates the need for human
              review.
            </p>
          </section>

          <section className="bg-[#0c0d12] border border-gray-900 rounded-xl p-6">
            <h2 className="text-lg font-semibold text-gray-100 mb-2">
              3. Human Review Is Required
            </h2>
            <p className="text-sm text-gray-400 leading-relaxed mb-3">
              Before any data exported from ClearPort is used in a customs
              filing, a qualified customs broker must:
            </p>
            <ol className="text-sm text-gray-400 leading-relaxed list-decimal pl-5 space-y-1.5">
              <li>
                Resolve every exception flagged in the Exception Desk — accept,
                correct, or reject each one. Unresolved exceptions block CSV
                export by design.
              </li>
              <li>
                Verify HTS code classifications against the current Harmonized
                Tariff Schedule of the importing country.
              </li>
              <li>
                Confirm declared values against the commercial invoice and any
                related payment instruments.
              </li>
              <li>
                Cross-check weights, quantities, and units of measure against
                the packing list and bill of lading.
              </li>
              <li>
                Verify shipper and consignee details, including addresses and
                EIN / tax ID numbers, against your records and any applicable
                denied-party screening.
              </li>
            </ol>
          </section>

          <section className="bg-[#0c0d12] border border-gray-900 rounded-xl p-6">
            <h2 className="text-lg font-semibold text-gray-100 mb-2">
              4. AI Output Is Not Legal Advice
            </h2>
            <p className="text-sm text-gray-400 leading-relaxed">
              The data ClearPort extracts, the exceptions it flags, and the
              confidence scores it assigns are operational aids for a
              licensed customs broker — they are not legal advice and do not
              constitute a legal opinion on the classification, valuation, or
              admissibility of any good. For legal advice on a specific
              shipment, consult a licensed customs attorney.
            </p>
          </section>

          <section className="bg-[#0c0d12] border border-gray-900 rounded-xl p-6">
            <h2 className="text-lg font-semibold text-gray-100 mb-2">
              5. Audit Logging of AI Responses
            </h2>
            <p className="text-sm text-gray-400 leading-relaxed">
              For traceability and regulatory defense, the system logs every
              AI extraction event to the <span className="font-mono text-amber-400">audit_logs</span> table.
              Each log entry records the action type
              (<span className="font-mono">[upload]</span>,
              <span className="font-mono"> [extract]</span>,
              <span className="font-mono"> [resolve]</span>,
              <span className="font-mono"> [edit]</span>,
              <span className="font-mono"> [export]</span>,
              <span className="font-mono"> [delete]</span>,
              <span className="font-mono"> [rules]</span>),
              the actor (your user ID / email), the affected shipment, and
              relevant field metadata. These logs are retained indefinitely
              and can be exported to CSV via the Entry Detail View for
              compliance audits.
            </p>
          </section>

          <section className="bg-[#0c0d12] border border-gray-900 rounded-xl p-6">
            <h2 className="text-lg font-semibold text-gray-100 mb-2">
              6. Shared Responsibility
            </h2>
            <p className="text-sm text-gray-400 leading-relaxed">
              Customs compliance is a shared responsibility:
            </p>
            <ul className="text-sm text-gray-400 leading-relaxed list-disc pl-5 space-y-1.5 mt-3">
              <li>
                <span className="font-semibold text-gray-300">ClearPort</span> —
                provides the AI extraction engine, exception routing, audit
                logging, and CSV export. We are responsible for the reliability
                of the platform and the integrity of the audit trail.
              </li>
              <li>
                <span className="font-semibold text-gray-300">The licensed customs broker</span> —
                reviews all AI output, resolves all exceptions, and signs the
                entry. The broker is legally accountable for the accuracy of
                the filed data under the customs regulations of the importing
                country (e.g. CBP regulations in the United States, with
                reasonable-care and shared-responsibility obligations under
                the Modernization Act).
              </li>
              <li>
                <span className="font-semibold text-gray-300">The importer of record</span> —
                retains ultimate legal responsibility for the accuracy of all
                declarations made on their behalf.
              </li>
            </ul>
          </section>

          <section className="bg-[#0c0d12] border border-gray-900 rounded-xl p-6">
            <h2 className="text-lg font-semibold text-gray-100 mb-2">
              7. Related Documents
            </h2>
            <ul className="text-sm text-gray-400 leading-relaxed list-disc pl-5 space-y-1.5">
              <li>
                <Link href="/terms" className="text-amber-500 hover:text-amber-400 underline">
                  Terms of Use
                </Link>{' '}
                — service description, prohibited uses, warranty disclaimer,
                limitation of liability.
              </li>
              <li>
                <Link href="/privacy" className="text-amber-500 hover:text-amber-400 underline">
                  Privacy Policy
                </Link>{' '}
                — document storage, RLS isolation, Gemini data flow, deletion
                requests.
              </li>
            </ul>
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
            <Link href="/privacy" className="hover:text-gray-300 transition-colors">
              Privacy Policy
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}
