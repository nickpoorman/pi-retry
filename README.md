# pi-retry

A [pi](https://github.com/badlogic/pi) extension that retries failed LLM responses — automatically for transient streaming errors, manually via `/retry` or Enter, and now with configurable default retry settings.

## Features

### Auto-retry transient errors

When an LLM response fails with a transient streaming error (for example `"aborted"` from an upstream proxy or gateway), the extension automatically retries with exponential backoff:

- **Default delays:** 2s → 4s → 8s → 16s → 32s
- **Default max attempts:** 5
- **Configurable max attempts:** change it globally with `/retry settings <count>`
- **No history pollution:** the failed response is invisible to the model because pi strips aborted and errored assistant messages before the next request

Only errors *not* already handled by pi's built-in retry are retried. User-initiated aborts (ESC) are never auto-retried — use `/retry` or Enter for those.

### Manual retry: `/retry`

Type `/retry` after any error or abort to re-invoke the LLM. The model starts fresh from the last user message and never sees the failed partial response.

### Manual retry: press Enter

After an error or user-initiated abort (ESC), press Enter on an empty editor to retry.

The Enter keypress is consumed only when all of these are true:

- The editor is empty
- The editor has focus
- The agent is idle
- The last response was an error or abort

Otherwise Enter behaves normally.

### Configure the global default retry count

You can change the default auto-retry count for all future pi sessions:

```bash
/retry settings 7
```

You can also use the alias command:

```bash
/retry:settings 7
```

Other useful forms:

```bash
/retry settings        # show current setting
/retry settings show   # show current setting
/retry settings reset  # reset back to 5
/retry settings 0      # disable auto-retry
```

The setting is saved to:

```text
~/.pi/agent/extensions/pi-retry.json
```

## Installation

### As a pi package

From npm:

```bash
pi install npm:@georgebashi/pi-retry
```

From this fork:

```bash
pi install git:github.com/nickpoorman/pi-retry
```

Or from a local checkout:

```bash
pi install /path/to/pi-retry
```

### For development/testing

```bash
pi -e /path/to/pi-retry/index.ts
```

## Logging

Every retry attempt is logged to `~/.pi/logs/pi-retry.jsonl` with:

- Provider, model, model ID, API type, thinking level
- Stop reason and error message
- Attempt number and delay
- Working directory and session ID

Event types:

- `retry`
- `retry_succeeded`
- `retry_exhausted`
- `manual_retry`

## How it works

1. **`agent_end`** checks whether the last assistant message failed with a retryable error.
2. If it qualifies, the extension waits using exponential backoff and sends a hidden retry trigger.
3. **`context`** removes the hidden trigger before the next LLM request.
4. **`/retry`** manually retries the last failed prompt.
5. **`/retry settings ...`** updates the global default retry count.
6. **Empty Enter** retries the last failed prompt when the editor is focused and blank.
7. **`turn_end`** resets the auto-retry counter after a successful response.
