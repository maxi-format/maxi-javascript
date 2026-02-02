import { MaxiError, MaxiErrorCode } from '../core/errors.js';
import { MaxiTypeDef, MaxiFieldDef } from '../core/types.js';

/**
 * Schema phase parser (directives + types + imports).
 * Operates on raw schema text, tokenizes internally.
 */
export class SchemaParser {
  /**
   * @param {string} schemaText Raw schema section text
   * @param {import('../core/types.js').MaxiParseResult} result
   * @param {import('../api/parse.js').MaxiParseOptions} options
   */
  constructor(schemaText, result, options) {
    this.schemaText = schemaText;
    this.result = result;
    this.options = options;
    /** @type {Set<string>} Track files being loaded to prevent circular imports */
    this.loadingStack = new Set();
  }

  /**
   * Parse schema section.
   */
  async parse() {
    // Skip if empty schema
    if (!this.schemaText.trim()) {
      return;
    }

    const lines = this.schemaText.split(/\r?\n/);
    let lineNumber = 1;

    for (let i = 0; i < lines.length; i++, lineNumber++) {
      const line = lines[i].trim();

      // Skip empty lines and comments
      if (!line || line.startsWith('#')) {
        continue;
      }

      // Parse directives
      if (line.startsWith('@')) {
        await this.parseDirective(line, lineNumber);
        continue;
      }

      // Parse type definition (may span multiple lines)
      const typeDefResult = this.parseTypeDefinition(lines, i, lineNumber);
      if (typeDefResult) {
        i = typeDefResult.nextIndex;
        lineNumber = typeDefResult.nextLine;
      }
    }

    // After all schemas loaded, resolve inheritance
    this.resolveInheritance();

    // Build name->alias lookup for later phases (records parsing / tests / dumping).
    this.buildNameIndex();
  }

  buildNameIndex() {
    // Non-enumerable to avoid surprising JSON output if users stringify schema.
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

    // Convenience resolver used by other components
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
        // Unknown directive - warn but don't fail
        this.result.addWarning(
          `Unknown directive '@${directiveName}' ignored`,
          { code: MaxiErrorCode.UnknownDirectiveError, line: lineNumber }
        );
    }
  }

  /**
   * Parse @version directive.
   * @param {string} value
   * @param {number} lineNumber
   * @private
   */
  parseVersionDirective(value, lineNumber) {
    // Basic semver validation
    if (!/^\d+\.\d+\.\d+$/.test(value)) {
      throw new MaxiError(
        `Invalid version format: ${value}`,
        MaxiErrorCode.InvalidSyntaxError,
        { line: lineNumber, filename: this.options.filename }
      );
    }

    // Check if we support this version (currently only 1.0.0)
    if (value !== '1.0.0') {
      throw new MaxiError(
        `Unsupported version: ${value}. Parser supports v1.0.0`,
        MaxiErrorCode.UnsupportedVersionError,
        { line: lineNumber, filename: this.options.filename }
      );
    }

    this.result.schema.version = value;
  }

  /**
   * Parse @mode directive.
   * @param {string} value
   * @param {number} lineNumber
   * @private
   */
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

  /**
   * Parse @schema directive and load external schema.
   * @param {string} pathOrUrl
   * @param {number} lineNumber
   * @private
   */
  async parseSchemaDirective(pathOrUrl, lineNumber) {
    // Check for circular imports
    if (this.loadingStack.has(pathOrUrl)) {
      // Circular import detected - this is allowed, just skip
      return;
    }

    // Add to imports list
    this.result.schema.imports.push(pathOrUrl);

    // Load external schema
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

    // Reject obvious non-type-def lines early.
    const trimmed = firstLine.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('@')) return null;

    // A schema type definition MUST have an opening '(' that starts the field list,
    // but records also have '(' so we additionally require either:
    // - explicit type name (Alias:TypeName...) OR
    // - inheritance marker before '(' (Alias<...>(...)) OR
    // - alias-only definition without ":" but NO digit immediately after '(' in the first line
    //
    // This avoids treating data records like U(1|...) as schema definitions.
    const looksLikeAliasParen = /^[A-Za-z_][A-Za-z0-9_-]*\s*\(/.test(trimmed);
    const looksLikeExplicitType = /^[A-Za-z_][A-Za-z0-9_-]*\s*:\s*[A-Za-z][A-Za-z0-9_-]*\s*(<[^>]+>)?\s*\(/.test(trimmed);
    const looksLikeInheritance = /^[A-Za-z_][A-Za-z0-9_-]*\s*<[^>]+>\s*\(/.test(trimmed);

    if (!looksLikeExplicitType && !looksLikeInheritance && looksLikeAliasParen) {
      // alias-only schema form "U(...)" exists, but record form is more common.
      // Heuristic: if after '(' we see a digit, '-' digit, or '~' likely it's a record.
      const afterParen = trimmed.slice(trimmed.indexOf('(') + 1).trimStart();
      if (/^(\d|-\d|~)/.test(afterParen)) return null;
      // Otherwise allow alias-only typedef (e.g., U(id|name|email))
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
        'Unclosed parenthesis in type definition',
        MaxiErrorCode.InvalidSyntaxError,
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

    // Header grammar (schema):
    //   Alias [ ":" TypeName ] [ "<" Parents ">" ]
    // Examples:
    //   U
    //   U:User
    //   U:User<P>
    //   U<P>
    const headerMatch = header.match(
      /^([A-Za-z_][A-Za-z0-9_-]*)(?::([A-Za-z][A-Za-z0-9_-]*))?(?:<\s*([^>]+?)\s*>)?\s*$/
    );
    if (!headerMatch) {
      throw new MaxiError(
        `Invalid type definition header: ${header}`,
        MaxiErrorCode.InvalidSyntaxError,
        { line: lineNumber, filename: this.options.filename }
      );
    }

    const [, alias, typeName, parentsStr] = headerMatch;

    if (this.result.schema.hasType(alias)) {
      throw new MaxiError(
        `Duplicate type alias '${alias}'`,
        MaxiErrorCode.DuplicateTypeError,
        { line: lineNumber, filename: this.options.filename }
      );
    }

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

  /**
   * Find the index of the matching ')' for the '(' at openIdx.
   * @param {string} s
   * @param {number} openIdx
   * @returns {number} index of matching ')', or -1
   * @private
   */
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

  /**
   * Parse field list from type definition.
   * @param {string} fieldsStr Field list string
   * @param {number} lineNumber
   * @returns {MaxiFieldDef[]}
   * @private
   */
  parseFieldList(fieldsStr, lineNumber) {
    const fields = [];

    // Normalize newlines/tabs/indentation inside (...) so per-field parsing is deterministic.
    // This also prevents leading indentation from being treated as part of symbols.
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

  /**
   * Parse a single field definition.
   * @param {string} fieldStr Field definition string
   * @param {number} lineNumber
   * @returns {MaxiFieldDef}
   * @private
   */
  parseField(fieldStr, lineNumber) {
    // name[:type[@annotation]][(constraints)][=default]

    let remainingStr = fieldStr.trim();
    let constraints = [];
    let defaultValue;

    // 1) Split name vs rest first (so constraints can be on either side)
    const colonIdx0 = this.findTopLevelChar(remainingStr, ':');
    let namePart = remainingStr;
    let restPart = '';

    if (colonIdx0 !== -1) {
      namePart = remainingStr.slice(0, colonIdx0).trim();
      restPart = remainingStr.slice(colonIdx0 + 1).trim();
    }

    // 2) Extract trailing constraints FIRST (before defaults), because >= and <= contain '='
    if (restPart) {
      const trailing = this.extractTrailingGroup(restPart, '(', ')');
      if (trailing) {
        constraints = this.parseConstraints(trailing.inner, lineNumber);
        restPart = trailing.before.trim();
      }
    }

    if (constraints.length === 0) {
      const trailing = this.extractTrailingGroup(namePart, '(', ')');
      if (trailing) {
        constraints = this.parseConstraints(trailing.inner, lineNumber);
        namePart = trailing.before.trim();
      }
    }

    // 3) Extract default value using TOP-LEVEL '=' (must not be inside (),[],{}, or strings)
    //    This avoids mis-parsing the '=' in >= / <= comparisons.
    const eqIdxName = this.findTopLevelChar(namePart, '=');
    if (eqIdxName !== -1) {
      defaultValue = namePart.slice(eqIdxName + 1).trim();
      namePart = namePart.slice(0, eqIdxName).trim();
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

    // 4) Parse typeExpr + annotation from restPart (after constraints/default removed)
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
      defaultValue,
    });
  }

  /**
   * Find first occurrence of a character at top-level (not in strings or (),[],{}).
   * @param {string} s
   * @param {string} ch
   * @returns {number}
   * @private
   */
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

    // The closing delimiter MUST be the last non-whitespace character
    if (!trimmed.endsWith(closeCh)) return null;

    const closeIdx = trimmed.lastIndexOf(closeCh);
    if (closeIdx === -1) return null;

    // Scan backwards from closeIdx-1 to find matching openCh.
    let inString = false;
    let depth = 1; // Start at 1 because we already found the closing paren
    let startIdx = -1;

    for (let i = closeIdx - 1; i >= 0; i--) {
      const ch = trimmed[i];

      // Skip string handling for simplicity (constraints don't contain strings)
      if (ch === '"') {
        // Toggle string state
        inString = !inString;
        continue;
      }

      if (inString) continue;

      if (ch === closeCh) {
        depth++;
      } else if (ch === openCh) {
        depth--;
        if (depth === 0) {
          startIdx = i;
          break;
        }
      }
    }

    if (startIdx === -1 || depth !== 0) return null;

    const before = trimmed.slice(0, startIdx);
    const inner = trimmed.slice(startIdx + 1, closeIdx);

    return { before, inner };
  }

  /**
   * Parse constraint string into structured constraints.
   * @param {string} constraintStr
   * @param {number} lineNumber
   * @returns {import('../core/types.js').ParsedConstraint[]}
   * @private
   */
  parseConstraints(constraintStr, lineNumber) {
    const constraints = [];

    const parts = this.splitConstraintParts(constraintStr)
      .map(p => p.trim())
      .filter(Boolean);

    for (const trimmed of parts) {
      if (trimmed === '!') {
        constraints.push({ type: 'required' });
        continue;
      }

      if (trimmed === 'id') {
        constraints.push({ type: 'id' });
        continue;
      }

      // Exact length constraint: =N (for arrays/maps)
      // MUST be checked before generic comparison, otherwise "=3" becomes a comparison.
      const exactLengthMatch = trimmed.match(/^=(\d+)$/);
      if (exactLengthMatch) {
        constraints.push({
          type: 'exact-length',
          value: parseInt(exactLengthMatch[1], 10)
        });
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
        constraints.push({ type: 'decimal-precision', value: trimmed });
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

      // Merge inherited fields with own fields
      // Own fields can override inherited ones
      const finalFields = [...inheritedFields];
      for (const ownField of typeDef.fields) {
        const existingIndex = finalFields.findIndex(f => f.name === ownField.name);
        if (existingIndex >= 0) {
          finalFields[existingIndex] = ownField; // Override
        } else {
          finalFields.push(ownField);
        }
      }

      typeDef.fields = finalFields;
      typeDef._inheritanceResolved = true;

      visiting.delete(alias);
      visited.add(alias);
    };

    // Resolve all types
    for (const alias of this.result.schema.types.keys()) {
      resolveType(alias);
    }
  }

  /**
   * Load and parse an external schema file.
   * @param {string} pathOrUrl Schema file path or URL
   * @param {number} lineNumber
   * @returns {Promise<void>|void}
   * @private
   */
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

      // Share loading stack to detect circular imports
      externalParser.loadingStack = this.loadingStack;

      await externalParser.parse();
    } catch (error) {
      if (error instanceof MaxiError) {
        throw error;
      }

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
