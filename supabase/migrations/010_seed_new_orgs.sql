-- ============================================================================
-- Migration 010: Auto-seed validation rules + broker templates for new orgs
-- ============================================================================

-- Function to seed default validation rules for a new org
CREATE OR REPLACE FUNCTION seed_default_validation_rules(new_org_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
  INSERT INTO validation_rules (org_id, name, field_key, rule_type, config, severity, is_active)
  VALUES
    (new_org_id, 'Invoice Value Confidence Threshold', 'declaredValue', 'confidence_threshold', '{"min_confidence": 80}', 'flag', true),
    (new_org_id, 'HTS Code Confidence Threshold', 'htsCode', 'confidence_threshold', '{"min_confidence": 85}', 'flag', true),
    (new_org_id, 'Shipper Confidence Threshold', 'shipper', 'confidence_threshold', '{"min_confidence": 75}', 'flag', true),
    (new_org_id, 'Consignee Confidence Threshold', 'consignee', 'confidence_threshold', '{"min_confidence": 75}', 'flag', true),
    (new_org_id, 'HTS Code Format', 'htsCode', 'regex_format', '{"pattern": "^\\d{4}\\.\\d{2}\\.\\d{4}$"}', 'flag', true),
    (new_org_id, 'Country Code Format', 'countryOfOrigin', 'regex_format', '{"pattern": "^[A-Z]{2}$"}', 'flag', true),
    (new_org_id, 'Invoice Number Required', 'invoiceNo', 'required_field', '{}', 'flag', true),
    (new_org_id, 'Shipper Required', 'shipper', 'required_field', '{}', 'flag', true),
    (new_org_id, 'Consignee Required', 'consignee', 'required_field', '{}', 'flag', true),
    (new_org_id, 'Declared Value Required', 'declaredValue', 'required_field', '{}', 'flag', true),
    (new_org_id, 'Declared Value Must Be Positive', 'declaredValue', 'math_check', '{"check": "greater_than_zero"}', 'flag', true),
    (new_org_id, 'Gross Weight >= Net Weight', 'grossWeight', 'math_check', '{"check": "gross_gte_net"}', 'flag', true),
    (new_org_id, 'Cross-Document Value Consistency', NULL, 'cross_doc_match', '{"tolerance_percent": 0}', 'flag', true);
END;
$$;

-- Function to seed default broker templates for a new org
CREATE OR REPLACE FUNCTION seed_default_broker_templates(new_org_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  import_tpl_id UUID;
  export_tpl_id UUID;
BEGIN
  -- Default import template
  INSERT INTO broker_templates (org_id, name, direction, delimiter, encoding, is_active)
  VALUES (new_org_id, 'Default Import Template', 'import', ',', 'utf-8', true)
  RETURNING id INTO import_tpl_id;

  INSERT INTO broker_field_mappings (template_id, internal_field_key, external_field_name, is_required, sort_order) VALUES
    (import_tpl_id, 'invoiceNo', 'Invoice Number', false, 1),
    (import_tpl_id, 'invoiceNo', 'InvoiceNo', false, 2),
    (import_tpl_id, 'invoiceDate', 'Invoice Date', false, 3),
    (import_tpl_id, 'invoiceDate', 'Date', false, 4),
    (import_tpl_id, 'shipper', 'Shipper', false, 5),
    (import_tpl_id, 'shipper', 'Exporter', false, 6),
    (import_tpl_id, 'consignee', 'Consignee', false, 7),
    (import_tpl_id, 'consignee', 'Importer', false, 8),
    (import_tpl_id, 'declaredValue', 'Total Value', false, 9),
    (import_tpl_id, 'declaredValue', 'Declared Value', false, 10),
    (import_tpl_id, 'htsCode', 'HTS Code', false, 11),
    (import_tpl_id, 'htsCode', 'HS Code', false, 12),
    (import_tpl_id, 'netWeight', 'Net Weight', false, 13),
    (import_tpl_id, 'netWeight', 'Weight', false, 14),
    (import_tpl_id, 'countryOfOrigin', 'Country of Origin', false, 15),
    (import_tpl_id, 'countryOfOrigin', 'Origin', false, 16),
    (import_tpl_id, 'carrier', 'Carrier', false, 17),
    (import_tpl_id, 'portOfEntry', 'Port of Entry', false, 18),
    (import_tpl_id, 'billOfLading', 'Bill of Lading', false, 19),
    (import_tpl_id, 'billOfLading', 'BOL', false, 20);

  -- Default export template
  INSERT INTO broker_templates (org_id, name, direction, delimiter, encoding, is_active)
  VALUES (new_org_id, 'Default Export Template', 'export', ',', 'utf-8', true)
  RETURNING id INTO export_tpl_id;

  INSERT INTO broker_field_mappings (template_id, internal_field_key, external_field_name, is_required, sort_order) VALUES
    (export_tpl_id, 'invoiceNo', 'invoice_number', true, 1),
    (export_tpl_id, 'invoiceDate', 'invoice_date', false, 2),
    (export_tpl_id, 'shipper', 'shipper_name', true, 3),
    (export_tpl_id, 'consignee', 'consignee_name', true, 4),
    (export_tpl_id, 'declaredValue', 'total_value', true, 5),
    (export_tpl_id, 'htsCode', 'hts_code', false, 6),
    (export_tpl_id, 'netWeight', 'net_weight', false, 7),
    (export_tpl_id, 'countryOfOrigin', 'country_of_origin', false, 8),
    (export_tpl_id, 'carrier', 'carrier', false, 9),
    (export_tpl_id, 'portOfEntry', 'port_of_entry', false, 10);
END;
$$;

-- Update create_organization to also seed defaults
CREATE OR REPLACE FUNCTION create_organization(p_org_name TEXT, p_creator_uid UUID)
RETURNS TABLE(org_id UUID, org_name TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_new_org_id UUID;
BEGIN
  INSERT INTO public.organizations (name)
  VALUES (p_org_name)
  RETURNING id INTO v_new_org_id;
  
  INSERT INTO public.organization_members (org_id, user_id, role, invited_by)
  VALUES (v_new_org_id, p_creator_uid, 'admin', p_creator_uid);
  
  -- Seed default validation rules + broker templates
  PERFORM seed_default_validation_rules(v_new_org_id);
  PERFORM seed_default_broker_templates(v_new_org_id);
  
  org_id := v_new_org_id;
  org_name := p_org_name;
  RETURN NEXT;
END;
$$;

GRANT EXECUTE ON FUNCTION create_organization(TEXT, UUID) TO authenticated;
