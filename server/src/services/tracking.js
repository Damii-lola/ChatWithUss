/**
 * Order tracking for the storefront widget.
 *
 * Security model (no customer account required):
 *  - Guest: order number + email must BOTH match. Any mismatch returns the same
 *    "not found" answer so the endpoint can't be used to discover orders or emails.
 *  - Logged-in customer: Shopify's signed app-proxy `logged_in_customer_id` is trusted,
 *    so they can open their own orders without typing an email.
 * Nothing private beyond what the order-status email already shows is returned
 * (no addresses, no payment details).
 */

const ORDER_FIELDS = /* GraphQL */ `
  fragment ChatWithUssOrder on Order {
    id
    name
    email
    processedAt
    cancelledAt
    displayFulfillmentStatus
    displayFinancialStatus
    statusPageUrl
    customer { id }
    totalPriceSet { presentmentMoney { amount currencyCode } }
    lineItems(first: 20) {
      nodes {
        id
        title
        variantTitle
        quantity
        image { url(transform: { maxWidth: 160, maxHeight: 160 }) altText }
      }
    }
    fulfillments(first: 10) {
      id
      status
      displayStatus
      createdAt
      updatedAt
      inTransitAt
      deliveredAt
      estimatedDeliveryAt
      trackingInfo(first: 3) { company number url }
      fulfillmentLineItems(first: 20) { nodes { quantity lineItem { id } } }
    }
  }
`;

export const FIND_ORDERS_QUERY = /* GraphQL */ `
  ${ORDER_FIELDS}
  query ChatWithUssFindOrders($q: String!, $first: Int!) {
    orders(first: $first, query: $q, sortKey: PROCESSED_AT, reverse: true) {
      nodes { ...ChatWithUssOrder }
    }
  }
`;

export class TrackingSetupError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TrackingSetupError';
  }
}

const ORDER_INPUT_RE = /^[a-z0-9][a-z0-9._-]{0,29}$/i;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

/** "#1001 " → "1001"; "SH-1001" → "sh-1001"; null if it can't be an order number. */
export function normalizeOrderNumber(input) {
  if (typeof input !== 'string') return null;
  const v = input.trim().replace(/^#+/, '').replace(/\s+/g, '').toLowerCase();
  return ORDER_INPUT_RE.test(v) ? v : null;
}

export function normalizeEmail(input) {
  if (typeof input !== 'string') return null;
  const v = input.trim().toLowerCase();
  return EMAIL_RE.test(v) && v.length <= 254 ? v : null;
}

const numericId = (gid) => (gid ? String(gid).match(/(\d+)$/)?.[1] ?? null : null);
const orderKey = (name) => String(name || '').replace(/^#+/, '').toLowerCase();

function accessErrors(errors) {
  return (errors || []).filter((e) => /access|approved|protected|not permitted|denied/i.test(e?.message || ''));
}

async function queryOrders(admin, q, first) {
  const { data, errors } = await admin.graphql(FIND_ORDERS_QUERY, { q, first }, { partial: true });
  const nodes = data?.orders?.nodes;
  if (!Array.isArray(nodes)) {
    if (accessErrors(errors).length) throw new TrackingSetupError('Order access not approved: ' + errors.map((e) => e.message).join('; '));
    throw new Error('Order lookup failed: ' + (errors || []).map((e) => e?.message).join('; '));
  }
  return { nodes, errors: errors || [] };
}

/**
 * Guest or logged-in lookup. Returns the raw order node, or null when it can't be shown.
 * @param {{orderNumber:string, email?:string|null, customerId?:string|null}} input (already normalised)
 */
export async function findOrder(admin, { orderNumber, email = null, customerId = null }) {
  const safe = orderNumber.replace(/["\\]/g, '');
  const { nodes, errors } = await queryOrders(admin, `name:"${safe}"`, 5);
  const matches = nodes.filter((o) => orderKey(o.name) === orderNumber);
  if (!matches.length) return null;

  if (customerId) {
    const mine = matches.find((o) => numericId(o.customer?.id) === String(customerId));
    if (mine) return mine;
  }
  if (!email) return null;

  // Protected customer data not approved → email comes back null with an access error.
  if (matches.every((o) => o.email == null) && accessErrors(errors).length) {
    throw new TrackingSetupError('Order email is hidden: protected customer data (Email) not approved for this app');
  }
  return matches.find((o) => typeof o.email === 'string' && o.email.trim().toLowerCase() === email) || null;
}

/** Recent orders for a logged-in customer (signed proxy id). */
export async function listCustomerOrders(admin, customerId, limit = 5) {
  const id = String(customerId).replace(/\D/g, '');
  if (!id) return [];
  const { nodes } = await queryOrders(admin, `customer_id:${id}`, limit);
  return nodes;
}

// ---------------------------------------------------------------- presentation

export const STAGES = ['Ordered', 'Shipped', 'On the way', 'Delivered'];

const DISPLAY = {
  // stage, short label
  SUBMITTED: [1, 'Shipping soon'],
  CONFIRMED: [1, 'Shipped'],
  LABEL_PURCHASED: [1, 'Label created'],
  LABEL_PRINTED: [1, 'Label created'],
  MARKED_AS_FULFILLED: [1, 'Shipped'],
  FULFILLED: [1, 'Shipped'],
  IN_TRANSIT: [2, 'In transit'],
  OUT_FOR_DELIVERY: [2, 'Out for delivery'],
  ATTEMPTED_DELIVERY: [2, 'Delivery attempted'],
  READY_FOR_PICKUP: [2, 'Ready for pickup'],
  NOT_DELIVERED: [2, 'Delivery issue'],
  FAILURE: [2, 'Delivery issue'],
  DELIVERED: [3, 'Delivered'],
  PICKED_UP: [3, 'Picked up'],
  CANCELED: [-1, 'Shipment cancelled'],
  LABEL_VOIDED: [-1, 'Shipment cancelled'],
};

function shipmentView(f) {
  let [stage, label] = DISPLAY[f.displayStatus] || [1, 'Shipped'];
  // Carrier timestamps beat a stale display status.
  if (f.deliveredAt && stage < 3) [stage, label] = [3, 'Delivered'];
  else if (f.inTransitAt && stage === 1) [stage, label] = [2, 'In transit'];
  const t = (f.trackingInfo || [])[0] || {};
  const issue = ['NOT_DELIVERED', 'FAILURE', 'ATTEMPTED_DELIVERY'].includes(f.displayStatus);
  return {
    stage,
    label,
    issue,
    carrier: t.company || null,
    tracking_number: t.number || null,
    tracking_url: /^https?:\/\//i.test(t.url || '') ? t.url : null,
    shipped_at: f.createdAt || null,
    in_transit_at: f.inTransitAt || null,
    delivered_at: f.deliveredAt || null,
    estimated_delivery_at: f.estimatedDeliveryAt || null,
    item_count: (f.fulfillmentLineItems?.nodes || []).reduce((n, li) => n + (li.quantity || 0), 0),
  };
}

/** Turns a raw Admin API order into the exact JSON the widget renders. */
export function orderView(order) {
  const shipments = (order.fulfillments || []).map(shipmentView).filter((s) => s.stage >= 0);
  const cancelled = Boolean(order.cancelledAt);
  const items = (order.lineItems?.nodes || []).map((li) => ({
    title: li.title,
    variant: li.variantTitle && li.variantTitle !== 'Default Title' ? li.variantTitle : null,
    quantity: li.quantity,
    image: li.image?.url || null,
  }));
  const totalItems = items.reduce((n, i) => n + (i.quantity || 0), 0);
  const shippedItems = shipments.reduce((n, s) => n + s.item_count, 0);
  const partial =
    !cancelled && shipments.length > 0 && (order.displayFulfillmentStatus === 'PARTIALLY_FULFILLED' || (shippedItems > 0 && shippedItems < totalItems));

  // Headline follows the most advanced shipment; issues take priority.
  const lead = shipments.find((s) => s.issue) || [...shipments].sort((a, b) => b.stage - a.stage)[0] || null;
  const stage = cancelled ? 0 : lead ? lead.stage : 0;

  let headline;
  let detail;
  if (cancelled) {
    headline = 'This order was cancelled';
    detail = 'If you were charged, the refund goes back to your original payment method.';
  } else if (!lead) {
    headline = order.displayFulfillmentStatus === 'ON_HOLD' ? 'Your order is on hold' : "We're preparing your order";
    detail = "You'll get tracking details as soon as it ships.";
  } else if (lead.issue) {
    headline = lead.label === 'Delivery attempted' ? 'Delivery was attempted' : "There's a problem with the delivery";
    detail = lead.carrier ? `Check the ${lead.carrier} tracking page for next steps.` : 'Use the tracking link below for next steps.';
  } else if (lead.stage === 3) {
    headline = lead.label === 'Picked up' ? 'Picked up' : 'Delivered';
    detail = null;
  } else if (lead.stage === 2) {
    headline = lead.label === 'Out for delivery' ? 'Out for delivery today' : lead.label === 'Ready for pickup' ? 'Ready for pickup' : "It's on the way";
    detail = lead.carrier ? `with ${lead.carrier}` : null;
  } else {
    headline = 'Your order has shipped';
    detail = lead.carrier ? `with ${lead.carrier}` : null;
  }

  return {
    name: order.name,
    placed_at: order.processedAt || null,
    cancelled,
    stage,
    stages: STAGES,
    headline,
    detail,
    eta: !cancelled && lead && lead.stage < 3 ? lead.estimated_delivery_at : null,
    delivered_at: !cancelled && lead && lead.stage === 3 ? lead.delivered_at : null,
    partial,
    total: order.totalPriceSet?.presentmentMoney
      ? { amount: order.totalPriceSet.presentmentMoney.amount, currency: order.totalPriceSet.presentmentMoney.currencyCode }
      : null,
    items,
    shipments,
    status_page_url: /^https:\/\//i.test(order.statusPageUrl || '') ? order.statusPageUrl : null,
  };
}

/** Compact row for the logged-in "Your orders" list. */
export function orderSummary(order) {
  const v = orderView(order);
  return { name: v.name, placed_at: v.placed_at, stage: v.stage, headline: v.headline, cancelled: v.cancelled, item_count: v.items.reduce((n, i) => n + i.quantity, 0), total: v.total, image: v.items.find((i) => i.image)?.image || null };
}
