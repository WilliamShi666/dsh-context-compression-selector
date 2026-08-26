# Parent and child agent cache-prefix audit

## Scope

This reference characterizes when DeepSeek Harness parent and child requests can present an identical prompt prefix to DeepSeek's automatic context cache. It does not add an explicit cache key, cache breakpoint, cache identifier, or client-side KV cache.

The selector plugin owns settings registration and UI only. It has no hook into agent request construction, subagent session creation, or LLM serialization, so this work must not add runtime request behavior to the plugin or modify Harness core.

## Three separate questions

Context inheritance asks whether a child session receives parent session events. A fork copies the parent event prefix through the last completed turn; a spawn starts without parent messages. The child metadata records the parent session and, for a fork, the seed length.

Harness cache control asks whether Harness supplies a DeepSeek cache key or breakpoint across requests or sessions. The DeepSeek adapter serializes ordinary Chat Completions input and reads official usage fields; it supplies no explicit cache control.

Server cache reuse asks whether byte-identical request prefixes can hit DeepSeek's automatic context cache. This is best-effort server behavior and is confirmed only when official response usage reports a positive `prompt_cache_hit_tokens` value. Latency and price are not evidence.

## Reuse characterization

The test-only audit representation is versioned and canonical. Object keys are sorted recursively, while arrays retain their model-visible order. A SHA-256 fingerprint is computed over UTF-8 JSON containing the provider, model, system prompt, tool schemas, and inherited messages.

A child is reusable only when it is a fork, declares parent-context inheritance, and its provider, model, system prompt, tools, and inherited messages equal the parent's stable envelope. Spawn mode, a changed persona or system prompt, changed tool schema or order, changed provider or model route, and changed history are rejected. The audit never repairs or concatenates mismatched contexts.

The characterization does not guarantee that two independently assembled HTTP bodies have the same byte prefix: JSON property order and the child-only continuation still belong to the DeepSeek adapter. The live test captures the actual immutable agent-loop request options and compares the stable inherited envelope before allowing a cache-reuse claim.

## Safe evidence record

An evidence event may contain only the audit version, prefix fingerprint, estimated shared-prefix tokens, parent and child session identifiers, mode, eligibility or reason, cache-read tokens, cache-miss tokens, observed prompt tokens, and confirmation status. It must not contain prompts, messages, tool arguments or results, tool schemas, permissions, environment values, credentials, or secrets.

Usage is internally consistent only when `cacheReadTokens + cacheMissTokens` equals the observed prompt-token total. A positive cache-read count confirms a natural cache hit for that request. Missing or zero cache-read usage yields `unconfirmed`, never a claimed miss caused by Harness.

## TDD acceptance criteria

The RED test imports an absent test-support module and defines the required behavior before implementation. The GREEN implementation remains under `tests/support` and exports no product runtime API.

- Fork accepts an identical completed-turn prefix and produces the same fingerprint for parent and child views.
- Spawn is ineligible because it does not inherit parent messages.
- Persona, tool schema or order, provider, model, and history mismatches are ineligible.
- Safe evidence records contain only the allowlisted fields and never contain representative secret or tool-result content.
- Usage projection accepts hit plus miss equaling the prompt total and rejects inconsistent totals.
- The existing selector runtime source remains unchanged, so disabling or omitting the plugin cannot affect agent requests.
- A key-gated host-side live DeepSeek E2E test uses an isolated in-memory context and task-local `DSH_HOME`; it reports only sanitized usage evidence.
- Existing fork, spawn, request-reconstruction, DeepSeek usage-projection, selector-plugin tests, the full build, and `git diff --check` pass.

## Operational boundaries

Tests do not connect to the active web profile, start or restart a Harness service, deploy code, or write session logs outside the isolated test environment. The test-only implementation adds no product runtime API and does not alter active profile settings or service state.
