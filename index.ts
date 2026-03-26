import { getAgentDir, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { matchesKey, type TUI } from "@mariozechner/pi-tui";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * pi-retry: Handles transient streaming errors + manual retry.
 *
 * Features:
 *
 * 1. **Auto-retry** — On `agent_end`, if the last assistant message has a
 *    retryable error not covered by pi's built-in retry, wait with exponential
 *    backoff and re-invoke the LLM. The failed assistant message is already
 *    stripped from LLM context by pi's `transform-messages` (it skips any
 *    assistant message with stopReason "error" or "aborted"). We just need
 *    to send a hidden trigger to kick off a new turn.
 *
 * 2. **Manual retry** — `/retry` command or pressing Enter on an empty
 *    editor retries the last prompt. Works for any aborted/errored
 *    response, including user-initiated ESC cancellations. Uses the
 *    `onTerminalInput` hook to intercept Enter before pi swallows it.
 *
 * 3. **Retry settings** — `/retry settings <count>` or `/retry:settings <count>`
 *    updates the global default auto-retry count for current and future pi
 *    sessions. The setting is stored in `~/.pi/agent/extensions/pi-retry.json`.
 *
 * History:
 *   The session is append-only, so we can't delete the aborted assistant
 *   message. But from the model's perspective, it's invisible (stripped by
 *   transform-messages). Our trigger messages use `display: false` so they
 *   don't clutter the TUI.
 *
 * Logging:
 *   Each retry attempt is logged to ~/.pi/logs/pi-retry.jsonl.
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_MAX_RETRIES = 5;
const BASE_DELAY_MS = 2000;

const RETRY_CUSTOM_TYPE = "__retry_trigger";
const CONFIG_DIR = join(getAgentDir(), "extensions");
const CONFIG_FILE = join(CONFIG_DIR, "pi-retry.json");

interface RetryConfig {
  maxRetries: number;
}

// Errors we retry that the built-in doesn't cover.
const RETRYABLE_PATTERNS = /\baborted\b/i;

// Patterns already handled by pi's built-in retry — don't double-retry.
const BUILTIN_RETRY_PATTERNS =
  /overloaded|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server error|internal error|connection.?error|connection.?refused|other side closed|fetch failed|upstream.?connect|reset before headers|terminated|retry delay/i;

function parseRetryCount(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) {
      return Number.parseInt(trimmed, 10);
    }
  }

  return null;
}

function loadRetryConfig(): RetryConfig {
  if (!existsSync(CONFIG_FILE)) {
    return { maxRetries: DEFAULT_MAX_RETRIES };
  }

  try {
    const parsed = JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) as {
      maxRetries?: unknown;
    };
    const maxRetries = parseRetryCount(parsed.maxRetries);
    if (maxRetries !== null) {
      return { maxRetries };
    }

    console.error(
      `Warning: Invalid maxRetries in ${CONFIG_FILE}; using default ${DEFAULT_MAX_RETRIES}.`,
    );
  } catch (error) {
    console.error(`Warning: Could not parse ${CONFIG_FILE}: ${String(error)}`);
  }

  return { maxRetries: DEFAULT_MAX_RETRIES };
}

function saveRetryConfig(config: RetryConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n");
}

function formatRetrySettings(config: RetryConfig): string {
  if (config.maxRetries === 0) {
    return "Auto-retry is disabled.";
  }

  return `Auto-retry is set to ${config.maxRetries} attempts.`;
}

function getCommandErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error);
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

const LOG_DIR = join(homedir(), ".pi", "logs");
const LOG_FILE = join(LOG_DIR, "pi-retry.jsonl");

interface RetryLogEntry {
  timestamp: string;
  event: "retry" | "retry_exhausted" | "retry_succeeded" | "manual_retry";
  provider?: string;
  model?: string;
  modelId?: string;
  api?: string;
  thinkingLevel?: string;
  stopReason?: string;
  errorMessage?: string;
  attempt: number;
  maxRetries: number;
  delayMs?: number;
  cwd: string;
  sessionId?: string;
  // Context size at the time of the event
  contextTokens?: number | null;
  contextWindow?: number;
  contextPercent?: number | null;
  messageCount?: number;
}

function logRetryEvent(entry: RetryLogEntry): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n");
  } catch {
    // Best-effort — don't break the extension if logging fails.
  }
}

/** Extract context size fields from the extension context. */
function getContextFields(ctx: any): Pick<RetryLogEntry, "contextTokens" | "contextWindow" | "contextPercent"> {
  const usage = ctx.getContextUsage?.();
  if (!usage) return {};
  return {
    contextTokens: usage.tokens,
    contextWindow: usage.contextWindow,
    contextPercent: usage.percent,
  };
}

// ---------------------------------------------------------------------------
// TUI focus detection
// ---------------------------------------------------------------------------

/**
 * Check if the editor is the currently focused component. Uses duck-typing
 * against the TUI's (runtime-accessible) focusedComponent: editors have both
 * `onSubmit` and `getText`, which no selector/dialog/overlay component does.
 *
 * When a modal UI is shown (model selector, confirm dialog, session picker,
 * extension selector, overlay, etc.), focus moves away from the editor, and
 * this returns false — preventing our Enter handler from stealing the keypress.
 */
function isEditorFocused(tui: TUI | null): boolean {
  if (!tui) return false;
  const focused = (tui as any).focusedComponent;
  if (!focused) return false;
  // Duck-type: the editor component has getText + onSubmit; selectors don't.
  return typeof focused.getText === "function" && "onSubmit" in focused;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function piRetry(pi: ExtensionAPI) {
  let retryConfig = loadRetryConfig();

  // -- Auto-retry state --
  let retryAttempt = 0;
  let lastErrorMessage = "";
  let lastStopReason = "";

  // -- Shared state: track whether last response was an error/abort --
  // Used by the manual retry path to know if there's something to retry.
  let lastResponseWasError = false;

  // Track pending retry triggers so we can strip them from context.
  let pendingRetryCleanup = false;

  // TUI reference, captured via a no-op widget during session_start.
  let tuiRef: TUI | null = null;

  function resetAutoRetryState() {
    retryAttempt = 0;
    lastErrorMessage = "";
    lastStopReason = "";
  }

  function triggerManualRetry(ctx: any) {
    if (!ctx.isIdle()) {
      ctx.ui.notify("Agent is still running.", "warning");
      return;
    }

    if (!lastResponseWasError) {
      ctx.ui.notify("Nothing to retry — last response completed successfully.", "warning");
      return;
    }

    const model = ctx.model;
    logRetryEvent({
      timestamp: new Date().toISOString(),
      event: "manual_retry",
      provider: model?.provider,
      model: model?.name,
      modelId: model?.id,
      api: model?.api,
      thinkingLevel: pi.getThinkingLevel(),
      attempt: 1,
      maxRetries: 1,
      cwd: ctx.cwd,
      sessionId: ctx.sessionManager.getSessionId(),
      ...getContextFields(ctx),
    });

    triggerRetry(pi);
  }

  function showRetrySettings(ctx: any) {
    ctx.ui.notify(
      `${formatRetrySettings(retryConfig)} Use /retry settings <count> or /retry:settings <count>. Config: ${CONFIG_FILE}`,
      "info",
    );
  }

  function updateRetrySettings(value: number, ctx: any) {
    retryConfig = { maxRetries: value };
    saveRetryConfig(retryConfig);
    resetAutoRetryState();
    ctx.ui.setStatus("pi-retry", undefined);

    const message =
      value === 0
        ? `Auto-retry disabled for current and future pi sessions. Config: ${CONFIG_FILE}`
        : `Auto-retry max set to ${value} for current and future pi sessions. Config: ${CONFIG_FILE}`;

    ctx.ui.notify(message, "success");
  }

  function handleRetrySettings(args: string | undefined, ctx: any) {
    const trimmed = (args ?? "").trim();

    if (!trimmed || /^(show|status)$/i.test(trimmed)) {
      showRetrySettings(ctx);
      return;
    }

    if (/^reset$/i.test(trimmed)) {
      updateRetrySettings(DEFAULT_MAX_RETRIES, ctx);
      return;
    }

    const maxRetries = parseRetryCount(trimmed);
    if (maxRetries === null) {
      ctx.ui.notify(
        "Usage: /retry settings <count>, /retry settings show, or /retry settings reset",
        "warning",
      );
      return;
    }

    try {
      updateRetrySettings(maxRetries, ctx);
    } catch (error) {
      ctx.ui.notify(`Failed to save retry settings: ${getCommandErrorMessage(error)}`, "error");
    }
  }

  // -----------------------------------------------------------------------
  // Reset auto-retry counter on successful responses
  // -----------------------------------------------------------------------
  pi.on("turn_end", async (event, ctx) => {
    const msg = event.message as any;
    if (
      msg.role === "assistant" &&
      msg.stopReason !== "error" &&
      msg.stopReason !== "aborted"
    ) {
      lastResponseWasError = false;

      if (retryAttempt > 0) {
        const model = ctx.model;
        logRetryEvent({
          timestamp: new Date().toISOString(),
          event: "retry_succeeded",
          provider: model?.provider,
          model: model?.name,
          modelId: model?.id,
          api: model?.api,
          thinkingLevel: pi.getThinkingLevel(),
          stopReason: lastStopReason,
          errorMessage: lastErrorMessage,
          attempt: retryAttempt,
          maxRetries: retryConfig.maxRetries,
          cwd: ctx.cwd,
          sessionId: ctx.sessionManager.getSessionId(),
          ...getContextFields(ctx),
        });

        ctx.ui.notify(`Retry succeeded on attempt ${retryAttempt}.`, "info");
        ctx.ui.setStatus("pi-retry", undefined);
        resetAutoRetryState();
      }
    }
  });

  // -----------------------------------------------------------------------
  // Auto-retry: detect retryable errors on agent_end
  // -----------------------------------------------------------------------
  pi.on("agent_end", async (event, ctx) => {
    const messages = event.messages;
    let lastAssistant: any = null;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") {
        lastAssistant = messages[i];
        break;
      }
    }
    if (!lastAssistant) return;

    const stopReason: string = lastAssistant.stopReason;
    const errorMessage: string = lastAssistant.errorMessage || "";

    // Track for manual retry
    if (stopReason === "error" || stopReason === "aborted") {
      lastResponseWasError = true;
    }

    // Never retry user-initiated aborts.
    if (
      stopReason === "aborted" &&
      /operation aborted|request was aborted/i.test(errorMessage)
    )
      return;

    // Only look at error/aborted responses.
    if (stopReason !== "error" && stopReason !== "aborted") return;

    // Skip if the built-in retry will handle it.
    if (BUILTIN_RETRY_PATTERNS.test(errorMessage)) return;

    // Check our patterns.
    if (!RETRYABLE_PATTERNS.test(errorMessage)) return;

    if (retryConfig.maxRetries === 0) return;

    retryAttempt++;
    lastErrorMessage = errorMessage;
    lastStopReason = stopReason;

    const model = ctx.model;

    if (retryAttempt > retryConfig.maxRetries) {
      logRetryEvent({
        timestamp: new Date().toISOString(),
        event: "retry_exhausted",
        provider: model?.provider,
        model: model?.name,
        modelId: model?.id,
        api: model?.api,
        thinkingLevel: pi.getThinkingLevel(),
        stopReason,
        errorMessage,
        attempt: retryAttempt - 1,
        maxRetries: retryConfig.maxRetries,
        cwd: ctx.cwd,
        sessionId: ctx.sessionManager.getSessionId(),
        messageCount: messages.length,
        ...getContextFields(ctx),
      });

      ctx.ui.notify(
        `Stream error persisted after ${retryConfig.maxRetries} retries: ${errorMessage}`,
        "error",
      );
      ctx.ui.setStatus("pi-retry", undefined);
      resetAutoRetryState();
      return;
    }

    const delayMs = BASE_DELAY_MS * 2 ** (retryAttempt - 1);

    logRetryEvent({
      timestamp: new Date().toISOString(),
      event: "retry",
      provider: model?.provider,
      model: model?.name,
      modelId: model?.id,
      api: model?.api,
      thinkingLevel: pi.getThinkingLevel(),
      stopReason,
      errorMessage,
      attempt: retryAttempt,
      maxRetries: retryConfig.maxRetries,
      delayMs,
      cwd: ctx.cwd,
      sessionId: ctx.sessionManager.getSessionId(),
      messageCount: messages.length,
      ...getContextFields(ctx),
    });

    ctx.ui.setStatus(
      "pi-retry",
      `Stream error "${errorMessage}", retrying (${retryAttempt}/${retryConfig.maxRetries}) in ${(delayMs / 1000).toFixed(0)}s…`,
    );

    await new Promise((resolve) => setTimeout(resolve, delayMs));
    ctx.ui.setStatus("pi-retry", undefined);

    triggerRetry(pi);
  });

  // -----------------------------------------------------------------------
  // Manual retry and settings commands
  // -----------------------------------------------------------------------
  pi.registerCommand("retry", {
    description: "Retry the last prompt, or manage auto-retry settings with `/retry settings ...`",
    handler: async (args, ctx) => {
      const trimmed = (args ?? "").trim();
      if (!trimmed) {
        triggerManualRetry(ctx);
        return;
      }

      const [subcommand, ...rest] = trimmed.split(/\s+/);
      if (subcommand.toLowerCase() === "settings") {
        handleRetrySettings(rest.join(" "), ctx);
        return;
      }

      ctx.ui.notify(
        `Unknown /retry subcommand "${subcommand}". Use /retry or /retry settings <count>.`,
        "warning",
      );
    },
  });

  pi.registerCommand("retry:settings", {
    description: "Show or update the default auto-retry count",
    handler: async (args, ctx) => {
      handleRetrySettings(args, ctx);
    },
  });

  // -----------------------------------------------------------------------
  // Empty Enter = retry: intercept raw terminal input via onTerminalInput
  // hook. When the editor is empty, the agent is idle, and the last
  // response was an error/abort, pressing Enter triggers a retry instead
  // of being swallowed as a no-op.
  //
  // We also check that the editor is the focused component. When a modal
  // UI is displayed (model selector, confirm dialog, session picker, etc.)
  // focus moves to the modal and we must NOT consume the Enter keypress —
  // otherwise the modal can't be interacted with.
  // -----------------------------------------------------------------------
  pi.on("session_start", async (_event, ctx) => {
    retryConfig = loadRetryConfig();

    // Capture TUI reference via a zero-height widget factory. The factory
    // is called once with the TUI instance; we stash it and return an
    // invisible component (empty render, no height).
    ctx.ui.setWidget("__pi-retry-tui-probe", (tui) => {
      tuiRef = tui;
      // Return a minimal no-op component that renders nothing.
      return { render: () => [] };
    }, { placement: "aboveEditor" });
    // Remove the widget immediately — we only needed it to grab tui.
    ctx.ui.setWidget("__pi-retry-tui-probe", undefined);

    ctx.ui.onTerminalInput((data) => {
      if (!matchesKey(data, "enter")) return;
      if (!lastResponseWasError) return;
      if (!ctx.isIdle()) return;
      if (ctx.ui.getEditorText().trim() !== "") return;
      // Don't consume Enter when a modal/selector/overlay has focus.
      if (!isEditorFocused(tuiRef)) return;

      // Consume the Enter keypress and trigger retry
      logRetryEvent({
        timestamp: new Date().toISOString(),
        event: "manual_retry",
        provider: ctx.model?.provider,
        model: ctx.model?.name,
        modelId: ctx.model?.id,
        api: ctx.model?.api,
        thinkingLevel: pi.getThinkingLevel(),
        attempt: 1,
        maxRetries: 1,
        cwd: ctx.cwd,
        sessionId: ctx.sessionManager.getSessionId(),
        ...getContextFields(ctx),
      });

      triggerRetry(pi);
      return { consume: true };
    });
  });

  // -----------------------------------------------------------------------
  // Context cleanup: strip our hidden trigger messages before LLM sees them.
  // transform-messages already strips the aborted assistant message, so we
  // only need to remove our custom trigger.
  // -----------------------------------------------------------------------
  pi.on("context", async (event) => {
    if (!pendingRetryCleanup) return;
    pendingRetryCleanup = false;

    const cleaned = event.messages.filter((msg: any) => {
      if (msg.role === "custom" && msg.customType === RETRY_CUSTOM_TYPE) {
        return false;
      }
      return true;
    });

    return { messages: cleaned };
  });

  // -----------------------------------------------------------------------
  // Helper: send the hidden retry trigger
  // -----------------------------------------------------------------------
  function triggerRetry(pi: ExtensionAPI) {
    pendingRetryCleanup = true;
    pi.sendMessage(
      {
        customType: RETRY_CUSTOM_TYPE,
        content: "Retrying.",
        display: false,
      },
      { triggerTurn: true },
    );
  }
}
