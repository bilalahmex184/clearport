// packages/shared/src/schema.ts — Shared extraction field schema
// Single definition of all extraction fields, used by both the web app
// and the future Cloudflare Workers (ingress + consumer).

export interface ExtractedField {
  field_key: string;
  field_label: string;
  extracted_value: string;
  confidence: number; // 0-100
  source_location?: {
    page: number;
    text_anchor: string;
    approx_position: 'top' | 'middle' | 'bottom';
  };
  line_items_array?: Array<{
    item_number: number;
    description: string;
    quantity: number;
    unit_of_measure: string;
    unit_price: number;
    amount: number;
  }>;
}

export interface JobRecord {
  id: string;
  shipment_id: string;
  org_id: string;
  user_id: string;
  status: 'queued' | 'processing' | 'completed' | 'failed' | 'dead_letter';
  document_id: string;
  file_name: string;
  storage_path: string;
  mime_type: string;
  created_at: string;
  updated_at: string;
  error_message?: string;
  retry_count: number;
  trace_id?: string;
}

export const EXTRACTION_FIELDS = [
  'shipper_name', 'shipper_address', 'shipper_email', 'shipper_phone',
  'consignee_name', 'consignee_address', 'consignee_email',
  'notify_party', 'bill_of_lading_number', 'carrier_ref', 'booking_number',
  'container_numbers', 'container_number', 'seal_numbers', 'seal_number',
  'vessel_name', 'voyage_number', 'port_of_loading', 'port_of_discharge',
  'port_of_entry', 'place_of_receipt', 'place_of_delivery',
  'goods_description', 'hs_codes', 'quantity', 'net_weight', 'net_weight_kg',
  'gross_weight', 'gross_weight_kg', 'total_gross_weight', 'weight_unit',
  'incoterms', 'freight_terms', 'invoice_number', 'invoice_date',
  'due_date', 'payment_date', 'shipment_date', 'shipped_on_board_date',
  'delivery_date', 'currency', 'unit_price', 'total_value', 'subtotal',
  'discount', 'tax', 'country_of_origin', 'carrier', 'line_items',
  'payment_status', 'payment_bank_name', 'payment_account_last4',
  'payment_transaction_id', 'payment_method', 'qty_received',
] as const;

export type ExtractionFieldKey = typeof EXTRACTION_FIELDS[number];
