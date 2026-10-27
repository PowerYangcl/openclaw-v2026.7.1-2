import type { ChatMessage, JdSpendResult } from "@/types/chat";

type SpendBatch = Record<string, { spend: number | null; balance: number | null }>;

/** Account balances are query-time observations, never per-turn settlement snapshots. */
export function createChatSpendRefresh(options: {
  session: () => string;
  messages: () => ChatMessage[];
  query: (responseIds: string[]) => Promise<SpendBatch>;
}) {
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const active = new Map<string, { session: string; completionId?: string; inFlight: boolean }>();

  function previousBalance(target: ChatMessage): number | null {
    const messages = options.messages();
    const index = messages.indexOf(target);
    let boundary = index - 1;
    while (boundary >= 0 && !["user", "system"].includes(messages[boundary]!.role)) {
      const refresh = messages[boundary]?.spendRefresh;
      if (refresh) return refresh.baseline;
      boundary--;
    }
    for (let i = boundary - 1; i >= 0; i--) {
      const previous =messages[i];
      const balance = previous?.spendResult?.balance;
      if (!previous?.spendLoading && typeof balance === "number" && Number.isFinite(balance)) return balance;
    }
    return null;
  }

  function find(id: string): ChatMessage | undefined {
    const completionId = active.get(id)?.completionId;
    return options.messages().find((message) => message.id === id ||
      (completionId && message.completionId === completionId));
  }

  function accept(message: ChatMessage, result: JdSpendResult): boolean {
    if (!Number.isFinite(result.spend) || !Number.isFinite(result.balance)) return false;
    if (result.balance === message.spendRefresh?.baseline) return false;
    message.spendResult = result;
    message.spendLoading = false;
    return true;
  }

  function tick(): void {
    timer = undefined;
    const ids: string[] = [];
    const selected: string[] = [];
    for (const [id, entry] of active) {
      const message = find(id);
      if (entry.session !== options.session() || !message?.spendRefresh ||
          Date.now() >= message.spendRefresh.deadline || !message.spendLoading) {
        active.delete(id);
        continue;
      }
      if (!entry.inFlight && message.completionId) {
        entry.inFlight = true;
        entry.completionId = message.completionId;
        ids.push(message.completionId);
        selected.push(id);
      }
    }
    if (ids.length) {
      const token = generation;
      void options.query(ids).then((results) => {
        if (token !== generation) return;
        for (const id of selected) {
          const entry = active.get(id);
          const message = find(id);
          if (!entry || entry.session !== options.session() || !message?.spendRefresh ||
              Date.now() >= message.spendRefresh.deadline) continue;
          const result = message.completionId ? results[message.completionId] : undefined;
          if (result && typeof result.spend === "number" && typeof result.balance === "number" &&
              accept(message, { spend: result.spend, balance: result.balance })) active.delete(id);
        }
      }).catch(() => {
        // Missing/failed observations keep the loading state; never estimate a balance.
      }).finally(() => {
        if (token !== generation) return;
        for (const id of selected) {
          const entry = active.get(id);
          if (entry) entry.inFlight = false;
        }
      });
    }
    if (active.size) timer = setTimeout(tick, 2_000);
  }

  function start(message: ChatMessage, live = false): void {
    if (message.role !== "assistant") return;
    if (!message.spendRefresh) {
      if (!live && message.spendResult && !message.spendLoading) return;
      message.spendRefresh = { baseline: previousBalance(message), deadline: Date.now() + 30_000 };
      if (message.spendResult && !message.spendLoading && accept(message, message.spendResult)) return;
      message.spendLoading = true;
    }
    if (!message.spendLoading || Date.now() >= message.spendRefresh.deadline ||
        [...active.keys()].some((id) => find(id) === message)) return;
    active.set(message.id, { session: options.session(), completionId: message.completionId, inFlight: false });
    if (!timer) timer = setTimeout(tick, live && message.spendResult ? 2_000 : 0);
  }

  /** Preserve observations and deadlines when cache/server history replaces message objects. */
  function preserve(incoming: ChatMessage[]): ChatMessage[] {
    const current = options.messages();
    for (const message of incoming) {
      const local = current.find((item) => item.id === message.id ||
        (message.completionId && item.completionId === message.completionId));
      if (!local) continue;
      if (local.spendResult) message.spendResult = local.spendResult;
      if (local.spendRefresh || local.spendLoading) {
        message.spendRefresh = local.spendRefresh;
        message.spendLoading = local.spendLoading;
      }
    }
    return incoming;
  }

  function stop(): void {
    generation++;
    if (timer) clearTimeout(timer);
    timer = undefined;
    active.clear();
  }

  return { start, preserve, stop };
}