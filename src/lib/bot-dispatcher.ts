import { dbAdapter } from "./mongodb";
import { resolvePlayer, sendFromBot, getNextBot } from "./lagos-api";

export const TOTAL_BOT_POOL = 2699;

const activeJobs = new Set<string>();

export async function advanceOrderStep(orderId: string) {
  const order = await dbAdapter.getOrder(orderId);
  if (!order || order.status === "completed" || order.status === "failed") {
    return order;
  }

  try {
    // Step 1: queued -> authenticating
    if (order.status === "queued") {
      await dbAdapter.updateOrder(orderId, {
        status: "authenticating",
        percentComplete: 15,
      });
      return await dbAdapter.getOrder(orderId);
    }

      // Step 2: authenticating -> resolve player & allocate swarm
    if (order.status === "authenticating") {
      const player = await resolvePlayer(order.username);
      if (!player) {
        throw new Error(`User @${order.username} not found on Lagos Life servers.`);
      }

      const botsNeeded = Math.min(TOTAL_BOT_POOL, Math.max(1, Math.ceil(order.amount / 30_000_000)));
      await dbAdapter.updateOrder(orderId, {
        status: "allocating",
        botsDispatched: botsNeeded,
        percentComplete: 30,
      });
      return await dbAdapter.getOrder(orderId);
    }

    // Step 3: allocating or streaming -> send batches until full chosen amount is delivered
    if (order.status === "allocating" || order.status === "streaming") {
      const delivered = order.amountDelivered || 0;
      const remainingAmount = order.amount - delivered;

      if (remainingAmount <= 0) {
        // Full chosen amount successfully reached! Finalize order.
        await dbAdapter.updateOrder(orderId, {
          status: "completed",
          amountDelivered: order.amount,
          percentComplete: 100,
          completedAt: new Date().toISOString(),
        });

        await dbAdapter.recordFundingLog({
          id: "log_" + Math.random().toString(36).substring(2, 10),
          username: order.username,
          amount: order.amount,
          orderId: order.id,
          timestamp: new Date().toISOString(),
        });

        return await dbAdapter.getOrder(orderId);
      }

      // Generate dynamic batch amount ranged between 10M - 100M (in clean 2.5M increments)
      const MIN_DISPATCH = 10_000_000;
      const MAX_DISPATCH = 100_000_000;
      const step = 2_500_000;
      const steps = Math.floor((MAX_DISPATCH - MIN_DISPATCH) / step);
      const randomTarget = MIN_DISPATCH + Math.floor(Math.random() * (steps + 1)) * step;
      const batchAmount = Math.min(remainingAmount, randomTarget);

      const batches = order.batches || [];
      const nextBatchId = batches.length + 1;

      // Resolve recipient player on Lagos Life
      const player = await resolvePlayer(order.username);
      if (!player) {
        throw new Error(`User @${order.username} could not be resolved on Lagos Life.`);
      }

      // Each bot safely transfers up to ₦15M per single-save delta (comfortable margin below ₦20M ceiling)
      const MAX_SAFE_BOT_SEND = 15_000_000;
      const numBotsNeeded = Math.ceil(batchAmount / MAX_SAFE_BOT_SEND);
      const portions: number[] = [];
      let rem = batchAmount;
      for (let i = 0; i < numBotsNeeded; i++) {
        const p = i === numBotsNeeded - 1 ? rem : Math.min(MAX_SAFE_BOT_SEND, Math.round(rem / (numBotsNeeded - i) / 500_000) * 500_000);
        portions.push(p);
        rem -= p;
      }

      let totalBatchSent = 0;
      let botsUsedCount = 0;
      let lastError = "";

      for (let pIdx = 0; pIdx < portions.length; pIdx++) {
        const portionAmt = portions[pIdx];
        let portionSuccess = false;

        // Try up to 30 bots across the 2,709-bot pool for this portion
        for (let attempt = 0; attempt < 30; attempt++) {
          const bot = getNextBot();
          if (!bot) {
            lastError = "No bots available in swarm registry pool";
            break;
          }

          console.log(`[Swarm Dispatch] Batch #${nextBatchId} (Bot ${pIdx + 1}/${portions.length}): Trying bot @${bot.username} for ₦${portionAmt.toLocaleString()}...`);

          try {
            const sendResult = await sendFromBot(bot, player.id, portionAmt);
            if (sendResult.success && sendResult.amountSent > 0) {
              totalBatchSent += sendResult.amountSent;
              botsUsedCount++;
              portionSuccess = true;
              console.log(`[Swarm Dispatch] Batch #${nextBatchId} sub-send SUCCESS via bot @${bot.username} (+₦${sendResult.amountSent.toLocaleString()})`);
              // Brief delay between bots to prevent rapid IP burst
              await new Promise((r) => setTimeout(r, 200));
              break;
            } else {
              lastError = sendResult.error || "Bot transfer failed";
              console.warn(`[Swarm Dispatch] Bot @${bot.username} attempt failed: ${lastError}`);
              // Hard-refused bots are already marked exhausted in sendFromBot — no extra delay needed
              const isHardRefusal = lastError.includes("server-rate-limited");
              if (!isHardRefusal) {
                // Brief delay only for soft failures (login/send issues)
                await new Promise((r) => setTimeout(r, 150));
              }
            }
          } catch (botErr: any) {
            lastError = botErr?.message || "Bot exception";
            console.warn(`[Swarm Dispatch] Bot @${bot.username} error: ${lastError}`);
            await new Promise((r) => setTimeout(r, 150));
          }
        }

        if (!portionSuccess) {
          console.warn(`[Swarm Dispatch] Batch #${nextBatchId}: Portion ${pIdx + 1} (₦${portionAmt.toLocaleString()}) could not be completed.`);
        }
      }

      // Strict Progress Accounting:
      // If all bot attempts failed, do NOT advance amountDelivered or mark complete.
      if (totalBatchSent <= 0) {
        const failedBatch = {
          batchId: nextBatchId,
          amount: 0,
          botsCount: numBotsNeeded,
          status: "failed" as const,
          timestamp: new Date().toISOString(),
        };

        await dbAdapter.updateOrder(orderId, {
          status: "failed",
          error: `Swarm transfer failed: ${lastError}`,
          batches: [...batches, failedBatch],
        });
        return await dbAdapter.getOrder(orderId);
      }

      const newDelivered = delivered + totalBatchSent;
      // Calculate progress percentage up to 99% until fully completed
      const pct = Math.min(99, Math.max(30, Math.round((newDelivered / order.amount) * 100)));

      const newBatch = {
        batchId: nextBatchId,
        amount: totalBatchSent,
        botsCount: botsUsedCount || 1,
        status: "sent" as const,
        timestamp: new Date().toISOString(),
      };

      // Check if this batch finished the entire order
      if (newDelivered >= order.amount) {
        await dbAdapter.updateOrder(orderId, {
          status: "completed",
          amountDelivered: order.amount,
          percentComplete: 100,
          batches: [...batches, newBatch],
          completedAt: new Date().toISOString(),
        });

        await dbAdapter.recordFundingLog({
          id: "log_" + Math.random().toString(36).substring(2, 10),
          username: order.username,
          amount: order.amount,
          orderId: order.id,
          timestamp: new Date().toISOString(),
        });

        return await dbAdapter.getOrder(orderId);
      } else {
        await dbAdapter.updateOrder(orderId, {
          status: "streaming",
          amountDelivered: newDelivered,
          percentComplete: pct,
          batches: [...batches, newBatch],
        });
        return await dbAdapter.getOrder(orderId);
      }
    }
  } catch (err: any) {
    console.error("Dispatcher error:", err);
    await dbAdapter.updateOrder(orderId, {
      status: "failed",
      error: err?.message || "Transfer failed",
    });
    return await dbAdapter.getOrder(orderId);
  }

  return order;
}

export async function processOrderBackground(orderId: string) {
  if (activeJobs.has(orderId)) return;
  activeJobs.add(orderId);

  try {
    let order = await dbAdapter.getOrder(orderId);
    while (order && order.status !== "completed" && order.status !== "failed") {
      order = await advanceOrderStep(orderId);
      await new Promise((r) => setTimeout(r, 600));
    }
  } catch (err: any) {
    console.error("Background runner error:", err);
  } finally {
    activeJobs.delete(orderId);
  }
}

export async function resumeOrder(orderId: string) {
  const order = await dbAdapter.getOrder(orderId);
  if (!order || order.status === "completed") {
    return order;
  }
  await dbAdapter.updateOrder(orderId, {
    status: "streaming",
    error: undefined,
  });
  return await dbAdapter.getOrder(orderId);
}

export async function cancelOrder(orderId: string) {
  const order = await dbAdapter.getOrder(orderId);
  if (!order || order.status === "completed") {
    return order;
  }
  await dbAdapter.updateOrder(orderId, {
    status: "failed",
    error: "Funding cancelled by user.",
  });
  return await dbAdapter.getOrder(orderId);
}

