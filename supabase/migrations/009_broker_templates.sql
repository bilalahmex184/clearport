-- ============================================================================
-- Migration 009: Field-mapping system (broker templates + mappings)
-- ============================================================================

CREATE TABLE IF NOT EXISTS broker_templates (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('import', 'export')),
  delimiter TEXT NOT NULL DEFAULT ',',
  encoding TEXT NOT NULL DEFAULT 'utf-8',
  version INTEGER NOT NULL DEFAULT 1,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS broker_field_mappings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  template_id UUID NOT NULL REFERENCES broker_templates(id) ON DELETE CASCADE,
  internal_field_key TEXT NOT NULL,
  external_field_name TEXT NOT NULL,
  transform JSONB DEFAULT '{}'::jsonb,
  is_required BOOLEAN NOT NULL DEFAULT false,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_broker_templates_org_id ON broker_templates(org_id);
CREATE INDEX IF NOT EXISTS idx_broker_field_mappings_template_id ON broker_field_mappings(template_id);

-- RLS
ALTER TABLE broker_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE broker_field_mappings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "org_scoped_broker_templates" ON broker_templates;
CREATE POLICY "org_scoped_broker_templates" ON broker_templates
  FOR ALL TO authenticated
  USING (
    (org_id IS NOT NULL AND is_org_member(org_id, auth.uid()))
    OR (org_id IS NULL AND user_id = auth.uid())
  )
  WITH CHECK (
    (org_id IS NOT NULL AND is_org_member(org_id, auth.uid()))
    OR (org_id IS NULL AND user_id = auth.uid())
  );

DROP POLICY IF EXISTS "org_scoped_broker_field_mappings" ON broker_field_mappings;
CREATE POLICY "org_scoped_broker_field_mappings" ON broker_field_mappings
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM broker_templates bt
      WHERE bt.id = broker_field_mappings.template_id
      AND (
        (bt.org_id IS NOT NULL AND is_org_member(bt.org_id, auth.uid()))
        OR (bt.org_id IS NULL AND bt.user_id = auth.uid())
      )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM broker_templates bt
      WHERE bt.id = broker_field_mappings.template_id
      AND (
        (bt.org_id IS NOT NULL AND is_org_member(bt.org_id, auth.uid()))
        OR (bt.org_id IS NULL AND bt.user_id = auth.uid())
      )
    )
  );

-- Triggers for auto org_id
CREATE OR REPLACE FUNCTION set_broker_templates_org_id()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.org_id IS NULL THEN
    SELECT org_id INTO NEW.org_id FROM organization_members WHERE user_id = NEW.user_id LIMIT 1;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_broker_templates_set_org ON broker_templates;
CREATE TRIGGER trg_broker_templates_set_org BEFORE INSERT ON broker_templates
  FOR EACH ROW EXECUTE FUNCTION set_broker_templates_org_id();

-- Seed default import template for existing orgs
DO $$
DECLARE
  org_record RECORD;
  template_id UUID;
BEGIN
  FOR org_record IN SELECT id FROM organizations LOOP
    -- Create default import template
    INSERT INTO broker_templates (org_id, name, direction, delimiter, encoding, is_active)
    VALUES (org_record.id, 'Default Import Template', 'import', ',', 'utf-8', true)
    RETURNING id INTO template_id;

    -- Seed default field mappings (mirrors the hardcoded headerMap in extract-document)
    INSERT INTO broker_field_mappings (template_id, internal_field_key, external_field_name, is_required, sort_order) VALUES
      (template_id, 'invoiceNo', 'Invoice Number', false, 1),
      (template_id, 'invoiceNo', 'InvoiceNo', false, 2),
      (template_id, 'invoiceDate', 'Invoice Date', false, 3),
      (template_id, 'invoiceDate', 'Date', false, 4),
      (template_id, 'shipper', 'Shipper', false, 5),
      (template_id, 'shipper', 'Exporter', false, 6),
      (template_id, 'consignee', 'Consignee', false, 7),
      (template_id, 'consignee', 'Importer', false, 8),
      (template_id, 'declaredValue', 'Total Value', false, 9),
      (template_id, 'declaredValue', 'Declared Value', false, 10),
      (template_id, 'htsCode', 'HTS Code', false, 11),
      (template_id, 'htsCode', 'HS Code', false, 12),
      (template_id, 'netWeight', 'Net Weight', false, 13),
      (template_id, 'netWeight', 'Weight', false, 14),
      (template_id, 'countryOfOrigin', 'Country of Origin', false, 15),
      (template_id, 'countryOfOrigin', 'Origin', false, 16),
      (template_id, 'carrier', 'Carrier', false, 17),
      (template_id, 'portOfEntry', 'Port of Entry', false, 18),
      (template_id, 'billOfLading', 'Bill of Lading', false, 19),
      (template_id, 'billOfLading', 'BOL', false, 20);

    -- Create default export template
    INSERT INTO broker_templates (org_id, name, direction, delimiter, encoding, is_active)
    VALUES (org_record.id, 'Default Export Template', 'export', ',', 'utf-8', true)
    RETURNING id INTO template_id;

    INSERT INTO broker_field_mappings (template_id, internal_field_key, external_field_name, is_required, sort_order) VALUES
      (template_id, 'invoiceNo', 'invoice_number', true, 1),
      (template_id, 'invoiceDate', 'invoice_date', false, 2),
      (template_id, 'shipper', 'shipper_name', true, 3),
      (template_id, 'consignee', 'consignee_name', true, 4),
      (template_id, 'declaredValue', 'total_value', true, 5),
      (template_id, 'htsCode', 'hts_code', false, 6),
      (template_id, 'netWeight', 'net_weight', false, 7),
      (template_id, 'countryOfOrigin', 'country_of_origin', false, 8),
      (template_id, 'carrier', 'carrier', false, 9),
      (template_id, 'portOfEntry', 'port_of_entry', false, 10);
  END LOOP;
END $$;
