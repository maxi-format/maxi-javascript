export { parseMaxi } from './api/parse.js';
export { dumpMaxi } from './api/dump.js';
export { streamMaxi, MaxiStreamResult } from './api/stream.js';
export { MaxiError, MaxiErrorCode } from './core/errors.js';
export {
  MaxiSchema,
  MaxiTypeDef,
  MaxiFieldDef,
  MaxiRecord,
  MaxiParseResult
} from './core/types.js';

/**
 * @typedef {import('./core/types.js').MaxiMode} MaxiMode
 * @typedef {import('./api/parse.js').MaxiParseOptions} MaxiParseOptions
 * @typedef {import('./api/dump.js').MaxiDumpOptions} MaxiDumpOptions
 */
