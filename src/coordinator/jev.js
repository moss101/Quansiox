'use strict';
/**
 * TypeSafe Jev judgments for the agent loop.
 * Pinned model jev-1.13.0. One POST /v1/systemone carries every question
 * that shares the turn state: a Choice (route), a Noul (mutation gate),
 * and a Score (subagent summary vs parent task).
 * Jev is not asked to write chat text. The API key is read from the
 * environment in this process and is never sent to the renderer.
 * With no key, judgeTurn returns { skipped: true } and the caller keeps
 * the ordinary chat-completions loop.
 */

const JEV_MODEL = 'jev-1.13.0';
const DEFAULT_ENDPOINT = 'https://api.typesafe.ai';

/** Destructive routes (files/shell writes, computer control) need this Choice confidence. */
const DESTRUCTIVE_CONFIDENCE = 0.62;
/** Noul must reach this before computer control or file mutation is enabled. */
const MUTATION_NOUL_MIN = 0.75;
/** Score levels are 0..4. Below 2 the summary does not accomplish the task. */
const LOW_SCORE_BELOW = 2;

const DESTRUCTIVE_ROUTES = new Set(['files_shell', 'computer']);

function turnQuestions() {
  return {
    route: {
      type: 'choice',
      instructions: {
        question: 'Which handler should run this user turn?',
        focus: 'Pick the single best next handler. Do not write the reply.',
      },
      criteria: {
        direct: 'Answer in text. No files, shell, computer, browser, or subagents.',
        files_shell: 'Read or write workspace files, or run shell in the workspace.',
        computer: 'Observe or drive the desktop GUI (screenshot, click, type, keys).',
        browser: 'Open or drive a web page in the Electron browser inside the agent computer. Not Safari.',
        subagent: 'Fan out to one or more subagents with their own prompts.',
      },
    },
    allow_mutation: {
      type: 'noul',
      instructions: 'Should this turn be allowed to mutate files or drive the computer?',
      criteria: {
        true: 'The user explicitly wants a change on disk or on the desktop.',
        false: 'The user wants an answer, a review, or anything that must not change the machine.',
      },
    },
    subagent_fit: {
      type: 'score',
      instructions: {
        question: 'How well does `subagent_summary` accomplish `parent_task`?',
        when_empty: 'If `subagent_summary` is empty, judge it as not accomplishing the task.',
      },
      criteria: [
        'The summary misses the parent task.',
        'The summary mentions the task but does not accomplish it.',
        'The summary partially accomplishes the parent task.',
        'The summary accomplishes the parent task with only minor gaps.',
        'The summary fully accomplishes the parent task.',
      ],
    },
  };
}

function buildRequest(state) {
  return {
    state: {
      user_message: String(state?.userMessage ?? ''),
      parent_task: String(state?.parentTask ?? ''),
      subagent_summary: String(state?.subagentSummary ?? ''),
    },
    model: JEV_MODEL,
    questions: turnQuestions(),
  };
}

/**
 * Compose fixture or live answers. Code owns the thresholds.
 * A destructive Choice below DESTRUCTIVE_CONFIDENCE is not taken.
 * Computer and file mutation stay off unless the Noul clears MUTATION_NOUL_MIN.
 * A Score below LOW_SCORE_BELOW is a low score, and only when a summary is present.
 */
function composeJudgments(answers, { summaryPresent = false } = {}) {
  const routeAnswer = answers?.route || {};
  const noulAnswer = answers?.allow_mutation || {};
  const scoreAnswer = answers?.subagent_fit || {};
  const rawChoice = routeAnswer.choice;
  const confidence = Number(routeAnswer.confidence);
  const noul = Number(noulAnswer.noul);
  const score = Number(scoreAnswer.score);
  let route = rawChoice;
  let blockedDestructive = false;
  if (DESTRUCTIVE_ROUTES.has(rawChoice) && !(confidence >= DESTRUCTIVE_CONFIDENCE)) {
    route = 'direct';
    blockedDestructive = true;
  }
  const mutationAllowed = noul >= MUTATION_NOUL_MIN;
  if (!mutationAllowed && (route === 'files_shell' || route === 'computer')) {
    route = 'direct';
    blockedDestructive = true;
  }
  const enableComputer = route === 'computer' && mutationAllowed;
  const enableFileMutation = route === 'files_shell' && mutationAllowed;
  const enableBrowser = route === 'browser';
  const fanOut = route === 'subagent';
  const lowScore = summaryPresent && !(score >= LOW_SCORE_BELOW);
  return {
    rawChoice,
    confidence,
    noul,
    route,
    blockedDestructive,
    mutationAllowed,
    enableComputer,
    enableFileMutation,
    enableBrowser,
    fanOut,
    score,
    scoreConfidence: Number(scoreAnswer.confidence),
    lowScore,
    success: summaryPresent ? !lowScore : null,
  };
}

async function postSystemOne(state, opts = {}) {
  const apiKey = opts.apiKey ?? process.env.TYPESAFE_API_KEY;
  if (!apiKey) return { skipped: true };
  const endpoint = (opts.endpoint || process.env.TYPESAFE_API_BASE || DEFAULT_ENDPOINT).replace(/\/$/, '');
  const body = buildRequest(state);
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const res = await fetchImpl(`${endpoint}/v1/systemone`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`typesafe ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  return { skipped: false, data, request: body };
}

/**
 * One request, three questions, then code composition.
 * No key → { skipped: true, permissive: true } and no network call.
 */
async function judgeTurn(state, opts = {}) {
  const apiKey = opts.apiKey ?? process.env.TYPESAFE_API_KEY;
  if (!apiKey) return { skipped: true, permissive: true };
  const posted = await postSystemOne(state, { ...opts, apiKey });
  const summaryPresent = Boolean(state?.subagentSummary && String(state.subagentSummary).trim());
  const composed = composeJudgments(posted.data?.answers, { summaryPresent });
  return {
    skipped: false,
    permissive: false,
    model: posted.data?.model || null,
    ...composed,
  };
}

module.exports = {
  JEV_MODEL,
  DEFAULT_ENDPOINT,
  DESTRUCTIVE_CONFIDENCE,
  MUTATION_NOUL_MIN,
  LOW_SCORE_BELOW,
  turnQuestions,
  buildRequest,
  composeJudgments,
  postSystemOne,
  judgeTurn,
};
