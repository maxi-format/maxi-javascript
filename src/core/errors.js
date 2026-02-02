/** Appendix B error codes from MAXI spec. */
export const MaxiErrorCode = Object.freeze({
  UnsupportedVersionError: 'E001',
  DuplicateTypeError: 'E002',
  UnknownTypeError: 'E003',
  UnknownDirectiveError: 'E004',
  InvalidSyntaxError: 'E005',
  SchemaMismatchError: 'E006',
  TypeMismatchError: 'E007',
  ConstraintViolationError: 'E008',
  UnresolvedReferenceError: 'E009',
  CircularInheritanceError: 'E010',
  MissingRequiredFieldError: 'E011',
  InvalidConstraintValueError: 'E012',
  UndefinedParentError: 'E013',
  ConstraintSyntaxError: 'E014',
  ArraySyntaxError: 'E015',
  DuplicateIdentifierError: 'E016',
  UnsupportedBinaryFormatError: 'E017',
  InvalidDefaultValueError: 'E018',
  StreamError: 'E019',
  SchemaLoadError: 'E020',
});

/**
 * MAXI error with line/column tracking.
 * @extends {Error}
 */
export class MaxiError extends Error {
  /**
   * @param {string} message
   * @param {keyof typeof MaxiErrorCode | string} code
   * @param {{line?: number, column?: number, filename?: string, cause?: unknown}} [meta]
   */
  constructor(message, code, meta = {}) {
    super(message);
    this.name = 'MaxiError';
    this.code = code;
    this.line = meta.line ?? null;
    this.column = meta.column ?? null;
    this.filename = meta.filename ?? null;
    if (meta.cause !== undefined) this.cause = meta.cause;
  }

  /**
   * Format error with location info for display.
   * @returns {string}
   */
  toString() {
    const loc = this.line ? ` at line ${this.line}${this.column ? `, column ${this.column}` : ''}` : '';
    const file = this.filename ? ` in ${this.filename}` : '';
    return `${this.name} [${this.code}]${file}${loc}: ${this.message}`;
  }
}

