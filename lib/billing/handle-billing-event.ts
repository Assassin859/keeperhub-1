import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  organizationSubscriptions,
  overageBillingRecords,
} from "@/lib/db/schema";
import { getMetricsCollector } from "@/lib/metrics";
import { MetricNames } from "@/lib/metrics/types";
import { recordAuditEvent } from "@/lib/security/audit-log";
import { BILLING_ALERTS } from "./constants";
import { clearAllDebtForOrg, clearDebtForInvoice } from "./execution-debt";
import { billOverageForOrg } from "./overage";
import { type PlanName, parsePlanName } from "./plans";
import { resolveSubscriptionPlan } from "./plans-server";
import type { BillingProvider, BillingWebhookEvent } from "./provider";

const LOG_PREFIX = "[Billing Handler]";

// Numeric ranking used to label plan changes as upgrade/downgrade. Same-plan
// tier changes (e.g. Pro 25k -> Pro 50k) are labeled "tier_change" since the
// dashboard tracks them separately from plan-level moves.
const PLAN_RANK: Record<PlanName, number> = {
  free: 0,
  pro: 1,
  business: 2,
  enterprise: 3,
};

function planChangeDirection(
  from: PlanName,
  to: PlanName
): "upgrade" | "downgrade" | "tier_change" {
  if (from === to) {
    return "tier_change";
  }
  return PLAN_RANK[to] > PLAN_RANK[from] ? "upgrade" : "downgrade";
}

type SubscriptionRow = typeof organizationSubscriptions.$inferSelect;

async function findSubscriptionByProviderId(
  providerSubscriptionId: string
): Promise<SubscriptionRow | undefined> {
  const rows = await db
    .select()
    .from(organizationSubscriptions)
    .where(
      eq(
        organizationSubscriptions.providerSubscriptionId,
        providerSubscriptionId
      )
    )
    .limit(1);
  return rows[0];
}

async function findSubscriptionByCustomerId(
  providerCustomerId: string
): Promise<SubscriptionRow | undefined> {
  const rows = await db
    .select()
    .from(organizationSubscriptions)
    .where(eq(organizationSubscriptions.providerCustomerId, providerCustomerId))
    .limit(1);
  return rows[0];
}

export async function handleBillingEvent(
  event: BillingWebhookEvent,
  provider: BillingProvider
): Promise<void> {
  const { type, data } = event;
  console.info(LOG_PREFIX, "Handling event:", type);

  switch (type) {
    case "checkout.completed": {
      await handleCheckoutCompleted(data, provider);
      break;
    }
    case "subscription.updated": {
      await handleSubscriptionUpdated(data);
      break;
    }
    case "subscription.deleted": {
      await handleSubscriptionDeleted(data);
      break;
    }
    case "invoice.paid": {
      await handleInvoicePaid(data);
      break;
    }
    case "invoice.payment_failed": {
      await handleInvoicePaymentFailed(data);
      break;
    }
    case "invoice.overdue": {
      await handleInvoiceOverdue(data);
      break;
    }
    case "invoice.payment_action_required": {
      await handleInvoicePaymentActionRequired(data);
      break;
    }
    default:
      break;
  }
}

async function handleCheckoutCompleted(
  data: BillingWebhookEvent["data"],
  provider: BillingProvider
): Promise<void> {
  const { organizationId, providerSubscriptionId } = data;

  if (!organizationId) {
    console.error("[Billing Webhook] No organizationId in checkout event");
    return;
  }

  if (!providerSubscriptionId) {
    console.error("[Billing Webhook] No subscription in checkout event");
    return;
  }

  console.info(
    LOG_PREFIX,
    "checkout.completed - orgId:",
    organizationId,
    "subId:",
    providerSubscriptionId
  );

  const details = await provider.getSubscriptionDetails(providerSubscriptionId);
  console.info(
    LOG_PREFIX,
    "Subscription details - priceId:",
    details.priceId,
    "status:",
    details.status
  );

  if (!details.priceId) {
    console.error(LOG_PREFIX, "No price ID found in subscription");
    return;
  }

  const resolved = resolveSubscriptionPlan(details.priceId, {
    subscription: details.subscriptionMetadata,
    price: details.priceMetadata,
  });
  if (!resolved) {
    console.error(
      LOG_PREFIX,
      "Unknown priceId, cannot resolve plan:",
      details.priceId
    );
    return;
  }
  const { plan, tier } = resolved;
  console.info(
    LOG_PREFIX,
    "Resolved plan:",
    plan,
    "tier:",
    tier,
    "from priceId:",
    details.priceId
  );

  const subscriptionData = {
    providerSubscriptionId,
    providerPriceId: details.priceId,
    plan,
    tier,
    status: "active" as const,
    currentPeriodStart: details.periodStart,
    currentPeriodEnd: details.periodEnd,
    cancelAtPeriodEnd: details.cancelAtPeriodEnd,
    updatedAt: new Date(),
  };

  await db
    .insert(organizationSubscriptions)
    .values({
      organizationId,
      ...subscriptionData,
    })
    .onConflictDoUpdate({
      target: organizationSubscriptions.organizationId,
      set: subscriptionData,
    });

  console.info(LOG_PREFIX, "Upserted subscription for org:", organizationId);

  getMetricsCollector().incrementCounter(
    MetricNames.BILLING_SUBSCRIPTION_CREATED,
    {
      plan,
      tier: tier ?? "none",
    }
  );
}

// Build the DB update payload for a subscription.updated event.
// Only changes plan/tier if the priceId actually changed (upgrade or plan switch).
// When cancelAtPeriodEnd is set, Stripe sends the same priceId -- we keep the
// current plan active until the period ends (handled by subscription.deleted).
function buildSubscriptionUpdate(
  data: BillingWebhookEvent["data"],
  current: SubscriptionRow
): Record<string, unknown> {
  const {
    priceId,
    status,
    cancelAtPeriodEnd,
    periodStart,
    periodEnd,
    subscriptionMetadata,
    priceMetadata,
  } = data;

  const priceChanged =
    priceId !== undefined && priceId !== current.providerPriceId;
  const resolved =
    priceChanged && priceId
      ? resolveSubscriptionPlan(priceId, {
          subscription: subscriptionMetadata,
          price: priceMetadata,
        })
      : undefined;

  console.info(
    LOG_PREFIX,
    "subscription.updated - subId:",
    current.providerSubscriptionId,
    "status:",
    status,
    "cancelAtPeriodEnd:",
    cancelAtPeriodEnd,
    "priceChanged:",
    priceChanged,
    priceChanged ? `${current.providerPriceId} -> ${priceId}` : "(no change)",
    "resolved:",
    resolved?.plan ?? current.plan,
    resolved?.tier ?? current.tier
  );

  const update: Record<string, unknown> = {
    status: status ?? current.status,
    currentPeriodStart: periodStart ?? current.currentPeriodStart,
    currentPeriodEnd: periodEnd ?? current.currentPeriodEnd,
    cancelAtPeriodEnd: cancelAtPeriodEnd ?? current.cancelAtPeriodEnd,
    updatedAt: new Date(),
  };

  if (priceChanged) {
    update.providerPriceId = priceId ?? null;
    update.plan = resolved?.plan ?? current.plan;
    update.tier = resolved?.tier ?? null;
  }

  return update;
}

async function handleSubscriptionUpdated(
  data: BillingWebhookEvent["data"]
): Promise<void> {
  const { providerSubscriptionId } = data;

  if (!providerSubscriptionId) {
    return;
  }

  const current = await findSubscriptionByProviderId(providerSubscriptionId);
  if (!current) {
    console.warn(
      LOG_PREFIX,
      "subscription.updated - no matching row for subId:",
      providerSubscriptionId
    );
    return;
  }

  const update = buildSubscriptionUpdate(data, current);

  // Bill overage BEFORE updating the subscription row so that if billing fails,
  // the old period data remains on the row for the scan endpoint to pick up.
  const periodRolled =
    data.periodStart instanceof Date &&
    current.currentPeriodStart instanceof Date &&
    data.periodStart.getTime() !== current.currentPeriodStart.getTime();

  if (
    periodRolled &&
    current.currentPeriodStart instanceof Date &&
    current.currentPeriodEnd instanceof Date
  ) {
    try {
      await billOverageForOrg(
        current.organizationId,
        current.currentPeriodStart,
        current.currentPeriodEnd
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        LOG_PREFIX,
        "Failed to bill overage for org (will be retried by scan):",
        current.organizationId,
        message
      );
    }
  }

  await db
    .update(organizationSubscriptions)
    .set(update)
    .where(
      eq(
        organizationSubscriptions.providerSubscriptionId,
        providerSubscriptionId
      )
    );

  const metrics = getMetricsCollector();
  const newPlanRaw = update.plan;
  const newPlan: PlanName =
    typeof newPlanRaw === "string"
      ? parsePlanName(newPlanRaw, parsePlanName(current.plan))
      : parsePlanName(current.plan);
  metrics.incrementCounter(MetricNames.BILLING_SUBSCRIPTION_UPDATED, {
    plan: newPlan,
  });

  // Plan change is signaled by priceChanged in buildSubscriptionUpdate
  // (only present in the update payload when the price differs).
  if (update.providerPriceId !== undefined) {
    const fromPlan = parsePlanName(current.plan);
    metrics.incrementCounter(MetricNames.BILLING_SUBSCRIPTION_PLAN_CHANGED, {
      from_plan: fromPlan,
      to_plan: newPlan,
      direction: planChangeDirection(fromPlan, newPlan),
    });

    // Authoritative plan-change record. The acting user is captured separately
    // by subscription.change_requested on the checkout route; here the actor
    // is the provider webhook that finalized the transition.
    await recordAuditEvent({
      actor: {
        userId: null,
        organizationId: current.organizationId,
        authMethod: "internal",
      },
      action: "subscription.plan_changed",
      resourceType: "subscription",
      resourceId: current.organizationId,
      before: { plan: current.plan, tier: current.tier },
      after: { plan: newPlan, tier: (update.tier as string | null) ?? null },
      metadata: { source: "stripe", providerSubscriptionId },
    });
  }
}

async function handleSubscriptionDeleted(
  data: BillingWebhookEvent["data"]
): Promise<void> {
  const { providerSubscriptionId } = data;

  if (!providerSubscriptionId) {
    return;
  }

  const current = await findSubscriptionByProviderId(providerSubscriptionId);
  const periodEnd =
    data.periodEnd instanceof Date ? data.periodEnd : current?.currentPeriodEnd;
  const now = new Date();

  // If the billing period hasn't ended yet (cancel at period end),
  // keep the plan active but mark status as canceled so the UI shows
  // the cancellation notice. The plan features remain available.
  if (periodEnd !== null && periodEnd !== undefined && periodEnd > now) {
    console.info(
      LOG_PREFIX,
      "subscription.deleted - subId:",
      providerSubscriptionId,
      "period still active until:",
      periodEnd.toISOString(),
      "- keeping plan, marking canceled"
    );

    await db
      .update(organizationSubscriptions)
      .set({
        status: "canceled",
        cancelAtPeriodEnd: false,
        updatedAt: now,
      })
      .where(
        eq(
          organizationSubscriptions.providerSubscriptionId,
          providerSubscriptionId
        )
      );

    // Clear debt even when period is still active -- no further overage
    // will be billed on a canceled subscription, so debt is moot.
    if (current) {
      await clearAllDebtForOrg(current.organizationId);
    }

    getMetricsCollector().incrementCounter(
      MetricNames.BILLING_SUBSCRIPTION_CANCELED,
      {
        plan: parsePlanName(current?.plan, "free"),
        tier: current?.tier ?? "none",
      }
    );

    if (current) {
      await recordAuditEvent({
        actor: {
          userId: null,
          organizationId: current.organizationId,
          authMethod: "internal",
        },
        action: "subscription.canceled",
        resourceType: "subscription",
        resourceId: current.organizationId,
        before: { plan: current.plan, status: current.status },
        after: { status: "canceled", activeUntil: periodEnd.toISOString() },
        metadata: { source: "stripe", providerSubscriptionId },
      });
    }
    return;
  }

  // Period has ended (or no period data) -- fully reset to free
  console.info(
    LOG_PREFIX,
    "subscription.deleted - subId:",
    providerSubscriptionId,
    "period ended, resetting to free"
  );

  await db
    .update(organizationSubscriptions)
    .set({
      plan: "free",
      tier: null,
      status: "canceled",
      providerSubscriptionId: null,
      providerPriceId: null,
      cancelAtPeriodEnd: false,
      updatedAt: now,
    })
    .where(
      eq(
        organizationSubscriptions.providerSubscriptionId,
        providerSubscriptionId
      )
    );

  // Clear any active debt -- it becomes moot when downgrading to free
  if (current) {
    await clearAllDebtForOrg(current.organizationId);
  }

  getMetricsCollector().incrementCounter(
    MetricNames.BILLING_SUBSCRIPTION_CANCELED,
    {
      plan: parsePlanName(current?.plan, "free"),
      tier: current?.tier ?? "none",
    }
  );

  if (current) {
    await recordAuditEvent({
      actor: {
        userId: null,
        organizationId: current.organizationId,
        authMethod: "internal",
      },
      action: "subscription.canceled",
      resourceType: "subscription",
      resourceId: current.organizationId,
      before: { plan: current.plan, status: current.status },
      after: { plan: "free", status: "canceled" },
      metadata: { source: "stripe", providerSubscriptionId },
    });
  }
}

async function markOverageRecordsPaid(
  organizationId: string,
  invoiceId: string
): Promise<void> {
  await db
    .update(overageBillingRecords)
    .set({ providerInvoiceId: invoiceId })
    .where(
      and(
        eq(overageBillingRecords.organizationId, organizationId),
        eq(overageBillingRecords.status, "billed"),
        isNull(overageBillingRecords.providerInvoiceId)
      )
    );
}

async function handleInvoicePaid(
  data: BillingWebhookEvent["data"]
): Promise<void> {
  const { providerSubscriptionId, invoiceId, providerCustomerId } = data;

  // Clear debt for this invoice regardless of subscription presence
  if (invoiceId) {
    await clearDebtForInvoice(invoiceId);
  }

  if (providerSubscriptionId) {
    console.info(LOG_PREFIX, "invoice.paid - subId:", providerSubscriptionId);

    const sub = await findSubscriptionByProviderId(providerSubscriptionId);

    await db
      .update(organizationSubscriptions)
      .set({
        status: "active",
        billingAlert: null,
        billingAlertUrl: null,
        updatedAt: new Date(),
      })
      .where(
        eq(
          organizationSubscriptions.providerSubscriptionId,
          providerSubscriptionId
        )
      );

    if (sub && invoiceId) {
      await markOverageRecordsPaid(sub.organizationId, invoiceId);
    }

    getMetricsCollector().incrementCounter(MetricNames.BILLING_INVOICE_PAID, {
      plan: parsePlanName(sub?.plan, "free"),
    });
    return;
  }

  // Fallback: standalone invoice (e.g. overage) -- find org by customer ID.
  // Deliberately does NOT set status: "active" because paying an overage invoice
  // is not the same as renewing a subscription. Only subscription invoices restore status.
  if (providerCustomerId) {
    const sub = await findSubscriptionByCustomerId(providerCustomerId);
    if (sub) {
      console.info(
        LOG_PREFIX,
        "invoice.paid - no subId, found org via customerId:",
        providerCustomerId
      );

      await db
        .update(organizationSubscriptions)
        .set({
          billingAlert: null,
          billingAlertUrl: null,
          updatedAt: new Date(),
        })
        .where(
          eq(organizationSubscriptions.organizationId, sub.organizationId)
        );

      if (invoiceId) {
        await markOverageRecordsPaid(sub.organizationId, invoiceId);
      }

      getMetricsCollector().incrementCounter(MetricNames.BILLING_INVOICE_PAID, {
        plan: parsePlanName(sub.plan, "free"),
      });
    }
  }
}

async function handleInvoicePaymentFailed(
  data: BillingWebhookEvent["data"]
): Promise<void> {
  const { providerSubscriptionId, invoiceUrl } = data;

  if (!providerSubscriptionId) {
    console.warn(
      LOG_PREFIX,
      "invoice.payment_failed - no subscriptionId, skipping"
    );
    return;
  }

  console.info(
    LOG_PREFIX,
    "invoice.payment_failed - subId:",
    providerSubscriptionId
  );

  const sub = await findSubscriptionByProviderId(providerSubscriptionId);

  await db
    .update(organizationSubscriptions)
    .set({
      status: "past_due",
      billingAlert: BILLING_ALERTS.PAYMENT_FAILED,
      billingAlertUrl: invoiceUrl ?? null,
      updatedAt: new Date(),
    })
    .where(
      eq(
        organizationSubscriptions.providerSubscriptionId,
        providerSubscriptionId
      )
    );

  getMetricsCollector().incrementCounter(MetricNames.BILLING_INVOICE_FAILED, {
    plan: parsePlanName(sub?.plan, "free"),
  });
}

async function handleInvoiceOverdue(
  data: BillingWebhookEvent["data"]
): Promise<void> {
  const { providerSubscriptionId, invoiceUrl } = data;

  if (!providerSubscriptionId) {
    console.warn(LOG_PREFIX, "invoice.overdue - no subscriptionId, skipping");
    return;
  }

  console.info(LOG_PREFIX, "invoice.overdue - subId:", providerSubscriptionId);

  await db
    .update(organizationSubscriptions)
    .set({
      billingAlert: BILLING_ALERTS.OVERDUE,
      billingAlertUrl: invoiceUrl ?? null,
      updatedAt: new Date(),
    })
    .where(
      eq(
        organizationSubscriptions.providerSubscriptionId,
        providerSubscriptionId
      )
    );
}

async function handleInvoicePaymentActionRequired(
  data: BillingWebhookEvent["data"]
): Promise<void> {
  const { providerSubscriptionId, invoiceUrl } = data;

  if (!providerSubscriptionId) {
    console.warn(
      LOG_PREFIX,
      "invoice.payment_action_required - no subscriptionId, skipping"
    );
    return;
  }

  console.info(
    LOG_PREFIX,
    "invoice.payment_action_required - subId:",
    providerSubscriptionId
  );

  await db
    .update(organizationSubscriptions)
    .set({
      billingAlert: BILLING_ALERTS.PAYMENT_ACTION_REQUIRED,
      billingAlertUrl: invoiceUrl ?? null,
      updatedAt: new Date(),
    })
    .where(
      eq(
        organizationSubscriptions.providerSubscriptionId,
        providerSubscriptionId
      )
    );
}
