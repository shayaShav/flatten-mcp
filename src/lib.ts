// Library entry point for in-code use of flatten-mcp.
//
//   import { flattenMessages, unflattenMessages } from 'flatten-mcp'
//
// Re-exports ONLY from ./core.js. It must never import ./index.ts — index.ts
// runs `await server.connect()` at the top level with no main-guard, so pulling
// it in here would boot a stdio server and hang the importing process.

export type {
    ApiMessage,
    ContentBlock,
    FlattenKind,
    FlattenMessagesOptions,
    ExtractedEntry,
    FlattenMessagesResult,
    MessagesRequestBody,
    FlattenRequestBodyResult,
} from './core.js';

export {
    flattenMessages,
    flattenMessagesExact,
    unflattenMessages,
    flattenRequestBody,
    flattenRequestBodyExact,
    unflattenRequestBody,
} from './core.js';
