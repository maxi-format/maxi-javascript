import { MaxiError, MaxiErrorCode } from '../core/errors.js';
import { MaxiRecord } from '../core/types.js';
import { validateRecordConstraints, validateEnumValue } from './constraint-validator.js';

/** Sentinel for explicit null (~) to distinguish from missing/empty values. */
const EXPLICIT_NULL = Object.freeze({});

export class RecordParser {
  /**
   * @param {string} recordsText
   * @param {import('../core/types.js').MaxiParseResult} result
   * @param {import('../api/parse.js').MaxiParseOptions} options
   */
  constructor(recordsText, result, options) {
    this.recordsText = recordsText;
    this.result = result;
    this.options = options;
    /** @type {Map<string, Set<unknown>>} */
    this.seenIds = new Map();
    this._isStrict = result.schema.mode === 'strict';
    this._filename = options.filename;
  }

  /**
   * Parse records section.
   */
  async parse() {
    const text = this.recordsText;
    if (!text || !text.trim()) return;

    const len = text.length;
    let i = 0;
    let lineNumber = 1;
    let atLineStart = true;

    while (i < len) {
      const ch = text.charCodeAt(i);

      if (ch === 10) {
        lineNumber++;
        i++;
        atLineStart = true;
        continue;
      }

      if (ch === 32 || ch === 9 || ch === 13) {
        i++;
        continue;
      }

      if (ch === 35) {
        atLineStart = false;
        while (i < len && text.charCodeAt(i) !== 10) i++;
        continue;
      }

      if (!((ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122) || ch === 95)) {
        if (atLineStart) {
          throw new MaxiError(
            `Invalid syntax in data section: unexpected character at line ${lineNumber}`,
            MaxiErrorCode.InvalidSyntaxError,
            { line: lineNumber, filename: this._filename }
          );
        }
        i++;
        continue;
      }
      atLineStart = false;

      const aliasStart = i;
      i++;
      while (i < len) {
        const c = text.charCodeAt(i);
        if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45 || c === 95) {
          i++;
        } else {
          break;
        }
      }
      const alias = text.slice(aliasStart, i);

      while (i < len) {
        const c = text.charCodeAt(i);
        if (c === 32 || c === 9 || c === 13) { i++; } else { break; }
      }

      if (i < len && text.charCodeAt(i) === 58) {
        throw new MaxiError(
          `Type definition '${text.slice(aliasStart, i)}:...' found in data section (after ###). Type definitions must appear before ###.`,
          MaxiErrorCode.StreamError,
          { line: lineNumber, filename: this._filename }
        );
      }

      if (i >= len || text.charCodeAt(i) !== 40) {
        continue;
      }

      const recordLine = lineNumber;
      i++;
      const valuesStart = i;

      let parenDepth = 1;
      let bracketDepth = 0;
      let braceDepth = 0;
      let inString = false;
      let escapeNext = false;

      while (i < len) {
        const c = text.charCodeAt(i);

        if (c === 10) lineNumber++;

        if (escapeNext) {
          escapeNext = false;
          i++;
          continue;
        }

        if (inString) {
          if (c === 92) {
            escapeNext = true;
          } else if (c === 34) {
            inString = false;
          }
          i++;
          continue;
        }

        if (c === 34) {
          inString = true;
          i++;
          continue;
        }

        if (c === 40) parenDepth++;
        else if (c === 41) {
          parenDepth--;
          if (parenDepth === 0) break;
        } else if (c === 91) bracketDepth++;
        else if (c === 93) bracketDepth = bracketDepth > 0 ? bracketDepth - 1 : 0;
        else if (c === 123) braceDepth++;
        else if (c === 125) braceDepth = braceDepth > 0 ? braceDepth - 1 : 0;

        i++;
      }

      if (i >= len || text.charCodeAt(i) !== 41 || parenDepth !== 0 || bracketDepth !== 0 || braceDepth !== 0) {
        if (bracketDepth !== 0) {
          throw new MaxiError(
            `Malformed array: unmatched bracket in record '${alias}'`,
            MaxiErrorCode.ArraySyntaxError,
            { line: recordLine, filename: this._filename }
          );
        }
        throw new MaxiError(
          `Unclosed record parentheses for '${alias}'`,
          MaxiErrorCode.InvalidSyntaxError,
          { line: recordLine, filename: this._filename }
        );
      }

      const valuesStr = text.slice(valuesStart, i);
      i++;

      const record = this.parseSingleRecord(alias, valuesStr, recordLine);
      this.result.records.push(record);
    }
  }

  /**
   * Parse a single record and return a MaxiRecord.
   * @param {string} alias
   * @param {string} valuesStr
   * @param {number} lineNumber
   * @returns {MaxiRecord}
   */
  parseSingleRecord(alias, valuesStr, lineNumber) {
    const typeDef = this.result.schema.getType(alias);
    if (!typeDef) {
      const error = new MaxiError(
        `Unknown type alias '${alias}'`,
        MaxiErrorCode.UnknownTypeError,
        { line: lineNumber, filename: this._filename }
      );

      if (this._isStrict) {
        throw error;
      }

      this.result.addWarning(error.message, {
        code: error.code,
        line: lineNumber
      });

      const values = this.parseFieldValues(valuesStr, null, lineNumber);
      return new MaxiRecord({ alias, values, lineNumber });
    }

    typeDef._ensureCache();

    let values = this.parseFieldValues(valuesStr, typeDef, lineNumber);

    if (!this._isStrict) {
      const typeFieldIndex = typeDef.fields.findIndex(f => f.name === 'type');
      if (typeFieldIndex !== -1 && values.length === typeDef.fields.length - 1) {
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

    if (this._isStrict) {
      if (values.length < typeDef.fields.length) {
        for (let i = values.length; i < typeDef.fields.length; i++) {
          const field = typeDef.fields[i];
          if (typeDef._requiredFlags[i] && field.defaultValue === undefined) {
            throw new MaxiError(
              `Record '${alias}' missing required field '${field.name}'`,
              MaxiErrorCode.MissingRequiredFieldError,
              { line: lineNumber, filename: this._filename }
            );
          }
        }
      } else if (values.length > typeDef.fields.length) {
        throw new MaxiError(
          `Record '${alias}' has ${values.length} values but type defines ${typeDef.fields.length} fields`,
          MaxiErrorCode.SchemaMismatchError,
          { line: lineNumber, filename: this._filename }
        );
      }
    }

    const fieldCount = typeDef.fields.length;
    const finalValues = new Array(fieldCount);
    for (let i = 0; i < fieldCount; i++) {
      const field = typeDef.fields[i];
      let value = i < values.length ? values[i] : undefined;

      if (value === EXPLICIT_NULL) {
        if (typeDef._requiredFlags[i] && field.defaultValue !== undefined) {
          const error = new MaxiError(
            `Field '${field.name}' is required with a default; explicit null (~) is not allowed`,
            MaxiErrorCode.MissingRequiredFieldError,
            { line: lineNumber, filename: this._filename }
          );
          if (this._isStrict) throw error;
          this.result.addWarning(error.message, { code: error.code, line: lineNumber });
        }
        value = null;
      } else if (value === undefined || value === '') {
        if (field.defaultValue !== undefined) {
          value = field.defaultValue;
        } else {
          value = null;
        }
      }

      if (typeDef._requiredFlags[i] && value === null) {
        const error = new MaxiError(
          `Required field '${field.name}' is null in record '${alias}'`,
          MaxiErrorCode.MissingRequiredFieldError,
          { line: lineNumber, filename: this._filename }
        );

        if (this._isStrict) {
          throw error;
        }
        this.result.addWarning(error.message, { code: error.code, line: lineNumber });
      }

      finalValues[i] = value;
    }

    for (let i = 0; i < fieldCount; i++) {
      const enumVals = typeDef._enumValues[i];
      if (enumVals) {
        const value = finalValues[i];
        if (value !== null && value !== undefined) {
          const strValue = String(value);
          if (!enumVals.includes(strValue)) {
            const msg = `Value '${strValue}' not in enum [${enumVals.join(',')}] for field '${typeDef.fields[i].name}'`;
            if (this._isStrict) {
              throw new MaxiError(msg, MaxiErrorCode.ConstraintViolationError, { line: lineNumber, filename: this._filename });
            }
            this.result.addWarning(msg, { code: MaxiErrorCode.ConstraintViolationError, line: lineNumber });
          }
        }
      }
    }

    if (typeDef._hasRuntimeConstraints) {
      validateRecordConstraints(finalValues, typeDef, this._isStrict, this.result, lineNumber, this._filename);
    }

    const idFieldIndex = typeDef._idFieldIndex;
    if (idFieldIndex >= 0 && idFieldIndex < finalValues.length) {
      const idValue = finalValues[idFieldIndex];
      if (idValue !== null && idValue !== undefined) {
        let seen = this.seenIds.get(alias);
        if (!seen) {
          seen = new Set();
          this.seenIds.set(alias, seen);
        }
        const idKey = String(idValue);
        if (seen.has(idKey)) {
          const msg = `Duplicate identifier '${idValue}' for type '${alias}'`;
          if (this._isStrict) {
            throw new MaxiError(msg, MaxiErrorCode.DuplicateIdentifierError, { line: lineNumber, filename: this._filename });
          }
          this.result.addWarning(msg, { code: MaxiErrorCode.DuplicateIdentifierError, line: lineNumber });
        }
        seen.add(idKey);
      }
    }

    return new MaxiRecord({ alias, values: finalValues, lineNumber });
  }

  /** @private */
  parseFieldValues(valuesStr, typeDef, lineNumber) {
    let isSimple = true;
    for (let j = 0; j < valuesStr.length; j++) {
      const cc = valuesStr.charCodeAt(j);
      if (cc === 34 || cc === 40 || cc === 41 || cc === 91 || cc === 93 || cc === 123 || cc === 125) {
        isSimple = false;
        break;
      }
    }

    if (isSimple) {
      const fields = typeDef?.fields;
      const values = [];
      let start = 0;
      let fi = 0;
      for (let j = 0; j <= valuesStr.length; j++) {
        if (j === valuesStr.length || valuesStr.charCodeAt(j) === 124) {
          const valueStr = this.fastTrim(valuesStr.slice(start, j));
          values.push(this.parseFieldValue(valueStr, fields?.[fi] ?? null, lineNumber));
          fi++;
          start = j + 1;
        }
      }
      return values;
    }

    const valueStrings = this.splitTopLevel(valuesStr, '|');
    const values = [];
    for (let i = 0; i < valueStrings.length; i++) {
      const valueStr = this.fastTrim(valueStrings[i]);
      const fieldDef = typeDef?.fields[i] ?? null;
      values.push(this.parseFieldValue(valueStr, fieldDef, lineNumber));
    }
    return values;
  }

  /** @private */
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
      if (escapeNext) { escapeNext = false; continue; }
      if (inString) {
        if (char === '\\') escapeNext = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') { inString = true; continue; }

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

  /** @private */
  fastTrim(s) {
    let start = 0;
    let end = s.length;
    while (start < end) {
      const c = s.charCodeAt(start);
      if (c !== 32 && c !== 9 && c !== 10 && c !== 13) break;
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

  /** @private */
  parseFieldValue(valueStr, fieldDef, lineNumber) {
    if (valueStr === '') return fieldDef?.defaultValue ?? null;
    if (valueStr === '~') return EXPLICIT_NULL;

    const c0 = valueStr.charCodeAt(0);
    const cLast = valueStr.charCodeAt(valueStr.length - 1);

    if (c0 === 91) {
      if (cLast !== 93) {
        throw new MaxiError(
          `Malformed array: unmatched opening bracket`,
          MaxiErrorCode.ArraySyntaxError,
          { line: lineNumber, filename: this._filename }
        );
      }
      return this.parseArray(valueStr, fieldDef, lineNumber);
    }
    if (c0 === 123 && cLast === 125) return this.parseMap(valueStr, fieldDef, lineNumber); // { }
    if (c0 === 40 && cLast === 41) return this.parseInlineObject(valueStr, fieldDef, lineNumber); // ( )
    if (c0 === 34 && cLast === 34) return this.parseQuotedString(valueStr); // " "

    const typeExpr = fieldDef?.typeExpr ?? 'str';

    const baseTypeMatch = typeExpr.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/);
    const baseType = baseTypeMatch ? baseTypeMatch[1] : typeExpr;

    if (baseType === 'int') {
      const nk = this.detectNumberKind(valueStr);
      if (nk === 1) return parseInt(valueStr, 10);
      if (this._isStrict) {
        throw new MaxiError(
          `Type mismatch: field expects int, got '${valueStr}'`,
          MaxiErrorCode.TypeMismatchError,
          { line: lineNumber, filename: this._filename }
        );
      }
      if (nk === 2 || nk === 3) {
        this.result.addWarning(
          `Type coercion: value '${valueStr}' coerced to int, fractional part lost`,
          { code: MaxiErrorCode.TypeMismatchError, line: lineNumber }
        );
        return parseInt(valueStr, 10);
      }
      this.result.addWarning(
        `Type mismatch: field expects int, got '${valueStr}'`,
        { code: MaxiErrorCode.TypeMismatchError, line: lineNumber }
      );
      return valueStr;
    }

    if (baseType === 'bool') {
      if (valueStr === '1' || valueStr === 'true') return true;
      if (valueStr === '0' || valueStr === 'false') return false;
      if (this._isStrict) {
        throw new MaxiError(
          `Type mismatch: field expects bool, got '${valueStr}'`,
          MaxiErrorCode.TypeMismatchError,
          { line: lineNumber, filename: this._filename }
        );
      }
      this.result.addWarning(
        `Type coercion: value '${valueStr}' is not a valid bool`,
        { code: MaxiErrorCode.TypeMismatchError, line: lineNumber }
      );
      return valueStr;
    }

    if (fieldDef?.typeExpr != null && baseType === 'str') {
      return valueStr;
    }

    if (typeExpr.startsWith('enum')) {
      const baseMatch = typeExpr.match(/^enum<(\w+)>/);
      if (!baseMatch || baseMatch[1] === 'str') {
        return valueStr;
      }
    }

    const annotation = fieldDef?.annotation;

    if (!this._isStrict && baseType === 'bytes' && annotation === 'base64') {
      const s = valueStr;
      if (this.looksLikeBase64(s)) {
        const mod = s.length & 3;
        if (mod !== 0) return s + (mod === 1 ? '===' : mod === 2 ? '==' : '=');
      }
      return s;
    }

    if (baseType === 'float') {
      const nk = this.detectNumberKind(valueStr);
      const fk = this.detectFloatKind(valueStr);
      if (fk || nk === 1 || nk === 2 || nk === 3) return parseFloat(valueStr);
      if (this._isStrict) {
        throw new MaxiError(
          `Type mismatch: field expects float, got '${valueStr}'`,
          MaxiErrorCode.TypeMismatchError,
          { line: lineNumber, filename: this._filename }
        );
      }
      this.result.addWarning(
        `Type coercion: value '${valueStr}' is not a valid float`,
        { code: MaxiErrorCode.TypeMismatchError, line: lineNumber }
      );
      return valueStr;
    }

    if (baseType === 'decimal') {
      const nk = this.detectNumberKind(valueStr);
      if (nk === 3) return parseInt(valueStr.slice(0, -1), 10);
      if (nk === 1 || nk === 2) return parseFloat(valueStr);
      if (this._isStrict) {
        throw new MaxiError(
          `Type mismatch: field expects decimal, got '${valueStr}'`,
          MaxiErrorCode.TypeMismatchError,
          { line: lineNumber, filename: this._filename }
        );
      }
      this.result.addWarning(
        `Type coercion: value '${valueStr}' is not a valid decimal`,
        { code: MaxiErrorCode.TypeMismatchError, line: lineNumber }
      );
      return valueStr;
    }

    if (!this._isStrict) {
      const fk = this.detectFloatKind(valueStr);
      if (fk) return parseFloat(valueStr);
      const nk = this.detectNumberKind(valueStr);
      if (nk === 1) return parseInt(valueStr, 10);
      if (nk === 2) return parseFloat(valueStr);
      if (nk === 3) return parseInt(valueStr.slice(0, -1), 10);
    }

    return valueStr;
  }

  /** @private */
  parseArray(arrayStr, fieldDef, lineNumber) {
    const content = arrayStr.slice(1, -1).trim();
    if (!content) return [];

    const elemType = this.getArrayElementType(fieldDef?.typeExpr);
    const elemFieldDef = elemType ? { typeExpr: elemType } : null;

    const elements = [];
    let currentElement = '';
    let depth = 0;
    let inString = false;
    let escapeNext = false;

    for (let i = 0; i < content.length; i++) {
      const char = content[i];

      if (escapeNext) { currentElement += char; escapeNext = false; continue; }
      if (char === '\\' && inString) { currentElement += char; escapeNext = true; continue; }
      if (char === '"') { inString = !inString; currentElement += char; continue; }

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

  /** @private */
  parseMap(mapStr, fieldDef, lineNumber) {
    // Remove braces
    const content = mapStr.slice(1, -1).trim();
    if (!content) return {};

    const mapValueType = this.getMapValueType(fieldDef?.typeExpr);
    const hasExplicitMapType = fieldDef?.typeExpr != null;
    const valueFieldDef = mapValueType ? { typeExpr: mapValueType } : (hasExplicitMapType ? { typeExpr: 'str' } : null);
    const mapKeyType = this.getMapKeyType(fieldDef?.typeExpr);
    const keyFieldDef = mapKeyType ? { typeExpr: mapKeyType } : null;

    const map = {};
    let currentEntry = '';
    let depth = 0;
    let inString = false;
    let escapeNext = false;

    for (let i = 0; i < content.length; i++) {
      const char = content[i];

      if (escapeNext) { currentEntry += char; escapeNext = false; continue; }
      if (char === '\\' && inString) { currentEntry += char; escapeNext = true; continue; }
      if (char === '"') { inString = !inString; currentEntry += char; continue; }

      if (!inString) {
        if (char === '(' || char === '[' || char === '{') depth++;
        else if (char === ')' || char === ']' || char === '}') depth--;
        if (char === ',' && depth === 0) {
          this.parseMapEntry(currentEntry.trim(), map, lineNumber, valueFieldDef, keyFieldDef);
          currentEntry = '';
          continue;
        }
      }
      currentEntry += char;
    }

    if (currentEntry.trim()) this.parseMapEntry(currentEntry.trim(), map, lineNumber, valueFieldDef, keyFieldDef);
    return map;
  }

  /** @private */
  getMapValueType(typeExpr) {
    if (!typeExpr) return null;
    const t = typeExpr.trim();
    if (t === 'map') return null;

    const m = t.match(/^map\s*<\s*(.+)\s*>\s*$/);
    if (!m) return null;

    const inside = m[1];
    let depth = 0;
    let inString = false;
    let cur = '';
    const parts = [];

    for (let i = 0; i < inside.length; i++) {
      const ch = inside[i];

      if (inString) {
        if (ch === '"' && inside[i - 1] !== '\\') inString = false;
        cur += ch; continue;
      }
      if (ch === '"') { inString = true; cur += ch; continue; }

      if (ch === '<') depth++;
      else if (ch === '>') depth = Math.max(0, depth - 1);

      if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    if (cur.trim()) parts.push(cur.trim());

    if (parts.length === 1) return parts[0] || null;
    return parts[parts.length - 1] || null;
  }

  /** @private */
  getMapKeyType(typeExpr) {
    if (!typeExpr) return null;
    const t = typeExpr.trim();
    if (t === 'map') return null;

    const m = t.match(/^map\s*<\s*(.+)\s*>\s*$/);
    if (!m) return null;

    const inside = m[1];
    let depth = 0;
    let inString = false;
    let cur = '';
    const parts = [];

    for (let i = 0; i < inside.length; i++) {
      const ch = inside[i];

      if (inString) {
        if (ch === '"' && inside[i - 1] !== '\\') inString = false;
        cur += ch; continue;
      }
      if (ch === '"') { inString = true; cur += ch; continue; }

      if (ch === '<') depth++;
      else if (ch === '>') depth = Math.max(0, depth - 1);

      if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    if (cur.trim()) parts.push(cur.trim());

    if (parts.length >= 2) return parts[0] || null;
    return null;
  }

  /** @private */
  parseMapEntry(entryStr, map, lineNumber, valueFieldDef = null, keyFieldDef = null) {
    let colonIndex = -1;
    let depth = 0;
    let inString = false;
    let escapeNext = false;

    for (let i = 0; i < entryStr.length; i++) {
      const ch = entryStr[i];

      if (escapeNext) { escapeNext = false; continue; }
      if (inString) {
        if (ch === '\\') { escapeNext = true; continue; }
        if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }

      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);

      if (ch === ':' && depth === 0) { colonIndex = i; break; }
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
    const key = this.parseFieldValue(keyStr, keyFieldDef ?? { typeExpr: 'str' }, lineNumber);
    if (keyFieldDef) {
      this.validateInlineTypeConstraints(key, keyFieldDef.typeExpr, 'map key', lineNumber);
    }
    const value = this.parseFieldValue(valueStr, valueFieldDef, lineNumber);
    if (valueFieldDef) {
      this.validateInlineTypeConstraints(value, valueFieldDef.typeExpr, 'map value', lineNumber);
    }
    map[String(key)] = value;
  }

  /** @private */
  validateInlineTypeConstraints(value, typeExpr, fieldName, lineNumber) {
    if (!typeExpr) return;
    const m = typeExpr.match(/^[a-zA-Z_][a-zA-Z0-9_]*\((.+)\)\s*$/);
    if (!m) return;
    const constraintStr = m[1];
    const parts = constraintStr.split(',').map(p => p.trim()).filter(Boolean);
    for (const part of parts) {
      const cmp = part.match(/^(>=|>|<=|<)\s*(.+)$/);
      if (!cmp) continue;
      const [, operator, limitStr] = cmp;
      const limit = parseFloat(limitStr);
      if (isNaN(limit)) continue;
      let actual;
      if (typeof value === 'string') actual = value.length;
      else if (typeof value === 'number') actual = value;
      else continue;
      let violated = false;
      if (operator === '>=' && actual < limit) violated = true;
      else if (operator === '>' && actual <= limit) violated = true;
      else if (operator === '<=' && actual > limit) violated = true;
      else if (operator === '<' && actual >= limit) violated = true;
      if (violated) {
        const msg = `${fieldName}: value ${actual} violates constraint ${operator}${limit}`;
        if (this._isStrict) {
          throw new MaxiError(msg, MaxiErrorCode.ConstraintViolationError, { line: lineNumber, filename: this._filename });
        }
        this.result.addWarning(msg, { code: MaxiErrorCode.ConstraintViolationError, line: lineNumber });
      }
    }
  }

  /** @private */
  parseInlineObject(objStr, fieldDef, lineNumber) {
    const innerValuesStr = objStr.slice(1, -1);
    const typeAlias = this.getInlineObjectTypeAlias(fieldDef?.typeExpr);
    if (!typeAlias) return { values: this.parseFieldValues(innerValuesStr, null, lineNumber) };

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
    const obj = {};
    for (let i = 0; i < typeDef.fields.length; i++) {
      const field = typeDef.fields[i];
      let v = i < values.length ? values[i] : undefined;
      if (v === EXPLICIT_NULL) v = null;
      else if (v === undefined || v === '') v = field.defaultValue !== undefined ? field.defaultValue : null;
      obj[field.name] = v;
    }
    return obj;
  }

  /** @private */
  getInlineObjectTypeAlias(typeExpr) {
    if (!typeExpr) return null;
    const t = typeExpr.trim();

    const arrMatch = t.match(/^(.+)\[\]\s*$/);
    const base = arrMatch ? arrMatch[1].trim() : t;

    if (/^map\s*</.test(base)) {
      const mapValueType = this.getMapValueType(base);
      const resolved = mapValueType ? mapValueType.trim() : null;
      return this.result.schema.resolveTypeAlias?.(resolved) ?? resolved;
    }

    const primitives = ['str', 'int', 'decimal', 'bool', 'bytes', 'map'];
    if (primitives.includes(base)) return null;
    return this.result.schema.resolveTypeAlias?.(base) ?? base;
  }

  /** @private */
  getArrayElementType(typeExpr) {
    if (!typeExpr) return null;
    const t = typeExpr.trim();
    const m = t.match(/^(.+)\[\]\s*$/);
    if (!m) return null;
    return (m[1] || '').trim() || null;
  }

  /** @private */
  parseQuotedString(str) {
    let result = str.slice(1, -1);
    result = result.replace(/\\n/g, '\n');
    result = result.replace(/\\r/g, '\r');
    result = result.replace(/\\t/g, '\t');
    result = result.replace(/\\"/g, '"');
    result = result.replace(/\\\\/g, '\\');
    return result;
  }

  /** @private */
  detectFloatKind(s) {
    const n = s.length;
    if (n === 0) return false;

    let i = 0;
    if (s.charCodeAt(0) === 45) { if (n === 1) return false; i = 1; }

    let cc = s.charCodeAt(i);
    if (cc < 48 || cc > 57) return false;

    while (i < n) { cc = s.charCodeAt(i); if (cc < 48 || cc > 57) break; i++; }
    if (i >= n) return false;

    if (cc === 46) {
      i++;
      while (i < n) { cc = s.charCodeAt(i); if (cc < 48 || cc > 57) break; i++; }
    }

    if (i >= n) return false;
    cc = s.charCodeAt(i);
    if (cc !== 101 && cc !== 69) return false;
    i++;
    if (i >= n) return false;

    cc = s.charCodeAt(i);
    if (cc === 43 || cc === 45) { i++; if (i >= n) return false; }

    cc = s.charCodeAt(i);
    if (cc < 48 || cc > 57) return false;

    while (i < n) { cc = s.charCodeAt(i); if (cc < 48 || cc > 57) return false; i++; }
    return true;
  }

  /**
   * @param {string} s
   * @returns {number} 0=not numeric, 1=int, 2=decimal, 3=trailing-dot
   * @private
   */
  detectNumberKind(s) {
    const n = s.length;
    if (n === 0) return 0;

    let i = 0;
    if (s.charCodeAt(0) === 45) { if (n === 1) return 0; i = 1; }

    let cc = s.charCodeAt(i);
    if (cc < 48 || cc > 57) return 0;

    while (i < n) { cc = s.charCodeAt(i); if (cc < 48 || cc > 57) break; i++; }
    if (i === n) return 1;
    if (s.charCodeAt(i) !== 46) return 0;
    i++;
    if (i === n) return 3;

    cc = s.charCodeAt(i);
    if (cc < 48 || cc > 57) return 0;

    while (i < n) { cc = s.charCodeAt(i); if (cc < 48 || cc > 57) return 0; i++; }
    return 2;
  }

  /** @private */
  looksLikeBase64(s) {
    const n = s.length;
    if (n === 0) return false;
    let pad = 0;
    for (let i = 0; i < n; i++) {
      const c = s.charCodeAt(i);
      if (c === 61) { pad++; continue; }
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
