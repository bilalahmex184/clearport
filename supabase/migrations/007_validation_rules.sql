-- ============================================================================
-- Migration 007: Configurable Rule Engine
-- Moves hardcoded validation rules from edge functions into a data-driven table
-- ============================================================================

CREATE TABLE IF NOT EXISTS validation_rules (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  field_key TEXT,
  rule_type TEXT NOT NULL CHECK (rule_type IN (
    'confidence_threshold',
    'math_check',
    'cross_doc_match',
    'required_field',
    'regex_format'
  )),
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  severity TEXT NOT NULL DEFAULT 'flag' CHECK (severity IN ('block', 'flag', 'warn')),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_validation_rules_org_id ON validation_rules(org_id);
CREATE INDEX IF NOT EXISTS idx_validation_rules_active ON validation_rules(is_active) WHERE is_active = true;

-- Add user_id column for backward compat with the set_user_id trigger
ALTER TABLE validation_rules ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;

-- ============================================================================
-- RLS
-- ============================================================================
ALTER TABLE validation_rules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "org_scoped_validation_rules" ON validation_rules;
CREATE POLICY "org_scoped_validation_rules" ON validation_rules
  FOR ALL TO authenticated
  USING (
    (org_id IS NOT NULL AND is_org_member(org_id, auth.uid()))
    OR (org_id IS NULL AND user_id IS NULL)
  )
  WITH CHECK (
    (org_id IS NOT NULL AND is_org_member(org_id, auth.uid()))
  );

-- ============================================================================
-- Seed default rules for every existing org
-- These mirror the hardcoded logic currently in flag-exceptions, schema-validate, math-validate
-- ============================================================================
DO $$
DECLARE
  org_record RECORD;
BEGIN
  FOR org_record IN SELECT id FROM organizations LOOP
    -- Confidence threshold: invoice fields
    INSERT INTO validation_rules (org_id, name, field_key, rule_type, config, severity, is_active)
    VALUES (
      org_record.id, 'Invoice Value Confidence Threshold', 'declaredValue',
      'confidence_threshold',
      '{"min_confidence": 80}'::jsonb,
      'flag', true
    ) ON CONFLICT DO NOTHING;

    -- Confidence threshold: HTS code
    INSERT INTO validation_rules (org_id, name, field_key, rule_type, config, severity, is_active)
    VALUES (
      org_record.id, 'HTS Code Confidence Threshold', 'htsCode',
      'confidence_threshold',
      '{"min_confidence": 85}'::jsonb,
      'flag', true
    ) ON CONFLICT DO NOTHING;

    -- Confidence threshold: parties (shipper/consignee)
    INSERT INTO validation_rules (org_id, name, field_key, rule_type, config, severity, is_active)
    VALUES (
      org_record.id, 'Parties Confidence Threshold', 'shipper',
      'confidence_threshold',
      '{"min_confidence": 75}'::jsonb,
      'flag', true
    ) ON CONFLICT DO NOTHING;

    INSERT INTO validation_rules (org_id, name, field_key, rule_type, config, severity, is_active)
    VALUES (
      org_record.id, 'Consignee Confidence Threshold', 'consignee',
      'confidence_threshold',
      '{"min_confidence": 75}'::jsonb,
      'flag', true
    ) ON CONFLICT DO NOTHING;

    -- Regex format: HTS code
    INSERT INTO validation_rules (org_id, name, field_key, rule_type, config, severity, is_active)
    VALUES (
      org_record.id, 'HTS Code Format', 'htsCode',
      'regex_format',
      '{"pattern": "^\\d{4}\\.\\d{2}\\.\\d{4}$"}'::jsonb,
      'flag', true
    ) ON CONFLICT DO NOTHING;

    -- Regex format: country of origin (2-letter ISO)
    INSERT INTO validation_rules (org_id, name, field_key, rule_type, config, severity, is_active)
    VALUES (
      org_record.id, 'Country Code Format', 'countryOfOrigin',
      'regex_format',
      '{"pattern": "^[A-Z]{2}$"}'::jsonb,
      'flag', true
    ) ON CONFLICT DO NOTHING;

    -- Required fields
    INSERT INTO validation_rules (org_id, name, field_key, rule_type, config, severity, is_active)
    VALUES (
      org_record.id, 'Invoice Number Required', 'invoiceNo',
      'required_field',
      '{}'::jsonb,
      'flag', true
    ) ON CONFLICT DO NOTHING;

    INSERT INTO validation_rules (org_id, name, field_key, rule_type, config, severity, is_active)
    VALUES (
      org_record.id, 'Shipper Required', 'shipper',
      'required_field',
      '{}'::jsonb,
      'flag', true
    ) ON CONFLICT DO NOTHING;

    INSERT INTO validation_rules (org_id, name, field_key, rule_type, config, severity, is_active)
    VALUES (
      org_record.id, 'Consignee Required', 'consignee',
      'required_field',
      '{}'::jsonb,
      'flag', true
    ) ON CONFLICT DO NOTHING;

    INSERT INTO validation_rules (org_id, name, field_key, rule_type, config, severity, is_active)
    VALUES (
      org_record.id, 'Declared Value Required', 'declaredValue',
      'required_field',
      '{}'::jsonb,
      'flag', true
    ) ON CONFLICT DO NOTHING;

    -- Math check: value > 0
    INSERT INTO validation_rules (org_id, name, field_key, rule_type, config, severity, is_active)
    VALUES (
      org_record.id, 'Declared Value Must Be Positive', 'declaredValue',
      'math_check',
      '{"check": "greater_than_zero"}'::jsonb,
      'flag', true
    ) ON CONFLICT DO NOTHING;

    -- Math check: gross >= net weight
    INSERT INTO validation_rules (org_id, name, field_key, rule_type, config, severity, is_active)
    VALUES (
      org_record.id, 'Gross Weight >= Net Weight', 'grossWeight',
      'math_check',
      '{"check": "gross_gte_net"}'::jsonb,
      'flag', true
    ) ON CONFLICT DO NOTHING;

    -- Cross-doc match: same field across documents must match
    INSERT INTO validation_rules (org_id, name, field_key, rule_type, config, severity, is_active)
    VALUES (
      org_record.id, 'Cross-Document Value Consistency', NULL,
      'cross_doc_match',
      '{"tolerance_percent": 0}'::jsonb,
      'flag', true
    ) ON CONFLICT DO NOTHING;

  END LOOP;
END $$;

-- ============================================================================
-- Trigger: set org_id on insert
-- ============================================================================
CREATE OR REPLACE FUNCTION set_validation_rules_org_id()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.org_id IS NULL THEN
    SELECT org_id INTO NEW.org_id FROM organization_members WHERE user_id = NEW.user_id LIMIT 1;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_validation_rules_set_org ON validation_rules;
CREATE TRIGGER trg_validation_rules_set_org BEFORE INSERT ON validation_rules
  FOR EACH ROW EXECUTE FUNCTION set_validation_rules_org_id();
