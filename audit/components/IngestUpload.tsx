'use client';

import * as React from 'react';
import { useClearPort } from '../context/ClearPortContext';
import { UploadCloud, CheckCircle2, ChevronRight, FileText, Loader2, Sparkles, AlertCircle, HelpCircle, XCircle } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { supabase } from '../lib/supabase';

type StepType = 'idle' | 'uploading' | 'detecting' | 'extracting' | 'done';

export default function IngestUpload() {
  const { simulateUpload, entries } = useClearPort();
  const [uploadStep, setUploadStep] = React.useState<StepType>('idle');
  const [uploadProgress, setUploadProgress] = React.useState(0);
  const [detectedType, setDetectedType] = React.useState('Commercial Invoice');
  const [isTypeConfirmed, setIsTypeConfirmed] = React.useState(false);
  const [elapsedTime, setElapsedTime] = React.useState(0);
  const [uploadedFile, setUploadedFile] = React.useState<File | null>(null);
  const [shipmentIdState, setShipmentIdState] = React.useState<string>('');
  const [errorMsg, setErrorMsg] = React.useState<string | null>(null);
  const [isDragging, setIsDragging] = React.useState(false);
  const activeIntervalRef = React.useRef<any>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  // Timer counter
  React.useEffect(() => {
    if (uploadStep !== 'idle' && uploadStep !== 'done') {
      const interval = setInterval(() => {
        setElapsedTime((prev) => prev + 1);
      }, 1000);
      activeIntervalRef.current = interval;
    } else {
      if (activeIntervalRef.current) {
        clearInterval(activeIntervalRef.current);
        activeIntervalRef.current = null;
      }
    }
    return () => {
      if (activeIntervalRef.current) {
        clearInterval(activeIntervalRef.current);
      }
    };
  }, [uploadStep]);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      handleFileUpload(files[0]);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      handleFileUpload(files[0]);
    }
  };

  const triggerFileInput = () => {
    if (fileInputRef.current) {
      fileInputRef.current.click();
    }
  };

  const handleFileUpload = async (file: File) => {
    // 1. Client-side Upload Validation
    const allowedMimeTypes = [
      'application/pdf',
      'image/png',
      'image/jpeg',
      'image/jpg',
      'image/tiff',
    ];
    if (!allowedMimeTypes.includes(file.type)) {
      setErrorMsg(`Unsupported file format (${file.type || 'unknown'}). Please upload PDF, PNG, JPEG, or TIFF.`);
      return;
    }

    const maxSizeBytes = 10 * 1024 * 1024; // 10MB limit
    if (file.size > maxSizeBytes) {
      setErrorMsg(`File size exceeds the 10MB limit. This file is ${(file.size / (1024 * 1024)).toFixed(2)} MB.`);
      return;
    }

    setUploadedFile(file);
    setUploadStep('uploading');
    setUploadProgress(0);
    setIsTypeConfirmed(false);
    setElapsedTime(0);
    setErrorMsg(null);

    const generatedShipId = `SHIP-2026-${Math.floor(1000 + Math.random() * 9000)}`;
    setShipmentIdState(generatedShipId);

    const formData = new FormData();
    formData.append('file', file);
    formData.append('shipment_id', generatedShipId);
    
    // Generate simple identifier
    const docId = Math.random().toString(36).substring(2, 11);
    formData.append('document_id', docId);

    // Visual loader progress
    const progressInterval = setInterval(() => {
      setUploadProgress((prev) => {
        if (prev >= 95) {
          clearInterval(progressInterval);
          return 95;
        }
        return prev + 5;
      });
    }, 100);

    try {
      if (supabase) {
        const { data, error } = await supabase.functions.invoke('upload-document', {
          body: formData,
        });

        if (error) {
          console.error('Edge Function error via SDK:', error);
          throw new Error(error.message || 'Error uploading file to Edge Function');
        }
        console.log('Upload successful via Supabase SDK:', data);
      } else {
        const response = await fetch('https://apfsceomnnhefxkvjhkz.supabase.co/functions/v1/upload-document', {
          method: 'POST',
          body: formData,
        });

        if (!response.ok) {
          const errData = await response.json().catch(() => ({}));
          throw new Error(errData.error || `Upload failed with status code ${response.status}`);
        }
        const data = await response.json();
        console.log('Upload successful via direct fetch:', data);
      }

      clearInterval(progressInterval);
      setUploadProgress(100);

      setTimeout(() => {
        setUploadStep('detecting');
        const lowerName = file.name.toLowerCase();
        if (lowerName.includes('packing') || lowerName.includes('pack')) {
          setDetectedType('Packing List');
        } else if (lowerName.includes('lading') || lowerName.includes('bol')) {
          setDetectedType('Bill of Lading');
        } else if (lowerName.includes('origin') || lowerName.includes('coo')) {
          setDetectedType('Certificate of Origin');
        } else {
          setDetectedType('Commercial Invoice');
        }
      }, 400);

    } catch (err) {
      clearInterval(progressInterval);
      console.error('Real file upload failed:', err);
      const errMsg = err instanceof Error ? err.message : 'The secure upload channel is unavailable or returned an error.';
      setErrorMsg(errMsg);
      setUploadStep('idle');
    }
  };

  const handleConfirmType = () => {
    setIsTypeConfirmed(true);
    setUploadStep('extracting');

    // Simulate OCR Extraction phase
    setTimeout(() => {
      const generatedShipId = shipmentIdState || `SHIP-2026-${Math.floor(1000 + Math.random() * 9000)}`;
      const fileName = uploadedFile ? uploadedFile.name : 'TC_9921_KK_INVOICE.pdf';
      simulateUpload(generatedShipId, [
        { name: fileName, type: detectedType },
        { name: 'TC_9921_KK_BOL.pdf', type: 'Bill of Lading' },
      ]);
      setUploadStep('done');
    }, 1800);
  };

  const formatTimer = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div id="ingest-root" className="grid grid-cols-1 lg:grid-cols-12 gap-5 h-[calc(100vh-120px)] overflow-hidden font-sans">
      
      {/* LEFT AREA: EXTREMELY SPACIOUS DRAG & DROP AND PROCESS STEPPER (8 cols) */}
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
                accept=".pdf,.png,.jpg,.jpeg,.tiff"
              />

              <div className="w-16 h-16 bg-gray-950 rounded-2xl flex items-center justify-center border border-gray-900 shadow-xl mb-5">
                <UploadCloud className={`w-8 h-8 transition-colors ${isDragging ? 'text-amber-500' : 'text-gray-400'}`} />
              </div>
              <h3 className="text-lg font-bold text-gray-200 tracking-tight">Ingest New Shipment Documents</h3>
              <p className="text-xs text-gray-500 max-w-sm mt-1.5 leading-relaxed">
                Drag & drop PDFs or click to upload Commercial Invoices, Packing Slips, Certificate of Origins, or Bills of Lading to automatically run compliance checks.
              </p>
              
              {errorMsg && (
                <div className="mt-4 flex items-center gap-2 bg-red-950/20 border border-red-900/40 text-red-400 text-xs rounded-lg px-4 py-2">
                  <XCircle className="w-4 h-4 shrink-0" />
                  <span>{errorMsg}</span>
                </div>
              )}

              <div className="mt-8 flex items-center gap-2 bg-gray-950 border border-gray-900/60 rounded-lg px-4 py-2 hover:border-amber-900/50 transition-all cursor-pointer">
                <Sparkles className="w-4 h-4 text-amber-500" />
                <span className="text-xs font-semibold text-gray-300">Choose File to Process via Edge Function</span>
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
                <p className="text-xs text-gray-500 mt-1">Establishing high-speed pipeline buffer with central Customs broker API...</p>
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

          {uploadStep === 'detecting' && (
            <motion.div
              key="detecting-state"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="text-center space-y-5 max-w-md mx-auto"
            >
              <div className="w-12 h-12 bg-gray-950 border border-gray-900 rounded-full flex items-center justify-center mx-auto">
                <Loader2 className="w-6 h-6 text-amber-500 animate-spin" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-gray-200 uppercase tracking-wider font-mono">2. DETECTING DOCUMENT TYPE</h3>
                <p className="text-xs text-gray-500 mt-1">Running NLP model layout classifications on uploaded structure...</p>
              </div>

              {!isTypeConfirmed && (
                <div className="bg-[#120f0e] border border-amber-950/40 rounded-xl p-4 space-y-3">
                  <div className="flex items-start gap-2 text-left">
                    <HelpCircle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                    <div>
                      <span className="text-xs font-mono text-gray-400 font-bold block uppercase">Uncertain Classification Warning</span>
                      <p className="text-[11px] text-gray-400 mt-0.5 leading-normal">
                        System is 84% confident this is a <span className="text-amber-400 font-bold font-mono">{detectedType}</span>. Confirm document class below to initiate parsing rules.
                      </p>
                    </div>
                  </div>

                  <div className="flex gap-2 justify-end">
                    <button
                      onClick={handleConfirmType}
                      className="bg-amber-600 hover:bg-amber-500 text-black px-3.5 py-1.5 rounded-md font-bold text-xs transition-all cursor-pointer"
                    >
                      Confirm {detectedType}
                    </button>
                    <button
                      onClick={() => {
                        setDetectedType(detectedType === 'Commercial Invoice' ? 'Packing List' : 'Commercial Invoice');
                        setIsTypeConfirmed(true);
                        setUploadStep('extracting');
                        setTimeout(() => {
                          const generatedShipId = shipmentIdState || `SHIP-2026-${Math.floor(1000 + Math.random() * 9000)}`;
                          const fileName = uploadedFile ? uploadedFile.name : 'TC_9921_KK_INVOICE.pdf';
                          simulateUpload(generatedShipId, [
                            { name: fileName, type: detectedType === 'Commercial Invoice' ? 'Packing List' : 'Commercial Invoice' },
                            { name: 'TC_9921_KK_BOL.pdf', type: 'Bill of Lading' },
                          ]);
                          setUploadStep('done');
                        }, 1800);
                      }}
                      className="text-gray-400 hover:text-white bg-gray-950 hover:bg-gray-900 border border-gray-900 px-3.5 py-1.5 rounded-md text-xs transition-all cursor-pointer font-medium"
                    >
                      Toggle Type
                    </button>
                  </div>
                </div>
              )}
            </motion.div>
          )}

          {uploadStep === 'extracting' && (
            <motion.div
              key="extracting-state"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="text-center space-y-5 max-w-md mx-auto"
            >
              <div className="w-12 h-12 bg-gray-950 border border-gray-900 rounded-full flex items-center justify-center mx-auto">
                <Loader2 className="w-6 h-6 text-amber-500 animate-spin" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-gray-200 uppercase tracking-wider font-mono">3. RUNNING FIELD EXTRACTION</h3>
                <p className="text-xs text-gray-500 mt-1">Parsing OCR structures, auditing valuations, weights, and HTS codes cross-document...</p>
              </div>

              <div className="bg-black/60 border border-gray-950 rounded-xl p-3.5 flex flex-col text-left font-mono text-[10px] text-gray-400 divide-y divide-gray-900">
                <div className="py-1.5 flex justify-between">
                  <span>HTS Lookup Model:</span>
                  <span className="text-amber-500">RUNNING...</span>
                </div>
                <div className="py-1.5 flex justify-between">
                  <span>Valuation Check:</span>
                  <span className="text-amber-500">RUNNING...</span>
                </div>
                <div className="py-1.5 flex justify-between">
                  <span>Validation Core:</span>
                  <span className="text-gray-600">PENDING</span>
                </div>
              </div>
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
              <div className="w-14 h-14 bg-emerald-950/40 border border-emerald-900 rounded-full flex items-center justify-center mx-auto">
                <CheckCircle2 className="w-8 h-8 text-emerald-400" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-gray-200 uppercase tracking-wider font-mono">4. SHIPMENT ANALYSIS READY</h3>
                <p className="text-xs text-gray-400 mt-1 leading-normal">
                  Shipment <span className="text-emerald-400 font-bold">SHIP-2026-1033</span> has been successfully indexed. 1 minor exception was flagged for broker verification.
                </p>
              </div>

              <div className="flex gap-2.5 justify-center pt-2">
                <button
                  onClick={() => simulateUpload('SHIP-2026-1033', []).then(() => setUploadStep('idle'))}
                  className="bg-emerald-600 hover:bg-emerald-500 text-black px-4 py-2 rounded-lg font-bold text-xs transition-all cursor-pointer uppercase tracking-wider"
                >
                  Go to Exception Desk
                </button>
                <button
                  onClick={() => setUploadStep('idle')}
                  className="text-gray-400 hover:text-white border border-gray-900 px-4 py-2 rounded-lg text-xs transition-all cursor-pointer font-medium uppercase tracking-wider"
                >
                  Upload Another File
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

      </div>

      {/* RIGHT AREA: REAL-TIME INGEST CLUSTER FEED (4 cols) */}
      <div className="lg:col-span-4 bg-[#0c0d12] border border-gray-900 rounded-xl p-5 flex flex-col justify-between overflow-hidden">
        <div>
          <h3 className="text-xs font-bold font-mono tracking-widest text-gray-400 uppercase mb-3">Shipment Entry Clusters</h3>
          <p className="text-xs text-gray-500 leading-relaxed">
            As files are ingested, the NLP engine clusters associated paperwork into cohesive single shipments to prevent fragmented filing records.
          </p>

          <div className="space-y-4 mt-6">
            
            {/* Cluster Card 1 */}
            <div className="bg-black/60 border border-gray-950 p-4 rounded-xl space-y-3">
              <div className="flex justify-between items-center">
                <span className="font-mono text-xs font-extrabold text-gray-200">Cluster Group A</span>
                <span className="text-[9px] font-mono bg-emerald-950/40 text-emerald-400 border border-emerald-900/40 px-1.5 py-0.5 rounded">
                  AUTO-GROUPED
                </span>
              </div>
              <div className="flex items-center gap-2.5 text-xs">
                <div className="bg-gray-950 p-2 border border-gray-900 rounded-lg">
                  <FileText className="w-5 h-5 text-gray-400" />
                </div>
                <div>
                  <span className="font-semibold text-gray-300 block">SHIP-2026-8802</span>
                  <span className="text-[10px] text-gray-500 font-mono">4 Documents Associated</span>
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5 text-[9px] font-mono text-gray-500 pt-1">
                <span className="bg-gray-950 px-1.5 py-0.5 rounded border border-gray-900">INV_AERO_8802.pdf</span>
                <span className="bg-gray-950 px-1.5 py-0.5 rounded border border-gray-900">PK_LIST_AERO.pdf</span>
                <span className="bg-gray-950 px-1.5 py-0.5 rounded border border-gray-900">BOL_PACIFIC.pdf</span>
              </div>
            </div>

            {/* Cluster Card 2 */}
            <div className="bg-black/40 border border-gray-950/60 p-4 rounded-xl space-y-3">
              <div className="flex justify-between items-center">
                <span className="font-mono text-xs font-extrabold text-gray-400">Cluster Group B</span>
                <span className="text-[9px] font-mono bg-emerald-950/40 text-emerald-400 border border-emerald-900/40 px-1.5 py-0.5 rounded">
                  AUTO-GROUPED
                </span>
              </div>
              <div className="flex items-center gap-2.5 text-xs">
                <div className="bg-gray-950 p-2 border border-gray-900 rounded-lg">
                  <FileText className="w-5 h-5 text-gray-500" />
                </div>
                <div>
                  <span className="font-semibold text-gray-400 block">SHIP-2026-9041</span>
                  <span className="text-[10px] text-gray-600 font-mono">3 Documents Associated</span>
                </div>
              </div>
            </div>

          </div>
        </div>

        <div className="bg-black/60 border border-gray-950 rounded-xl p-3.5 flex items-start gap-2.5">
          <AlertCircle className="w-4 h-4 text-gray-500 shrink-0 mt-0.5" />
          <p className="text-[10px] text-gray-500 leading-normal">
            ClearPort relies on cryptographic document hashes to ensure file integrity. Modified, re-scanned, or corrupted duplicate files will generate immediate security warnings.
          </p>
        </div>
      </div>

    </div>
  );
}
