/**
 * The bounded contexts.
 *
 * The map itself lives in `src/shared/contexts.js` so the main process can
 * read it too; this module is the renderer's view of it.
 */
export { CONTEXTS, contextById, contextsUsing, describe } from '../../shared/contexts.js';
