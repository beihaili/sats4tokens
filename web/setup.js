// "Where will you use it?": the setup snippet for each kind of client. Shared by the homepage (preview with a
// placeholder key) and the key page (real key), so what a buyer previews is exactly what they paste later.
// The homepage remembers the buyer's choice in localStorage (`s4t-plan`); the key page opens on that tab.

export const USES = [
  { id: 'claude-code', name: 'Claude Code', sub: 'Anthropic’s coding agent in your terminal' },
  { id: 'codex', name: 'Codex CLI', sub: 'OpenAI’s coding agent in your terminal' },
  { id: 'app', name: 'Another app', sub: 'Cursor, Cline, Open WebUI, Chatbox … any OpenAI-compatible app' },
  { id: 'code', name: 'My own code', sub: 'curl, Python, Node — the OpenAI API' },
];

// Claude Code defaults: these routes are the cheapest Claude on the shop and accept Claude Code clients.
export const CC_DEFAULT = 'claude-opus-4-8';
const CC_SMALL = 'claude-opus-4-6';
export const CODEX_DEFAULT = 'gpt-5.5';
export const CHAT_DEFAULT = 'deepseek-flash';

/** Read the plan the homepage saved: {use, model}; {} when none or storage is blocked. */
export function loadPlan() {
  try {
    return JSON.parse(localStorage.getItem('s4t-plan') ?? '{}') ?? {};
  } catch {
    return {};
  }
}
export function savePlan(plan) {
  try {
    localStorage.setItem('s4t-plan', JSON.stringify(plan));
  } catch {}
}

/**
 * The snippet for `use`: `{hint, text, rows}`. `base` is the OpenAI base URL (…/v1), `key` the key or a placeholder,
 * `model` the model the buyer picked for that client (falls back to a sensible default).
 */
export function setupFor(use, { base, key, model }) {
  const root = base.replace(/\/v1\/?$/, '');
  if (use === 'claude-code') {
    // Claude Code speaks the Anthropic API at the root URL (it adds /v1/messages). new-api reserves quota for
    // max_tokens up front, so cap the output or a small key is refused before the first call.
    return {
      hint: 'Paste in a terminal. It sets the key for this terminal session only, then starts Claude Code.',
      rows: 7,
      text: `export ANTHROPIC_BASE_URL=${root}
export ANTHROPIC_AUTH_TOKEN=${key}
export ANTHROPIC_MODEL=${model || CC_DEFAULT}
export ANTHROPIC_DEFAULT_HAIKU_MODEL=${CC_SMALL}
export CLAUDE_CODE_MAX_OUTPUT_TOKENS=4096
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
claude`,
    };
  }
  if (use === 'codex') {
    return {
      hint: 'Paste in a terminal (macOS / Linux). It adds a "sats4tokens" provider to ~/.codex/config.toml once, then starts Codex with it.',
      rows: 12,
      // the grep keeps a second paste from adding the table twice (a duplicate TOML table breaks the whole config)
      text: `mkdir -p ~/.codex && grep -qs '^\\[model_providers.sats4tokens\\]' ~/.codex/config.toml || cat >> ~/.codex/config.toml <<'EOF'

[model_providers.sats4tokens]
name = "Sats4Tokens"
base_url = "${base}"
env_key = "SATS4TOKENS_API_KEY"
wire_api = "responses"
EOF
export SATS4TOKENS_API_KEY=${key}
codex -c model_provider=sats4tokens -m ${model || CODEX_DEFAULT}`,
    };
  }
  if (use === 'app') {
    return {
      hint: 'In the app’s settings, add a custom OpenAI-compatible provider with these three values.',
      rows: 3,
      text: `Base URL:  ${base}
API key:   ${key}
Model:     ${model || CHAT_DEFAULT}`,
    };
  }
  return {
    hint: 'Any OpenAI SDK works: set the base URL and key. Quick test:',
    rows: 5,
    text: `curl ${base}/chat/completions \\
  -H "Authorization: Bearer ${key}" \\
  -H "content-type: application/json" \\
  -d '{"model":"${model || CHAT_DEFAULT}","messages":[{"role":"user","content":"hi"}]}'`,
  };
}

/** Copy a textarea's text; navigator.clipboard is https/localhost only (and may be denied), so fall back. */
export async function copyText(box) {
  try {
    await navigator.clipboard.writeText(box.value);
  } catch {
    box.select();
    document.execCommand('copy');
  }
}
