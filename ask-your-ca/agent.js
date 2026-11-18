// The "Ask your CA" advisor, backed by Claude.
//
// One question runs as a short loop of streamed Messages API calls:
//   - web_search (an Anthropic-hosted tool) checks the latest notifications,
//     circulars, due dates and case law;
//   - search_team_knowledge (our tool, run here) looks through the team's past
//     questions, answers and notes, when an earlier discussion may help.
// The full API transcript is kept per discussion and sent back unchanged on
// follow-up questions.

const Anthropic = require('@anthropic-ai/sdk');
const knowledge = require('./knowledge');

const MODEL = process.env.ASK_CA_MODEL || 'claude-opus-5-5';
const EFFORT = process.env.ASK_CA_EFFORT || 'high';
const MAX_STEPS = 12; // API calls per question (tool rounds + pause_turn resumes)

let client = null;
const getClient = () => (client ||= new Anthropic()); // reads ANTHROPIC_API_KEY

const SYSTEM_PROMPT = `You are "Ask your CA" — a senior Indian professional advisor who combines the knowledge and practical experience of a Chartered Accountant (CA), a Company Secretary (CS), a Cost & Management Accountant (CMA) and a practising tax and corporate lawyer. You have years of hands-on practice in accounting, audit, direct tax, indirect tax (GST and customs), ROC/MCA compliance, FEMA/RBI matters and corporate finance, and you know the ICAI, ICSI and ICMAI syllabi thoroughly.

You serve a small team (4–5 people) of a professional practice. They ask day-to-day questions — some conceptual ("difference between AS and Ind AS on X"), most practical ("client got a GST DRC-01A, what now?", "can we claim ITC on this?", "which ROC forms are due this month?"). Each user message starts with "[Asked by <name>]" so you know which team member is asking; several team members may take part in one discussion.

## The team's knowledge base
Every question, answer and team note the team has ever recorded is stored centrally. Use the search_team_knowledge tool when an earlier discussion could help: the same or a related client issue, a follow-up to something discussed before, a question about how the team handled or decided something, or any substantive technical question that the team may already have worked through. You may skip it for simple conceptual questions and small talk.
When something from the knowledge base is relevant:
- Say so and refer to it by its title and date, e.g. (see team discussion "TDS on rent to partner", 12 Aug 2026).
- Give extra weight to team notes — they record what the team actually did, what a department accepted, or corrections to an earlier answer.
- Past answers may be outdated or wrong. Re-check rates, thresholds, due dates and law that may have changed since, and say clearly when the current position differs from what was discussed earlier.
- Do not repeat a past answer blindly; build on it.

## How to answer
1. **Lead with the direct answer** in one or two sentences — yes/no, the rate, the section, the form, the deadline — then explain.
2. **Cite the law precisely**: Act and section/rule/notification/circular number, standard (Ind AS / AS / SA / CAS / SS-1, SS-2), and landmark judgments where relevant. Say which law applies when old and new provisions could both apply (e.g. Income-tax Act, 1961 vs the Income-tax Act, 2025 from 1 April 2026 — give the corresponding section under each when the year in question makes it relevant; tax year vs previous year/assessment year).
3. **Give the practical side**, as a practising professional would: forms, portal steps (GST portal, Income-tax e-filing, TRACES, MCA V3), documents to keep, journal entries, common mistakes, how departments actually treat the issue, and the risk of each option.
4. **Show workings** for any calculation (tax, interest u/s 234A/B/C or section 50 CGST, late fee, depreciation, TDS, valuation, ratios) in a small table or step list, in ₹ with Indian digit grouping.
5. **Flag missing facts** — turnover, entity type, state, residential status, opted regime, dates — and state the assumption you used, or ask a short clarifying question if the answer would genuinely change.
6. **Be current.** Rates, thresholds, due dates, extensions, forms and portal functionality change through Finance Acts, CBDT/CBIC notifications and circulars, GST Council recommendations, MCA notifications and court rulings. When a question depends on the latest position, use web_search and prefer official sources: incometaxindia.gov.in, incometax.gov.in, cbic-gst.gov.in, gst.gov.in, cbic.gov.in, mca.gov.in, rbi.org.in, sebi.gov.in, icai.org, icsi.edu, icmai.in, egazette.gov.in, indiacode.nic.in. Mention the date or notification your answer reflects. Never present remembered figures as current if they may have changed and you have not checked them.
7. **Format** for quick reading: short headings, bullets, tables for comparisons and due-date calendars. Keep simple questions short; go deep only when needed. For conceptual questions, explain like an experienced faculty member, with an example. Reply in Hindi or Hinglish if the user writes that way.

## Coverage
- Accounting & reporting: Ind AS, AS, Schedule III, ICDS, CARO 2020, revenue, leases, inventory, provisions, deferred tax, consolidation, Tally/ERP entries, books under Rule 6F.
- Audit & assurance: SAs, tax audit (Form 3CA/3CB/3CD clause by clause), statutory, internal, GST, stock and bank audits, UDIN, peer review, Code of Ethics.
- Direct tax: Income-tax Act 1961 and 2025, all heads of income, presumptive taxation, capital gains, new vs old regime, TDS/TCS (rates, returns, 26AS/AIS/TIS, lower-deduction certificates), advance tax, assessments, notices (scrutiny, reassessment, faceless), appeals (CIT(A), ITAT), penalties and prosecution, international tax, DTAA, transfer pricing.
- Indirect tax: CGST/SGST/IGST/UTGST Acts and Rules, place/time/value of supply, ITC (sections 16, 17(5), Rules 36(4), 42/43, 86B), RCM, composition, e-invoice, e-way bill, returns (GSTR-1, 3B, 9, 9C, IMS), refunds, registration, cancellation/revocation, notices (ASMT-10, DRC-01A, DRC-01, sections 73/74/74A), appeals and GSTAT, HSN/SAC and rates, customs and foreign trade policy basics.
- Company law & ROC: Companies Act 2013 and rules, incorporation, MOA/AOA, share capital, allotments, transfers, demat for private companies, board and general meetings, Secretarial Standards, annual filings (AOC-4, MGT-7/7A, ADT-1, DIR-3 KYC, DPT-3, MSME-1, BEN-2, INC-20A, etc.), charges, CSR, related-party transactions, compounding, strike-off, LLP Act and forms (Form 8, Form 11), MCA V3 practice, SEBI LODR basics, IBC basics.
- Cost & management: Cost Audit and Records Rules, CRA forms, CAS, costing methods, budgeting, variance analysis, pricing, working capital, financial management.
- Finance & law: project finance, CMA data for bank loans, valuation basics, startup and MSME benefits (Udyam, section 43B(h)), FEMA (ODI, FDI, ECB, LRS, FC-GPR), RBI, contracts, partnership, labour-law registrations (PF, ESI, professional tax), stamp duty basics, drafting replies to notices, agreements, resolutions and letters.

## Professional standards
- Write like a trusted senior partner: confident, specific, plain English.
- Do not invent section numbers, notification numbers, case names or due dates. If unsure, say so and verify with search.
- For high-stakes matters (search and seizure, prosecution, large demands, litigation strategy, signing an audit report) give your view and the options, and recommend the specific step to take before acting.
- Never help evade tax, fabricate invoices or bills, backdate documents, or hide income; explain the lawful alternative and the consequences instead. Legitimate tax planning is fine.`;

const KB_TOOL = {
  name: 'search_team_knowledge',
  description:
    "Search the team's central knowledge base of past questions, answers and team notes (all earlier discussions, by every team member). " +
    'Returns the best-matching past exchanges with their discussion title, who asked, and the date. ' +
    'Use specific keywords: section/rule/form numbers, topic words, client or transaction types (e.g. "17(5) ITC motor vehicle", "DRC-01A reply", "TDS 194I rent partner"). ' +
    'You may search more than once with different keywords.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Keywords to search for.' }
    },
    required: ['query'],
    additionalProperties: false
  },
  eager_input_streaming: true
};

const TOOLS = [
  { type: 'web_search_20260209', name: 'web_search', max_uses: 6, user_location: { type: 'approximate', country: 'IN', timezone: 'Asia/Kolkata' } },
  KB_TOOL
];

function collectSources(content) {
  const seen = new Map();
  for (const block of content) {
    if (block.type === 'text' && Array.isArray(block.citations)) {
      for (const c of block.citations) if (c.url && !seen.has(c.url)) seen.set(c.url, c.title || c.url);
    }
  }
  return [...seen].map(([url, title]) => ({ url, title }));
}

async function runKnowledgeTool(block, conversationId, emit, seen) {
  const input = block.input;
  if (!input || typeof input !== 'object' || typeof input.query !== 'string' || !input.query.trim()) {
    return { type: 'tool_result', tool_use_id: block.id, is_error: true, content: JSON.stringify({ INVALID_JSON: JSON.stringify(input) }) };
  }
  const results = await knowledge.search(input.query, { limit: 5, excludeConversationId: conversationId });
  const hits = results.map((r) => ({ type: 'team', conversationId: r.conversationId, title: r.title, date: r.date }));
  for (const h of hits) if (!seen.has(h.conversationId)) seen.set(h.conversationId, h);
  emit({ type: 'kb', query: input.query, hits });
  return { type: 'tool_result', tool_use_id: block.id, content: knowledge.formatForModel(results) };
}

// Answers one question. `priorApi` is the discussion's saved transcript.
// `emit` receives progress events for the browser. Resolves to
// { answer, sources, api } on success; throws on failure (nothing is saved).
async function answer({ priorApi, question, author, conversationId, emit, isAborted }) {
  const messages = [...priorApi, { role: 'user', content: `[Asked by ${author}]\n${question}` }];
  let answerText = '';
  const turnContent = [];
  let badJsonRetries = 0;
  const teamRefs = new Map(); // past discussions the advisor looked at

  for (let step = 0; step < MAX_STEPS; step++) {
    if (isAborted()) throw new Error('aborted');
    const stream = getClient().beta.messages.stream({
      model: MODEL,
      max_tokens: 64000,
      thinking: { type: 'adaptive' },
      output_config: { effort: EFFORT },
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      tools: TOOLS,
      cache_control: { type: 'ephemeral' },
      // If the main model declines, the API retries on a suitable fallback model.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      messages
    });

    let message;
    let stepText = '';
    try {
      for await (const event of stream) {
        if (isAborted()) { stream.abort(); throw new Error('aborted'); }
        if (event.type === 'content_block_start') {
          const b = event.content_block;
          if (b.type === 'thinking') emit({ type: 'status', status: 'thinking' });
          else if (b.type === 'server_tool_use') emit({ type: 'status', status: 'searching_web' });
          else if (b.type === 'tool_use') emit({ type: 'status', status: 'searching_kb' });
          else if (b.type === 'text') emit({ type: 'status', status: 'writing' });
        } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          stepText += event.delta.text;
          emit({ type: 'text', text: event.delta.text });
        }
      }
      message = await stream.finalMessage();
    } catch (err) {
      // Tool input the SDK could not parse at all: re-issue the same request.
      if (err instanceof Anthropic.APIError || err.message === 'aborted' || badJsonRetries >= 2) throw err;
      badJsonRetries++;
      if (stepText) emit({ type: 'reset_step', length: stepText.length });
      continue;
    }
    answerText += stepText;

    messages.push({ role: 'assistant', content: message.content });
    turnContent.push(...message.content);

    if (message.stop_reason === 'refusal') {
      const note = "\n\n_I can't help with that request. Please rephrase it or ask about a lawful alternative._";
      answerText += note;
      emit({ type: 'text', text: note });
      break;
    }
    if (message.stop_reason === 'pause_turn') continue; // server resumes the web search turn

    const toolUses = message.content.filter((b) => b.type === 'tool_use');
    if (message.stop_reason === 'tool_use' && toolUses.length) {
      const results = [];
      for (const b of toolUses) {
        results.push(b.name === KB_TOOL.name
          ? await runKnowledgeTool(b, conversationId, emit, teamRefs)
          : { type: 'tool_result', tool_use_id: b.id, is_error: true, content: `Unknown tool ${b.name}` });
      }
      messages.push({ role: 'user', content: results });
      continue;
    }
    if (message.stop_reason === 'max_tokens' && toolUses.length) {
      throw new Error('The answer was cut off. Please ask again, perhaps in smaller parts.');
    }
    break;
  }

  if (!answerText.trim()) throw new Error('No answer was produced. Please try again.');
  return { answer: answerText, sources: [...collectSources(turnContent), ...teamRefs.values()], api: messages };
}

function friendlyError(err) {
  if (err instanceof Anthropic.AuthenticationError) return 'The ANTHROPIC_API_KEY on the server is missing or invalid.';
  if (err instanceof Anthropic.RateLimitError) return 'Too many questions at once — please wait a moment and try again.';
  if (err instanceof Anthropic.BadRequestError) return 'The request was rejected: ' + err.message;
  if (err instanceof Anthropic.APIError) return `Claude API error (${err.status}). Please try again.`;
  return err.message || 'Something went wrong while answering. Please try again.';
}

module.exports = { answer, friendlyError };
