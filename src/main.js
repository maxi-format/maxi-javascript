export { parseMaxi } from './api/parse.js';
export { dumpMaxi } from './api/dump.js';
export { dumpMaxiAuto } from './api/auto-dump.js';
export { parseMaxiAs, parseMaxiAutoAs } from './api/hydrate.js';
export { streamMaxi, MaxiStreamResult } from './api/stream.js';
export { MaxiError, MaxiErrorCode } from './core/errors.js';
export {
  MaxiSchema,
  MaxiTypeDef,
  MaxiFieldDef,
  MaxiRecord,
  MaxiParseResult
} from './core/types.js';
export { defineMaxiSchema, getMaxiSchema, undefineMaxiSchema } from './core/schema-registry.js';

/**
 * @typedef {import('./core/types.js').MaxiMode} MaxiMode
 * @typedef {import('./api/parse.js').MaxiParseOptions} MaxiParseOptions
 * @typedef {import('./api/dump.js').MaxiDumpOptions} MaxiDumpOptions
 * @typedef {import('./api/dump.js').MaxiDumpTypeInput} MaxiDumpTypeInput
 */
