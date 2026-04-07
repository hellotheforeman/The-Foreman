const db = require('./db');

function extractReferenceText({ parsedIntent, raw, state }) {
  if (parsedIntent?.query) return parsedIntent.query;
  if (parsedIntent?.name) return parsedIntent.name;
  if (parsedIntent?.jobRef) return parsedIntent.jobRef;
  if (state?.focus?.customerName) return state.focus.customerName;

  const text = (raw || '').trim();
  if (!text) return '';

  const refMatch = text.match(/(?:for|with|to|book|schedule|quote|invoice|chase|follow up|paid|done)\s+([a-z][a-z\s'.-]+)/i);
  if (refMatch) return refMatch[1].trim();

  return text;
}

function rankCandidateJobs(jobs, query) {
  const trimmed = (query || '').trim().toLowerCase();
  return [...jobs].sort((a, b) => {
    const aName = (a.customer_name || '').toLowerCase();
    const bName = (b.customer_name || '').toLowerCase();
    const aDesc = (a.description || '').toLowerCase();
    const bDesc = (b.description || '').toLowerCase();

    const aScore = (aName.includes(trimmed) ? 3 : 0) + (aDesc.includes(trimmed) ? 2 : 0);
    const bScore = (bName.includes(trimmed) ? 3 : 0) + (bDesc.includes(trimmed) ? 2 : 0);
    return bScore - aScore;
  });
}

async function findCandidateJobs({ businessId, query }) {
  const trimmed = (query || '').trim();
  if (!trimmed) return [];

  const jobs = await db.findLikelyOpenJobs(businessId, trimmed);
  return rankCandidateJobs(jobs, trimmed);
}

async function resolveSingleJobReference({ businessId, parsedIntent, raw, state }) {
  if (parsedIntent?.jobId) {
    const job = await db.getJobWithCustomer(parsedIntent.jobId, businessId);
    return job ? { status: 'resolved', job } : { status: 'missing', job: null, jobs: [] };
  }

  if (state?.focus?.jobId) {
    const job = await db.getJobWithCustomer(state.focus.jobId, businessId);
    if (job) return { status: 'resolved', job };
  }

  const openJobs = await db.getOpenJobs(businessId);
  if (openJobs.length === 1) {
    return { status: 'resolved', job: openJobs[0] };
  }

  const query = extractReferenceText({ parsedIntent, raw, state });
  const candidates = await findCandidateJobs({ businessId, query });

  if (candidates.length === 1) {
    return { status: 'resolved', job: candidates[0] };
  }

  if (candidates.length > 1) {
    return { status: 'multiple', job: null, jobs: candidates };
  }

  return { status: 'missing', job: null, jobs: [] };
}

module.exports = {
  extractReferenceText,
  rankCandidateJobs,
  findCandidateJobs,
  resolveSingleJobReference,
};
