import type { Config } from '../config.js';
import type { DB } from '../db.js';
import { log } from '../log.js';
import { ShopifyClient, assertNoUserErrors, toGid } from './client.js';
import type { Address, CreateOrderInput, ProductItem, ShopifyGateway, ShopifyOrderStatus, StockItem } from './types.js';

const STOCK_QUERY = /* GraphQL */ `
  query Stock($first: Int!, $after: String, $q: String) {
    productVariants(first: $first, after: $after, query: $q) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id sku barcode
        inventoryItem {
          id tracked
          inventoryLevels(first: 10) {
            nodes { location { id } quantities(names: ["available"]) { name quantity } }
          }
        }
      }
    }
  }`;

const PRODUCTS_QUERY = /* GraphQL */ `
  query Products($first: Int!, $after: String, $q: String) {
    productVariants(first: $first, after: $after, query: $q) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id sku barcode price title
        inventoryItem { measurement { weight { value unit } } }
        metafields(namespace: "dropship", first: 20) { nodes { key value } }
        product {
          id title vendor productType descriptionHtml
          media(first: 6) { nodes { ... on MediaImage { image { url } } } }
          metafields(namespace: "dropship", first: 20) { nodes { key value } }
        }
      }
    }
  }`;

const PRICE_LIST_QUERY = /* GraphQL */ `
  query PriceList($id: ID!, $after: String) {
    priceList(id: $id) {
      prices(first: 250, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { variant { id } price { amount } }
      }
    }
  }`;

const DRAFT_CREATE = /* GraphQL */ `
  mutation DraftCreate($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) { draftOrder { id } userErrors { field message } }
  }`;

// Mit Zahlungsziel oder B2B-Firma das deprecated paymentPending weglassen.
// Ohne beides bleibt paymentPending der Fallback, damit die Order nicht als bezahlt gilt.
const DRAFT_COMPLETE = /* GraphQL */ `
  mutation DraftComplete($id: ID!) {
    draftOrderComplete(id: $id) {
      draftOrder { order { id name } }
      userErrors { field message }
    }
  }`;

const DRAFT_COMPLETE_PENDING = /* GraphQL */ `
  mutation DraftCompletePending($id: ID!) {
    draftOrderComplete(id: $id, paymentPending: true) {
      draftOrder { order { id name } }
      userErrors { field message }
    }
  }`;

const PAYMENT_TERMS_QUERY = /* GraphQL */ `
  query { paymentTermsTemplates { id dueInDays paymentTermsType } }`;

const WEBHOOK_LIST = /* GraphQL */ `
  query { webhookSubscriptions(first: 100) { nodes { topic uri } } }`;

const ORDER_STATUS = /* GraphQL */ `
  query OrderStatus($id: ID!) {
    order(id: $id) {
      name cancelledAt displayFulfillmentStatus returnStatus
      fulfillments(first: 10) { trackingInfo(first: 5) { company number url } }
    }
  }`;

const TAGS_ADD = /* GraphQL */ `
  mutation TagsAdd($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { field message } } }`;

const WEBHOOK_CREATE = /* GraphQL */ `
  mutation Hook($topic: WebhookSubscriptionTopic!, $uri: String!) {
    webhookSubscriptionCreate(topic: $topic, webhookSubscription: { uri: $uri }) {
      webhookSubscription { id }
      userErrors { field message }
    }
  }`;

type Page<N> = { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: N[] };

const metaMap = (nodes: { key: string; value: string }[] | undefined) =>
  Object.fromEntries((nodes ?? []).map((m) => [m.key, m.value]));

function toMailing(a: Address) {
  const parts = a.name.trim().split(/\s+/);
  const lastName = parts.at(-1) ?? '';
  const firstName = parts.slice(0, -1).join(' ');
  return {
    firstName, lastName,
    company: a.company || undefined,
    address1: a.address1,
    address2: a.address2 || undefined,
    zip: a.zip,
    city: a.city,
    countryCode: a.countryCode,
    phone: a.phone || undefined,
  };
}

export class RealShopifyGateway implements ShopifyGateway {
  private termsTemplate: string | null | undefined;

  constructor(private readonly cfg: Config, db?: DB, private readonly client = new ShopifyClient(cfg, db)) {}

  private async paginate<N>(query: string, pick: (d: any) => Page<N>, vars: Record<string, unknown>): Promise<N[]> {
    const out: N[] = [];
    let after: string | null = null;
    do {
      const page: Page<N> = pick(await this.client.graphql(query, { ...vars, after }));
      out.push(...page.nodes);
      after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    } while (after);
    return out;
  }

  async fetchStock(): Promise<StockItem[]> {
    type N = {
      id: string; sku: string | null; barcode: string | null;
      inventoryItem: { id: string; tracked: boolean; inventoryLevels: { nodes: { location: { id: string }; quantities: { quantity: number }[] }[] } };
    };
    const nodes = await this.paginate<N>(STOCK_QUERY, (d) => d.productVariants, { first: 100, q: this.cfg.PRODUCT_QUERY });
    return nodes.map((n) => ({
      variantId: n.id,
      inventoryItemId: n.inventoryItem.id,
      sku: n.sku ?? '',
      barcode: n.barcode ?? '',
      tracked: n.inventoryItem.tracked,
      levels: Object.fromEntries(n.inventoryItem.inventoryLevels.nodes.map((l) => [l.location.id, l.quantities[0]?.quantity ?? 0])),
    }));
  }

  async fetchProducts(): Promise<ProductItem[]> {
    const nodes = await this.paginate<any>(PRODUCTS_QUERY, (d) => d.productVariants, { first: 25, q: this.cfg.PRODUCT_QUERY });
    return nodes.map((n) => {
      const w = n.inventoryItem?.measurement?.weight;
      const factor: Record<string, number> = { KILOGRAMS: 1, GRAMS: 0.001, POUNDS: 0.453592, OUNCES: 0.0283495 };
      const variantTitle = n.title && n.title !== 'Default Title' ? ` – ${n.title}` : '';
      return {
        variantId: n.id,
        productId: n.product.id,
        sku: n.sku ?? '',
        barcode: n.barcode ?? '',
        title: `${n.product.title}${variantTitle}`,
        brand: n.product.vendor ?? '',
        productType: n.product.productType ?? '',
        descriptionHtml: n.product.descriptionHtml ?? '',
        images: (n.product.media?.nodes ?? []).map((m: any) => m?.image?.url).filter(Boolean),
        weightKg: w ? Math.round(w.value * (factor[w.unit] ?? 1) * 1000) / 1000 : null,
        price: Number(n.price),
        meta: { ...metaMap(n.product.metafields?.nodes), ...metaMap(n.metafields?.nodes) },
      } satisfies ProductItem;
    });
  }

  async fetchPriceList(): Promise<Map<string, number>> {
    if (!this.cfg.B2B_PRICE_LIST_ID) return new Map();
    const id = toGid('PriceList', this.cfg.B2B_PRICE_LIST_ID);
    const nodes = await this.paginate<{ variant: { id: string }; price: { amount: string } }>(
      PRICE_LIST_QUERY, (d) => d.priceList.prices, { id },
    );
    return new Map(nodes.map((n) => [n.variant.id, Number(n.price.amount)]));
  }

  async createOrder(input: CreateOrderInput) {
    const lineItems: Record<string, unknown>[] = input.lines.map((l) => ({
      variantId: l.variantId,
      quantity: l.quantity,
      ...(l.discountPercent && l.discountPercent > 0
        ? { appliedDiscount: { value: l.discountPercent, valueType: 'PERCENTAGE', title: 'Händler-EK' } }
        : {}),
    }));
    if (input.fee && input.fee.amount > 0) {
      lineItems.push({
        title: input.fee.title,
        quantity: 1,
        originalUnitPriceWithCurrency: { amount: input.fee.amount.toFixed(2), currencyCode: this.cfg.CURRENCY },
        requiresShipping: false,
        taxable: true,
      });
    }
    const draftInput: Record<string, unknown> = {
      email: input.email,
      shippingAddress: toMailing(input.shippingAddress),
      lineItems,
      tags: input.tags,
      customAttributes: input.attributes,
      note: input.note,
    };
    if (input.billingAddress) draftInput.billingAddress = toMailing(input.billingAddress);
    if (input.purchasingCompany) {
      draftInput.purchasingEntity = {
        purchasingCompany: {
          companyId: toGid('Company', input.purchasingCompany.companyId),
          companyLocationId: toGid('CompanyLocation', input.purchasingCompany.companyLocationId),
          companyContactId: toGid('CompanyContact', input.purchasingCompany.companyContactId),
        },
      };
    }
    if (input.paymentTermsTemplateId) {
      draftInput.paymentTerms = { paymentTermsTemplateId: toGid('PaymentTermsTemplate', input.paymentTermsTemplateId) };
    }
    const created = await this.client.graphql<any>(DRAFT_CREATE, { input: draftInput });
    assertNoUserErrors(created.draftOrderCreate.userErrors, 'draftOrderCreate');
    const draftId = created.draftOrderCreate.draftOrder.id;

    const paymentPending = !input.paymentTermsTemplateId && !input.purchasingCompany;
    const done = await this.client.graphql<any>(paymentPending ? DRAFT_COMPLETE_PENDING : DRAFT_COMPLETE, { id: draftId });
    assertNoUserErrors(done.draftOrderComplete.userErrors, 'draftOrderComplete');
    const order = done.draftOrderComplete.draftOrder.order;
    return { orderId: order.id as string, orderName: order.name as string };
  }

  async getOrderStatus(orderId: string): Promise<ShopifyOrderStatus | null> {
    const d = await this.client.graphql<any>(ORDER_STATUS, { id: orderId });
    const o = d.order;
    if (!o) return null;
    return {
      name: o.name,
      cancelled: Boolean(o.cancelledAt),
      fulfillmentStatus: o.displayFulfillmentStatus,
      returnStatus: o.returnStatus ?? 'NO_RETURN',
      tracking: (o.fulfillments ?? []).flatMap((f: any) => f.trackingInfo ?? []),
    };
  }

  async addOrderTags(orderId: string, tags: string[]) {
    const d = await this.client.graphql<any>(TAGS_ADD, { id: orderId, tags });
    assertNoUserErrors(d.tagsAdd.userErrors, 'tagsAdd');
  }

  async resolvePaymentTermsTemplate(): Promise<string | null> {
    if (this.termsTemplate !== undefined) return this.termsTemplate;
    if (this.cfg.PAYMENT_TERMS_TEMPLATE_ID) {
      this.termsTemplate = toGid('PaymentTermsTemplate', this.cfg.PAYMENT_TERMS_TEMPLATE_ID);
      return this.termsTemplate;
    }
    if (this.cfg.PAYMENT_TERMS_DAYS <= 0) {
      this.termsTemplate = null;
      return null;
    }
    try {
      const data = await this.client.graphql<{ paymentTermsTemplates: { id: string; dueInDays: number | null; paymentTermsType: string }[] }>(PAYMENT_TERMS_QUERY);
      const days = this.cfg.PAYMENT_TERMS_DAYS;
      const templates = data.paymentTermsTemplates ?? [];
      const match = templates.find((t) => t.dueInDays === days && t.paymentTermsType === 'NET')
        ?? templates.find((t) => t.dueInDays === days);
      this.termsTemplate = match?.id ?? null;
      if (!this.termsTemplate) log.warn('kein zahlungsziel-template', { days });
    } catch (e) {
      log.warn('zahlungsziel nicht gelesen, fallback paymentPending', { error: String(e) });
      return null;
    }
    return this.termsTemplate;
  }

  async listWebhooks(): Promise<{ topic: string; uri: string }[]> {
    const data = await this.client.graphql<{ webhookSubscriptions: { nodes: { topic: string; uri: string }[] } }>(WEBHOOK_LIST);
    return data.webhookSubscriptions.nodes ?? [];
  }

  async registerWebhook(topic: string, uri: string) {
    const d = await this.client.graphql<any>(WEBHOOK_CREATE, { topic, uri });
    assertNoUserErrors(d.webhookSubscriptionCreate.userErrors, `webhookSubscriptionCreate ${topic}`);
    return d.webhookSubscriptionCreate.webhookSubscription.id as string;
  }
}
