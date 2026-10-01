class ValidationError extends Error {
  constructor(message, field) {
    super(message);
    this.field = field;
  }
}

function handleRequest(payload) {
  if (!payload || typeof payload.name !== 'string' || payload.name.length === 0) {
    throw new ValidationError('name is required', 'name');
  }
  if (payload.trigger === 'boom') {
    throw new TypeError('unexpected internal failure');
  }
  return { status: 200, body: { ok: true } };
}

function handle(payload) {
  try {
    return handleRequest(payload);
  } catch (e) {
    if (e instanceof ValidationError) {
      return { status: 400, body: { error: e.message, field: e.field } };
    }
    return { status: 500, body: { error: e.message } };
  }
}

module.exports = { handle };
