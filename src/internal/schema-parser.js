import { MaxiError, MaxiErrorCode } from '../core/errors.js';
import { MaxiTypeDef, MaxiFieldDef } from '../core/types.js';
import { validateSchemaConstraints } from './constraint-validator.js';

/**
 * Schema phase parser (directives + types + imports).
 */
export class SchemaParser {
  /**
   * @param {string} schemaText
   * @param {import('../core/types.js').MaxiParseResult} result
   * @param {import('../api/parse.js').MaxiParseOptions} options
   */
  constructor(schemaText, result, options) {
    this.schemaText = schemaText;
    this.result = result;
    this.options = options;
    /** @type {Set<string>} */
    this.loadingStack = new Set();
    /** @type {Set<string>} */
    this.localAliases = new Set();
  }

  async parse() {
    if (!this.schemaText.trim()) return;

    const lines = this.schemaText.split(/\r?\n/);
    let lineNumber = 1;

    for (let i = 0; i < lines.length; i++, lineNumber++) {
      const line = lines[i].trim();

      if (!line || line.startsWith('#')) continue;

      if (line.startsWith('@')) {
        await this.parseDirective(line, lineNumber);
        continue;
      }

      const typeDefResult = this.parseTypeDefinition(lines, i, lineNumber);
      if (typeDefResult) {
        i = typeDefResult.nextIndex;
        lineNumber = typeDefResult.nextLine;
      }
    }

    this.resolveInheritance();
    validateSchemaConstraints(this.result.schema, this.options.filename);
    this.validateDefaultValues();
    this.buildNameIndex();

    if (!this._isImported) {
      this.validateFieldTypeReferences();
    }
  }

  buildNameIndex() {
    const nameToAlias = new Map();
    for (const [alias, td] of this.result.schema.types.entries()) {
      const name = td.name;
      if (name && !nameToAlias.has(name)) nameToAlias.set(name, alias);
    }

    Object.defineProperty(this.result.schema, '_nameToAlias', {
      value: nameToAlias,
      enumerable: false,
      configurable: true,
      writable: true,
    });

    Object.defineProperty(this.result.schema, 'resolveTypeAlias', {
      value: (maybeAliasOrName) => {
        if (!maybeAliasOrName) return null;
        if (this.result.schema.types.has(maybeAliasOrName)) return maybeAliasOrName;
        return this.result.schema._nameToAlias?.get(maybeAliasOrName) ?? null;
      },
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }

  /**
   * Parse a directive line.
   * @param {string} line
   * @param {number} lineNumber
   * @private
   */
  async parseDirective(line, lineNumber) {
    const match = line.match(/^@([a-zA-Z_][a-zA-Z0-9_-]*):(.+)$/);
    if (!match) {
      throw new MaxiError(
        `Invalid directive syntax: ${line}`,
        MaxiErrorCode.InvalidSyntaxError,
        { line: lineNumber, filename: this.options.filename }
      );
    }

    const [, directiveName, directiveValue] = match;
    const value = directiveValue.trim();

    switch (directiveName) {
      case 'version':
        this.parseVersionDirective(value, lineNumber);
        break;

      case 'mode':
        this.parseModeDirective(value, lineNumber);
        break;

      case 'schema':
        await this.parseSchemaDirective(value, lineNumber);
        break;

      default:
        this.result.addWarning(
          `Unknown directive '@${directiveName}' ignored`,
          { code: MaxiErrorCode.UnknownDirectiveError, line: lineNumber }
        );
    }
  }

  /** @private */
  parseVersionDirective(value, lineNumber) {
    if (!/^\d+\.\d+\.\d+$/.test(value)) {
      throw new MaxiError(
        `Invalid version format: ${value}`,
        MaxiErrorCode.InvalidSyntaxError,
        { line: lineNumber, filename: this.options.filename }
      );
    }

    if (value !== '1.0.0') {
      throw new MaxiError(
        `Unsupported version: ${value}. Parser supports v1.0.0`,
        MaxiErrorCode.UnsupportedVersionError,
        { line: lineNumber, filename: this.options.filename }
      );
    }

    this.result.schema.version = value;
  }

  /** @private */
  parseModeDirective(value, lineNumber) {
    if (value !== 'strict' && value !== 'lax') {
      throw new MaxiError(
        `Invalid mode: ${value}. Must be 'strict' or 'lax'`,
        MaxiErrorCode.InvalidSyntaxError,
        { line: lineNumber, filename: this.options.filename }
      );
    }
    this.result.schema.mode = value;
  }

  /** @private */
  async parseSchemaDirective(pathOrUrl, lineNumber) {
    if (this.loadingStack.has(pathOrUrl)) return;

    this.result.schema.imports.push(pathOrUrl);
    await this.loadExternalSchema(pathOrUrl, lineNumber);
  }

  /**
   * Parse type definition (may span multiple lines).
   * @param {string[]} lines
   * @param {number} startIndex
   * @param {number} startLine
   * @returns {{nextIndex: number, nextLine: number} | null}
   * @private
   */
  parseTypeDefinition(lines, startIndex, startLine) {
    const firstLine = lines[startIndex];

    const trimmed = firstLine.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('@')) return null;

    const looksLikeAliasParen = /^[A-Za-z_][A-Za-z0-9_-]*\s*\(/.test(trimmed);
    const looksLikeExplicitType = /^[A-Za-z_][A-Za-z0-9_-]*\s*:\s*[A-Za-z_][A-Za-z0-9_-]*\s*(<[^>]+>)?\s*\(/.test(trimmed);
    const looksLikeInheritance = /^[A-Za-z_][A-Za-z0-9_-]*\s*<[^>]+>\s*\(/.test(trimmed);

    if (!looksLikeExplicitType && !looksLikeInheritance && looksLikeAliasParen) {
      const afterParen = trimmed.slice(trimmed.indexOf('(') + 1).trimStart();
      if (/^(\d|-\d|~)/.test(afterParen)) return null;
    } else if (!looksLikeExplicitType && !looksLikeInheritance) {
      return null;
    }

    let fullDef = '';
    let i = startIndex;
    let lineNum = startLine;

    let inString = false;
    let escapeNext = false;

    let sawOpenParen = false;
    let parenDepth = 0;

    for (; i < lines.length; i++, lineNum++) {
      const currentLine = lines[i];
      fullDef += currentLine + '\n';

      for (let k = 0; k < currentLine.length; k++) {
        const ch = currentLine[k];

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

        if (ch === '(') {
          sawOpenParen = true;
          parenDepth++;
          continue;
        }

        if (ch === ')') {
          if (!sawOpenParen) {
            throw new MaxiError(
              'Unmatched closing parenthesis in type definition',
              MaxiErrorCode.InvalidSyntaxError,
              { line: lineNum, filename: this.options.filename }
            );
          }
          parenDepth--;
          if (parenDepth < 0) {
            throw new MaxiError(
              'Unmatched closing parenthesis in type definition',
              MaxiErrorCode.InvalidSyntaxError,
              { line: lineNum, filename: this.options.filename }
            );
          }
          if (parenDepth === 0) {
            break;
          }
        }
      }

      if (sawOpenParen && parenDepth === 0) break;
    }

    if (!sawOpenParen) return null;

    if (parenDepth !== 0) {
      throw new MaxiError(
        'Unclosed parenthesis in type definition (possible malformed constraint)',
        MaxiErrorCode.ConstraintSyntaxError,
        { line: startLine, filename: this.options.filename }
      );
    }

    this.parseCompleteTypeDefinition(fullDef, startLine);
    return { nextIndex: i, nextLine: lineNum };
  }

  /**
   * Parse a complete type definition string.
   * @param {string} def Complete type definition
   * @param {number} lineNumber
   * @private
   */
  parseCompleteTypeDefinition(def, lineNumber) {
    const trimmed = def.trim();

    const openIdx = trimmed.indexOf('(');
    if (openIdx === -1) {
      throw new MaxiError(
        `Invalid type definition syntax: ${trimmed}`,
        MaxiErrorCode.InvalidSyntaxError,
        { line: lineNumber, filename: this.options.filename }
      );
    }

    const closeIdx = this.findMatchingParen(trimmed, openIdx);
    if (closeIdx === -1) {
      throw new MaxiError(
        `Invalid type definition syntax: ${trimmed}`,
        MaxiErrorCode.InvalidSyntaxError,
        { line: lineNumber, filename: this.options.filename }
      );
    }

    // Allow trailing whitespace after the closing paren, but nothing else
    const tail = trimmed.slice(closeIdx + 1).trim();
    if (tail.length !== 0) {
      throw new MaxiError(
        `Invalid type definition syntax: ${trimmed}`,
        MaxiErrorCode.InvalidSyntaxError,
        { line: lineNumber, filename: this.options.filename }
      );
    }

    const header = trimmed.slice(0, openIdx).trim();
    const fieldsStr = trimmed.slice(openIdx + 1, closeIdx).trim();

    const headerMatch = header.match(
      /^([A-Za-z_][A-Za-z0-9_-]*)(?::([A-Za-z_][A-Za-z0-9_-]*))?(?:<\s*([^>]+?)\s*>)?\s*$/
    );
    if (!headerMatch) {
      throw new MaxiError(
        `Invalid type definition header: ${header}`,
        MaxiErrorCode.InvalidSyntaxError,
        { line: lineNumber, filename: this.options.filename }
      );
    }

    const [, alias, typeName, parentsStr] = headerMatch;

    if (this.localAliases.has(alias)) {
      throw new MaxiError(
        `Duplicate type alias '${alias}'`,
        MaxiErrorCode.DuplicateTypeError,
        { line: lineNumber, filename: this.options.filename }
      );
    }
    this.localAliases.add(alias);

    const parents = parentsStr
      ? parentsStr.split(',').map(p => p.trim()).filter(Boolean)
      : [];

    const typeDef = new MaxiTypeDef({ alias, name: typeName || null, parents });

    if (fieldsStr) {
      const fieldDefs = this.parseFieldList(fieldsStr, lineNumber);
      fieldDefs.forEach(f => typeDef.addField(f));
    }

    this.result.schema.addType(typeDef);
  }

  /** @private */
  findMatchingParen(s, openIdx) {
    if (openIdx < 0 || s[openIdx] !== '(') return -1;

    let depth = 0;
    let inString = false;
    let escapeNext = false;

    for (let i = openIdx; i < s.length; i++) {
      const ch = s[i];

      if (escapeNext) {
        escapeNext = false;
        continue;
      }

      if (inString) {
        if (ch === '\\') {
          escapeNext = true;
          continue;
        }
        if (ch === '"') {
          inString = false;
        }
        continue;
      }

      if (ch === '"') {
        inString = true;
        continue;
      }

      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) return i;
      }
    }

    return -1;
  }

  /** @private */
  parseFieldList(fieldsStr, lineNumber) {
    const fields = [];

    const normalized = fieldsStr
      .replace(/\r?\n/g, ' ')
      .replace(/\t/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const fieldStrs = this.splitTopLevel(normalized, '|')
      .map(f => f.trim())
      .filter(Boolean);

    for (const fieldStr of fieldStrs) {
      fields.push(this.parseField(fieldStr, lineNumber));
    }

    return fields;
  }

  /**
   * Split on a delimiter only at top-level (not inside (), [], {}, or strings).
   * @param {string} s
   * @param {string} delim single-character delimiter
   * @returns {string[]}
   * @private
   */
  splitTopLevel(s, delim) {
    const out = [];
    let cur = '';

    let inString = false;
    let escapeNext = false;

    let paren = 0;
    let bracket = 0;
    let brace = 0;

    for (let i = 0; i < s.length; i++) {
      const ch = s[i];

      if (escapeNext) {
        cur += ch;
        escapeNext = false;
        continue;
      }

      if (inString) {
        if (ch === '\\') {
          cur += ch;
          escapeNext = true;
          continue;
        }
        if (ch === '"') inString = false;
        cur += ch;
        continue;
      }

      if (ch === '"') {
        inString = true;
        cur += ch;
        continue;
      }

      if (ch === '(') paren++;
      else if (ch === ')') paren = Math.max(0, paren - 1);
      else if (ch === '[') bracket++;
      else if (ch === ']') bracket = Math.max(0, bracket - 1);
      else if (ch === '{') brace++;
      else if (ch === '}') brace = Math.max(0, brace - 1);

      if (ch === delim && paren === 0 && bracket === 0 && brace === 0) {
        out.push(cur);
        cur = '';
        continue;
      }

      cur += ch;
    }

    out.push(cur);
    return out;
  }

  /** @private */
  parseField(fieldStr, lineNumber) {
    let remainingStr = fieldStr.trim();
    let constraints = [];
    let elementConstraints = [];
    let defaultValue;

    const colonIdx0 = this.findTopLevelChar(remainingStr, ':');
    let namePart = remainingStr;
    let restPart = '';

    if (colonIdx0 !== -1) {
      namePart = remainingStr.slice(0, colonIdx0).trim();
      restPart = remainingStr.slice(colonIdx0 + 1).trim();
    }

    if (restPart) {
      const trailing = this.extractTrailingGroup(restPart, '(', ')');
      if (trailing) {
        constraints = this.parseConstraints(trailing.inner, lineNumber);
        restPart = trailing.before.trim();

        if (/\[\]\s*$/.test(restPart)) {
          const withoutBrackets = restPart.replace(/\[\]\s*$/, '').trim();
          const innerTrailing = this.extractTrailingGroup(withoutBrackets, '(', ')');
          if (innerTrailing) {
            elementConstraints = this.parseConstraints(innerTrailing.inner, lineNumber);
            restPart = innerTrailing.before.trim() + '[]';
          }
        }
      }
    }

    if (constraints.length === 0) {
      const trailing = this.extractTrailingGroup(namePart, '(', ')');
      if (trailing) {
        constraints = this.parseConstraints(trailing.inner, lineNumber);
        namePart = trailing.before.trim();
      }
    }

    const eqIdxName = this.findTopLevelChar(namePart, '=');
    if (eqIdxName !== -1) {
      defaultValue = namePart.slice(eqIdxName + 1).trim();
      namePart = namePart.slice(0, eqIdxName).trim();
      // After extracting default value, try again to extract constraints from name
      if (constraints.length === 0) {
        const trailing = this.extractTrailingGroup(namePart, '(', ')');
        if (trailing) {
          constraints = this.parseConstraints(trailing.inner, lineNumber);
          namePart = trailing.before.trim();
        }
      }
    } else if (restPart) {
      const eqIdxRest = this.findTopLevelChar(restPart, '=');
      if (eqIdxRest !== -1) {
        defaultValue = restPart.slice(eqIdxRest + 1).trim();
        restPart = restPart.slice(0, eqIdxRest).trim();
      }
    }

    if (defaultValue !== undefined) {
      if (defaultValue.startsWith('"') && defaultValue.endsWith('"')) {
        defaultValue = this.unescapeString(defaultValue.slice(1, -1));
      }
    }

    // 4) Parse typeExpr + annotation from restPart
    let typeExpr = null;
    let annotation = null;

    if (restPart) {
      const atIdx = this.findTopLevelChar(restPart, '@');
      if (atIdx !== -1) {
        typeExpr = restPart.slice(0, atIdx).trim() || null;
        annotation = restPart.slice(atIdx + 1).trim() || null;
      } else {
        typeExpr = restPart.trim() || null;
      }
    }

    return new MaxiFieldDef({
      name: namePart,
      typeExpr,
      annotation,
      constraints,
      elementConstraints: elementConstraints.length > 0 ? elementConstraints : null,
      defaultValue,
    });
  }

  /** @private */
  findTopLevelChar(s, ch) {
    let inString = false;
    let escapeNext = false;
    let paren = 0, bracket = 0, brace = 0;

    for (let i = 0; i < s.length; i++) {
      const c = s[i];

      if (escapeNext) {
        escapeNext = false;
        continue;
      }

      if (inString) {
        if (c === '\\') {
          escapeNext = true;
          continue;
        }
        if (c === '"') inString = false;
        continue;
      }

      if (c === '"') {
        inString = true;
        continue;
      }

      if (c === '(') paren++;
      else if (c === ')') paren = Math.max(0, paren - 1);
      else if (c === '[') bracket++;
      else if (c === ']') bracket = Math.max(0, bracket - 1);
      else if (c === '{') brace++;
      else if (c === '}') brace = Math.max(0, brace - 1);

      if (c === ch && paren === 0 && bracket === 0 && brace === 0) return i;
    }

    return -1;
  }

  /**
   * If s ends with a balanced (...) group (ignoring trailing whitespace), extract it.
   * Returns { before, inner } or null.
   * @param {string} s
   * @param {string} openCh
   * @param {string} closeCh
   * @returns {{before: string, inner: string} | null}
   * @private
   */
  extractTrailingGroup(s, openCh, closeCh) {
    const trimmed = s.trimEnd();
    if (!trimmed.endsWith(closeCh)) return null;

    const closeIdx = trimmed.lastIndexOf(closeCh);
    if (closeIdx === -1) return null;

    let inString = false;
    let depth = 1;
    let startIdx = -1;

    for (let i = closeIdx - 1; i >= 0; i--) {
      const ch = trimmed[i];
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === closeCh) depth++;
      else if (ch === openCh) { depth--; if (depth === 0) { startIdx = i; break; } }
    }

    if (startIdx === -1 || depth !== 0) return null;
    return { before: trimmed.slice(0, startIdx), inner: trimmed.slice(startIdx + 1, closeIdx) };
  }

  /** @private */
  parseConstraints(constraintStr, lineNumber) {
    const constraints = [];

    const parts = this.splitConstraintParts(constraintStr)
      .map(p => p.trim())
      .filter(Boolean);

    for (const trimmed of parts) {
      if (trimmed === '!') { constraints.push({ type: 'required' }); continue; }
      if (trimmed === 'id') { constraints.push({ type: 'id' }); continue; }

      const exactLengthMatch = trimmed.match(/^=(\d+)$/);
      if (exactLengthMatch) {
        constraints.push({ type: 'exact-length', value: parseInt(exactLengthMatch[1], 10) });
        continue;
      }

      const comparisonMatch = trimmed.match(/^(>=|>|<=|<|=)\s*(.+)$/);
      if (comparisonMatch) {
        const [, operator, valueStr] = comparisonMatch;
        const value = valueStr.trim();
        const numValue = parseFloat(value);
        constraints.push({
          type: 'comparison',
          operator,
          value: isNaN(numValue) ? value : numValue
        });
        continue;
      }

      if (trimmed.startsWith('pattern:')) {
        const pattern = trimmed.substring('pattern:'.length).trim();
        try {
          new RegExp(pattern);
          constraints.push({ type: 'pattern', value: pattern });
        } catch (error) {
          throw new MaxiError(
            `Invalid regex pattern: ${pattern}`,
            MaxiErrorCode.ConstraintSyntaxError,
            { line: lineNumber, filename: this.options.filename, cause: error }
          );
        }
        continue;
      }

      if (trimmed.startsWith('mime:')) {
        const mimeSpec = trimmed.substring('mime:'.length).trim();
        const mimeTypes = this.parseMimeSpec(mimeSpec);
        constraints.push({ type: 'mime', value: mimeTypes });
        continue;
      }

      const precisionMatch = trimmed.match(/^(\d+:)?(\d+)?\.(\d+(?::\d+)?)?$/);
      if (precisionMatch) {
        constraints.push(this.parseDecimalPrecision(trimmed));
        continue;
      }

      throw new MaxiError(
        `Unknown constraint: ${trimmed}`,
        MaxiErrorCode.ConstraintSyntaxError,
        { line: lineNumber, filename: this.options.filename }
      );
    }

    return constraints;
  }

  splitConstraintParts(str) {
    const parts = [];
    let current = '';

    let inString = false;
    let escapeNext = false;

    // Track nesting inside constraint values (e.g., mime:[a,b], pattern:(...), etc.)
    let bracketDepth = 0;
    let parenDepth = 0;
    let braceDepth = 0;

    for (let i = 0; i < str.length; i++) {
      const ch = str[i];

      if (escapeNext) {
        current += ch;
        escapeNext = false;
        continue;
      }

      if (inString) {
        if (ch === '\\') {
          current += ch;
          escapeNext = true;
          continue;
        }
        if (ch === '"') inString = false;
        current += ch;
        continue;
      }

      if (ch === '"') {
        inString = true;
        current += ch;
        continue;
      }

      if (ch === '[') bracketDepth++;
      else if (ch === ']') bracketDepth = Math.max(0, bracketDepth - 1);
      else if (ch === '(') parenDepth++;
      else if (ch === ')') parenDepth = Math.max(0, parenDepth - 1);
      else if (ch === '{') braceDepth++;
      else if (ch === '}') braceDepth = Math.max(0, braceDepth - 1);

      // Only split on commas at top-level of the constraint list
      if (ch === ',' && bracketDepth === 0 && parenDepth === 0 && braceDepth === 0) {
        parts.push(current);
        current = '';
        continue;
      }

      current += ch;
    }

    parts.push(current);
    return parts;
  }

  parseMimeSpec(mimeSpec) {
    const s = mimeSpec.trim();
    if (!s) return [];

    // Single MIME type
    if (!s.startsWith('[')) {
      // allow quoted mime too: mime:"image/png"
      const single = s.startsWith('"') && s.endsWith('"')
        ? this.unescapeString(s.slice(1, -1))
        : s;
      return [single.trim()].filter(Boolean);
    }

    // List of MIME types: [type1,type2,...] (items may be quoted)
    if (!s.endsWith(']')) {
      throw new MaxiError(
        `Invalid mime constraint value: ${mimeSpec}`,
        MaxiErrorCode.ConstraintSyntaxError
      );
    }

    const content = s.slice(1, -1).trim();
    if (!content) return [];

    // Split items by comma at top-level (quotes allowed)
    const items = [];
    let cur = '';
    let inString = false;
    let escapeNext = false;

    for (let i = 0; i < content.length; i++) {
      const ch = content[i];

      if (escapeNext) {
        cur += ch;
        escapeNext = false;
        continue;
      }

      if (inString) {
        if (ch === '\\') {
          cur += ch;
          escapeNext = true;
          continue;
        }
        if (ch === '"') inString = false;
        cur += ch;
        continue;
      }

      if (ch === '"') {
        inString = true;
        cur += ch;
        continue;
      }

      if (ch === ',') {
        const item = cur.trim();
        if (item) items.push(item);
        cur = '';
        continue;
      }

      cur += ch;
    }

    const last = cur.trim();
    if (last) items.push(last);

    return items
      .map((t) => {
        const tt = t.trim();
        if (tt.startsWith('"') && tt.endsWith('"')) return this.unescapeString(tt.slice(1, -1)).trim();
        return tt;
      })
      .filter(Boolean);
  }

  /**
   * Parse decimal precision constraint into structured form.
   * Forms: 5.2, 0:10.2, .2:4, 1:999., 0:100.0:2, .2, N.
   * @param {string} raw
   * @returns {import('../core/types.js').ParsedConstraint}
   * @private
   */
  parseDecimalPrecision(raw) {
    // Split on '.'
    const dotIdx = raw.indexOf('.');
    const intPart = raw.slice(0, dotIdx);     // e.g. "0:10", "5", ""
    const fracPart = raw.slice(dotIdx + 1);   // e.g. "2", "2:4", ""

    let intMin = null, intMax = null, fracMin = null, fracMax = null;

    if (intPart) {
      if (intPart.includes(':')) {
        const [a, b] = intPart.split(':');
        intMin = a !== '' ? parseInt(a, 10) : null;
        intMax = b !== '' ? parseInt(b, 10) : null;
      } else {
        // Single number = exact (both min and max)
        intMax = parseInt(intPart, 10);
      }
    }

    if (fracPart) {
      if (fracPart.includes(':')) {
        const [a, b] = fracPart.split(':');
        fracMin = a !== '' ? parseInt(a, 10) : null;
        fracMax = b !== '' ? parseInt(b, 10) : null;
      } else {
        // Single number = exact (both min and max)
        fracMax = parseInt(fracPart, 10);
      }
    }

    return {
      type: 'decimal-precision',
      value: raw,
      intMin,
      intMax,
      fracMin,
      fracMax,
    };
  }

  /**
   * Unescape string sequences.
   * @param {string} str
   * @returns {string}
   * @private
   */
  unescapeString(str) {
    return str
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }

  static PRIMITIVE_TYPES = new Set([
    'str', 'int', 'decimal', 'float', 'bool', 'bytes', 'map',
  ]);

  /** @private */
  extractReferencedType(typeExpr) {
    if (!typeExpr) return null;
    let t = typeExpr.trim();

    if (t.startsWith('enum')) return null;

    const mapMatch = t.match(/^map\s*<\s*(.+)\s*>\s*$/);
    if (mapMatch) {
      const inside = mapMatch[1];
      let depth = 0;
      let parenDepth = 0;
      let lastComma = -1;
      for (let i = 0; i < inside.length; i++) {
        if (inside[i] === '(') parenDepth++;
        else if (inside[i] === ')') parenDepth = Math.max(0, parenDepth - 1);
        else if (parenDepth === 0 && inside[i] === '<') depth++;
        else if (parenDepth === 0 && inside[i] === '>') depth--;
        else if (inside[i] === ',' && depth === 0 && parenDepth === 0) lastComma = i;
      }
      const valueType = lastComma >= 0 ? inside.slice(lastComma + 1).trim() : inside.trim();
      return this.extractReferencedType(valueType);
    }
    if (t === 'map') return null;

    t = t.replace(/\([^)]*\)\s*$/, '').trim();

    while (t.endsWith('[]')) {
      t = t.slice(0, -2).trim();
      t = t.replace(/\([^)]*\)\s*$/, '').trim();
    }

    if (!t) return null;
    if (SchemaParser.PRIMITIVE_TYPES.has(t)) return null;
    return t;
  }

  /** @private */
  validateFieldTypeReferences() {
    for (const [alias, typeDef] of this.result.schema.types.entries()) {
      for (const field of typeDef.fields) {
        const refType = this.extractReferencedType(field.typeExpr);
        if (refType && !this.result.schema.types.has(refType) && !this.result.schema.resolveTypeAlias?.(refType)) {
          throw new MaxiError(
            `Field '${field.name}' in type '${alias}' references unknown type '${refType}'`,
            MaxiErrorCode.UnknownTypeError,
            { filename: this.options.filename }
          );
        }
      }
    }
  }

  /** @private */
  validateDefaultValues() {
    for (const [alias, typeDef] of this.result.schema.types.entries()) {
      for (const field of typeDef.fields) {
        if (field.defaultValue === undefined) continue;

        const defVal = String(field.defaultValue);
        const typeExpr = field.typeExpr;
        if (!typeExpr) continue;

        if (typeExpr === 'int') {
          if (!/^-?\d+$/.test(defVal)) {
            throw new MaxiError(
              `Invalid default value '${field.defaultValue}' for field '${field.name}' of type 'int' in '${alias}'`,
              MaxiErrorCode.InvalidDefaultValueError,
              { filename: this.options.filename }
            );
          }
        } else if (typeExpr === 'float' || typeExpr === 'decimal') {
          if (isNaN(Number(defVal))) {
            throw new MaxiError(
              `Invalid default value '${field.defaultValue}' for field '${field.name}' of type '${typeExpr}' in '${alias}'`,
              MaxiErrorCode.InvalidDefaultValueError,
              { filename: this.options.filename }
            );
          }
        } else if (typeExpr === 'bool') {
          if (!['true', 'false', '1', '0'].includes(defVal)) {
            throw new MaxiError(
              `Invalid default value '${field.defaultValue}' for field '${field.name}' of type 'bool' in '${alias}'`,
              MaxiErrorCode.InvalidDefaultValueError,
              { filename: this.options.filename }
            );
          }
        }
      }
    }
  }

  /**
   * Resolve inheritance after all types are loaded.
   * @private
   */
  resolveInheritance() {
    const visited = new Set();
    const visiting = new Set();

    const resolveType = (alias) => {
      if (visited.has(alias)) return;
      if (visiting.has(alias)) {
        throw new MaxiError(
          `Circular inheritance detected involving type '${alias}'`,
          MaxiErrorCode.CircularInheritanceError
        );
      }

      const typeDef = this.result.schema.getType(alias);
      if (!typeDef || typeDef._inheritanceResolved) return;

      visiting.add(alias);

      // Resolve parent types first
      const inheritedFields = [];
      for (const parentAlias of typeDef.parents) {
        const parentType = this.result.schema.getType(parentAlias);
        if (!parentType) {
          throw new MaxiError(
            `Type '${alias}' inherits from '${parentAlias}', but '${parentAlias}' is not defined`,
            MaxiErrorCode.UndefinedParentError
          );
        }

        // Recursively resolve parent
        resolveType(parentAlias);

        // Add parent fields (avoid duplicates)
        for (const field of parentType.fields) {
          if (!inheritedFields.some(f => f.name === field.name)) {
            inheritedFields.push(field);
          }
        }
      }

      const finalFields = [...inheritedFields];
      for (const ownField of typeDef.fields) {
        const existingIndex = finalFields.findIndex(f => f.name === ownField.name);
        if (existingIndex >= 0) {
          finalFields[existingIndex] = ownField;
        } else {
          finalFields.push(ownField);
        }
      }

      typeDef.fields = finalFields;
      typeDef._inheritanceResolved = true;

      visiting.delete(alias);
      visited.add(alias);
    };

    for (const alias of this.result.schema.types.keys()) {
      resolveType(alias);
    }
  }

  /** @private */
  async loadExternalSchema(pathOrUrl, lineNumber) {
    if (!this.options.loadSchema) {
      throw new MaxiError(
        `Cannot load schema '${pathOrUrl}': no loadSchema function provided`,
        MaxiErrorCode.SchemaLoadError,
        { line: lineNumber, filename: this.options.filename }
      );
    }

    this.loadingStack.add(pathOrUrl);

    try {
      const schemaContent = await this.options.loadSchema(pathOrUrl);

      const externalParser = new SchemaParser(schemaContent, this.result, {
        ...this.options,
        filename: pathOrUrl
      });
      externalParser._isImported = true;
      externalParser.loadingStack = this.loadingStack;

      await externalParser.parse();
    } catch (error) {
      if (error instanceof MaxiError) throw error;

      throw new MaxiError(
        `Failed to load schema '${pathOrUrl}': ${error?.message ?? String(error)}`,
        MaxiErrorCode.SchemaLoadError,
        { line: lineNumber, filename: this.options.filename, cause: error }
      );
    } finally {
      this.loadingStack.delete(pathOrUrl);
    }
  }
}
