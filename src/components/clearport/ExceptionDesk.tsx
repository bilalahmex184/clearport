'use client';
// ============================================================================
// ExceptionDesk.tsx — thin orchestrator for the 3-panel exception review UI
// ============================================================================
// FIX5-7-SPLIT: the three panels (ExceptionList, DocumentViewer,
// ResolutionPanel) used to live inline as 600+ lines of JSX. They are now
// separate components; this file just:
//   1. Pulls the relevant slice of the ClearPort context.
//   2. Holds the cross-panel shared state (activeDocTab, zoomLevel, rotation,
//      documentUrl) — these need to be shared because:
//        • activeDocTab drives the DocumentViewer's URL fetch AND the
//          bounding-box overlay (which reacts to selectedException.docType).
//        • zoomLevel / rotation are controlled by the DocumentViewer's
//          toolbar but applied to whichever view (real file or structured
//          extract) is rendered.
//        • documentUrl is fetched inside DocumentViewer but the parent owns
//          its identity so the "VIEW FILE" re-fetch button can reset it.
//   3. Derives canResolveExceptions from the RBAC role.
//   4. Syncs activeDocTab to selectedException.docType when the selection
//      changes (so the bounding box + viewer follow the user's pick).
//   5. Renders the three panels with the right props.
//
// No behavior change — the same context slice, the same state, the same UI.
// ============================================================================

import * as React from 'react';
import { AlertCircle } from 'lucide-react';
import { useClearPort } from '@/context/ClearPortContext';
import { canResolve } from '@/lib/services/rbac.service';
import ExceptionList from './ExceptionList';
import DocumentViewer from './DocumentViewer';
import ResolutionPanel from './ResolutionPanel';
import OnboardingBanner from './OnboardingBanner';

export default function ExceptionDesk() {
  const {
    entries,
    selectedEntry,
    selectedExceptionId,
    selectedException,
    selectException,
    updateException,
    undoLastAction,
    acceptAllHighConfidence,
    rules,
    userRole,
    exportToCSV,
    setActiveTab,
  } = useClearPort();

  // --- Onboarding banner visibility (FIX 10) ------------------------------
  // Derived purely from `entries.length` + a localStorage dismissal flag —
  // no setState-in-effect. The flag is read lazily on mount (client-only;
  // SSR returns true so the banner never renders server-side, avoiding
  // hydration mismatch). Dismissal is persisted to localStorage so the
  // banner never reappears for this user, even after a reload.
  const [onboardingDismissed, setOnboardingDismissed] =
    React.useState<boolean>(() => {
      if (typeof window === 'undefined') return true; // SSR: hide banner
      return (
        window.localStorage.getItem('clearport-onboarding-dismissed') ===
        'true'
      );
    });

  const showOnboardingBanner =
    entries.length === 0 && !onboardingDismissed;

  const dismissOnboardingBanner = React.useCallback(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(
        'clearport-onboarding-dismissed',
        'true',
      );
    }
    setOnboardingDismissed(true);
  }, []);

  const goToIngest = React.useCallback(() => {
    setActiveTab('ingest');
  }, [setActiveTab]);

  // RBAC: viewer role cannot resolve exceptions. They can still browse the
  // document viewer + exception list (read-only), but the Accept / Modify /
  // Reject buttons are hidden and the keyboard shortcuts that mutate state
  // are disabled below (inside ResolutionPanel).
  const canResolveExceptions = canResolve(userRole);

  // --- Shared cross-panel state (managed here, passed down as props) -------
  const [activeDocTab, setActiveDocTab] = React.useState('');
  const [zoomLevel, setZoomLevel] = React.useState(100);
  const [rotation, setRotation] = React.useState(0);
  const [documentUrl, setDocumentUrl] = React.useState<string | null>(null);

  // When the selected exception changes, switch the document viewer to the
  // exception's source document so the bounding box shows up on the right
  // page. (editValue + isEditing are owned by ResolutionPanel — they sync
  // to the same selectedException.id change inside that component.)
  React.useEffect(() => {
    if (selectedException) {
      setActiveDocTab(selectedException.docType);
    }
  }, [selectedException?.id]);

  // --- Render --------------------------------------------------------------
  // The onboarding banner is mounted above the content area when the user
  // has 0 shipments + hasn't dismissed it. The content (no-shipment state
  // OR 3-panel grid) is unchanged from the original — we only wrap it in a
  // flex column when the banner is visible so the banner gets its own row
  // and the content fills the rest. When the banner is hidden, the layout
  // is byte-for-byte identical to the pre-onboarding version.
  const content = !selectedEntry ? (
    <div className="h-full flex flex-col items-center justify-center text-gray-500 p-6">
      <AlertCircle className="w-12 h-12 mb-4 text-gray-600 animate-pulse" />
      <p className="text-sm font-medium">No shipment selected</p>
      <p className="text-xs text-gray-600 mt-1">Please select an active batch from the Dashboard or sidebar.</p>
    </div>
  ) : (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 lg:gap-5 h-full overflow-y-auto lg:overflow-hidden p-3 sm:p-4 md:p-6 font-sans">
      <ExceptionList
        selectedEntry={selectedEntry}
        selectedExceptionId={selectedExceptionId}
        onSelectException={selectException}
        onExportCSV={exportToCSV}
        onAcceptAllHighConfidence={acceptAllHighConfidence}
        rules={rules}
        canResolveExceptions={canResolveExceptions}
        userRole={userRole}
      />

      <DocumentViewer
        selectedEntry={selectedEntry}
        selectedException={selectedException}
        activeDocTab={activeDocTab}
        setActiveDocTab={setActiveDocTab}
        documentUrl={documentUrl}
        setDocumentUrl={setDocumentUrl}
        zoomLevel={zoomLevel}
        setZoomLevel={setZoomLevel}
        rotation={rotation}
        setRotation={setRotation}
      />

      <ResolutionPanel
        selectedEntry={selectedEntry}
        selectedException={selectedException}
        onUpdateException={updateException}
        onUndoLastAction={undoLastAction}
        canResolveExceptions={canResolveExceptions}
      />
    </div>
  );

  if (!showOnboardingBanner) {
    return content;
  }

  return (
    <div className="flex flex-col h-full">
      <OnboardingBanner
        onDismiss={dismissOnboardingBanner}
        onGoToIngest={goToIngest}
      />
      <div className="flex-1 min-h-0">{content}</div>
    </div>
  );
}
