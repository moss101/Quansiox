'use strict';
/**
 * Error taxonomy — one classification for every error that can reach a user.
 *
 * The reference implementation distinguishes eleven transport outcomes
 * (`ok, refused, timeout, http_5xx, dns, no_storage, access_denied,
 * box_blocked, network, pod_hibernated`) and treats "non-retryable" and
 * "pre-dispatch retryable" as explicit sets. A free-text error string cannot
 * carry that: nothing can act on "something went wrong".
 *
 * So every error in the app gets a **code** from this table, and the code
 * decides what happens next: retry, ask the user, give up, or report.
 *
 * Pure module — no Electron, no I/O.
 */

/** The transport / outcome classification. */
const CODE = {
  OK: 'ok',
  /** The peer understood and said no (a policy refusal, a declined approval). */
  REFUSED: 'refused',
  /** A deadline expired. */
  TIMEOUT: 'timeout',
  /** The peer failed with a 5xx. */
  HTTP_5XX: 'http_5xx',
  /** A 4xx that is not a retryable one. */
  HTTP_4XX: 'http_4xx',
  /** Name resolution failed. */
  DNS: 'dns',
  /** The peer could not be reached at all. */
  NETWORK: 'network',
  /** The peer refused the connection. */
  CONNECTION_REFUSED: 'connection_refused',
  /** There is no room, no quota, or no disk. */
  NO_STORAGE: 'no_storage',
  /** The OS or the sandbox denied the operation. */
  ACCESS_DENIED: 'access_denied',
  /** The resource is blocked by policy (a blocked domain, a blocked tool). */
  BLOCKED: 'blocked',
  /** The thing asked for does not exist. */
  NOT_FOUND: 'not_found',
  /** The thing asked for is not in a state that allows the operation. */
  INVALID_STATE: 'invalid_state',
  /** The user declined. */
  USER_DECLINED: 'user-declined',
  /** The operation was cancelled. */
  CANCELLED: 'cancelled',
  /** A local-first feature that this install does not provide. */
  UNAVAILABLE: 'unavailable',
  /** A bug in the app. */
  INTERNAL: 'internal',
};

/** Codes that are worth retrying. */
const RETRYABLE = new Set([CODE.TIMEOUT, CODE.HTTP_5XX, CODE.NETWORK, CODE.CONNECTION_REFUSED, CODE.DNS]);

/** Codes that are worth retrying only before the request was dispatched. */
const PRE_DISPATCH_RETRYABLE = new Set([CODE.NETWORK, CODE.CONNECTION_REFUSED, CODE.DNS]);

/** Codes that mean "ask the user", not "try again". */
const NEEDS_USER = new Set([
  CODE.REFUSED, CODE.USER_DECLINED, CODE.ACCESS_DENIED, CODE.BLOCKED, CODE.NO_STORAGE,
]);

/** Codes that mean "this will never work here". */
const FATAL = new Set([CODE.UNAVAILABLE, CODE.NOT_FOUND, CODE.INVALID_STATE]);

/**
 * A classified error.
 */
class ClassifiedError extends Error {
  constructor(code, message, detail = {}) {
    super(message || code);
    this.name = 'ClassifiedError';
    this.code = code;
    this.detail = detail;
    this.classified = true;
  }

  get retryable() { return RETRYABLE.has(this.code); }
  get preDispatchRetryable() { return PRE_DISPATCH_RETRYABLE.has(this.code); }
  get needsUser() { return NEEDS_USER.has(this.code); }
  get fatal() { return FATAL.has(this.code); }
}

/**
 * Classify an arbitrary thrown value.
 *
 * @param {*} error
 * @param {object} [context] extra detail to attach
 * @returns {{ code: string, message: string, retryable: boolean, preDispatchRetryable: boolean, needsUser: boolean, fatal: boolean, detail: object }}
 */
function classify(error, context = {}) {
  if (error && error.classified) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      preDispatchRetryable: error.preDispatchRetryable,
      needsUser: error.needsUser,
      fatal: error.fatal,
      detail: { ...error.detail, ...context },
    };
  }
  const code = codeOf(error);
  const message = String(error?.message ?? error ?? 'unknown error');
  return {
    code,
    message,
    retryable: RETRYABLE.has(code),
    preDispatchRetryable: PRE_DISPATCH_RETRYABLE.has(code),
    needsUser: NEEDS_USER.has(code),
    fatal: FATAL.has(code),
    detail: { ...(error?.detail ?? {}), ...context },
  };
}

/** The code for a thrown value, judged from the shapes we actually see. */
function codeOf(error) {
  if (!error) return CODE.INTERNAL;
  if (error.code === 'DEADLINE_EXCEEDED' || error.code === 'ETIMEDOUT') return CODE.TIMEOUT;
  if (error.code === 'ECONNREFUSED') return CODE.CONNECTION_REFUSED;
  if (error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN') return CODE.DNS;
  if (error.code === 'ENETUNREACH' || error.code === 'EHOSTUNREACH' || error.code === 'EHOSTDOWN') return CODE.NETWORK;
  if (error.code === 'ENOSPC' || error.code === 'EDQUOT') return CODE.NO_STORAGE;
  if (error.code === 'EACCES' || error.code === 'EPERM') return CODE.ACCESS_DENIED;
  if (error.code === 'ENOENT') return CODE.NOT_FOUND;
  if (error.code === 'ABORT_ERR' || error.name === 'AbortError') return CODE.CANCELLED;
  if (error.name === 'ClassifiedError' && error.code) return error.code;

  const status = Number(error?.status ?? error?.response?.status ?? 0);
  if (status >= 500) return CODE.HTTP_5XX;
  if (status === 429 || status === 408) return CODE.TIMEOUT;
  if (status >= 400) return CODE.HTTP_4XX;
  if (error?.name === 'TimeoutError' || /timed? ?out/i.test(String(error?.message ?? ''))) return CODE.TIMEOUT;
  return CODE.INTERNAL;
}

/** Classify and throw. */
function throwClassified(code, message, detail) {
  throw new ClassifiedError(code, message, detail);
}

/**
 * The `shouldRetry` predicate for the retry policy: retry only what the
 * taxonomy says is retryable.
 */
function shouldRetry(error) {
  return classify(error).retryable;
}

module.exports = {
  CODE,
  ClassifiedError,
  FATAL,
  NEEDS_USER,
  PRE_DISPATCH_RETRYABLE,
  RETRYABLE,
  classify,
  codeOf,
  shouldRetry,
  throwClassified,
};
