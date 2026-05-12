/** Appendix B error codes from MAXI spec. */
export const MaxiErrorCode = Object.freeze({
  // E1xx — Schema definition errors
  InvalidSyntaxError: 'E101',
  DuplicateTypeError: 'E102',
  UnknownDirectiveError: 'E103',
  // E2xx — Type system errors
  UnknownTypeError: 'E201',
  UndefinedParentError: 'E202',
  CircularInheritanceError: 'E203',
  UnresolvedReferenceError: 'E204',
  DuplicateIdentifierError: 'E205',
  // E3xx — Constraint errors
  ConstraintSyntaxError: 'E301',
  InvalidConstraintValueError: 'E302',
  ConstraintViolationError: 'E303',
  ArraySyntaxError: 'E304',
  // E4xx — Data record errors
  SchemaMismatchError: 'E401',
  TypeMismatchError: 'E402',
  MissingRequiredFieldError: 'E403',
  InvalidDefaultValueError: 'E404',
  UnsupportedBinaryFormatError: 'E405',
  // E5xx — Data type errors
  EnumAliasError: 'E501',
  // E6xx — IO / runtime errors
  UnsupportedVersionError: 'E601',
  SchemaLoadError: 'E602',
  StreamError: 'E603',
});

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

  toString() {
    const loc = this.line ? ` at line ${this.line}${this.column ? `, column ${this.column}` : ''}` : '';
    const file = this.filename ? ` in ${this.filename}` : '';
    return `${this.name} [${this.code}]${file}${loc}: ${this.message}`;
  }
}
