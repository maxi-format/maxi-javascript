import { MaxiError, MaxiErrorCode } from '../core/errors.js';
import { MaxiRecord } from '../core/types.js';

/**
 * Records phase parser.
 * Operates on raw records text, tokenizes internally.
 */
export class RecordParser {
  /**
   * @param {string} recordsText Raw records section text
   * @param {import('../core/types.js').MaxiParseResult} result
   * @param {import('../api/parse.js').MaxiParseOptions} options
   */
  constructor(recordsText, result, options) {
    this.recordsText = recordsText;
    this.result = result;
    this.options = options;
  }

  /**
   * Parse records section.
   */
  async parse() {
    const text = this.recordsText;
    if (!text || !text.trim()) return;

    // Fast single-pass scanner:
    // - finds Alias(...) records (including multi-line and nested inline objects)
    // - tracks line numbers incrementally (no substring+split per record)
    const len = text.length;

    let i = 0;
    let lineNumber = 1;

    const isIdentStart = (c) => (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c === '_';
    const isIdentChar = (c) =>
      isIdentStart(c) || (c >= '0' && c <= '9') || c === '-' || c === '_';

    while (i < len) {
      const ch = text[i];

      // line tracking
      if (ch === '\n') {
        lineNumber++;
        i++;
        continue;
      }

      // skip whitespace
      if (ch === ' ' || ch === '\t' || ch === '\r') {
        i++;
        continue;
      }

      // record must start with alias identifier
      if (!isIdentStart(ch)) {
        i++;
        continue;
      }

      // parse alias
      const aliasStart = i;
      i++;
      while (i < len && isIdentChar(text[i])) i++;
      const alias = text.slice(aliasStart, i);

      // skip whitespace before '('
      while (i < len && (text[i] === ' ' || text[i] === '\t' || text[i] === '\r')) i++;

      if (i >= len || text[i] !== '(') {
        // not a record; keep scanning
        continue;
      }

      // parse (...) with nesting & string handling
      const recordLine = lineNumber;
      i++; // past '('
      const valuesStart = i;

      let parenDepth = 1;
      let bracketDepth = 0;
      let braceDepth = 0;
      let inString = false;
      let escapeNext = false;

      while (i < len) {
        const c = text[i];

        if (c === '\n') lineNumber++;

        if (escapeNext) {
          escapeNext = false;
          i++;
          continue;
        }

        if (inString) {
          if (c === '\\') {
            escapeNext = true;
          } else if (c === '"') {
            inString = false;
          }
          i++;
          continue;
        }

        if (c === '"') {
          inString = true;
          i++;
          continue;
        }

        if (c === '(') parenDepth++;
        else if (c === ')') {
          parenDepth--;
          if (parenDepth === 0) break;
        } else if (c === '[') bracketDepth++;
        else if (c === ']') bracketDepth = Math.max(0, bracketDepth - 1);
        else if (c === '{') braceDepth++;
        else if (c === '}') braceDepth = Math.max(0, braceDepth - 1);

        i++;
      }

      if (i >= len || text[i] !== ')' || parenDepth !== 0 || bracketDepth !== 0 || braceDepth !== 0) {
        throw new MaxiError(
          `Unclosed record parentheses for '${alias}'`,
          MaxiErrorCode.InvalidSyntaxError,
          { line: recordLine, filename: this.options.filename }
        );
      }

      const valuesStr = text.slice(valuesStart, i);
      i++; // past ')'

      const record = this.parseSingleRecord(alias, valuesStr, recordLine);
      this.result.records.push(record);

      // continue scanning (lineNumber already updated inside record)
    }
  }

  /**
   * Parse a single record's values string.
   * @param {string} alias
   * @param {string} valuesStr The content between the record's parentheses.
   * @param {number} lineNumber
   * @returns {MaxiRecord}
   * @private
   */
  parseSingleRecord(alias, valuesStr, lineNumber) {
    // Get type definition from schema
    const typeDef = this.result.schema.getType(alias);
    if (!typeDef) {
      const error = new MaxiError(
        `Unknown type alias '${alias}'`,
        MaxiErrorCode.UnknownTypeError,
        { line: lineNumber, filename: this.options.filename }
      );

      if (this.result.schema.mode === 'strict') {
        throw error;
      }

      // In lax mode, add warning and attempt best-effort parsing
      this.result.addWarning(error.message, {
        code: error.code,
        line: lineNumber
      });

      // Parse values without schema validation
      const values = this.parseFieldValues(valuesStr, null, lineNumber);
      return new MaxiRecord({ alias, values, lineNumber });
    }

    // Parse field values according to schema
    let values = this.parseFieldValues(valuesStr, typeDef, lineNumber);

    // LAX heuristic for inherited 'type' field (unchanged)
    if (this.result.schema.mode !== 'strict') {
      const typeFieldIndex = typeDef.fields.findIndex(f => f.name === 'type');
      if (typeFieldIndex !== -1 && values.length === typeDef.fields.length - 1) {
        // Insert inferred type at the "type" position
        const typeFieldDef = typeDef.fields[typeFieldIndex];

        let inferred = null;
        if (typeFieldDef.defaultValue !== undefined && typeFieldDef.defaultValue !== null) {
          inferred = typeFieldDef.defaultValue;
        } else if (typeDef.name) {
          inferred = String(typeDef.name).toLowerCase();
        } else {
          inferred = String(typeDef.alias).toLowerCase();
        }

        const patched = values.slice();
        patched.splice(typeFieldIndex, 0, inferred);
        values = patched;
      }
    }

    // Validate field count in strict mode (unchanged)
    if (this.result.schema.mode === 'strict') {
      if (values.length < typeDef.fields.length) {
        // Check if missing fields have defaults
        for (let i = values.length; i < typeDef.fields.length; i++) {
          const field = typeDef.fields[i];
          if (field.isRequired() && field.defaultValue === undefined) {
            throw new MaxiError(
              `Record '${alias}' missing required field '${field.name}'`,
              MaxiErrorCode.MissingRequiredFieldError,
              { line: lineNumber, filename: this.options.filename }
            );
          }
        }
      } else if (values.length > typeDef.fields.length) {
        throw new MaxiError(
          `Record '${alias}' has ${values.length} values but type defines ${typeDef.fields.length} fields`,
          MaxiErrorCode.SchemaMismatchError,
          { line: lineNumber, filename: this.options.filename }
        );
      }
    }

    // Fill in defaults for missing trailing fields (unchanged)
    const finalValues = [];
    for (let i = 0; i < typeDef.fields.length; i++) {
      const field = typeDef.fields[i];
      let value = i < values.length ? values[i] : undefined;

      // Handle empty/missing values - but ONLY if value is actually undefined or empty string
      if (value === undefined || value === '') {
        if (field.defaultValue !== undefined) {
          value = field.defaultValue;
        } else {
          value = null;
        }
      }

      // Validate required fields
      if (field.isRequired() && value === null) {
        const error = new MaxiError(
          `Required field '${field.name}' is null in record '${alias}'`,
          MaxiErrorCode.MissingRequiredFieldError,
          { line: lineNumber, filename: this.options.filename }
        );

        if (this.result.schema.mode === 'strict') {
          throw error;
        }
        this.result.addWarning(error.message, { code: error.code, line: lineNumber });
      }

      finalValues.push(value);
    }

    return new MaxiRecord({ alias, values: finalValues, lineNumber });
  }

  /**
   * Parse field values from record content.
   * @param {string} valuesStr Field values string
   * @param {import('../core/types.js').MaxiTypeDef | null} typeDef Type definition (null for untyped)
   * @param {number} lineNumber
   * @returns {unknown[]}
   * @private
   */
  parseFieldValues(valuesStr, typeDef, lineNumber) {
    // Fast path: simple records have no nested structures or quotes.
    const isSimple =
      valuesStr.indexOf('"') === -1 &&
      valuesStr.indexOf('(') === -1 &&
      valuesStr.indexOf(')') === -1 &&
      valuesStr.indexOf('[') === -1 &&
      valuesStr.indexOf(']') === -1 &&
      valuesStr.indexOf('{') === -1 &&
      valuesStr.indexOf('}') === -1;

    const valueStrings = isSimple ? valuesStr.split('|') : this.splitTopLevel(valuesStr, '|');

    const values = [];
    for (let i = 0; i < valueStrings.length; i++) {
      const raw = valueStrings[i];
      const valueStr = isSimple ? raw : this.fastTrim(raw);
      const fieldDef = typeDef?.fields[i] ?? null;
      values.push(this.parseFieldValue(valueStr, fieldDef, lineNumber));
    }


    return values;
  }

  /**
   * Splits a string by a delimiter only at the top level (not inside quotes, parens, brackets, or braces).
   * PERF: uses indices + slice (avoids per-char string concatenation).
   * @private
   */
  splitTopLevel(str, delimiter) {
    /** @type {string[]} */
    const parts = [];

    let partStart = 0;

    let parenDepth = 0;
    let bracketDepth = 0;
    let braceDepth = 0;
    let inString = false;
    let escapeNext = false;

    for (let i = 0; i < str.length; i++) {
      const char = str[i];

      if (escapeNext) {
        escapeNext = false;
        continue;
      }

      if (inString) {
        if (char === '\\') escapeNext = true;
        else if (char === '"') inString = false;
        continue;
      }

      if (char === '"') {
        inString = true;
        continue;
      }

      if (char === '(') parenDepth++;
      else if (char === ')') parenDepth--;
      else if (char === '[') bracketDepth++;
      else if (char === ']') bracketDepth--;
      else if (char === '{') braceDepth++;
      else if (char === '}') braceDepth--;

      if (char === delimiter && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
        parts.push(str.slice(partStart, i));
        partStart = i + 1;
      }
    }

    parts.push(str.slice(partStart));
    return parts;
  }

  /**
   * Faster trim that avoids allocating when no surrounding whitespace.
   * @param {string} s
   * @returns {string}
   * @private
   */
  fastTrim(s) {
    let start = 0;
    let end = s.length;

    while (start < end) {
      const c = s.charCodeAt(start);
      if (c !== 32 && c !== 9 && c !== 10 && c !== 13) break; // SP HTAB LF CR
      start++;
    }

    while (end > start) {
      const c = s.charCodeAt(end - 1);
      if (c !== 32 && c !== 9 && c !== 10 && c !== 13) break;
      end--;
    }

    if (start === 0 && end === s.length) return s;
    return s.slice(start, end);
  }

  /**
   * Parse a single field value.
   * @param {string} valueStr
   * @param {import('../core/types.js').MaxiFieldDef | null} fieldDef
   * @param {number} lineNumber
   * @returns {unknown}
   * @private
   */
  parseFieldValue(valueStr, fieldDef, lineNumber) {
    // Hot path: avoid repeated optional chaining / string trims.
    // Empty value
    if (valueStr === '') {
      return fieldDef?.defaultValue ?? null;
    }

    // Explicit null
    if (valueStr === '~') {
      return null;
    }

    // Array / Map / Inline object / Quoted string: keep as-is
    const c0 = valueStr[0];
    const cLast = valueStr[valueStr.length - 1];

    // Array
    if (c0 === '[' && cLast === ']') {
      return this.parseArray(valueStr, fieldDef, lineNumber);
    }

    // Map
    if (c0 === '{' && cLast === '}') {
      return this.parseMap(valueStr, fieldDef, lineNumber);
    }

    // Inline object
    if (c0 === '(' && cLast === ')') {
      // Fast path: inline object with no nested structures/quotes inside
      // (common for small embedded objects); otherwise fall back.
      const inner = valueStr.slice(1, -1);
      const isInlineSimple =
        inner.indexOf('"') === -1 &&
        inner.indexOf('(') === -1 &&
        inner.indexOf(')') === -1 &&
        inner.indexOf('[') === -1 &&
        inner.indexOf(']') === -1 &&
        inner.indexOf('{') === -1 &&
        inner.indexOf('}') === -1;

      if (isInlineSimple) {
        // parseInlineObject expects "(...)", so keep it, but it will use parseFieldValues
        // which will hit the simple split path.
        return this.parseInlineObject(valueStr, fieldDef, lineNumber);
      }

      return this.parseInlineObject(valueStr, fieldDef, lineNumber);
    }

    // Quoted string
    if (c0 === '"' && cLast === '"') {
      return this.parseQuotedString(valueStr);
    }

    const typeExpr = fieldDef?.typeExpr ?? 'str';
    const annotation = fieldDef?.annotation;

    // LAX: bytes@base64 padding normalization (avoid regex)
    if (this.result?.schema?.mode !== 'strict' && typeExpr === 'bytes' && annotation === 'base64') {
      const s = valueStr;
      if (this.looksLikeBase64(s)) {
        const mod = s.length & 3; // %4
        if (mod !== 0) return s + (mod === 1 ? '===' : mod === 2 ? '==' : '=');
      }
      return s;
    }

    // Boolean: ONLY coerce when the schema says bool
    if (typeExpr === 'bool') {
      // Accept both token-efficient and verbose forms
      if (valueStr === '1' || valueStr === 'true') return true;
      if (valueStr === '0' || valueStr === 'false') return false;
      return valueStr;
    }

    // Numbers: use fast detector instead of regex
    const nk = this.detectNumberKind(valueStr);

    if (typeExpr === 'int') {
      if (nk === 1) {
        // parseInt on known-good digits is fast
        const num = parseInt(valueStr, 10);
        return num;
      }
      // "500." is not int
      return valueStr;
    }

    if (typeExpr === 'decimal') {
      if (nk === 3) {
        // "500." => int 500 (fixture behavior)
        const num = parseInt(valueStr.slice(0, -1), 10);
        return num;
      }
      if (nk === 1 || nk === 2) {
        const num = parseFloat(valueStr);
        return num;
      }
      return valueStr;
    }

    // LAX fallback numeric coercion only when schema isn't numeric
    if (this.result?.schema?.mode !== 'strict') {
      if (nk === 1) return parseInt(valueStr, 10);
      if (nk === 2) return parseFloat(valueStr);
      if (nk === 3) return parseInt(valueStr.slice(0, -1), 10);
    }

    return valueStr;
  }

  /**
   * Parse array value.
   * @param {string} arrayStr
   * @param {import('../core/types.js').MaxiFieldDef | null} fieldDef
   * @param {number} lineNumber
   * @returns {unknown[]}
   * @private
   */
  parseArray(arrayStr, fieldDef, lineNumber) {
    // Remove brackets
    const content = arrayStr.slice(1, -1).trim();
    if (!content) return [];

    // If schema says "int[]", "decimal[]", "bool[]", etc., coerce elements accordingly.
    // If untyped, allow lax-mode numeric coercion by passing null (parseFieldValue handles fallback).
    const elemType = this.getArrayElementType(fieldDef?.typeExpr);
    const elemFieldDef = elemType ? { typeExpr: elemType } : null;

    const elements = [];
    let currentElement = '';
    let depth = 0;
    let inString = false;
    let escapeNext = false;

    for (let i = 0; i < content.length; i++) {
      const char = content[i];

      if (escapeNext) {
        currentElement += char;
        escapeNext = false;
        continue;
      }

      if (char === '\\' && inString) {
        currentElement += char;
        escapeNext = true;
        continue;
      }

      if (char === '"') {
        inString = !inString;
        currentElement += char;
        continue;
      }

      if (!inString) {
        if (char === '(' || char === '[' || char === '{') depth++;
        else if (char === ')' || char === ']' || char === '}') depth--;

        if (char === ',' && depth === 0) {
          elements.push(this.parseFieldValue(currentElement.trim(), elemFieldDef, lineNumber));
          currentElement = '';
          continue;
        }
      }

      currentElement += char;
    }

    if (currentElement.trim() !== '') {
      elements.push(this.parseFieldValue(currentElement.trim(), elemFieldDef, lineNumber));
    }

    return elements;
  }

  /**
   * Parse map value.
   * @param {string} mapStr
   * @param {import('../core/types.js').MaxiFieldDef | null} fieldDef
   * @param {number} lineNumber
   * @returns {Object}
   * @private
   */
  parseMap(mapStr, fieldDef, lineNumber) {
    // Remove braces
    const content = mapStr.slice(1, -1).trim();
    if (!content) return {};

    // Determine map value type from schema: map<...>
    // If untyped map, allow lax-mode numeric coercion by passing null (parseFieldValue handles fallback).
    const mapValueType = this.getMapValueType(fieldDef?.typeExpr);
    const valueFieldDef = mapValueType ? { typeExpr: mapValueType } : null;

    const map = {};
    let currentEntry = '';
    let depth = 0;
    let inString = false;
    let escapeNext = false;

    for (let i = 0; i < content.length; i++) {
      const char = content[i];

      if (escapeNext) {
        currentEntry += char;
        escapeNext = false;
        continue;
      }

      if (char === '\\' && inString) {
        currentEntry += char;
        escapeNext = true;
        continue;
      }

      if (char === '"') {
        inString = !inString;
        currentEntry += char;
        continue;
      }

      if (!inString) {
        if (char === '(' || char === '[' || char === '{') depth++;
        else if (char === ')' || char === ']' || char === '}') depth--;

        if (char === ',' && depth === 0) {
          this.parseMapEntry(currentEntry.trim(), map, lineNumber, valueFieldDef);
          currentEntry = '';
          continue;
        }
      }

      currentEntry += char;
    }

    if (currentEntry.trim()) {
      this.parseMapEntry(currentEntry.trim(), map, lineNumber, valueFieldDef);
    }

    return map;
  }

  /**
   * Extract the map value type from a type expression.
   * @param {string | null | undefined} typeExpr
   * @returns {string | null}
   * @private
   */
  getMapValueType(typeExpr) {
    if (!typeExpr) return null;
    const t = typeExpr.trim();

    // "map" (untyped)
    if (t === 'map') return null;

    // map<...>
    const m = t.match(/^map\s*<\s*(.+)\s*>\s*$/);
    if (!m) return null;

    const inside = m[1];

    // split top-level by comma
    let depth = 0;
    let inString = false;
    let cur = '';
    const parts = [];

    for (let i = 0; i < inside.length; i++) {
      const ch = inside[i];

      if (inString) {
        if (ch === '"' && inside[i - 1] !== '\\') inString = false;
        cur += ch;
        continue;
      }
      if (ch === '"') {
        inString = true;
        cur += ch;
        continue;
      }

      if (ch === '<') depth++;
      else if (ch === '>') depth = Math.max(0, depth - 1);

      if (ch === ',' && depth === 0) {
        parts.push(cur.trim());
        cur = '';
        continue;
      }
      cur += ch;
    }
    if (cur.trim()) parts.push(cur.trim());

    // If one param: treat as value type. If two+: treat last as value type.
    if (parts.length === 1) return parts[0] || null;
    return parts[parts.length - 1] || null;
  }

  /**
   * Parse single map entry.
   * @param {string} entryStr
   * @param {Object} map
   * @param {number} lineNumber
   * @param {{typeExpr: string} | null} valueFieldDef
   * @private
   */
  parseMapEntry(entryStr, map, lineNumber, valueFieldDef = null) {
    // Find colon separator (not inside strings or nested structures)
    let colonIndex = -1;
    let depth = 0;
    let inString = false;
    let escapeNext = false;

    for (let i = 0; i < entryStr.length; i++) {
      const ch = entryStr[i];

      if (escapeNext) {
        escapeNext = false;
        continue;
      }
      if (inString) {
        if (ch === '\\') {
          escapeNext = true;
          continue;
        }
        if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }

      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);

      if (ch === ':' && depth === 0) {
        colonIndex = i;
        break;
      }
    }

    if (colonIndex === -1) {
      throw new MaxiError(
        `Invalid map entry format: ${entryStr}`,
        MaxiErrorCode.InvalidSyntaxError,
        { line: lineNumber, filename: this.options.filename }
      );
    }

    const keyStr = entryStr.slice(0, colonIndex).trim();
    const valueStr = entryStr.slice(colonIndex + 1).trim();

    // Keys are strings in projected JSON; parse as string (supports quoted keys)
    const key = this.parseFieldValue(keyStr, { typeExpr: 'str' }, lineNumber);
    const value = this.parseFieldValue(valueStr, valueFieldDef, lineNumber);

    map[String(key)] = value;
  }

  /**
   * Parse inline object and return a plain JS object (not MaxiRecord),
   * mapping values to the referenced schema type's fields.
   * @private
   */
  parseInlineObject(objStr, fieldDef, lineNumber) {
    const innerValuesStr = objStr.slice(1, -1);

    const typeAlias = this.getInlineObjectTypeAlias(fieldDef?.typeExpr);
    if (!typeAlias) {
      return { values: this.parseFieldValues(innerValuesStr, null, lineNumber) };
    }

    const typeDef = this.result.schema.getType(typeAlias);
    if (!typeDef) {
      if (this.result.schema.mode === 'strict') {
        throw new MaxiError(
          `Unknown type alias '${typeAlias}' for inline object`,
          MaxiErrorCode.UnknownTypeError,
          { line: lineNumber, filename: this.options.filename }
        );
      }
      this.result.addWarning(`Unknown type alias '${typeAlias}' for inline object`, {
        code: MaxiErrorCode.UnknownTypeError,
        line: lineNumber
      });
      return { values: this.parseFieldValues(innerValuesStr, null, lineNumber) };
    }

    const values = this.parseFieldValues(innerValuesStr, typeDef, lineNumber);

    // FIX: apply same trailing-default/null semantics as top-level records
    const obj = {};
    for (let i = 0; i < typeDef.fields.length; i++) {
      const field = typeDef.fields[i];
      let v = i < values.length ? values[i] : undefined;

      if (v === undefined || v === '') {
        if (field.defaultValue !== undefined) v = field.defaultValue;
        else v = null;
      }

      obj[field.name] = v;
    }
    return obj;
  }

  /**
   * Infer inline object type alias from a field type expression (alias or name).
   * @private
   */
  getInlineObjectTypeAlias(typeExpr) {
    if (!typeExpr) return null;
    const t = typeExpr.trim();

    // array element, e.g. "Order[]" -> "Order"
    const arrMatch = t.match(/^(.+)\[\]\s*$/);
    const base = arrMatch ? arrMatch[1].trim() : t;

    // map value type, e.g. "map<User>" -> "User"
    if (/^map\s*</.test(base)) {
      const mapValueType = this.getMapValueType(base);
      const resolved = mapValueType ? mapValueType.trim() : null;
      return this.result.schema.resolveTypeAlias?.(resolved) ?? resolved;
    }

    const primitives = ['str', 'int', 'decimal', 'bool', 'bytes', 'map'];
    if (primitives.includes(base)) return null;

    return this.result.schema.resolveTypeAlias?.(base) ?? base;
  }

  /**
   * Extract array element type from a type expression, e.g. "int[]" -> "int".
   * @private
   */
  getArrayElementType(typeExpr) {
    if (!typeExpr) return null;
    const t = typeExpr.trim();
    const m = t.match(/^(.+)\[\]\s*$/);
    if (!m) return null;
    return (m[1] || '').trim() || null;
  }

  /**
   * Parse quoted string with escape sequences.
   * @private
   */
  parseQuotedString(str) {
    let result = str.slice(1, -1);
    result = result.replace(/\\n/g, '\n');
    result = result.replace(/\\r/g, '\r');
    result = result.replace(/\\t/g, '\t');
    result = result.replace(/\\"/g, '"');
    result = result.replace(/\\\\/g, '\\');
    return result;
  }

  // --- NEW: small helpers for hot-path parsing (avoid regex) ---
  /**
   * @param {string} s
   * @returns {number} 0 = not numeric, 1 = int-like, 2 = decimal-like, 3 = int-with-trailing-dot (e.g. "500.")
   * @private
   */
  detectNumberKind(s) {
    const n = s.length;
    if (n === 0) return 0;

    let i = 0;
    const c0 = s.charCodeAt(0);
    if (c0 === 45 /* '-' */) {
      if (n === 1) return 0;
      i = 1;
    }

    // must start with digit
    let cc = s.charCodeAt(i);
    if (cc < 48 || cc > 57) return 0;

    // consume digits
    while (i < n) {
      cc = s.charCodeAt(i);
      if (cc < 48 || cc > 57) break;
      i++;
    }

    if (i === n) return 1; // pure int

    if (s.charCodeAt(i) !== 46 /* '.' */) return 0;
    i++; // past '.'

    if (i === n) return 3; // trailing dot

    // must have at least one digit after dot for decimal
    cc = s.charCodeAt(i);
    if (cc < 48 || cc > 57) return 0;

    while (i < n) {
      cc = s.charCodeAt(i);
      if (cc < 48 || cc > 57) return 0;
      i++;
    }

    return 2; // decimal
  }

  /**
   * @param {string} s
   * @returns {boolean}
   * @private
   */
  looksLikeBase64(s) {
    // Fast-ish check: allow A-Z a-z 0-9 + / and '=' at end
    // No regex allocation in hot path.
    const n = s.length;
    if (n === 0) return false;
    let pad = 0;
    for (let i = 0; i < n; i++) {
      const c = s.charCodeAt(i);
      if (c === 61 /* '=' */) {
        pad++;
        continue;
      }
      // once padding started, only '=' allowed
      if (pad > 0) return false;

      const isAZ = c >= 65 && c <= 90;
      const isaz = c >= 97 && c <= 122;
      const is09 = c >= 48 && c <= 57;
      const isPlus = c === 43;
      const isSlash = c === 47;
      if (!(isAZ || isaz || is09 || isPlus || isSlash)) return false;
    }
    return pad <= 2;
  }
}
