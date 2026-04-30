import { MaxiError, MaxiErrorCode } from '../core/errors.js';

const ANNOTATION_TYPE_MAP = {
  base64: ['bytes'],
  hex: ['bytes'],
  timestamp: ['int'],
  date: ['str'],
  datetime: ['str'],
  time: ['str'],
  email: ['str'],
  url: ['str'],
  uuid: ['str'],
};

const PRIMITIVES = new Set(['int', 'decimal', 'float', 'str', 'bool', 'bytes']);

/**
 * Validate schema-level constraints: annotation compatibility and constraint conflicts.
 * @param {import('../core/types.js').MaxiSchema} schema
 * @param {string} [filename]
 */
export function validateSchemaConstraints(schema, filename) {
  for (const [, typeDef] of schema.types) {
    for (const field of typeDef.fields) {
      validateAnnotationTypeCompat(field, typeDef.alias, filename);
      validateConstraintConflicts(field, typeDef.alias, filename);
    }
  }
}

function validateAnnotationTypeCompat(field, typeAlias, filename) {
  if (!field.annotation) return;

  const allowedTypes = ANNOTATION_TYPE_MAP[field.annotation];
  if (!allowedTypes) {
    const baseType = getBaseTypeName(field.typeExpr);
    if (baseType === 'bytes') {
      throw new MaxiError(
        `Unsupported binary format annotation '@${field.annotation}' on bytes field '${field.name}' in type '${typeAlias}'. Supported: @base64, @hex`,
        MaxiErrorCode.UnsupportedBinaryFormatError,
        { filename }
      );
    }
    return;
  }

  const baseType = getBaseTypeName(field.typeExpr);
  if (!baseType) return;

  if (!allowedTypes.includes(baseType)) {
    throw new MaxiError(
      `Type annotation '@${field.annotation}' cannot be applied to '${baseType}' field '${field.name}' in type '${typeAlias}'`,
      MaxiErrorCode.InvalidConstraintValueError,
      { filename }
    );
  }
}

function validateConstraintConflicts(field, typeAlias, filename) {
  const constraints = field.constraints;
  if (!constraints || constraints.length < 2) return;

  let minGe = null, minGt = null, maxLe = null, maxLt = null;

  for (const c of constraints) {
    if (c.type !== 'comparison') continue;
    const v = typeof c.value === 'number' ? c.value : null;
    if (v === null) continue;

    switch (c.operator) {
      case '>=': minGe = minGe !== null ? Math.max(minGe, v) : v; break;
      case '>':  minGt = minGt !== null ? Math.max(minGt, v) : v; break;
      case '<=': maxLe = maxLe !== null ? Math.min(maxLe, v) : v; break;
      case '<':  maxLt = maxLt !== null ? Math.min(maxLt, v) : v; break;
    }
  }

  const effectiveMin = minGe ?? (minGt !== null ? minGt + 1 : null);
  const effectiveMax = maxLe ?? (maxLt !== null ? maxLt - 1 : null);

  if (effectiveMin !== null && effectiveMax !== null && effectiveMin > effectiveMax) {
    throw new MaxiError(
      `Conflicting constraints in field '${field.name}' of type '${typeAlias}': lower bound exceeds upper bound`,
      MaxiErrorCode.InvalidConstraintValueError,
      { filename }
    );
  }

  if (minGe !== null && maxLt !== null && minGe >= maxLt) {
    throw new MaxiError(
      `Conflicting constraints in field '${field.name}' of type '${typeAlias}': lower bound exceeds upper bound`,
      MaxiErrorCode.InvalidConstraintValueError,
      { filename }
    );
  }
  if (minGt !== null && maxLe !== null && minGt >= maxLe) {
    throw new MaxiError(
      `Conflicting constraints in field '${field.name}' of type '${typeAlias}': lower bound exceeds upper bound`,
      MaxiErrorCode.InvalidConstraintValueError,
      { filename }
    );
  }
}

/**
 * Validate a single record's values against field constraints.
 * @param {unknown[]} values
 * @param {import('../core/types.js').MaxiTypeDef} typeDef
 * @param {boolean} isStrict
 * @param {import('../core/types.js').MaxiParseResult} result
 * @param {number} lineNumber
 * @param {string} [filename]
 */
export function validateRecordConstraints(values, typeDef, isStrict, result, lineNumber, filename) {
  for (let i = 0; i < typeDef.fields.length; i++) {
    const field = typeDef.fields[i];
    const value = i < values.length ? values[i] : null;
    const constraints = field.constraints;
    if (!constraints || constraints.length === 0) continue;
    if (value === null || value === undefined) continue;

    for (const c of constraints) {
      const violation = checkConstraint(c, value, field);
      if (violation) {
        if (isStrict) {
          throw new MaxiError(
            violation,
            MaxiErrorCode.ConstraintViolationError,
            { line: lineNumber, filename }
          );
        }
        result.addWarning(violation, {
          code: MaxiErrorCode.ConstraintViolationError,
          line: lineNumber,
        });
      }
    }
  }
}

function checkConstraint(constraint, value, field) {
  switch (constraint.type) {
    case 'required':
    case 'id':
    case 'mime':
    case 'decimal-precision':
      return null;
    case 'comparison':
      return checkComparison(constraint, value, field);
    case 'pattern':
      return checkPattern(constraint, value, field);
    case 'exact-length':
      return checkExactLength(constraint, value, field);
    default:
      return null;
  }
}

function checkComparison(constraint, value, field) {
  const { operator, value: limit } = constraint;
  if (typeof limit !== 'number') return null;

  const baseType = getBaseTypeName(field.typeExpr);

  let actual;
  if (baseType === 'str' || baseType === 'bytes' || (!baseType && typeof value === 'string')) {
    if (typeof value !== 'string') return null;
    actual = value.length;
  } else if (typeof value === 'number') {
    actual = value;
  } else {
    return null;
  }

  switch (operator) {
    case '>=': if (actual < limit) return `Field '${field.name}': value ${actual} violates constraint >=${limit}`; break;
    case '>':  if (actual <= limit) return `Field '${field.name}': value ${actual} violates constraint >${limit}`; break;
    case '<=': if (actual > limit) return `Field '${field.name}': value ${actual} violates constraint <=${limit}`; break;
    case '<':  if (actual < limit) return null; if (actual >= limit) return `Field '${field.name}': value ${actual} violates constraint <${limit}`; break;
  }

  return null;
}

function checkPattern(constraint, value, field) {
  if (typeof value !== 'string') return null;
  const re = new RegExp(constraint.value);
  if (!re.test(value)) {
    return `Field '${field.name}': value '${value}' does not match pattern '${constraint.value}'`;
  }
  return null;
}

function checkExactLength(constraint, value, field) {
  let len = null;
  if (Array.isArray(value)) {
    len = value.length;
  } else if (typeof value === 'object' && value !== null) {
    len = Object.keys(value).length;
  }
  if (len !== null && len !== constraint.value) {
    return `Field '${field.name}': expected exactly ${constraint.value} elements, got ${len}`;
  }
  return null;
}

/**
 * Validate an enum field value against the allowed set.
 * @param {string} typeExpr
 * @param {unknown} value
 * @param {string} fieldName
 * @param {boolean} isStrict
 * @param {import('../core/types.js').MaxiParseResult} result
 * @param {number} lineNumber
 * @param {string} [filename]
 */
export function validateEnumValue(typeExpr, value, fieldName, isStrict, result, lineNumber, filename) {
  if (value === null || value === undefined) return;

  const enumInfo = parseEnumTypeExpr(typeExpr);
  if (!enumInfo) return;

  const strValue = String(value);
  if (!enumInfo.values.includes(strValue)) {
    const msg = `Value '${strValue}' not in enum [${enumInfo.values.join(',')}] for field '${fieldName}'`;
    if (isStrict) {
      throw new MaxiError(msg, MaxiErrorCode.ConstraintViolationError, { line: lineNumber, filename });
    }
    result.addWarning(msg, { code: MaxiErrorCode.ConstraintViolationError, line: lineNumber });
  }
}

function parseEnumTypeExpr(typeExpr) {
  if (!typeExpr) return null;
  const t = typeExpr.trim();
  if (!t.startsWith('enum')) return null;

  const m = t.match(/^enum(?:<(\w+)>)?\[([^\]]*)\]$/);
  if (!m) return null;

  const baseType = m[1] || 'str';
  const values = m[2].split(',').map(v => v.trim()).filter(Boolean);

  return { baseType, values };
}

function getBaseTypeName(typeExpr) {
  if (!typeExpr) return 'str';
  const t = typeExpr.trim();
  const noArr = t.replace(/(\[\])+$/, '');

  if (PRIMITIVES.has(noArr)) return noArr;
  if (noArr === 'map' || noArr.startsWith('map<')) return 'map';
  if (noArr.startsWith('enum')) return 'enum';

  return null;
}
