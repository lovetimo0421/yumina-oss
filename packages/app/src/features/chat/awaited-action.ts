type ActionResult = { applied: true; variables: Record<string, unknown>; firedIds: string[] };

/** The generic sandbox bridge resolves errors as values; never leak a rejection. */
export async function dispatchAwaitedAction(
  args: unknown[], available: boolean, execute?: (actionId: string, params?: Record<string, unknown>) => Promise<ActionResult>,
): Promise<ActionResult | { error: string }> {
  try {
    if (!available || !execute) throw new Error("Actions are unavailable in this view.");
    if (args.length < 1 || args.length > 2 || typeof args[0] !== "string" || !args[0]) throw new Error("Invalid action ID.");
    // What a button passes in (商品, 价格) rides along as a plain object;
    // anything else in that place is a malformed call.
    const extra = args[1];
    if (args.length === 2 && (!extra || typeof extra !== "object" || Array.isArray(extra))) throw new Error("Invalid action parameters.");
    const params = args.length === 2 ? extra as Record<string, unknown> : undefined;
    return await execute(args[0], params);
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Action failed. Please try again." };
  }
}
