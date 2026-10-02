/**
 * ResolveAI's global configuration: the one file to read, or change, to see how the whole application is set up.
 *
 * - Environment variables: every setting is read here, by `loadConfig` (MCP server), `loadSimConfig` (simulator backend)
 *   and the small helpers below. Nothing else in the repo reads a setting from `process.env`.
 * - Settings: ports, hosts, limits, timeouts, model names, file locations and tuning values.
 * - Language: the word lists, patterns and canned replies the agent reads and writes with.
 *
 * It holds plain values and functions with no Node imports, so the browser views can import it as well.
 */

export type Env = Record<string, string | undefined>;

// Where things live -----------------------------------------------------------------------------------------------

/** Paths below are relative to the repository root. */
export const DB_FILE = 'data/resolveai.db';
export const CORPUS_DIR = 'corpus';
export const TICKET_CARD_HTML = 'packages/server/dist/ui/ticket-card.html';

/** The repository root, with a trailing slash, whether this file runs from source or from the server build. */
export function repoRoot(): string {
  const here = decodeURIComponent(new URL('.', /* @vite-ignore */ import.meta.url).pathname);
  return here.replace(/packages\/server\/dist\/$/, '');
}

export const repoPath = (path: string): string => `${repoRoot()}${path}`;

// Network ---------------------------------------------------------------------------------------------------------

export const LOCAL_HOST = '127.0.0.1';
export const LOCAL_HOSTNAMES = ['localhost', LOCAL_HOST, '[::1]'];
export const PORTS = { mcp: 3000, simulator: 3200, web: 5173, sandbox: 5174 } as const;
export const DEFAULT_MCP_URL = `http://${LOCAL_HOST}:${PORTS.mcp}/mcp`;
export const DEFAULT_SIM_BACKEND_URL = `http://${LOCAL_HOST}:${PORTS.simulator}`;
/** Both spellings of the local address, since a browser treats them as different origins. */
export const DEFAULT_WEB_ORIGINS = [`http://localhost:${PORTS.web}`, `http://${LOCAL_HOST}:${PORTS.web}`];

// Demo accounts ---------------------------------------------------------------------------------------------------

/** Demo-only tokens: they exist only on this machine and unlock only the fictional demo accounts in corpus/demo.json. */
export const DEMO_TOKENS = { alex: 'demo-token-alex', raj: 'demo-token-raj', nate: 'demo-token-nate' } as const;

/** The demo users from corpus/demo.json. The MCP token for each comes from configuration, never from the browser. */
export const PERSONAS: { id: string; name: string; note: string }[] = [
  { id: 'alex', name: 'Alex', note: 'Owns one machine: "my coffee machine" needs no question.' },
  { id: 'raj', name: 'Raj', note: 'Owns two machines, one out of warranty: "my coffee machine" needs a question.' },
  { id: 'nate', name: 'Nate', note: 'Owns a Google Pixel 9 phone.' },
];

// Helpers for reading the environment -----------------------------------------------------------------------------

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

const positiveInt = (value: string | undefined, fallback: number, name: string): number => {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive whole number`);
  return parsed;
};

/** `a:b,c:d` pairs, as in MCP_USER_TOKENS ("token:user-id") and SIM_PERSONAS ("persona:token"). */
function pairs(value: string | undefined, name: string, shape: string): [string, string][] {
  return list(value).map((entry) => {
    const split = entry.indexOf(':');
    const left = entry.slice(0, split).trim();
    const right = entry.slice(split + 1).trim();
    if (split < 1 || !right) throw new Error(`${name} entry "${entry}" must look like ${shape}`);
    return [left, right];
  });
}

// MCP server (packages/server) ------------------------------------------------------------------------------------

export interface Config {
  host: string;
  port: number;
  /** Token with no user behind it. Optional when user tokens are set. */
  bearerToken?: string;
  /** Token to user id, from MCP_USER_TOKENS="token-a:demo-alex,token-b:demo-other". */
  userTokens: Record<string, string>;
  /** SQLite file built by `npm run ingest`. */
  dbPath: string;
  /** Must match the embedder used at ingestion. */
  embedder: 'transformers' | 'hash';
  /**
   * Cross-encoder reranking of the best search candidates: better first results at roughly 150 ms per search and a
   * second small model to download. `off` serves the fused order with the original confidence rules.
   */
  reranker: 'cross-encoder' | 'off';
  /** Hostnames (no port) accepted in the Host header. */
  allowedHosts: string[];
  /** Hostnames (no scheme or port) accepted in the Origin header. */
  allowedOrigins: string[];
}

/** The SQLite index location: RESOLVEAI_DB, else the default under the repository root. */
export const resolveDbPath = (env: Env = process.env): string => env.RESOLVEAI_DB ?? repoPath(DB_FILE);

export function loadConfig(env: Env = process.env): Config {
  const bearerToken = env.MCP_BEARER_TOKEN || undefined;
  const userTokens: Record<string, string> = {};
  for (const [token, userId] of pairs(env.MCP_USER_TOKENS, 'MCP_USER_TOKENS', 'token:user-id')) {
    if (token in userTokens) throw new Error('MCP_USER_TOKENS contains the same token twice');
    userTokens[token] = userId;
  }
  if (!bearerToken && Object.keys(userTokens).length === 0) {
    throw new Error('Set MCP_USER_TOKENS (token:user-id pairs) or MCP_BEARER_TOKEN');
  }
  return {
    host: env.HOST ?? LOCAL_HOST,
    port: Number(env.PORT ?? PORTS.mcp),
    bearerToken,
    userTokens,
    dbPath: resolveDbPath(env),
    embedder: env.RESOLVEAI_EMBEDDER === 'hash' ? 'hash' : 'transformers',
    reranker: env.RESOLVEAI_RERANKER === 'off' ? 'off' : 'cross-encoder',
    allowedHosts: [...LOCAL_HOSTNAMES, ...list(env.ALLOWED_HOSTS)],
    allowedOrigins: [...LOCAL_HOSTNAMES, ...list(env.ALLOWED_ORIGINS)],
  };
}

// Simulator (packages/simulator) ----------------------------------------------------------------------------------

export interface SimConfig {
  host: string;
  port: number;
  /** Origins of the web app, the only ones allowed to call this backend from a browser. */
  webOrigins: string[];
  mcpUrl: string;
  /** Persona id to the bearer token that persona uses against the MCP server. */
  personaTokens: Record<string, string>;
  agent: {
    model: string;
    /** Thinking depth. Low keeps spoken replies quick. */
    effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    /** Ask the API to retry on another model if a safety classifier declines. */
    fallback: boolean;
    maxTokens: number;
    /** Most model calls in one turn before giving up. */
    maxRounds: number;
    /** Most user turns in one session, a guard on spend. */
    maxTurnsPerSession: number;
  };
}

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export function loadSimConfig(env: Env = process.env): SimConfig {
  const personaTokens: Record<string, string> = {};
  for (const [id, token] of pairs(env.SIM_PERSONAS, 'SIM_PERSONAS', 'persona:token')) {
    if (!PERSONAS.some((persona) => persona.id === id)) throw new Error(`SIM_PERSONAS names unknown persona "${id}"`);
    if (id in personaTokens) throw new Error(`SIM_PERSONAS lists "${id}" twice`);
    personaTokens[id] = token;
  }
  if (Object.keys(personaTokens).length === 0) {
    throw new Error('Set SIM_PERSONAS, for example alex:token-alex (the MCP_USER_TOKENS of the server)');
  }
  const effort = (env.RESOLVEAI_AGENT_EFFORT ?? 'low') as SimConfig['agent']['effort'];
  if (!EFFORTS.includes(effort)) throw new Error(`RESOLVEAI_AGENT_EFFORT must be one of ${EFFORTS.join(', ')}`);

  return {
    host: env.SIM_HOST ?? LOCAL_HOST,
    port: positiveInt(env.SIM_PORT, PORTS.simulator, 'SIM_PORT'),
    webOrigins: env.SIM_WEB_ORIGIN ? list(env.SIM_WEB_ORIGIN) : DEFAULT_WEB_ORIGINS,
    mcpUrl: env.SIM_MCP_URL ?? DEFAULT_MCP_URL,
    personaTokens,
    agent: {
      model: env.RESOLVEAI_AGENT_MODEL ?? 'claude-sonnet-5-5',
      effort,
      fallback: env.RESOLVEAI_AGENT_FALLBACK !== 'off',
      maxTokens: positiveInt(env.SIM_MAX_TOKENS, 8192, 'SIM_MAX_TOKENS'),
      maxRounds: positiveInt(env.SIM_MAX_ROUNDS, 8, 'SIM_MAX_ROUNDS'),
      maxTurnsPerSession: positiveInt(env.SIM_MAX_TURNS, 40, 'SIM_MAX_TURNS'),
    },
  };
}

/** Whether the simulator uses the offline mock agent (SIM_LLM=mock), and whether a Claude credential is set. */
export const loadLlmMode = (env: Env = process.env) => ({
  mock: env.SIM_LLM === 'mock',
  hasCredential: Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN),
});

/** Where the web dev server sends /api calls (SIM_BACKEND). */
export const simBackendUrl = (env: Env = process.env): string => env.SIM_BACKEND ?? DEFAULT_SIM_BACKEND_URL;

/** The port of the sandbox page for MCP App views (VITE_SANDBOX_PORT), which must differ from the web app's. */
export const sandboxPort = (env: Record<string, unknown> = process.env): number => Number(env.VITE_SANDBOX_PORT ?? PORTS.sandbox);

// Limits and timings not set from the environment ------------------------------------------------------------------

/** How many texts are embedded per batch, and the vector size of the embedding model. */
export const EMBEDDING_BATCH_SIZE = 16;
export const EMBEDDING_DIMS = 384;
/** Vector size of the offline hashing embedder. */
export const HASH_EMBEDDER_DIMS = 128;

/** The beta flag and mode the API needs to retry on another model when a safety classifier declines. */
export const LLM_FALLBACK_BETA = 'server-side-fallback-2026-07-01';
/** Token usage the mock agent reports for its input, so the trace looks like a real turn. */
export const MOCK_INPUT_TOKENS = 5200;

/** Server-sent events: how long a browser waits before reconnecting. */
export const SIM_SSE_RETRY_MS = 2000;
/** Session manager defaults: most sessions at once, idle time before one is closed, events kept for replay. */
export const SIM_MAX_SESSIONS = 20;
export const SIM_IDLE_MS = 30 * 60_000;
export const SIM_EVENT_LOG_LIMIT = 2000;

/** The demo launcher (npm run demo): how long to wait for a service to open its port, and how often to check. */
export const DEMO_PORT_TIMEOUT_MS = 120_000;
export const DEMO_PORT_POLL_MS = 500;

// Everything below was moved here from the module that used it ------------------------------------------------------

// MCP HTTP endpoint (packages/server/src/app.ts)
export const SERVER_MCP_PATH = '/mcp';
export const SERVER_MAX_BODY_BYTES = 4 * 1024 * 1024;
export const SERVER_ALLOWED_METHODS = ['POST', 'GET', 'DELETE'];

// Authentication (packages/server/src/auth.ts)
export const AUTH_USER_PREFIX = 'user:';

// Ticket card view (packages/server/src/ui/ticketCard.ts)
/** The ui:// resource that renders the result of create_support_case (an MCP App view). */
export const TICKET_CARD_URI = 'ui://resolveai/ticket-card.html';

// Case tools (packages/server/src/tools/caseAccess.ts)
export const NO_ACCOUNT =
  'Cases belong to a signed-in user and this connection has no account linked, so case tools are unavailable.';

// Product identification (packages/server/src/products/identify.ts)
/** Candidates this close to the best score are treated as equally likely. */
export const IDENTIFY_AMBIGUITY_MARGIN = 0.15;
/** Fuzzy word overlap never outranks a phrase match. */
export const IDENTIFY_FUZZY_CEILING = 0.6;
export const IDENTIFY_HIGH = 0.85;
export const IDENTIFY_MEDIUM = 0.4;
export const IDENTIFY_GENERIC_WORDS = new Set(['coffee', 'machine', 'maker', 'the', 'a', 'an', 'my', 'one', 'with', 'and', 'of', 'i', 'have', 'got', 'phone']);

// Embeddings (packages/server/src/ingest/embed.ts)
export const EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';

// Chunking (packages/server/src/ingest/chunk.ts)
export const CHUNK_PAGE_MARKER = /^<!--\s*page:\s*(\d+)\s*-->$/;
export const CHUNK_HEADING = /^(#{1,3})\s+(.+?)\s*$/;
export const CHUNK_SEPARATOR_CELL = /^:?-{2,}:?$/;

// Corpus (packages/server/src/ingest/corpus.ts)
export const DOC_TYPES = ['manual', 'troubleshooting', 'warranty'] as const;

// Retrieval presets (packages/server/src/retrieval/presets.ts)
/**
 * Reranker settings the shipped calibration model was fitted under (eval variant "rerank:keep=2,ctx=1"). The model's
 * signals only mean the same thing under the same settings, so these live in one place and a test ties them to the
 * model's recorded fit.
 */
export const RERANK_SETTINGS = { rerankTop: 10, rerankWeight: 1, rerankKeep: 2, rerankContext: true } as const;
export const RERANK_VARIANT = 'rerank:keep=2,ctx=1';

// Sufficiency (packages/server/src/retrieval/sufficiency.ts)
/**
 * Cosine thresholds are tuned for all-MiniLM-L6-v2 against the synthetic corpus.
 * Re-tune them (see test/retrieval.eval.test.ts) when the embedding model changes.
 */
export const DEFAULT_THRESHOLDS = {
  highCoverage: 0.75,
  highCosine: 0.3,
  mediumCoverage: 0.5,
  mediumCosine: 0.2,
};
/** Unknown terms at or above this share of the query lower the confidence by one level. */
export const UNKNOWN_DEMOTES_AT = 1 / 3;
/** Features for retrieval without a reranker. */
export const FEATURES = ['coverage', 'coverageTop1', 'unknownShare', 'topCosine', 'cosineProminence', 'agreement', 'margin', 'exactCode'] as const;
/** Features for retrieval with a reranker: the same ones, plus three that describe its output. */
export const RERANK_FEATURES = [...FEATURES, 'rerankTopMatchesRrfTop', 'rerankMargin', 'rerankTopScore'] as const;

// Query text (packages/server/src/retrieval/text.ts)
export const STOPWORDS = new Set(
  (
    'a an and are as at be been but by can could did do does for from get got had has have how i if in into is isnt it its ' +
    'just me my no not of on or our please so that the their them then there these they this to up was we were what when ' +
    'where which while who why will with would you your wont dont doesnt cant im ive help need want long many much often think thinks maybe seems seem really very bit kind sort thing something' +
    // Generic to every document in the corpus, so they say nothing about whether the right page was found.
    ' coffee machine maker'
  ).split(' '),
);
/**
 * Generic English verbs, adverbs and pronouns that say nothing about a product problem ("air is getting into the
 * pump", "it barely trickles", "if none of this works"). A general rule, not a list built from particular queries.
 * Left out by default so it can be measured on its own; the calibrated retriever turns it on.
 */
export const FILLER_WORDS = new Set(
  (
    'get gets getting got gotten make makes making made take takes taking took go goes going went gone come comes coming came ' +
    'keep keeps keeping kept put puts putting say says said see sees seen seem seems seemed happen happens happening happened ' +
    'try tries trying tried work works working worked barely hardly almost still even already always ever again anymore also ' +
    'properly actually basically anything everything nothing none something someone anyone everyone ' +
    'ok okay hi hello thanks thank'
  ).split(' '),
);

// Retriever (packages/server/src/retrieval/retriever.ts)
/** bm25 weights for the section, text and context columns of chunks_fts. */
export const FTS_CONTENT_WEIGHTS = '1.0, 1.0, 0.5';
export const RRF_K = 60;
export const CANDIDATES_PER_LIST = 200;
export const TOP_FOR_SIGNALS = 3;
export const WARRANTY_INTENT = /\b(warranty|guarantee|guaranteed|covered|coverage|claim|replacement|repair)\b/i;
export const DOC_TYPE_PRIOR: Record<(typeof DOC_TYPES)[number], number> = { troubleshooting: 1.1, manual: 1, warranty: 0.9 };

// Reranker (packages/server/src/retrieval/rerank.ts)
export const RERANKER_MODEL = 'Xenova/ms-marco-MiniLM-L-6-v2';
export const RERANK_BLEND_K = 60;

// Warranty (packages/server/src/support/warranty.ts)
export const DAY_MS = 86_400_000;

// Mock agent (packages/simulator/server/agent/mock.ts)
export const MOCK_MODEL = 'mock-agent';
export const MOCK_NOT_FOUND = "I couldn't find that in your documentation.";
// Each is put once, in this order, so a second "not found" asks something new instead of the same thing again.
export const MOCK_DETAIL_QUESTIONS = ['What error code or light pattern do you see?', 'What does the machine do when you try to use it, for example any sounds or leaks?'];
export const MOCK_MODEL_MENTION = /\be-?0\d\b|brew ?pro|dripmate|\bes-?1\b|espresso|pixel/i;
export const MOCK_GENERIC_WORDS = new Set(['machine', 'coffee', 'brewwell', 'maker', 'phone', 'the', 'one', 'my', 'is', 'it']);

// Agent loop (packages/simulator/server/agent/loop.ts)
export const TRACE_TEXT_LIMIT = 600;

// Conversation reading (packages/simulator/server/agent/context.ts)
/** After this many attempts that did not help, or questions the customer could not answer, a support case is the next step. */
export const ESCALATE_AFTER = 2;
/** Calls that only read: the same call twice returns the same answer, so the second adds nothing. */
export const READ_ONLY_TOOLS = new Set(['search_troubleshooting', 'identify_product', 'list_owned_products', 'get_product', 'check_warranty', 'get_document_section']);
/** Lookups a message that carries no problem must not start. */
export const LOOKUP_TOOLS = new Set(['search_troubleshooting', 'identify_product', 'list_owned_products']);
export const SKIPPED_PREFIX = '[skipped] ';
export const NEUTRAL_PRODUCT_KEY = '';
export const PATTERN_SAFETY = /\b(smoke|smoking|fire|burning|sparks?|sparking|electric shock|shocked|electrocut\w*|melting|melted)\b/;
export const PATTERN_ESCALATE = /\b(support|ticket|escalate|complaint)\b|\b(open|create|file|start|raise)\b.*\bcase\b|\b(talk|speak) to (a |an )?(human|person|agent|someone)\b/;
export const ACK_WORDS = new Set(
  ['ok', 'okay', 'alright', 'all', 'right', 'thanks', 'thank', 'thx', 'you', 'so', 'much', 'very', 'a', 'lot', 'again', 'great', 'cool', 'nice', 'perfect', 'awesome', 'got', 'it', 'i', 'see', 'understood', 'makes', 'sense', 'will', 'do', 'cheers', 'bye', 'goodbye', 'good', 'morning', 'afternoon', 'evening', 'night', 'hello', 'hi', 'hey', 'sounds', 'fine', 'noted', 'anyway', 'though'],
);
export const PATTERN_YES = /^(yes|yeah|yep|yup|sure|please|absolutely|definitely|go ahead|do it|correct)\b/;
export const PATTERN_NO = /^(no|nope|nah|not really|not now|maybe later|no need|never ?mind|i'?m (good|fine)|i am (good|fine))\b/;
// "I'll try that" promises an action; it asks for nothing.
export const PATTERN_WILL_ACT = /\b(i'?ll|i will|let me|i'?m going to|gonna) (try|check|do|give|see|get|go|look|test|have a go)\b/;
export const PATTERN_OFFER_YES = /^(yes|yeah|yep|yup|sure|please|ok|okay|alright|go ahead|do it|sounds good|absolutely|definitely)\b/;
export const PATTERN_FIXED = /\b(worked|fixed|solved|works now|working now|working again|sorted)\b/;
export const PATTERN_FAILED =
  /\b(didn'?t|did not|doesn'?t|does not|won'?t|will not|isn'?t|not) (work|help|fix|change|brew|working|helping)\b|\bstill (not|nothing|no|won'?t|will not|the same|broken|blinking|dripping|leaking|doesn'?t|isn'?t)\b|\bnothing (changed|happened|works?)\b|\bno (change|difference|luck)\b|\bnothing\b|\bsame (problem|thing)\b|\btried (that|it)\b/;
export const PATTERN_CLARIFY = /\b(repeat|say (that|it) again|come again|pardon|what do you mean|what was that|didn'?t (catch|hear|get|understand)|can you (explain|clarify|rephrase)|what does that mean)\b/;
/** "Which device is this for?": a question about the machine the conversation is about. */
export const PATTERN_WHICH_PRODUCT = /\b(which|what) (device|machine|model|product)\b/;
/** An answer to "which machine?" that names all of them. */
export const PATTERN_BOTH = /\b(both|each one|all of them|all (the )?(machines|models|of these))\b/;
export const PATTERN_NEXT = /\b(next step|what (next|now|else)|anything else (i can|to) try|another (way|step|option)|something else|what should i do (now|next))\b/;
export const PATTERN_DONT_KNOW = /\b(don'?t know|do not know|no idea|not sure|can'?t tell|unsure|dunno)\b/;
// What a home-product conversation is about. A line with none of this, and no one to answer, is not about the product.
export const PATTERN_DOMAIN =
  /\b(machine|maker|coffee|espresso|brew\w*|drip\w*|pods?|capsules?|cups?|carafe|pot|water|tank|reservoir|filter|descal\w*|scale|clean\w*|leak\w*|error|codes?|lights?|leds?|blink\w*|flash\w*|buttons?|display|screen|steam|pump|noise|noisy|loud|grind\w*|milk|froth\w*|temperature|hot|cold|warm|lukewarm|weak|bitter|taste|smell|burnt|warranty|cover\w*|repair\w*|replac\w*|broken|fix\w*|work\w*|manual|guide|model|serial|product|appliance|device|unit|reset|brewwell|wi-?fi|apps?|connect\w*|bluetooth|alexa|firmware|phones?|pixel|google|batter\w*|charg\w*|cables?|usb\w*|ports?|wireless|signal|sims?|esim|network|mobile|data|updat\w*|android|camera|slow\w*|lag\w*|laggy|freez\w*|froze\w*|crash\w*|overheat\w*|touch\w*|dropp?\w*|crack\w*|restart\w*|reboot\w*|power\w*|apps?|storage|speed|heat|hot)\b/;
export const PATTERN_ERROR_CODE = /\be-?\d{1,3}\b/;
// A line that asks something of its own, rather than giving the detail that was asked for.
export const PATTERN_ASKS = /\?\s*$|^(what|where|when|why|how|who|which|is|are|do|does|can|could|will|would|should)\b/;
// Words about the conversation itself ("what is the next step", "anything else I can try").
export const PATTERN_ABOUT_THE_HELP = /\b(steps?|next|options?|alternatives?|else|another|instead|different)\b/;
export const PATTERN_REFERS_BACK = /\b(it|this|that|they|them|these|those)\b/;
export const OVERLAP_STOP_WORDS = new Set(['the', 'a', 'an', 'is', 'it', 'that', 'this', 'you', 'your', 'to', 'of', 'and', 'or', 'do', 'did', 'can', 'what', 'i']);
export const REPEAT_OVERLAP = 0.8;

// Call guard (packages/simulator/server/agent/guard.ts)
/** Lines that carry nothing to look up: a search or a product lookup for one is wasted, and misleading. */
export const GUARD_NO_LOOKUP_INTENTS: readonly string[] = ['acknowledge', 'off_topic', 'safety', 'affirm'];

// MCP client (packages/simulator/server/mcp/client.ts)
export const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

// Simulator HTTP (packages/simulator/server/http/app.ts)
export const SIM_MAX_BODY_BYTES = 8 * 1024;
export const SIM_HEARTBEAT_MS = 15_000;
/** Only these schemes can be read through the backend: cited document pages and MCP App views. */
export const SIM_READABLE_URI = /^(doc|ui):\/\//;

// Sessions (packages/simulator/server/http/sessions.ts)
export const MAX_MESSAGE_CHARS = 1000;

// Sandbox page (packages/simulator/web/src/sandbox.ts)
export const SANDBOX_ALLOWED_REFERRER = /^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/;

// App bridge (packages/simulator/web/src/apps/bridge.ts)
export const APP_HOST_INFO = { name: 'ResolveAI Simulator', version: '0.0.0' };

// Ticket card labels (packages/server/ui/ticket-card/src/main.ts)
export const TICKET_STATUS_LABEL = { in_warranty: 'In warranty', expired: 'Expired', unknown: 'Not confirmed' } as const;
