import { ethers } from 'ethers';
import { getConfig } from './config';
import type { AgentEligibility, AgentFeedback } from './types';

type TemplateValue = string | number | boolean | null | TemplateObject | TemplateValue[];
interface TemplateObject {
  [key: string]: TemplateValue;
}

export interface FeedbackTemplateContext {
  agentId: string;
  agentIdDecimal: string;
  collateralizationId: string;
  collateralizationSince: string;
  collateralizationSinceIso: string;
  chainId: string;
  chainName: string;
  pgtcrId: string;
  amount: string;
  daysActive: string;
  daysActiveRounded: string;
  hoursActive: string;
  walletAddress: string;
  nowIso: string;
  feedbackValue: string;
  feedbackDecimals: string;
}

function normalizeAgentIdToDecimal(agentId: string): string {
  try {
    return BigInt(agentId).toString(10);
  } catch {
    return agentId;
  }
}

export function createFeedbackTemplateContext(
  eligibility: AgentEligibility,
  walletAddress: string,
  now: Date = new Date()
): FeedbackTemplateContext {
  const config = getConfig();
  const nowMs = now.getTime();
  const collateralizationSinceMs = eligibility.collateralizationSince * 1000;
  const durationMs = Math.max(0, nowMs - collateralizationSinceMs);
  const hoursActive = durationMs / (60 * 60 * 1000);
  const daysActive = durationMs / (24 * 60 * 60 * 1000);

  return {
    agentId: eligibility.agent,
    agentIdDecimal: normalizeAgentIdToDecimal(eligibility.agent),
    collateralizationId: eligibility.collateralizationId,
    collateralizationSince: String(eligibility.collateralizationSince),
    collateralizationSinceIso: new Date(collateralizationSinceMs).toISOString(),
    chainId: String(eligibility.chainId),
    chainName: config.currentChain ?? process.env.CHAIN ?? `eip155:${eligibility.chainId}`,
    pgtcrId: String(eligibility.pgtcrId),
    amount: eligibility.amount.toString(),
    daysActive: daysActive.toFixed(2),
    daysActiveRounded: Math.floor(daysActive).toString(),
    hoursActive: hoursActive.toFixed(2),
    walletAddress,
    nowIso: now.toISOString(),
    feedbackValue: String(config.FEEDBACK_VALUE),
    feedbackDecimals: String(config.FEEDBACK_DECIMALS),
  };
}

export function renderTemplate(template: string, context: FeedbackTemplateContext): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: keyof FeedbackTemplateContext) => {
    return context[key] ?? '';
  });
}

function renderTemplateValue<T extends TemplateValue>(value: T, context: FeedbackTemplateContext): T {
  if (typeof value === 'string') {
    return renderTemplate(value, context) as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => renderTemplateValue(entry, context)) as T;
  }
  if (value && typeof value === 'object') {
    const rendered: TemplateObject = {};
    for (const [key, entry] of Object.entries(value)) {
      rendered[key] = renderTemplateValue(entry as TemplateValue, context);
    }
    return rendered as T;
  }
  return value;
}

function buildGeneratedFeedbackDocument(
  context: FeedbackTemplateContext,
  endpoint: string,
  tag1: string,
  tag2: string
): string {
  const config = getConfig();
  const title = renderTemplate(config.FEEDBACK_TITLE_TEMPLATE, context);
  const text = renderTemplate(config.FEEDBACK_TEXT_TEMPLATE, context);
  const extraJson = renderTemplateValue(config.FEEDBACK_EXTRA_JSON as TemplateObject, context);

  const payload: Record<string, unknown> = {
    schema: 'erc8004-feedback-bot/v1',
    generatedAt: context.nowIso,
    createdAt: context.nowIso,
    agentId: context.agentIdDecimal,
    agentIdHex: context.agentId,
    clientAddress: `eip155:${context.chainId}:${context.walletAddress}`,
    value: getConfig().FEEDBACK_VALUE,
    valueDecimals: getConfig().FEEDBACK_DECIMALS,
    tag1,
    tag2,
    endpoint,
    title,
    text,
    collateralization: {
      id: context.collateralizationId,
      since: context.collateralizationSince,
      sinceIso: context.collateralizationSinceIso,
      hoursActive: context.hoursActive,
      daysActive: context.daysActive,
      amount: context.amount,
      pgtcrId: context.pgtcrId,
      chainId: context.chainId,
      chainName: context.chainName,
    },
    ...extraJson,
  };

  if (config.IDENTITY_REGISTRY_ADDRESS) {
    payload.agentRegistry = `eip155:${context.chainId}:${config.IDENTITY_REGISTRY_ADDRESS}`;
  }

  return JSON.stringify(payload);
}

function createDataUri(document: string): string {
  return `data:application/json;base64,${Buffer.from(document, 'utf8').toString('base64')}`;
}

export function buildFeedbackForEligibility(
  eligibility: AgentEligibility,
  walletAddress: string,
  now: Date = new Date()
): AgentFeedback {
  const config = getConfig();
  const context = createFeedbackTemplateContext(eligibility, walletAddress, now);

  const tag1 = renderTemplate(config.FEEDBACK_TAG1, context);
  const tag2 = renderTemplate(config.FEEDBACK_TAG2, context);
  const endpoint = renderTemplate(config.FEEDBACK_ENDPOINT, context);
  const configuredUri = renderTemplate(config.FEEDBACK_URI, context);
  const configuredHash = renderTemplate(config.FEEDBACK_HASH, context);

  let feedbackURI = '';
  let feedbackHash = '0x0000000000000000000000000000000000000000000000000000000000000000';

  if (config.FEEDBACK_URI_MODE === 'none') {
    feedbackURI = '';
  } else if (
    config.FEEDBACK_URI_MODE === 'static' ||
    (config.FEEDBACK_URI_MODE === 'auto' && configuredUri !== '')
  ) {
    feedbackURI = configuredUri;
    feedbackHash = configuredHash || feedbackHash;
  } else {
    const document = buildGeneratedFeedbackDocument(context, endpoint, tag1, tag2);
    feedbackURI = createDataUri(document);
    feedbackHash = ethers.keccak256(ethers.toUtf8Bytes(document));
  }

  return {
    agentId: eligibility.agent,
    value: config.FEEDBACK_VALUE,
    decimals: config.FEEDBACK_DECIMALS,
    tag1,
    tag2,
    endpoint,
    feedbackURI,
    feedbackHash,
  };
}
