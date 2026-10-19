/** Validated Todo fields. */
export interface TodoInput {
  readonly title: string;
  readonly completed?: boolean;
}

/** Result of {@link validateTodoInput}. */
export type ValidationResult = { ok: true; value: TodoInput } | { ok: false; message: string };

const MAX_TITLE_LENGTH = 200;

/**
 * Validate a Todo request body.
 *
 * API Gateway request validators are gone in this pattern, so the application
 * owns input validation. Kept dependency-free on purpose; swap in zod/ajv for
 * larger schemas.
 */
export function validateTodoInput(body: unknown, opts: { requireTitle: boolean }): ValidationResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, message: 'Request body must be a JSON object' };
  }
  const { title, completed } = body as Record<string, unknown>;

  if (title === undefined) {
    if (opts.requireTitle) {
      return { ok: false, message: 'title is required' };
    }
  } else if (typeof title !== 'string' || title.trim().length === 0 || title.length > MAX_TITLE_LENGTH) {
    return { ok: false, message: `title must be a non-empty string of at most ${MAX_TITLE_LENGTH} characters` };
  }

  if (completed !== undefined && typeof completed !== 'boolean') {
    return { ok: false, message: 'completed must be a boolean' };
  }

  return { ok: true, value: { title: (title as string | undefined) ?? '', completed: completed as boolean | undefined } };
}
