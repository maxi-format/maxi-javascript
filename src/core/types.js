/**
 * Core MAXI type definitions (IR - Intermediate Representation).
 */

/** @typedef {'strict'|'lax'} MaxiMode */

export class MaxiSchema {
  constructor() {
    /** @type {string} */
    this.version = '1.0.0';
    /** @type {MaxiMode} */
    this.mode = 'lax';
    /** @type {string[]} */
    this.imports = [];
    /** @type {Map<string, MaxiTypeDef>} */
    this.types = new Map();
  }

  /** @param {MaxiTypeDef} typeDef */
  addType(typeDef) { this.types.set(typeDef.alias, typeDef); }

  /** @param {string} alias @returns {MaxiTypeDef | undefined} */
  getType(alias) { return this.types.get(alias); }

  /** @param {string} alias @returns {boolean} */
  hasType(alias) { return this.types.has(alias); }
}

export class MaxiTypeDef {
  /**
   * @param {{alias: string, name?: string|null, parents?: string[], fields?: MaxiFieldDef[]}} args
   */
  constructor({ alias, name = null, parents = [], fields = [] }) {
    this.alias = alias;
    this.name = name;
    this.parents = parents;
    this.fields = fields;
    this._inheritanceResolved = false;
    /** @type {number} Cached id field index, -1 = none, -2 = not computed */
    this._idFieldIndex = -2;
    /** @type {boolean[]|null} Cached per-field "isRequired" flags */
    this._requiredFlags = null;
    /** @type {(string[]|null)[]|null} Cached parsed enum values per field (null entry = not enum) */
    this._enumValues = null;
    /** @type {boolean} Whether any field has constraints needing runtime validation */
    this._hasRuntimeConstraints = false;
  }

  /** @param {MaxiFieldDef} field */
  addField(field) { this.fields.push(field); this._invalidateCache(); }

  /** Invalidate cached metadata (call after fields change) */
  _invalidateCache() {
    this._idFieldIndex = -2;
    this._requiredFlags = null;
    this._enumValues = null;
  }

  /** Precompute cached field metadata for fast record parsing */
  _ensureCache() {
    if (this._idFieldIndex !== -2) return;
    const len = this.fields.length;

    // id field index
    this._idFieldIndex = -1;
    for (let i = 0; i < len; i++) {
      const f = this.fields[i];
      if (f.constraints?.some(c => c.type === 'id')) { this._idFieldIndex = i; break; }
    }
    if (this._idFieldIndex === -1) {
      for (let i = 0; i < len; i++) {
        if (this.fields[i].name === 'id') { this._idFieldIndex = i; break; }
      }
    }

    // required flags
    this._requiredFlags = new Array(len);
    for (let i = 0; i < len; i++) {
      this._requiredFlags[i] = this.fields[i].constraints?.some(c => c.type === 'required') ?? false;
    }

    // enum values cache
    this._enumValues = new Array(len);
    this._hasRuntimeConstraints = false;
    for (let i = 0; i < len; i++) {
      const f = this.fields[i];
      const te = f.typeExpr;
      if (te && te.startsWith('enum')) {
        const m = te.match(/^enum(?:<\w+>)?\[([^\]]*)\]$/);
        this._enumValues[i] = m ? m[1].split(',').map(v => v.trim()).filter(Boolean) : null;
      } else {
        this._enumValues[i] = null;
      }
      // Check for runtime constraints (comparison, pattern, exact-length)
      if (f.constraints) {
        for (const c of f.constraints) {
          if (c.type === 'comparison' || c.type === 'pattern' || c.type === 'exact-length') {
            this._hasRuntimeConstraints = true;
          }
        }
      }
    }
  }

  /** @returns {MaxiFieldDef | null} */
  getIdField() {
    this._ensureCache();
    return this._idFieldIndex >= 0 ? this.fields[this._idFieldIndex] : null;
  }

  /** @returns {string | null} Name of the identifier field */
  get identifierField() {
    return this.getIdField()?.name ?? null;
  }
}

/**
 * @typedef {Object} ParsedConstraint
 * @property {'required'|'id'|'comparison'|'pattern'|'mime'|'decimal-precision'|'exact-length'} type
 * @property {any} [value]
 */

export class MaxiFieldDef {
  /**
   * @param {{name: string, typeExpr?: string|null, annotation?: string|null, constraints?: ParsedConstraint[]|null, elementConstraints?: ParsedConstraint[]|null, defaultValue?: unknown}} args
   */
  constructor({ name, typeExpr = null, annotation = null, constraints = null, elementConstraints = null, defaultValue = undefined }) {
    this.name = name;
    this.typeExpr = typeExpr;
    this.annotation = annotation;
    this.constraints = constraints;
    this.elementConstraints = elementConstraints;
    this.defaultValue = defaultValue;
  }

  /** @returns {boolean} */
  isRequired() { return this.constraints?.some(c => c.type === 'required') ?? false; }

  /** @returns {boolean} */
  isId() { return this.constraints?.some(c => c.type === 'id') ?? false; }

  /** @returns {string[] | null} Parsed enum values if this field is an enum type */
  get enumValues() {
    if (!this.typeExpr?.startsWith('enum')) return null;
    const m = this.typeExpr.match(/^enum(?:<\w+>)?\[([^\]]*)\]$/);
    if (!m) return null;
    return m[1].split(',').map(v => {
      const t = v.trim();
      if (t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1);
      return t;
    }).filter(Boolean);
  }
}

export class MaxiRecord {
  /**
   * @param {{alias: string, values?: unknown[], lineNumber?: number}} args
   */
  constructor({ alias, values = [], lineNumber = null }) {
    this.alias = alias;
    this.values = values;
    this.lineNumber = lineNumber;
  }
}

export class MaxiParseResult {
  constructor() {
    /** @type {MaxiSchema} */
    this.schema = new MaxiSchema();
    /** @type {MaxiRecord[]} */
    this.records = [];
    /** @type {Array<{message: string, code?: string, line?: number, column?: number}>} */
    this.warnings = [];
  }

  /**
   * @param {string} message
   * @param {{code?: string, line?: number, column?: number}} [meta]
   */
  addWarning(message, meta = {}) {
    this.warnings.push({ message, ...meta });
  }
}
