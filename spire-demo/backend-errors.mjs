export const JEV_BACKEND_FAILURE = 'JEV_BACKEND_FAILURE';

export function jevBackendFailure(message, cause) {
  const error = new Error(`${JEV_BACKEND_FAILURE}: ${message}`);
  error.code = JEV_BACKEND_FAILURE;
  if (cause !== undefined) error.cause = cause;
  return error;
}
