/**
 * Core MAXI type definitions (IR - Intermediate Representation).
 */

/**
 * @typedef {'strict'|'lax'} MaxiMode
 */

/**
 * MAXI schema containing type definitions and directives.
 */
export class MaxiSchema {
  constructor() {
    /** @type {string} */
    this.version = '1.0.0';
    /** @type {MaxiMode} */
    this.mode = 'lax';
    /** @type {string[]} Schema imports (@schema directives) */
    this.imports = [];
    /** @type {Map<string, MaxiTypeDef>} alias -> typedef */
    this.types = new Map();
  }

  /**
   * Add or update a type definition.
   * @param {MaxiTypeDef} typeDef
   */
  addType(typeDef) {
    this.types.set(typeDef.alias, typeDef);
  }

  /**
   * Get type by alias.
   * @param {string} alias
   * @returns {MaxiTypeDef | undefined}
   */
  getType(alias) {
    return this.types.get(alias);
  }

  /**
   * Check if type exists.
   * @param {string} alias
   * @returns {boolean}
   */
  hasType(alias) {
    return this.types.has(alias);
  }
}

/**
 * Type definition with inheritance support.
 */
export class MaxiTypeDef {
  /**
   * @param {{alias: string, name?: string|null, parents?: string[], fields?: MaxiFieldDef[]}} args
   */
  constructor({ alias, name = null, parents = [], fields = [] }) {
    /** @type {string} Short alias (e.g., "U") */
    this.alias = alias;
    /** @type {string|null} Full type name (e.g., "User"), optional */
    this.name = name;
    /** @type {string[]} Parent type aliases for inheritance */
    this.parents = parents;
    /** @type {MaxiFieldDef[]} Field definitions (after inheritance resolution) */
    this.fields = fields;
    /** @type {boolean} Whether inheritance has been resolved */
    this._inheritanceResolved = false;
  }

  /**
   * Add a field to this type.
   * @param {MaxiFieldDef} field
   */
  addField(field) {
    this.fields.push(field);
  }

  /**
   * Get field by name.
   * @param {string} name
   * @returns {MaxiFieldDef | undefined}
   */
  getField(name) {
    return this.fields.find(f => f.name === name);
  }

  /**
   * Get identifier field (marked with 'id' constraint or named 'id').
   * @returns {MaxiFieldDef | null}
   */
  getIdField() {
    // First check for explicit 'id' constraint
    const explicitId = this.fields.find(f =>
      f.constraints?.some(c => c.type === 'id')
    );
    if (explicitId) return explicitId;

    // Fall back to field named 'id'
    return this.fields.find(f => f.name === 'id') ?? null;
  }
}

/**
 * Parsed constraint representation.
 * @typedef {Object} ParsedConstraint
 * @property {'required'|'id'|'comparison'|'pattern'|'mime'|'decimal-precision'|'exact-length'} type
 * @property {any} [value] Constraint value (depends on type)
 */

/**
 * Field definition with type and constraint information.
 */
export class MaxiFieldDef {
  /**
   * @param {{name: string, typeExpr?: string|null, annotation?: string|null, constraints?: ParsedConstraint[]|null, defaultValue?: unknown}} args
   */
  constructor({ name, typeExpr = null, annotation = null, constraints = null, defaultValue = undefined }) {
    /** @type {string} Field name */
    this.name = name;
    /** @type {string|null} Raw type expression (e.g., "int", "str[]", "User") */
    this.typeExpr = typeExpr;
    /** @type {string|null} Type annotation (e.g., "email", "datetime") */
    this.annotation = annotation;
    /** @type {ParsedConstraint[]|null} Parsed constraints */
    this.constraints = constraints;
    /** @type {unknown} Default value (parsed and coerced) */
    this.defaultValue = defaultValue;
  }

  /**
   * Check if field is required (has '!' constraint).
   * @returns {boolean}
   */
  isRequired() {
    return this.constraints?.some(c => c.type === 'required') ?? false;
  }

  /**
   * Check if field is an identifier (has 'id' constraint or name is 'id').
   * @returns {boolean}
   */
  isId() {
    return this.constraints?.some(c => c.type === 'id') ?? this.name === 'id';
  }

  /**
   * Get base type (without array/map wrappers).
   * @returns {string}
   */
  getBaseType() {
    if (!this.typeExpr) return 'str';
    // Remove array suffix
    const noArray = this.typeExpr.replace(/\[\]$/, '');
    // Remove map prefix
    const noMap = noArray.replace(/^map(<.*>)?$/, 'str');
    return noMap || 'str';
  }
}

/**
 * Data record instance.
 */
export class MaxiRecord {
  /**
   * @param {{alias: string, values?: unknown[], lineNumber?: number}} args
   */
  constructor({ alias, values = [], lineNumber = null }) {
    /** @type {string} Type alias */
    this.alias = alias;
    /** @type {unknown[]} Field values (positional) */
    this.values = values;
    /** @type {number|null} Source line number for debugging */
    this.lineNumber = lineNumber;
  }

  /**
   * Get value by field index.
   * @param {number} index
   * @returns {unknown}
   */
  getValue(index) {
    return this.values[index];
  }

  /**
   * Get identifier value (first field by convention, or explicit id field).
   * @returns {unknown}
   */
  getId() {
    return this.values[0];
  }
}

/**
 * Parse result containing schema and data records.
 */
export class MaxiParseResult {
  constructor() {
    /** @type {MaxiSchema} */
    this.schema = new MaxiSchema();
    /** @type {MaxiRecord[]} Data records */
    this.records = [];
    /** @type {Array<{message: string, code?: string, line?: number, column?: number}>} */
    this.warnings = [];
  }

  /**
   * Add a warning.
   * @param {string} message
   * @param {{code?: string, line?: number, column?: number}} [meta]
   */
  addWarning(message, meta = {}) {
    this.warnings.push({ message, ...meta });
  }
}
