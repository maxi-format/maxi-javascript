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
  }

  /** @param {MaxiFieldDef} field */
  addField(field) { this.fields.push(field); }


  /** @returns {MaxiFieldDef | null} */
  getIdField() {
    const explicitId = this.fields.find(f => f.constraints?.some(c => c.type === 'id'));
    if (explicitId) return explicitId;
    return this.fields.find(f => f.name === 'id') ?? null;
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
