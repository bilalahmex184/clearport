'use client';
// ============================================================================
// DocumentViewer.tsx — Center panel of the ExceptionDesk
// ============================================================================
// Extracted from ExceptionDesk.tsx (FIX5-7-SPLIT — behavior-preserving).
//
// Renders the data-driven document tabs (derived from the shipment's fields
// + uploaded documents), zoom/rotate controls, and the document board:
//   • If a signed URL was fetched → show the real file (image / PDF / text /
//     unknown with download link) with the flagged-field bounding box overlay.
//   • Else if a fetch is in flight → spinner.
//   • Else → "structured extract" fallback that lists the field/value pairs
//     for the active tab.
//
// Local state: documentMime, isLoadingUrl (only this panel reads them).
// The active tab + the resolved documentUrl are shared with the parent
// (ExceptionDesk) so the bounding-box overlay can react to selection changes
// fired from the left panel.
// ============================================================================

import * as React from 'react';
import {
  Eye, FileText, ZoomIn, ZoomOut, RotateCw, Loader2,
} from 'lucide-react';
import { motion } from 'framer-motion';
import { supabase, invokeEdgeFunction } from '@/lib/supabase';
import type { ShipmentEntry, Exception } from '@/lib/clearport-types';

export interface DocumentViewerProps {
  selectedEntry: ShipmentEntry;
  selectedException: Exception | undefined;
  activeDocTab: string;
  setActiveDocTab: (tab: string) => void;
  documentUrl: string | null;
  setDocumentUrl: (url: string | null) => void;
  zoomLevel: number;
  setZoomLevel: React.Dispatch<React.SetStateAction<number>>;
  rotation: number;
  setRotation: React.Dispatch<React.SetStateAction<number>>;
}

export default function DocumentViewer({
  selectedEntry,
  selectedException,
  activeDocTab,
  setActiveDocTab,
  documentUrl,
  setDocumentUrl,
  zoomLevel,
  setZoomLevel,
  rotation,
  setRotation,
}: DocumentViewerProps) {
  const [documentMime, setDocumentMime] = React.useState<string>('');
  const [isLoadingUrl, setIsLoadingUrl] = React.useState(false);

  // Fetch signed URL for the active document when tab changes
  React.useEffect(() => {
    if (!selectedEntry || !activeDocTab) {
      setDocumentUrl(null);
      setDocumentMime('');
      return;
    }

    // Find the document matching the active tab
    const doc = selectedEntry.documents.find(d => d.docType === activeDocTab);
    if (!doc) {
      setDocumentUrl(null);
      setDocumentMime('');
      return;
    }

    let cancelled = false;
    setIsLoadingUrl(true);
    setDocumentUrl(null);
    setDocumentMime(doc.mimeType || '');

    (async () => {
      try {
        // Try the get-document-url edge function first
        const response = await invokeEdgeFunction<any>('get-document-url', {
          storagePath: doc.storagePath,
        });
        if (!cancelled && response?.success && response.signedUrl) {
          setDocumentUrl(response.signedUrl);
        }
      } catch (err) {
        // Fallback: try direct Supabase storage signed URL
        if (supabase && !cancelled) {
          try {
            const { data } = await supabase.storage
              .from('documents')
              .createSignedUrl(doc.storagePath, 3600);
            if (data?.signedUrl) {
              setDocumentUrl(data.signedUrl);
            }
          } catch (e) {
            console.warn('[doc-url] failed to get signed URL:', e);
          }
        }
      } finally {
        if (!cancelled) setIsLoadingUrl(false);
      }
    })();

    return () => { cancelled = true; };
  }, [selectedEntry?.id, selectedEntry, activeDocTab, setDocumentUrl]);

  // Data-driven document tabs (derive from shipment fields, not hardcoded IDs)
  // Derive available doc types from BOTH fields' sourceDoc AND uploaded documents
  const availableDocTypes = Array.from(new Set([
    ...selectedEntry.fields.map(f => f.sourceDoc).filter(Boolean),
    ...selectedEntry.documents.map(d => d.docType).filter(Boolean),
  ]));

  // Filter fields by the active doc tab (if multiple doc types exist)
  const fieldsForActiveTab = availableDocTypes.length > 1
    ? selectedEntry.fields.filter(f => f.sourceDoc === activeDocTab || !activeDocTab)
    : selectedEntry.fields;

  return (
    <div className="lg:col-span-5 bg-[#0c0d12] border border-gray-900 rounded-xl flex flex-col overflow-hidden relative min-h-[500px] lg:min-h-0">
      {/* Document Tabs (data-driven) */}
      <div className="px-4 py-2 bg-[#0e1017] border-b border-gray-900 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-1.5 overflow-x-auto">
          {availableDocTypes.map(doc => (
            <button
              key={doc}
              onClick={() => setActiveDocTab(doc)}
              className={`text-xs px-3 py-1.5 rounded-md font-medium transition-all whitespace-nowrap ${
                activeDocTab === doc
                  ? 'bg-gray-800 text-gray-100'
                  : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              {doc === 'Commercial Invoice' ? 'Invoice' : doc === 'Bill of Lading' ? 'BOL' : doc}
            </button>
          ))}
          {availableDocTypes.length === 0 && (
            <span className="text-xs text-gray-600">No documents available</span>
          )}
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={() => setZoomLevel(prev => Math.max(50, prev - 10))}
            title="Zoom Out"
            className="p-1 rounded text-gray-500 hover:text-gray-300 hover:bg-gray-950 transition-all cursor-pointer"
          >
            <ZoomOut className="w-4 h-4" />
          </button>
          <span className="text-xs font-mono text-gray-500 w-10 text-center">{zoomLevel}%</span>
          <button
            onClick={() => setZoomLevel(prev => Math.min(200, prev + 10))}
            title="Zoom In"
            className="p-1 rounded text-gray-500 hover:text-gray-300 hover:bg-gray-950 transition-all cursor-pointer"
          >
            <ZoomIn className="w-4 h-4" />
          </button>
          <button
            onClick={() => setRotation(prev => (prev + 90) % 360)}
            title="Rotate 90°"
            className="p-1 rounded text-gray-500 hover:text-gray-300 hover:bg-gray-950 transition-all cursor-pointer"
          >
            <RotateCw className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Document Board — shows real uploaded file or extracted data view */}
      <div className="flex-1 overflow-auto bg-[#040406] p-3 sm:p-4 md:p-6 flex items-start justify-center relative">
        {documentUrl ? (
          /* Real file viewer — show the actual uploaded document based on MIME type */
          <div
            style={{
              transform: `scale(${zoomLevel / 100}) rotate(${rotation}deg)`,
              transformOrigin: 'top center',
              transition: 'transform 0.15s ease-out',
            }}
            className="rounded border border-gray-700 shadow-2xl overflow-hidden bg-white relative"
          >
            {documentMime.startsWith('text/') ? (
              /* Text file — show in iframe with monospace styling */
              <iframe
                src={documentUrl}
                className="w-full max-w-[500px] h-[400px] sm:h-[500px] md:h-[600px] bg-white"
                title="Document text"
                style={{ fontFamily: 'monospace', fontSize: '12px' }}
              />
            ) : documentMime === 'application/pdf' ? (
              /* PDF — show in iframe (browser's built-in PDF viewer) */
              <iframe
                src={documentUrl}
                className="w-full max-w-[500px] h-[400px] sm:h-[500px] md:h-[600px] bg-white"
                title="Document PDF"
              />
            ) : documentMime.startsWith('image/') ? (
              /* Image (PNG, JPEG, TIFF) — show directly with zoom/rotate */
              <img
                src={documentUrl}
                alt={`Document: ${activeDocTab}`}
                className="max-w-full max-h-[400px] sm:max-h-[500px] md:max-h-[600px] object-contain mx-auto"
                onError={(e) => {
                  console.warn('[doc-viewer] image failed to load:', documentUrl);
                }}
              />
            ) : (
              /* Unknown type — provide download link */
              <div className="w-full max-w-[500px] h-[400px] sm:h-[500px] md:h-[600px] flex flex-col items-center justify-center bg-gray-50 p-4 sm:p-8 text-center">
                <FileText className="w-16 h-16 text-gray-400 mb-4" />
                <p className="text-sm font-semibold text-gray-700 mb-2">
                  {activeDocTab || 'Document'}
                </p>
                <p className="text-xs text-gray-500 mb-4">
                  Preview not available for this file type ({documentMime || 'unknown'})
                </p>
                <a
                  href={documentUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs bg-amber-500 hover:bg-amber-600 text-black font-bold px-4 py-2 rounded-lg transition-all"
                >
                  Download File
                </a>
              </div>
            )}

            {/* Highlighted bounding box overlay */}
            {selectedException && activeDocTab === selectedException.docType && (
              <motion.div
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                className="absolute border-[2px] border-amber-500 bg-amber-500/10 rounded pointer-events-none shadow-[0_0_12px_rgba(245,158,11,0.4)]"
                style={{
                  left: `${selectedException.boundingBox.x}%`,
                  top: `${selectedException.boundingBox.y}%`,
                  width: `${selectedException.boundingBox.w}%`,
                  height: `${selectedException.boundingBox.h}%`,
                }}
              >
                <div className="absolute -top-3.5 left-0 text-[7px] font-mono text-white bg-amber-600 px-1 py-0.5 rounded shadow whitespace-nowrap uppercase tracking-wider font-bold">
                  FLAGGED: {selectedException.fieldName.toUpperCase()}
                </div>
              </motion.div>
            )}
          </div>
        ) : isLoadingUrl ? (
          <div className="flex items-center justify-center h-full">
            <Loader2 className="w-8 h-8 text-amber-500 animate-spin" />
          </div>
        ) : (
          /* Fallback: show extracted data as a structured view (not a fake document) */
          <div
            style={{
              transform: `scale(${zoomLevel / 100}) rotate(${rotation}deg)`,
              transformOrigin: 'top center',
              transition: 'transform 0.15s ease-out',
            }}
            className="w-full max-w-[500px] bg-[#0c0d12] border border-gray-800 rounded-xl shadow-2xl p-4 sm:p-6 relative"
          >
            <div className="flex items-center justify-between mb-4 pb-3 border-b border-gray-800">
              <div>
                <h3 className="text-sm font-bold text-gray-100 uppercase tracking-wider">
                  {activeDocTab || 'Extracted Data'}
                </h3>
                <p className="text-[10px] text-gray-500 font-mono mt-0.5">
                  {selectedEntry.id} • {selectedEntry.documents.length} file(s) uploaded
                </p>
              </div>
              <div className="flex items-center gap-2">
                {selectedEntry.documents.length > 0 && (
                  <button
                    onClick={() => {
                      const doc = selectedEntry.documents.find(d => d.docType === activeDocTab) || selectedEntry.documents[0];
                      if (doc) {
                        setActiveDocTab(doc.docType);
                        // Trigger re-fetch by changing tab
                        setDocumentUrl(null);
                        // Re-run the effect by toggling
                        setTimeout(() => setActiveDocTab(doc.docType), 10);
                      }
                    }}
                    className="flex items-center gap-1 text-[9px] font-mono text-amber-400 border border-amber-900/40 px-2 py-1 rounded hover:bg-amber-950/30 transition-all"
                    title="Load original file"
                  >
                    <Eye className="w-3 h-3" />
                    VIEW FILE
                  </button>
                )}
                <span className="text-[9px] font-mono bg-amber-950/40 text-amber-400 border border-amber-900/40 px-2 py-0.5 rounded uppercase">
                  Structured Extract
                </span>
              </div>
            </div>

            <div className="space-y-2">
              {fieldsForActiveTab.map((f, idx) => (
                <div key={f.id || idx} className={`flex justify-between items-start p-2 rounded border ${
                  f.isFlagged ? 'bg-red-950/20 border-red-900/40' : 'bg-black/30 border-gray-900'
                }`}>
                  <div className="flex-1">
                    <span className="text-[10px] font-mono text-gray-500 uppercase tracking-wider block">{f.label}</span>
                    <span className={`text-xs font-mono ${f.isFlagged ? 'text-amber-400' : 'text-gray-200'}`}>
                      {f.value}
                    </span>
                    {f.crossDocValue && (
                      <span className="text-[9px] text-red-400 block mt-0.5">↔ {f.crossDocValue}</span>
                    )}
                  </div>
                  <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded ${
                    f.confidence < 60 ? 'bg-red-950 text-red-400' :
                    f.confidence < 85 ? 'bg-amber-950 text-amber-400' :
                    'bg-emerald-950 text-emerald-400'
                  }`}>
                    {f.confidence}%
                  </span>
                </div>
              ))}
            </div>

            {fieldsForActiveTab.length === 0 && (
              <div className="text-center py-8 text-gray-600 text-xs">
                No fields for {activeDocTab || 'this document'}. Upload a {activeDocTab || 'document'} or check another tab.
              </div>
            )}

            {selectedException && activeDocTab === selectedException.docType && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="mt-4 p-3 bg-amber-950/20 border border-amber-900/40 rounded-lg"
              >
                <div className="text-[10px] font-mono text-amber-400 uppercase tracking-wider mb-1">
                  ⚠ FLAGGED: {selectedException.fieldName}
                </div>
                <p className="text-[11px] text-gray-300">{selectedException.reason}</p>
              </motion.div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
