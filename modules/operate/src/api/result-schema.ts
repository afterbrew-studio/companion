import type { ZodType } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

/**
 * A caller's answer shape, as the wire format a harness can enforce.
 *
 * Callers already validate with zod (`verdictSchema.parse(extractModelJson(...))`),
 * so the shape exists; what did not exist was a way to send it to the model.
 * Deriving it here keeps ONE source of truth: a schema and a hand-written copy
 * of it would disagree on the first field somebody adds, and the copy is the one
 * the model would follow.
 *
 * A harness that cannot enforce a schema ignores it and the caller parses the
 * final message exactly as before, so passing one is never a behaviour change
 * on its own.
 */
export function resultSchemaOf(schema: ZodType<unknown>): unknown {
  return zodToJsonSchema(schema, {
    // Inlined rather than $ref'd into a definitions block: providers vary in
    // how much of JSON Schema they accept, and a self-referential document is
    // the first thing they refuse.
    $refStrategy: 'none',
    target: 'jsonSchema7',
  });
}
