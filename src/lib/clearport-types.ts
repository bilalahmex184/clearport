// ============================================================================
// ClearPort — Shared Type Definitions
// Used by frontend (Next.js) and mirrored by edge functions (Deno)
// ============================================================================

export type ShipmentStatus = 'Under Review' | 'Approved' | 'Exported';
export type ExceptionStatus = 'Unresolved' | 'Accepted' | 'Corrected' | 'Rejected';
export type ExceptionType =
  | 'low_confidence'
  | 'schema_error'
  | 'math_error'
  | 'cross_doc_mismatch'
  | 'missing_field';
export type ReviewerAction = 'Accepted' | 'Corrected' | 'Rejected';
export type AuditLogType = 'info' | 'success' | 'warning' | 'error';
export type DocType =
  | 'Commercial Invoice'
  | 'Packing List'
  | 'Bill of Lading'
  | 'Certificate of Origin'
  | 'CBP Form 3461'
  | 'Unknown';

export interface BoundingBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ExceptionHistoryEntry {
  user: string;
  oldValue: string;
  newValue: string;
  timestamp: string;
  action: ReviewerAction;
}

// --- Database row types (snake_case, matches Postgres) ---

export interface DbShipment {
  id: string;
  user_id: string | null;
  shipper: string;
  consignee: string;
  status: ShipmentStatus;
  docs_count: number;
  urgency: string;
  initial_confidence: number;
  current_confidence: number;
  created_at: string;
  updated_at: string;
}

export interface DbDocument {
  id: string;
  shipment_id: string;
  user_id: string | null;
  doc_type: DocType;
  file_name: string;
  storage_path: string;
  file_size: number | null;
  mime_type: string | null;
  uploaded_at: string;
}

export interface DbDocumentField {
  id: string;
  document_id: string;
  shipment_id: string;
  user_id: string | null;
  field_key: string;
  field_label: string;
  extracted_value: string | null;
  corrected_value: string | null;
  confidence: number;
  is_flagged: boolean;
  exception_reason: string | null;
  reviewer_action: ReviewerAction | null;
  bounding_box: BoundingBox | null;
  cross_doc_value: string | null;
  cross_doc_source: string | null;
  validation_errors: string[];
  updated_at: string;
}

export interface DbException {
  id: string;
  shipment_id: string;
  field_id: string | null;
  user_id: string | null;
  field_key: string;
  field_name: string;
  original_value: string | null;
  extracted_value: string | null;
  cross_doc_value: string | null;
  confidence: number;
  reason: string;
  exception_type: ExceptionType;
  doc_type: string | null;
  bounding_box: BoundingBox | null;
  status: ExceptionStatus;
  corrected_value: string | null;
  history: ExceptionHistoryEntry[];
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
}

export interface DbOperationalRules {
  id: string;
  user_id: string | null;
  invoice_threshold: number;
  hts_threshold: number;
  parties_threshold: number;
  updated_at: string;
}

export interface DbAuditLog {
  id: string;
  shipment_id: string | null;
  user_id: string | null;
  text: string;
  timestamp: string;
  type: AuditLogType;
}

// --- Frontend state types (camelCase, used by React) ---

export interface ExtractedField {
  id: string;
  key: string;
  label: string;
  value: string;
  sourceDoc: string;
  isFlagged: boolean;
  exceptionId?: string;
  confidence: number;
  correctedValue?: string;
  crossDocValue?: string;
  crossDocSource?: string;
  boundingBox?: BoundingBox;
}

export interface Exception {
  id: string;
  fieldName: string;
  fieldKey: string;
  originalValue: string;
  extractedValue: string;
  crossDocValue?: string;
  confidence: number;
  reason: string;
  exceptionType: ExceptionType;
  docType: string;
  boundingBox: BoundingBox;
  status: ExceptionStatus;
  correctedValue?: string;
  history: ExceptionHistoryEntry[];
  fieldId?: string;
  createdAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
}

export interface ShipmentEntry {
  id: string;
  shipper: string;
  consignee: string;
  status: ShipmentStatus;
  docsCount: number;
  urgency: string;
  initialConfidence: number;
  currentConfidence: number;
  exceptions: Exception[];
  fields: ExtractedField[];
  documents: Array<{
    id: string;
    docType: DocType;
    fileName: string;
    storagePath: string;
    mimeType: string | null;
    uploadedAt: string;
  }>;
  createdAt: string;
}

export interface OperationalRules {
  invoiceThreshold: number;
  htsThreshold: number;
  partiesThreshold: number;
}

export interface AuditLog {
  id: string;
  text: string;
  timestamp: string;
  type: AuditLogType;
  shipmentId?: string;
}

// --- Edge function response types ---

export interface UploadDocumentResponse {
  success: boolean;
  documentId: string;
  shipmentId: string;
  storagePath: string;
  signedUrl: string;
  docType: DocType;
}

export interface ExtractDocumentResponse {
  success: boolean;
  shipmentId: string;
  documentId: string;
  fields: Array<{
    field_key: string;
    field_label: string;
    extracted_value: string;
    confidence: number;
    bounding_box: BoundingBox;
  }>;
  shipper?: string;
  consignee?: string;
}

export interface GetShipmentsResponse {
  success: boolean;
  shipments: ShipmentEntry[];
}

export interface EdgeFunctionError {
  error: string;
  code?: string;
}
