import Ajv from 'ajv';
import type { ValidateFunction } from 'ajv';

// Catalog and GUI host tool schemas use JSON Schema draft-07. Compile trusted
// definitions once and validate model-supplied arguments without coercion or
// default insertion. Unknown keywords fail at compilation instead of being
// silently advertised but ignored.
const ajv = new Ajv({
  allErrors: true,
  strictSchema: true,
  strictTypes: false,
  strictRequired: false,
  strictTuples: false,
  allowUnionTypes: true,
  ownProperties: true
});
const validators = new WeakMap<object, ValidateFunction>();

export function assertToolArguments(
  schema: Record<string, unknown>,
  value: unknown,
  toolName: string
): void {
  let validate = validators.get(schema);
  if (!validate) {
    try {
      validate = ajv.compile(schema);
    } catch (error) {
      throw new Error(`Invalid schema for ${toolName}: ${error instanceof Error ? error.message : String(error)}`);
    }
    validators.set(schema, validate);
  }
  if (!validate(value)) {
    const details = ajv.errorsText((validate.errors ?? []).slice(0, 8), {
      dataVar: 'params',
      separator: '; '
    });
    throw new Error(`Invalid parameters for ${toolName}: ${details}`);
  }
}
