import {decide, type DecisionQuestion} from '../../server/decision-model.ts';
import type {StationContext} from '../../server/runtime.ts';

interface LinkCandidate {href: string; text?: string}
interface DecisionRole {id: string; instructions: string}
interface SourcePage {url: string; text: string}
interface Classification {
  kind: string;
  answers: {q: number; yes: boolean; quote: string}[];
  confidence: number;
}

const short = (value: string, limit: number) => value.length <= limit ? value : value.slice(0, limit);
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const fieldText = (value: unknown, limit: number) => typeof value === 'string' ? short(value, limit) : '';

/** Indices always resolve to supplied originals; the model cannot invent URLs. */
export async function chooseSourceLinks(ctx: StationContext, candidates: readonly LinkCandidate[],
  roles: readonly DecisionRole[], purpose: string, description = ''): Promise<Map<string, string>> {
  if (candidates.length < 2 || !roles.length) return new Map();
  const sample = candidates.slice(0, Math.min(10, Math.floor(64 / roles.length) - 1));
  const criteria = Object.fromEntries(sample.map((candidate, index) =>
    [`p${index}`, `${fieldText(candidate.text, 55)} ${short(candidate.href, 135)}`.trim()]));
  criteria.none = 'No supplied page is suitable, or evidence is insufficient.';
  const questions: Record<string, DecisionQuestion> = Object.fromEntries(roles.slice(0, 8).map(role => [role.id, {
    type: 'choice', instructions: role.instructions + ' Choose only a supplied page ID; none when uncertain.', criteria,
  }]));
  const response = await decide(ctx, {purpose, state: {
    scope: short(description, 240),
    pages: sample.map((candidate, index) => ({id: `p${index}`, url: short(candidate.href, 135), text: fieldText(candidate.text, 55)})),
  }, questions});
  const selected = new Map<string, string>();
  if (!response) return selected;
  for (const role of roles) {
    const answer = response.answers[role.id];
    if (answer?.type !== 'choice' || answer.confidence < 0.7 ||
        (answer.probabilities[answer.choice] ?? 0) < 0.75 || !/^p\d+$/.test(answer.choice)) continue;
    const candidate = sample[Number(answer.choice.slice(1))];
    if (candidate) selected.set(role.id, candidate.href);
  }
  return selected;
}

/** Keep every original candidate, including fallback pages and SPA query strings. */
export async function prioritizeCaptureCandidates<T extends {href: string}>(ctx: StationContext,
  candidates: readonly T[], links: readonly LinkCandidate[], role: 'breadth' | 'proof'): Promise<T[]> {
  if (candidates.length < 2) return [...candidates];
  const scope = ctx.token.data.understanding;
  const takeaway = record(scope) && record(scope.takeaway) ? fieldText(scope.takeaway.text, 180) : '';
  const choices = await chooseSourceLinks(ctx, candidates.map(candidate => ({href: candidate.href,
    text: links.find(link => link.href === candidate.href)?.text})), [{id: role, instructions: role === 'breadth'
    ? 'Which page is the best first place to inspect this entry’s own catalogue or range of offerings? Prefer product content over login, customer showcases, pricing and source code listings. This only orders browsing; it cannot certify visual quality.'
    : 'Which page is the best first place to inspect one concrete demo or component of this entry? Prefer a usable example over marketing, login, pricing and unrelated sibling products. This only orders browsing; it cannot certify an actual rendered stage.'}],
  `curation.capture.${role}.priority`, `${fieldText(ctx.token.data.title, 80)} ${takeaway}`);
  const selected = choices.get(role);
  return selected ? [...candidates.filter(candidate => candidate.href === selected), ...candidates.filter(candidate => candidate.href !== selected)] : [...candidates];
}

/** Eight atomic questions in one call: seven ordered predicates and one exact quote. */
export async function classifyEvidence(ctx: StationContext, kinds: readonly string[], role: string,
  pages: readonly SourcePage[]): Promise<Classification | null> {
  const rules = kinds.map((kind, index) => role.split(/\r?\n/).find(line =>
    new RegExp(`^${index + 1}\\.\\s+\\*\\*${kind}\\b`).test(line)));
  if (rules.some(rule => !rule || rule.length > 350) || kinds.length !== 7) return null;
  // Keep entire, contiguous source sentences. No generated quotations or silent
  // slicing of a sentence that might discard a negation or license exception.
  const excerpts: string[] = [];
  let excerptCharacters = 0;
  for (const page of pages) {
    for (const sentence of page.text.split(/(?<=[.!?。！？])\s+|[\r\n]+/)) {
      const quote = sentence.trim();
      if (quote.length < 18 || quote.length > 180 || excerpts.includes(quote) || excerptCharacters + quote.length > 1200) continue;
      excerpts.push(quote);
      excerptCharacters += quote.length;
      if (excerpts.length === 12) break;
    }
    if (excerpts.length === 12) break;
  }
  if (!excerpts.length) return null;
  // A high-scoring fallback category is not positive evidence of a worthwhile
  // design. The final work category always goes through the existing agent.
  const questions: Record<string, DecisionQuestion> = Object.fromEntries(kinds.map((kind, index) => [`q${index + 1}`, {
    type: 'noul', instructions: `${rules[index]} Judge only supplied text. The category is what the visitor takes away, not its implementation technology. Give an uncertain score when the text cannot establish yes or no.`,
  }]));
  questions.quote = {type: 'choice', instructions: `Select the supplied exact sentence that directly supports the FIRST yes in these ordered rules: ${rules.join(' ')} A product name or mention of a technology is insufficient. Choose none if no sentence establishes it.`,
    criteria: {...Object.fromEntries(excerpts.map((quote, index) => [`s${index}`, quote])), none: 'No direct supporting sentence'}};
  const response = await decide(ctx, {purpose: 'curation.classify', state: {
    sourceSentences: excerpts.map((text, index) => ({id: `s${index}`, text})),
  }, questions});
  if (!response) return null;
  const answers: Classification['answers'] = [];
  let firstYes = -1;
  let confidence = 1;
  for (let index = 0; index < kinds.length; index++) {
    const answer = response.answers[`q${index + 1}`];
    if (answer?.type !== 'noul' || !Number.isFinite(answer.noul)) return null;
    if (answer.noul >= 0.95) {
      firstYes = index;
      confidence = Math.min(confidence, answer.noul);
      break;
    }
    if (answer.noul > 0.05) return null;
    confidence = Math.min(confidence, 1 - answer.noul);
    answers.push({q: index + 1, yes: false, quote: ''});
  }
  if (firstYes < 0 || firstYes === kinds.length - 1) return null;
  const selected = response.answers.quote;
  if (selected?.type !== 'choice' || selected.confidence < 0.9 ||
      (selected.probabilities[selected.choice] ?? 0) < 0.9 || !/^s\d+$/.test(selected.choice)) return null;
  const quote = excerpts[Number(selected.choice.slice(1))];
  if (!quote || !pages.some(page => page.text.includes(quote))) return null;
  answers.push({q: firstYes + 1, yes: true, quote});
  return {kind: kinds[firstYes], answers, confidence: Math.min(confidence, selected.confidence)};
}

const FACTS = ['author', 'organization', 'repository', 'license', 'pricing', 'sourceCode', 'commercial'] as const;
const FACT_PURPOSES = {
  author: 'the actual creator or maintainer, not a testimonial author',
  organization: 'the organization owning or maintaining the product',
  repository: 'the product’s actual source repository',
  license: 'the license and the exact material it covers',
  pricing: 'the free or paid offering and any separate paid tier',
  sourceCode: 'whether this product’s source code is public, independently of its license',
  commercial: 'commercial usage rights and restrictions for the actual offering',
  repositoryLicense: 'the license of this product’s source code, not the license of generated artwork or downloaded assets',
};

/** Prioritize relevant existing evidence without deleting any historical quote. */
export async function prioritizeFactSources(ctx: StationContext, pages: readonly SourcePage[]): Promise<SourcePage[]> {
  if (pages.length < 2) return [...pages];
  const sample = pages.slice(0, 8);
  const criteria = {...Object.fromEntries(sample.map((page, index) => [`p${index}`, `Evidence from ${short(page.url, 100)}`])), none: 'No supplied evidence'};
  const questions: Record<string, DecisionQuestion> = Object.fromEntries(FACTS.map(field => [field, {
    type: 'choice', instructions: `Which supplied page most directly provides evidence for ${FACT_PURPOSES[field]}? Select none if uncertain; a URL name alone is not proof.`, criteria,
  }]));
  const response = await decide(ctx, {purpose: 'curation.facts.sources', state: {
    pages: sample.map((page, index) => ({id: `p${index}`, url: short(page.url, 100), excerpt: short(page.text, 160)})),
  }, questions});
  if (!response) return [...pages];
  const selected = new Set<SourcePage>();
  for (const field of FACTS) {
    const answer = response.answers[field];
    if (answer?.type !== 'choice' || answer.confidence < 0.7 ||
        (answer.probabilities[answer.choice] ?? 0) < 0.75 || !/^p\d+$/.test(answer.choice)) continue;
    const page = sample[Number(answer.choice.slice(1))];
    if (page) selected.add(page);
  }
  return [...selected, ...pages.filter(page => !selected.has(page))];
}

/** These are review leads, never approval, replacements for sources, or vetoes. */
export async function factReviewLeads(ctx: StationContext): Promise<string> {
  const facts = ctx.token.data.facts;
  if (!record(facts)) return '';
  const known = [...FACTS, 'repositoryLicense' as const].filter(field => record(facts[field]) && typeof facts[field].value === 'string' && facts[field].value !== 'unknown');
  if (!known.length) return '';
  const questions: Record<string, DecisionQuestion> = Object.fromEntries(known.map(field => [field, {
    type: 'noul', instructions: `Does the supplied verbatim quote entail the ${field} value within its stated scope? Check ${FACT_PURPOSES[field]}. Absence or truncation of supporting text is uncertain, not proof of contradiction.`,
  }]));
  const response = await decide(ctx, {purpose: 'curation.facts.review', state: {
    claims: Object.fromEntries(known.map(field => {
      const fact = facts[field] as Record<string, unknown>;
      return [field, {value: fieldText(fact.value, 65), scope: fieldText(fact.scope, 90), quote: fieldText(fact.quote, 200), truncated: typeof fact.quote === 'string' && fact.quote.length > 200}];
    })),
  }, questions});
  if (!response) return '';
  const concerns = known.filter(field => {
    const answer = response.answers[field];
    return answer?.type === 'noul' && answer.noul <= 0.1;
  });
  return concerns.length ? `\n\n文字预检提示（仅待核对线索，不能当作事实或审查结论）：${concerns.map(field => `facts.${field} 的引用与值/范围可能不一致`).join('；')}。请独立检查下方完整原文，若证据成立应忽略提示。` : '';
}

export async function copyReviewLeads(ctx: StationContext): Promise<string> {
  const copy = ctx.token.data.copy;
  if (!record(copy)) return '';
  const facts = record(ctx.token.data.facts) ? ctx.token.data.facts : {};
  const questions: Record<string, DecisionQuestion> = {
    price_scope: {type: 'noul', instructions: 'Does the copy respect the stated pricing and license scope without presenting a free part as an entirely free product or treating artwork permission as source-code permission?'},
    supported_claims: {type: 'noul', instructions: 'Are concrete feature, scale and quantity claims in the copy supported by supplied facts? Missing facts mean uncertainty. Do not invent numbers.'},
    restrained_tone: {type: 'noul', instructions: 'Does the copy state concrete uses without unsupported superlatives, guaranteed outcomes, promotional hype or claims of having personally tested unobserved behavior?'},
    useful_takeaway: {type: 'noul', instructions: 'Does the takeaway explain what a visitor can actually obtain or do, rather than only saying the site looks beautiful or is modern?'},
  };
  const response = await decide(ctx, {purpose: 'curation.copy.review', state: {
    copy: Object.fromEntries(['name', 'takeawayZh', 'noteZh', 'descriptionZh'].map(key => [key, fieldText(copy[key], key === 'noteZh' ? 450 : 240)])),
    facts: Object.fromEntries(['pricing', 'license', 'sourceCode', 'commercial'].map(key => {
      const fact = record(facts[key]) ? facts[key] : {};
      return [key, {value: fieldText(fact.value, 55), scope: fieldText(fact.scope, 80)}];
    })),
  }, questions});
  if (!response) return '';
  const labels: Record<string, string> = {price_scope: '价格、许可或源码范围', supported_claims: '功能/数量断言的事实依据', restrained_tone: '营销夸大或未观察行为', useful_takeaway: 'takeaway 是否说明实际用途'};
  const concerns = Object.keys(questions).filter(key => {
    const answer = response.answers[key];
    return answer?.type === 'noul' && answer.noul <= 0.1;
  });
  return concerns.length ? `\n\n文字预检提示（供独立核对，不是自动拒收）：${concerns.map(key => labels[key]).join('；')}。仍须检查完整资料和真实图片，不能用此结果代替图文对应审查。` : '';
}
