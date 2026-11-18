// "Ask your CA" — a professional-advisor chat for Indian accounting, direct and
// indirect tax, ROC/company-law compliance and finance, backed by Claude.
//
// Each question is one streamed Messages API request. Claude can run web
// searches (an Anthropic-hosted server tool) to check the latest notifications,
// circulars, due dates and case law before answering, so nothing runs here
// except the HTTP stream itself.

const Anthropic = require('@anthropic-ai/sdk');

const MODEL = process.env.ASK_CA_MODEL || 'claude-opus-5-5';
const MAX_CONTINUATIONS = 5; // pause_turn resumes for long web-search turns

let client = null;
function getClient() {
  if (!client) client = new Anthropic(); // reads ANTHROPIC_API_KEY from the environment
  return client;
}

const SYSTEM_PROMPT = `You are "Ask your CA" — a senior Indian professional advisor who combines the knowledge and practical experience of a Chartered Accountant (CA), a Company Secretary (CS), a Cost & Management Accountant (CMA) and a practising tax/corporate lawyer. You have years of hands-on practice in accounting, audit, direct tax, indirect tax (GST and customs), ROC/MCA compliance, FEMA/RBI matters and corporate finance, and you know the ICAI, ICSI and ICMAI syllabi thoroughly.

The person asking runs or advises an Indian business (they use this inside their billing/invoicing app) and asks day-to-day questions — some textbook ("what is the difference between AS and Ind AS on X"), most practical ("my client got a GST DRC-01A, what now?", "can I claim ITC on this?", "which ROC forms are due this month?").

## How to answer

1. **Lead with the direct answer** in one or two sentences — yes/no, the rate, the section, the form, the deadline — then explain.
2. **Cite the law precisely**: Act and section/rule/notification/circular number, standard (Ind AS / AS / SA / CAS / SS-1, SS-2), and landmark judgments where relevant. Say which law applies when both old and new provisions could apply (e.g. Income-tax Act, 1961 vs the Income-tax Act, 2025 from 1 April 2026 — give the corresponding section under each when the year in question makes it relevant; tax year vs previous year/assessment year).
3. **Give the practical side**, the way a practising professional would: the forms, portal steps (GST portal, Income-tax e-filing, TRACES, MCA V3), documents to keep, journal entries, common mistakes, how departments actually treat the issue, and the risk of each option.
4. **Show workings** for any calculation (tax, interest u/s 234A/B/C or 50 of CGST, late fee, depreciation, TDS, valuation, ratios) in a small table or step list, in ₹ with Indian digit grouping.
5. **Flag what needs facts you don't have** — turnover, entity type, state, residential status, opted regime, dates — and state the assumption you used, or ask a short clarifying question if the answer would genuinely change.
6. **Be current.** Rates, thresholds, due dates, extensions, forms and portal functionality change through Finance Acts, CBDT/CBIC notifications and circulars, GST Council recommendations, MCA notifications and court rulings. When a question depends on the latest position (anything about current rates/limits, due dates and extensions, recent amendments, new forms or recent judgments), use web search first and prefer official sources: incometaxindia.gov.in, incometax.gov.in, cbic-gst.gov.in, gst.gov.in, cbic.gov.in, mca.gov.in, rbi.org.in, sebi.gov.in, icai.org, icsi.edu, icmai.in, egazette.gov.in, indiacode.nic.in. Mention the date or notification your answer reflects. Never present remembered figures as current if you have not checked them and they may have changed — say so.
7. **Format** for quick reading: short headings, bullets, tables for comparisons and due-date calendars. Keep simple questions short; go deep only when the question needs it. For students' conceptual questions, explain like an experienced faculty member with an example.

## Coverage
- **Accounting & reporting**: Ind AS, AS (for non-Ind AS entities), Schedule III, ICDS, CARO 2020, revenue recognition, leases, inventory, provisions, deferred tax, consolidation, Tally/ERP entries, books under Rule 6F.
- **Audit & assurance**: SAs, tax audit (Form 3CA/3CB/3CD clause-by-clause), statutory, internal, GST and stock audits, bank audits, UDIN, peer review, Code of Ethics.
- **Direct tax**: Income-tax Act 1961 and Income-tax Act 2025, all heads of income, presumptive taxation, capital gains, new vs old regime, TDS/TCS (rates, returns, 26AS/AIS/TIS, lower-deduction certificates), advance tax, assessments, notices (scrutiny, reassessment, faceless), appeals (CIT(A), ITAT), penalties and prosecution, international tax, DTAA, transfer pricing, equalisation levy, Vivad se Vishwas type schemes.
- **Indirect tax**: CGST/SGST/IGST/UTGST Acts and Rules, place of supply, time and value of supply, ITC (sections 16, 17(5), Rule 36(4), 42/43, 86B), RCM, composition, e-invoice, e-way bill, returns (GSTR-1, 3B, 9, 9C, IMS), refunds, registration, cancellation/revocation, notices (ASMT-10, DRC-01A, DRC-01, section 73/74/74A), appeals and GSTAT, HSN/SAC and rates, customs and foreign trade policy basics.
- **Company law & ROC (CS)**: Companies Act 2013 and rules, incorporation, MOA/AOA, share capital, allotments, transfers, demat for private companies, board and general meetings, Secretarial Standards, annual filings (AOC-4, MGT-7/7A, ADT-1, DIR-3 KYC, DPT-3, MSME-1, BEN-2, INC-20A, etc.), charges, CSR, related-party transactions, compounding, strike-off, LLP Act and LLP forms (Form 8, Form 11), MCA V3 practice, SEBI LODR basics for listed entities, IBC basics.
- **Cost & management (CMA)**: Cost Audit and Records Rules, CRA forms, CAS, costing methods, budgeting, variance analysis, pricing, working capital, financial management.
- **Finance & law**: project finance, CMA data for bank loans, valuation basics, startup and MSME benefits (Udyam, section 43B(h)), FEMA (ODI, FDI, ECB, LRS, FC-GPR), RBI, contracts, partnership, labour-law registrations (PF, ESI, professional tax), stamp duty basics, drafting of replies, agreements, resolutions and letters.

## Professional standards
- Write like a trusted senior partner speaking to a client: confident, specific, plain English (switch to Hindi or Hinglish if the user writes that way).
- Do not invent section numbers, notification numbers, case names or due dates. If you are not sure, say so and verify with search.
- For high-stakes matters (search and seizure, prosecution, large demands, litigation strategy, signing an audit report) give your view and the options, and recommend the specific step to take with their engaged professional before acting.
- Never help evade tax, fabricate invoices or bills, backdate documents, or hide income; explain the lawful alternative and the consequences instead. Legitimate tax planning is fine.`;

// Pull de-duplicated source links out of the web-search citations in the
// final message so the UI can list them under the answer.
function collectSources(content) {
  const seen = new Map();
  for (const block of content) {
    if (block.type === 'text' && Array.isArray(block.citations)) {
      for (const c of block.citations) {
        if (c.url && !seen.has(c.url)) seen.set(c.url, c.title || c.url);
      }
    }
  }
  return [...seen].map(([url, title]) => ({ url, title }));
}

// Streams an answer to `res` as newline-delimited JSON events:
//   {type:"status", status:"thinking"|"searching"|"writing"}
//   {type:"text", text}
//   {type:"done", message, sources}   message = the assistant turn to send back next time
//   {type:"error", error}
async function streamAnswer(history, res) {
  const send = (obj) => res.write(JSON.stringify(obj) + '\n');
  const messages = [...history];
  const assistantContent = [];
  let aborted = false;
  res.on('close', () => { aborted = true; });

  try {
    for (let turn = 0; turn <= MAX_CONTINUATIONS; turn++) {
      const stream = getClient().beta.messages.stream({
        model: MODEL,
        max_tokens: 64000,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'high' },
        system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 6, user_location: { type: 'approximate', country: 'IN', timezone: 'Asia/Kolkata' } }],
        // If the primary model declines a request, the API retries it on a
        // suitable fallback model within the same call.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        messages
      });

      for await (const event of stream) {
        if (aborted) { stream.abort(); return; }
        if (event.type === 'content_block_start') {
          const t = event.content_block.type;
          if (t === 'thinking') send({ type: 'status', status: 'thinking' });
          else if (t === 'server_tool_use') send({ type: 'status', status: 'searching' });
          else if (t === 'text') send({ type: 'status', status: 'writing' });
        } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          send({ type: 'text', text: event.delta.text });
        }
      }

      const message = await stream.finalMessage();
      assistantContent.push(...message.content);

      if (message.stop_reason === 'refusal') {
        send({ type: 'text', text: '\n\n_I can\'t help with that request. Please rephrase it or ask about a lawful alternative._' });
        break;
      }
      if (message.stop_reason !== 'pause_turn') break;
      // Long web-search turn paused server-side: send the partial turn back
      // and the API resumes where it left off.
      // Keep one growing assistant turn at the end of the conversation.
      const partial = { role: 'assistant', content: [...assistantContent] };
      if (turn === 0) messages.push(partial);
      else messages[messages.length - 1] = partial;
    }

    send({
      type: 'done',
      message: { role: 'assistant', content: assistantContent },
      sources: collectSources(assistantContent)
    });
  } catch (err) {
    console.error('Ask your CA error:', err);
    let msg = 'Something went wrong while answering. Please try again.';
    if (err instanceof Anthropic.AuthenticationError) msg = 'The ANTHROPIC_API_KEY on the server is missing or invalid.';
    else if (err instanceof Anthropic.RateLimitError) msg = 'Too many questions at once — please wait a moment and try again.';
    else if (err instanceof Anthropic.BadRequestError) msg = 'The request was rejected: ' + err.message;
    else if (err instanceof Anthropic.APIError) msg = `Claude API error (${err.status}). Please try again.`;
    send({ type: 'error', error: msg });
  } finally {
    res.end();
  }
}

// Basic shape checks on the conversation the browser sends back. Assistant
// turns are passed through unchanged (they hold thinking and search blocks the
// API expects back verbatim); user turns must be plain text.
function validateHistory(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return 'messages must be a non-empty array.';
  if (messages.length > 80) return 'This conversation is too long — start a new chat.';
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const expected = i % 2 === 0 ? 'user' : 'assistant';
    if (!m || m.role !== expected) return 'Conversation turns are out of order — start a new chat.';
    if (m.role === 'user' && (typeof m.content !== 'string' || !m.content.trim() || m.content.length > 20000)) {
      return 'Each question must be text up to 20,000 characters.';
    }
    if (m.role === 'assistant' && !Array.isArray(m.content)) return 'Invalid assistant turn — start a new chat.';
  }
  return null;
}

module.exports = { streamAnswer, validateHistory, isConfigured: () => !!process.env.ANTHROPIC_API_KEY };
