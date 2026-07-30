// ============================================================================
// ClearPort — Rule Engine (Upgraded)
// Loads active validation_rules for an org and runs them against document_fields.
// Returns RuleEvaluationResult[] with severity, decision_trace, and dependencies.
// ============================================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/lib/utils/logger';
import type { RuleEvaluationResult, DecisionTrace } from '@/lib/rules/types';

export interface ValidationRule {
  id: string;
  org_id: string;
  name: string;
  field_key: string | null;
  rule_type: 'confidence_threshold' | 'math_check' | 'cross_doc_match' | 'required_field' | 'regex_format';
  config: Record<string, any>;
  severity: 'block' | 'flag' | 'warn';
  is_active: boolean;
}

// Legacy result type (backward compat)
export interface RuleResult {
  rule_id: string;
  rule_name: string;
  field_key: string | null;
  passed: boolean;
  message: string;
  severity: 'block' | 'flag' | 'warn';
}

export interface DocumentField {
  id: string;
  field_key: string;
  field_label: string;
  extracted_value: string | null;
  corrected_value: string | null;
  confidence: number;
  is_flagged: boolean;
  document_id: string;
  documents?: { doc_type: string; file_name: string } | null;
}

/**
 * Load all active validation rules for an org.
 */
export async function loadRules(client: SupabaseClient, orgId: string): Promise<ValidationRule[]> {
  const { data, error } = await client
    .from('validation_rules')
    .select('*')
    .eq('org_id', orgId)
    .eq('is_active', true)
    .order('created_at', { ascending: true });

  if (error) {
    logger.error('RuleEngine: failed to load rules', { orgId, error: error.message });
    return [];
  }

  return (data || []) as ValidationRule[];
}

/**
 * Run all rules against a set of document fields.
 * Returns a flat list of results (one per rule per field that was evaluated).
 */
export function runRules(rules: ValidationRule[], fields: DocumentField[]): RuleResult[] {
  const results: RuleResult[] = [];

  for (const rule of rules) {
    if (rule.field_key) {
      // Field-specific rule: find matching field(s)
      const matchingFields = fields.filter(f => f.field_key === rule.field_key);
      if (matchingFields.length === 0) {
        // Field not present — check if it's a required_field rule
        if (rule.rule_type === 'required_field') {
          results.push({
            rule_id: rule.id,
            rule_name: rule.name,
            field_key: rule.field_key,
            passed: false,
            message: `Required field "${rule.field_key}" is missing from the document.`,
            severity: rule.severity,
          });
        }
        // For other rule types, skip if field not present
        continue;
      }
      for (const field of matchingFields) {
        const result = evaluateRule(rule, field, fields);
        results.push(result);
      }
    } else {
      // Global rule (field_key is null) — applies to all fields or runs cross-field checks
      const result = evaluateGlobalRule(rule, fields);
      results.push(...result);
    }
  }

  return results;
}

/**
 * Upgraded: Run all rules and produce RuleEvaluationResult[] with
 * decision_trace, dependencies, and severity.
 */
export function runRulesUpgraded(rules: ValidationRule[], fields: DocumentField[]): RuleEvaluationResult[] {
  const results: RuleEvaluationResult[] = [];

  for (const rule of rules) {
    if (rule.field_key) {
      const matchingFields = fields.filter(f => f.field_key === rule.field_key);
      if (matchingFields.length === 0) {
        if (rule.rule_type === 'required_field') {
          results.push({
            rule_id: rule.id,
            status: "failed",
            severity: rule.severity === "block" ? "error" : "warning",
            expected: "field present",
            actual: "missing",
            reason: `Required field "${rule.field_key}" is missing from the document.`,
            dependencies: [rule.field_key],
            decision_trace: {
              fields_used: [rule.field_key],
              evaluation_path: ["check_presence", "not_found"],
              final_outcome: "failed",
            },
          });
        }
        continue;
      }
      for (const field of matchingFields) {
        const passed = rulePassed(rule, field, fields);
        const reason = generateMessage(rule, field, fields, passed);
        const value = field.corrected_value || field.extracted_value || '';

        results.push({
          rule_id: rule.id,
          status: passed ? "passed" : "failed",
          severity: rule.severity === "block" ? "error" : "warning",
          expected: getExpectedValue(rule),
          actual: value,
          reason,
          dependencies: [rule.field_key],
          decision_trace: {
            fields_used: [rule.field_key],
            evaluation_path: [rule.rule_type, passed ? "pass" : "fail"],
            final_outcome: passed ? "passed" : "failed",
          },
        });
      }
    } else {
      // Global rule
      const legacyResults = evaluateGlobalRule(rule, fields);
      for (const lr of legacyResults) {
        results.push({
          rule_id: lr.rule_id,
          status: lr.passed ? "passed" : "failed",
          severity: lr.severity === "block" ? "error" : "warning",
          expected: "cross-document match",
          actual: lr.message,
          reason: lr.message,
          dependencies: [lr.field_key].filter(Boolean) as string[],
          decision_trace: {
            fields_used: [lr.field_key].filter(Boolean) as string[],
            evaluation_path: ["cross_doc_match", lr.passed ? "match" : "mismatch"],
            final_outcome: lr.passed ? "passed" : "failed",
          },
        });
      }
    }
  }

  return results;
}

function getExpectedValue(rule: ValidationRule): any {
  switch (rule.rule_type) {
    case "confidence_threshold":
      return `confidence >= ${rule.config.min_confidence}`;
    case "regex_format":
      return `matches ${rule.config.pattern}`;
    case "required_field":
      return "field present and non-empty";
    case "math_check":
      return rule.config.check;
    case "cross_doc_match":
      return "all sources agree";
    default:
      return "unknown";
  }
}

/**
 * Evaluate a single rule against a single field.
 */
function evaluateRule(rule: ValidationRule, field: DocumentField, allFields: DocumentField[]): RuleResult {
  const value = field.corrected_value || field.extracted_value || '';
  const passed: boolean = rulePassed(rule, field, allFields);
  const message = generateMessage(rule, field, allFields, passed);

  return {
    rule_id: rule.id,
    rule_name: rule.name,
    field_key: field.field_key,
    passed,
    message,
    severity: rule.severity,
  };
}

/**
 * Evaluate a global rule (no specific field_key) against all fields.
 */
function evaluateGlobalRule(rule: ValidationRule, fields: DocumentField[]): RuleResult[] {
  const results: RuleResult[] = [];

  if (rule.rule_type === 'cross_doc_match') {
    // Group fields by field_key, find mismatches across documents
    const fieldMap: Record<string, DocumentField[]> = {};
    for (const f of fields) {
      if (!fieldMap[f.field_key]) fieldMap[f.field_key] = [];
      fieldMap[f.field_key].push(f);
    }

    for (const [key, fieldGroup] of Object.entries(fieldMap)) {
      if (fieldGroup.length < 2) continue; // Need at least 2 docs to compare

      // Compare values across documents
      const values = fieldGroup.map(f => ({
        value: (f.corrected_value || f.extracted_value || '').toLowerCase().trim(),
        doc: f.documents?.doc_type || 'Unknown',
        raw: f.corrected_value || f.extracted_value || '',
      }));

      const uniqueValues = new Set(values.map(v => v.value));
      if (uniqueValues.size > 1) {
        // Mismatch found
        const valueSummary = values.map(v => `${v.doc}: "${v.raw}"`).join(' vs ');
        results.push({
          rule_id: rule.id,
          rule_name: rule.name,
          field_key: key,
          passed: false,
          message: `Cross-document mismatch for "${key}": ${valueSummary}`,
          severity: rule.severity,
        });
      }
    }
  }

  return results;
}

/**
 * Check if a rule passes for the given field.
 */
function rulePassed(rule: ValidationRule, field: DocumentField, allFields: DocumentField[]): boolean {
  const value = field.corrected_value || field.extracted_value || '';

  switch (rule.rule_type) {
    case 'confidence_threshold': {
      const minConf = rule.config.min_confidence ?? 0;
      return field.confidence >= minConf;
    }

    case 'regex_format': {
      if (!value) return true; // Empty values skip format check (required_field handles missing)
      const pattern = rule.config.pattern;
      if (!pattern) return true;
      try {
        const regex = new RegExp(pattern);
        return regex.test(value);
      } catch {
        return true; // Invalid regex pattern — don't block
      }
    }

    case 'required_field': {
      return value.length > 0;
    }

    case 'math_check': {
      const check = rule.config.check;
      if (!check) return true;

      if (check === 'greater_than_zero') {
        const num = parseCurrencyToNumber(value);
        return num !== null && num > 0;
      }

      if (check === 'gross_gte_net') {
        const grossField = allFields.find(f => f.field_key === 'grossWeight');
        const netField = allFields.find(f => f.field_key === 'netWeight');
        if (!grossField || !netField) return true; // Can't check without both
        const gross = parseWeightToKg(grossField.corrected_value || grossField.extracted_value || '');
        const net = parseWeightToKg(netField.corrected_value || netField.extracted_value || '');
        if (gross === null || net === null) return true;
        return gross >= net;
      }

      return true;
    }

    case 'cross_doc_match': {
      // Handled in evaluateGlobalRule for null field_key
      // For field-specific cross_doc_match, check if other docs have different values
      const sameKeyFields = allFields.filter(f => f.field_key === field.field_key && f.id !== field.id);
      if (sameKeyFields.length === 0) return true;
      const myValue = value.toLowerCase().trim();
      return sameKeyFields.every(f => {
        const otherValue = (f.corrected_value || f.extracted_value || '').toLowerCase().trim();
        return otherValue === myValue;
      });
    }

    default:
      return true;
  }
}

/**
 * Generate a human-readable explanation message for a rule result.
 * This is the structured explanation layer (Section 3) — interpolates actual values.
 */
function generateMessage(rule: ValidationRule, field: DocumentField, allFields: DocumentField[], passed: boolean): string {
  const value = field.corrected_value || field.extracted_value || '';
  const fieldLabel = field.field_label || field.field_key;

  if (passed) {
    return `${fieldLabel} passed "${rule.name}".`;
  }

  switch (rule.rule_type) {
    case 'confidence_threshold': {
      const minConf = rule.config.min_confidence ?? 0;
      return `${fieldLabel} confidence ${field.confidence}% is below the ${minConf}% threshold configured for this org.`;
    }

    case 'regex_format': {
      const pattern = rule.config.pattern || '';
      return `${fieldLabel} value "${value}" does not match the required format (pattern: ${pattern}).`;
    }

    case 'required_field': {
      return `Required field "${fieldLabel}" is missing from the document.`;
    }

    case 'math_check': {
      const check = rule.config.check;
      if (check === 'greater_than_zero') {
        return `${fieldLabel} value "${value}" must be greater than zero.`;
      }
      if (check === 'gross_gte_net') {
        const grossField = allFields.find(f => f.field_key === 'grossWeight');
        const netField = allFields.find(f => f.field_key === 'netWeight');
        const gross = grossField?.corrected_value || grossField?.extracted_value || '—';
        const net = netField?.corrected_value || netField?.extracted_value || '—';
        return `Gross weight (${gross}) must be greater than or equal to net weight (${net}).`;
      }
      return `${fieldLabel} failed math check "${check}".`;
    }

    case 'cross_doc_match': {
      const sameKeyFields = allFields.filter(f => f.field_key === field.field_key && f.id !== field.id);
      const otherDocs = sameKeyFields.map(f => {
        const docType = f.documents?.doc_type || 'Unknown';
        const otherValue = f.corrected_value || f.extracted_value || '—';
        return `${docType} shows "${otherValue}"`;
      });
      if (otherDocs.length > 0) {
        return `${fieldLabel}: ${field.documents?.doc_type || 'This document'} shows "${value}" but ${otherDocs.join(' and ')}.`;
      }
      return `${fieldLabel} cross-document mismatch detected.`;
    }

    default:
      return `${fieldLabel} failed validation rule "${rule.name}".`;
  }
}

// ============================================================================
// Helpers
// ============================================================================

function parseCurrencyToNumber(val: string): number | null {
  if (!val) return null;
  const cleaned = val.replace(/[^0-9.-]/g, '');
  const num = parseFloat(cleaned);
  return Number.isFinite(num) ? num : null;
}

function parseWeightToKg(val: string): number | null {
  if (!val) return null;
  const match = val.match(/([\d,]+\.?\d*)\s*(lbs?|kg|kgs|pounds?|kilograms?|g|grams?|oz|ounces?|tons?)?/i);
  if (!match) return null;
  const num = parseFloat(match[1].replace(/,/g, ''));
  if (!Number.isFinite(num)) return null;
  const unit = (match[2] || '').toLowerCase().trim();
  // Convert to kg
  switch (unit) {
    case 'lbs':
    case 'lb':
    case 'pounds':
    case 'pound':
      return num * 0.453592;
    case 'kg':
    case 'kgs':
    case 'kilograms':
    case 'kilogram':
      return num;
    case 'g':
    case 'grams':
    case 'gram':
      return num / 1000;
    case 'oz':
    case 'ounces':
    case 'ounce':
      return num * 0.0283495;
    case 'tons':
    case 'ton':
      return num * 907.185;
    default:
      return num; // Assume kg if no unit
  }
}
