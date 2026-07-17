'use client';

import * as React from 'react';
import { useClearPort } from '@/context/ClearPortContext';
import { UploadCloud, CheckCircle2, FileText, Loader2, Sparkles, AlertCircle, HelpCircle, XCircle, Lock, Clock } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { supabase } from '@/lib/supabase';
import { canUpload, roleLabel } from '@/lib/services/rbac.service';

type StepType = 'idle' | 'uploading' | 'processing' | 'done';

export default function IngestUpload() {
  const { uploadDocuments, entries, selectedEntry, setActiveTab, userRole } = useClearPort();

  // RBAC: viewer role cannot upload. Show a locked panel instead of the
  // drag/drop zone so the viewer can still see recent shipment clusters
  // on the right side (read-only access to existing data).
  const canUploadFiles = canUpload(userRole);
  const [uploadStep, setUploadStep] = React.useState<StepType>('idle');
  const [uploadProgress, setUploadProgress] = React.useState(0);
  const [detectedType, setDetectedType] = React.useState('Commercial Invoice');
  const [isTypeConfirmed, setIsTypeConfirmed] = React.useState(false);
  const [elapsedTime, setElapsedTime] = React.useState(0);
  const [uploadedFile, setUploadedFile] = React.useState<File | null>(null);
  const [shipmentIdState, setShipmentIdState] = React.useState<string>('');
  const [errorMsg, setErrorMsg] = React.useState<string | null>(null);
  const [isDragging, setIsDragging] = React.useState(false);
  const [successShipmentId, setSuccessShipmentId] = React.useState<string>('');
  const activeIntervalRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  // Timer
  React.useEffect(() => {
    if (uploadStep !== 'idle' && uploadStep !== 'done') {
      const interval = setInterval(() => {
        setElapsedTime(prev => prev + 1);
      }, 1000);
      activeIntervalRef.current = interval;
    } else {
      if (activeIntervalRef.current) {
        clearInterval(activeIntervalRef.current);
        activeIntervalRef.current = null;
      }
    }
    return () => {
      if (activeIntervalRef.current) clearInterval(activeIntervalRef.current);
    };
  }, [uploadStep]);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => setIsDragging(false);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      handleFileUpload(Array.from(files));
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      handleFileUpload(Array.from(files));
    }
  };

  const triggerFileInput = () => {
    fileInputRef.current?.click();
  };

  const handleFileUpload = async (files: File[]) => {
    if (!canUploadFiles) {
      setErrorMsg('Your role does not have permission to upload documents.');
      return;
    }

    const allowedMimeTypes = ['application/pdf', 'image/png', 'image/jpeg', 'image/jpg', 'image/tiff', 'text/plain', 'text/csv'];
    // (§6) 20MB per-file limit — enforced client-side, server-side, and at bucket level.
    // (§6.2) 100MB per-shipment aggregate limit — wired up, not a dead variable.
    const maxSizeBytes = 20 * 1024 * 1024; // 20MB per file
    const maxShipmentSize = 100 * 1024 * 1024; // 100MB per shipment aggregate

    // Calculate total batch size
    const totalBatchSize = files.reduce((sum, f) => sum + f.size, 0);
    if (totalBatchSize > maxShipmentSize) {
      setErrorMsg(`Total batch size (${(totalBatchSize / (1024 * 1024)).toFixed(1)}MB) exceeds the 100MB per-shipment limit. Please upload fewer files or smaller files.`);
      return;
    }

    // Validate ALL files first — reject the batch only if ALL are invalid
    const validFiles: File[] = [];
    const invalidFiles: { name: string; reason: string }[] = [];

    for (const file of files) {
      if (!allowedMimeTypes.includes(file.type)) {
        invalidFiles.push({ name: file.name, reason: `Unsupported format (${file.type || 'unknown'})` });
      } else if (file.size > maxSizeBytes) {
        invalidFiles.push({ name: file.name, reason: `Exceeds 20MB limit (${(file.size / (1024 * 1024)).toFixed(1)}MB). Maximum file size is 20MB.` });
      } else {
        validFiles.push(file);
      }
    }

    if (validFiles.length === 0) {
      setErrorMsg(`All ${files.length} file(s) rejected: ${invalidFiles.map(f => f.name).join(', ')}`);
      return;
    }

    // Duplicate detection within the batch
    const seenHashes = new Set<string>();
    const uniqueFiles: File[] = [];
    const duplicates: string[] = [];

    for (const file of validFiles) {
      // Simple dedup by name+size (not a cryptographic hash, but catches accidental duplicates)
      const hash = `${file.name}:${file.size}`;
      if (seenHashes.has(hash)) {
        duplicates.push(file.name);
      } else {
        seenHashes.add(hash);
        uniqueFiles.push(file);
      }
    }

    // Set up state for multi-file upload
    setUploadedFile(uniqueFiles[0]); // Show first file in UI
    setUploadStep('uploading');
    setUploadProgress(0);
    setIsTypeConfirmed(false);
    setElapsedTime(0);
    setErrorMsg(null);

    // Per-file progress tracking
    const fileResults: { name: string; success: boolean; error?: string; shipmentId?: string }[] = [];
    const CONCURRENCY_LIMIT = 3; // Max 3 concurrent uploads

    // Process files in batches of CONCURRENCY_LIMIT
    for (let i = 0; i < uniqueFiles.length; i += CONCURRENCY_LIMIT) {
      const batch = uniqueFiles.slice(i, i + CONCURRENCY_LIMIT);

      const batchResults = await Promise.allSettled(
        batch.map(async (file) => {
          try {
            const result = await uploadDocuments([file]);
            return { name: file.name, success: result.success, error: result.error, shipmentId: result.shipmentId };
          } catch (err) {
            return { name: file.name, success: false, error: err instanceof Error ? err.message : 'Upload failed' };
          }
        }),
      );

      batchResults.forEach((result) => {
        if (result.status === 'fulfilled') {
          fileResults.push(result.value);
        } else {
          fileResults.push({ name: 'unknown', success: false, error: 'Promise rejected' });
        }
      });

      // Update progress
      const progress = Math.min(95, Math.round(((i + batch.length) / uniqueFiles.length) * 95));
      setUploadProgress(progress);
    }

    // Post-batch summary
    const succeeded = fileResults.filter(r => r.success);
    const failed = fileResults.filter(r => !r.success);

    // Use the first successful shipment for the UI
    const firstSuccess = succeeded[0];
    if (firstSuccess) {
      setShipmentIdState(firstSuccess.shipmentId || '');
      setSuccessShipmentId(firstSuccess.shipmentId || '');
      setUploadProgress(100);

      // ── IMMEDIATE RESPONSE ──
      // The upload has landed and the shipment row exists with
      // validation_status='pending'. Skip the old 'detecting'/'extracting'
      // theatre and go straight to 'processing' — the user sees "received,
      // processing" the moment the file lands. The useEffect below watches the
      // selected shipment's validation_status (refreshed every 4s by the
      // context's polling) and transitions to 'done' when the pipeline reaches
      // a terminal state (completed/failed/degraded).
      setUploadStep('processing');
    }

    // Show summary if there were any issues
    if (invalidFiles.length > 0 || duplicates.length > 0 || failed.length > 0) {
      const parts: string[] = [];
      if (succeeded.length > 0) parts.push(`${succeeded.length} processed`);
      if (failed.length > 0) parts.push(`${failed.length} failed: ${failed.map(f => f.name).join(', ')}`);
      if (invalidFiles.length > 0) parts.push(`${invalidFiles.length} rejected: ${invalidFiles.map(f => f.name).join(', ')}`);
      if (duplicates.length > 0) parts.push(`${duplicates.length} duplicates skipped: ${duplicates.join(', ')}`);

      if (succeeded.length === 0) {
        setErrorMsg(`Batch upload failed. ${parts.join('; ')}`);
        setUploadStep('idle');
      } else {
        // Partial success — show warning but don't block
        console.warn(`Batch upload partial: ${parts.join('; ')}`);
      }
    }
  };

  // ── Watch the selected shipment's validation_status ──
  // While we're in the 'processing' step, poll-driven context updates refresh
  // `selectedEntry.validationStatus` every 4s. The moment it reaches a
  // terminal state (completed/failed/degraded) we transition to 'done' so the
  // user sees the result without manually refreshing. This is what makes the
  // status column built last round actually visible in real time.
  React.useEffect(() => {
    if (uploadStep !== 'processing') return;
    const status = selectedEntry?.validationStatus;
    if (status === 'completed' || status === 'failed' || status === 'degraded') {
      setUploadStep('done');
    }
  }, [uploadStep, selectedEntry?.validationStatus]);

  const handleGoToExceptionDesk = () => {
    setActiveTab('exception-desk');
    setUploadStep('idle');
  };

  const formatTimer = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 h-full overflow-hidden p-6 font-sans">
      {/* LEFT: Upload area + stepper */}
      <div className="lg:col-span-8 bg-[#0c0d12] border border-gray-900 rounded-xl flex flex-col justify-center p-8 relative overflow-hidden">
        <div className="absolute top-4 left-4 flex items-center gap-1.5 font-mono text-[10px] text-gray-500 uppercase tracking-widest">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
          <span>ENTERPRISE INGEST CHANNEL</span>
        </div>

        {uploadStep !== 'idle' && (
          <div className="absolute top-4 right-4 flex items-center gap-2 font-mono text-xs text-gray-400 bg-gray-950 px-3 py-1.5 rounded-md border border-gray-900">
            <span>TIMER:</span>
            <span className="font-bold text-white tracking-wider">{formatTimer(elapsedTime)}</span>
            <span className="text-gray-600 text-[10px] uppercase">/ sub-2m PROMISE</span>
          </div>
        )}

        {/* RBAC: viewer role sees a locked panel instead of the drag/drop
            zone. They can still browse existing shipments on the right. */}
        {!canUploadFiles && (
          <div className="text-center space-y-5 max-w-md mx-auto px-4">
            <div className="w-16 h-16 bg-gray-950 rounded-2xl flex items-center justify-center border border-gray-900 shadow-xl mb-5 mx-auto">
              <Lock className="w-8 h-8 text-amber-500" />
            </div>
            <h3 className="text-lg font-bold text-gray-200 tracking-tight">Upload Restricted</h3>
            <p className="text-xs text-gray-500 max-w-sm mx-auto leading-relaxed">
              Your role is <span className="font-bold text-gray-300">{roleLabel(userRole)}</span>.
              Ingesting new shipment documents requires an <span className="font-mono">operator</span> or
              <span className="font-mono"> admin</span> role. Contact your ClearPort administrator to
              request a role upgrade, or browse existing shipments below.
            </p>
            <button
              onClick={() => setActiveTab('entry-detail')}
              className="inline-flex items-center gap-2 bg-gray-950 border border-gray-900 hover:border-gray-700 px-4 py-2 rounded-lg text-xs font-semibold text-gray-300 transition-all cursor-pointer"
            >
              <FileText className="w-4 h-4" />
              <span>Browse Existing Shipments</span>
            </button>
          </div>
        )}

        {canUploadFiles && (
        <AnimatePresence mode="wait">
          {uploadStep === 'idle' && (
            <motion.div
              key="idle-state"
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.98 }}
              onClick={triggerFileInput}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              className={`border-2 border-dashed rounded-2xl p-12 text-center flex flex-col items-center justify-center cursor-pointer transition-all aspect-[16/9] max-w-2xl mx-auto w-full select-none ${
                isDragging
                  ? 'border-amber-500 bg-amber-950/10'
                  : 'border-gray-800 hover:border-gray-700 bg-black/20 hover:bg-black/40'
              }`}
            >
              <input
                type="file"
                ref={fileInputRef}
                onChange={handleFileChange}
                className="hidden"
                accept=".pdf,.png,.jpg,.jpeg,.tiff,.txt,.csv"
                multiple
              />

              <div className="w-16 h-16 bg-gray-950 rounded-2xl flex items-center justify-center border border-gray-900 shadow-xl mb-5">
                <UploadCloud className={`w-8 h-8 transition-colors ${isDragging ? 'text-amber-500' : 'text-gray-400'}`} />
              </div>
              <h3 className="text-lg font-bold text-gray-200 tracking-tight">Ingest New Shipment Documents</h3>
              <p className="text-xs text-gray-500 max-w-sm mt-1.5 leading-relaxed">
                Drag & drop PDFs or click to upload Commercial Invoices, Packing Slips, Certificate of Origins, or Bills of Lading to automatically run compliance checks via Gemini extraction.
              </p>

              {errorMsg && (
                <div className="mt-4 flex items-center gap-2 bg-red-950/20 border border-red-900/40 text-red-400 text-xs rounded-lg px-4 py-2">
                  <XCircle className="w-4 h-4 shrink-0" />
                  <span>{errorMsg}</span>
                </div>
              )}

              <div className="mt-8 flex items-center gap-2 bg-gray-950 border border-gray-900/60 rounded-lg px-4 py-2 hover:border-amber-900/50 transition-all cursor-pointer">
                <Sparkles className="w-4 h-4 text-amber-500" />
                <span className="text-xs font-semibold text-gray-300">Choose Files to Process</span>
              </div>
            </motion.div>
          )}

          {uploadStep === 'uploading' && (
            <motion.div
              key="uploading-state"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="text-center space-y-5 max-w-md mx-auto"
            >
              <div className="w-12 h-12 bg-gray-950 border border-gray-900 rounded-full flex items-center justify-center mx-auto animate-pulse">
                <Loader2 className="w-6 h-6 text-amber-500 animate-spin" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-gray-200 uppercase tracking-wider font-mono">1. UPLOADING SECURE FILES</h3>
                <p className="text-xs text-gray-500 mt-1">Establishing secure pipeline with Supabase Storage...</p>
              </div>

              <div className="w-full bg-gray-950 rounded-full h-1.5 overflow-hidden border border-gray-900">
                <motion.div
                  className="bg-amber-500 h-1.5 rounded-full"
                  initial={{ width: 0 }}
                  animate={{ width: `${uploadProgress}%` }}
                  transition={{ duration: 0.15 }}
                />
              </div>
              <span className="text-xs font-mono text-gray-400 block">{uploadProgress}% uploaded</span>
            </motion.div>
          )}

          {uploadStep === 'processing' && (
            <motion.div
              key="processing-state"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="text-center space-y-5 max-w-md mx-auto"
            >
              <div className="w-12 h-12 bg-gray-950 border border-gray-900 rounded-full flex items-center justify-center mx-auto">
                <Loader2 className="w-6 h-6 text-amber-500 animate-spin" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-gray-200 uppercase tracking-wider font-mono">
                  RECEIVED — PROCESSING
                </h3>
                <p className="text-xs text-gray-500 mt-1">
                  Shipment <span className="text-gray-300 font-mono">{successShipmentId}</span> is in the pipeline.
                  Extraction, validation, and exception flagging are running — this page updates automatically.
                </p>
              </div>

              {/* Live status indicator — driven by the context's 4s polling of
                  validation_status. Shows the real pipeline state, not a fake
                  progress bar. */}
              <div className="bg-black/60 border border-gray-950 rounded-xl p-3.5 flex flex-col text-left font-mono text-[10px] text-gray-400 divide-y divide-gray-900">
                <div className="py-1.5 flex justify-between items-center">
                  <span className="flex items-center gap-1.5">
                    <Clock className="w-3 h-3 text-gray-600" />
                    Pipeline Status:
                  </span>
                  <span className={
                    selectedEntry?.validationStatus === 'running' ? 'text-amber-500' :
                    selectedEntry?.validationStatus === 'completed' ? 'text-emerald-500' :
                    selectedEntry?.validationStatus === 'failed' || selectedEntry?.validationStatus === 'degraded' ? 'text-red-500' :
                    'text-blue-500'
                  }>
                    {(selectedEntry?.validationStatus || 'pending').toUpperCase()}
                  </span>
                </div>
                <div className="py-1.5 flex justify-between">
                  <span>Fields Extracted:</span>
                  <span className="text-gray-300">{selectedEntry?.fields?.length ?? 0}</span>
                </div>
                <div className="py-1.5 flex justify-between">
                  <span>Exceptions Flagged:</span>
                  <span className="text-gray-300">{selectedEntry?.exceptions?.length ?? 0}</span>
                </div>
              </div>
              <p className="text-[10px] text-gray-600 font-mono">
                Auto-refreshing every 4s — no action needed.
              </p>
            </motion.div>
          )}

          {uploadStep === 'done' && (
            <motion.div
              key="done-state"
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0 }}
              className="text-center space-y-5 max-w-md mx-auto"
            >
              {(() => {
                const status = selectedEntry?.validationStatus;
                const isClean = status === 'completed' && (selectedEntry?.exceptions?.length ?? 0) === 0;
                const hasIssues = status === 'completed' && (selectedEntry?.exceptions?.length ?? 0) > 0;
                const isFailed = status === 'failed' || status === 'degraded';
                return (
                  <>
                    <div className={`w-14 h-14 rounded-full flex items-center justify-center mx-auto border ${
                      isClean ? 'bg-emerald-950/40 border-emerald-900' :
                      hasIssues ? 'bg-amber-950/40 border-amber-900' :
                      isFailed ? 'bg-red-950/40 border-red-900' :
                      'bg-gray-950 border-gray-900'
                    }`}>
                      {isClean ? <CheckCircle2 className="w-8 h-8 text-emerald-400" /> :
                       isFailed ? <XCircle className="w-8 h-8 text-red-400" /> :
                       <AlertCircle className="w-8 h-8 text-amber-400" />}
                    </div>
                    <div>
                      <h3 className="text-sm font-semibold text-gray-200 uppercase tracking-wider font-mono">
                        {isClean ? 'SHIPMENT VALIDATED' :
                         hasIssues ? 'VALIDATION COMPLETE — EXCEPTIONS FOUND' :
                         isFailed ? 'VALIDATION INCOMPLETE' :
                         'SHIPMENT ANALYSIS READY'}
                      </h3>
                      <p className="text-xs text-gray-400 mt-1 leading-normal">
                        Shipment <span className="text-emerald-400 font-bold font-mono">{successShipmentId}</span>{' '}
                        {isClean ? 'validated cleanly — zero exceptions.' :
                         hasIssues ? `validated with ${selectedEntry?.exceptions?.length ?? 0} exception(s) to review.` :
                         isFailed ? 'had a pipeline error — retry or manual review required.' :
                         'has been indexed. Review flagged exceptions in the Exception Desk.'}
                      </p>
                    </div>
                  </>
                );
              })()}

              <div className="flex gap-2.5 justify-center pt-2">
                <button
                  onClick={handleGoToExceptionDesk}
                  className="bg-emerald-600 hover:bg-emerald-500 text-black px-4 py-2 rounded-lg font-bold text-xs transition-all cursor-pointer uppercase tracking-wider"
                >
                  Go to Exception Desk
                </button>
                <button
                  onClick={() => {
                    setUploadStep('idle');
                    setUploadedFile(null);
                    setSuccessShipmentId('');
                  }}
                  className="text-gray-400 hover:text-white border border-gray-900 px-4 py-2 rounded-lg text-xs transition-all cursor-pointer font-medium uppercase tracking-wider"
                >
                  Upload Another File
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
        )}
      </div>

      {/* RIGHT: Cluster feed */}
      <div className="lg:col-span-4 bg-[#0c0d12] border border-gray-900 rounded-xl p-5 flex flex-col justify-between overflow-hidden">
        <div>
          <h3 className="text-xs font-bold font-mono tracking-widest text-gray-400 uppercase mb-3">Shipment Entry Clusters</h3>
          <p className="text-xs text-gray-500 leading-relaxed">
            As files are ingested, the extraction engine clusters associated paperwork into cohesive single shipments to prevent fragmented filing records.
          </p>

          <div className="space-y-4 mt-6 max-h-[400px] overflow-y-auto">
            {entries.slice(0, 4).map((entry, idx) => (
              <div key={entry.id} className={`bg-black/60 border p-4 rounded-xl space-y-3 ${
                idx === 0 ? 'border-gray-800' : 'border-gray-950/60'
              }`}>
                <div className="flex justify-between items-center">
                  <span className="font-mono text-xs font-extrabold text-gray-200">{entry.id}</span>
                  <span className="text-[9px] font-mono bg-emerald-950/40 text-emerald-400 border border-emerald-900/40 px-1.5 py-0.5 rounded">
                    {entry.exceptions.filter(e => e.status === 'Unresolved').length > 0 ? `${entry.exceptions.filter(e => e.status === 'Unresolved').length} EXCEPTIONS` : 'AUTO-GROUPED'}
                  </span>
                </div>
                <div className="flex items-center gap-2.5 text-xs">
                  <div className="bg-gray-950 p-2 border border-gray-900 rounded-lg">
                    <FileText className="w-5 h-5 text-gray-400" />
                  </div>
                  <div>
                    <span className="font-semibold text-gray-300 block truncate max-w-[150px]">{entry.shipper}</span>
                    <span className="text-[10px] text-gray-500 font-mono">{entry.docsCount} Documents Associated</span>
                  </div>
                </div>
              </div>
            ))}

            {entries.length === 0 && (
              <div className="text-center text-gray-600 text-xs py-8">
                No shipments yet. Upload documents to create clusters.
              </div>
            )}
          </div>
        </div>

        <div className="bg-black/60 border border-gray-950 rounded-xl p-3.5 flex items-start gap-2.5 mt-4">
          <AlertCircle className="w-4 h-4 text-gray-500 shrink-0 mt-0.5" />
          <p className="text-[10px] text-gray-500 leading-normal">
            ClearPort uses cryptographic document hashes to ensure file integrity. Modified, re-scanned, or corrupted duplicate files will generate immediate security warnings.
          </p>
        </div>
      </div>
    </div>
  );
}
