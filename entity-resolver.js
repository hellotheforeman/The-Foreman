const db = require('./db');

function extractReferenceText({ parsedIntent, raw }) {
  if (parsedIntent?.query) return parsedIntent.query;
  if (parsedIntent?.name) return parsedIntent.name;
  if (raw) {
    const match = raw.match(/(?:for|with|to|book|schedule|quote|invoice|chase|archive|delete|remove)\s+([a-z][a-z\s'.-]+)/i);
    if (match) return match[1].trim();
  }
  return raw || '';
}

async function findCandidateJobs({ businessId, query }) {
  const trimmed = (query || '').trim();
  if (!trimmed) return [];

  const [byName, byDescription, likely] = await Promise.all([
    db.findOpenJobsByCustomerName(businessId, trimmed),
    db.findJobsByDescription(businessId, trimmed),
    db.findLikelyOpenJobs(businessId, trimmed),
  ]);

  const seen = new Set();
  return [...likely, ...byName, ...byDescription].filter((job) => {
    if (seen.has(job.id)) return false;
    seen.add(job.id);
    return true;
  });
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

async function resolveSingleJobReference({ businessId, parsedIntent, raw, state }) {
  if (parsedIntent?.jobId) {
    const job = await db.getJobWithCustomer(parsedIntent.jobId);
    return job ? { status: 'resolved', job } : { status: 'missing', job: null, jobs: [] };
  }

  if (state?.jobId) {
    const job = await db.getJobWithCustomer(state.jobId);
    if (job) return { status: 'resolved', job };
  }

  const openJobs = await db.getOpenJobs(businessId);
  if (openJobs.length === 1) {
    return { status: 'resolved', job: openJobs[0] };
  }

  const query = extractReferenceText({ parsedIntent, raw });
  const candidates = rankCandidateJobs(await findCandidateJobs({ businessId, query }), query);

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
  findCandidateJobs,
  rankCandidateJobs,
  resolveSingleJobReference,
};
