function classifyMessage(raw, parsedIntent, currentState) {
  const text = (raw || '').trim();
  const lower = text.toLowerCase();

  if (!text) {
    return { kind: 'unknown', suggestedWorkflow: null, raw: text };
  }

  if (lower === 'all' || /^\d+(?:\s*(?:,|and)\s*\d+)*$/.test(lower)) {
    return { kind: 'selection', suggestedWorkflow: currentState?.workflow || null, raw: text };
  }

  if (/^(thanks|thank you|cheers|nice one|legend|perfect|great stuff|ta)\b/i.test(text)) {
    return { kind: 'social', suggestedWorkflow: null, raw: text };
  }

  if (/^(when|when's|when is|what time|what day|has|is|did)\b/i.test(lower)) {
    return { kind: 'status_query', suggestedWorkflow: 'query_job_status', raw: text };
  }

  if (/(quote|schedule|book|invoice|paid|chase|follow up|archive|delete|remove|done)\b/i.test(lower)) {
    const intentToWorkflow = {
      quote: 'create_quote',
      schedule: 'schedule_job',
      book: 'schedule_job',
      invoice: 'send_invoice',
      paid: 'mark_paid',
      chase: 'chase_payment',
      'follow up': 'follow_up',
      archive: 'archive_job',
      delete: 'archive_job',
      remove: 'archive_job',
      done: 'complete_job',
    };

    const match = lower.match(/quote|schedule|book|invoice|paid|chase|follow up|archive|delete|remove|done/);
    return {
      kind: 'new_action',
      suggestedWorkflow: intentToWorkflow[match?.[0]] || null,
      raw: text,
    };
  }

  if (currentState?.workflow) {
    return { kind: 'follow_up_answer', suggestedWorkflow: currentState.workflow, raw: text };
  }

  if (parsedIntent?.intent && parsedIntent.intent !== 'unknown') {
    return { kind: 'new_action', suggestedWorkflow: parsedIntent.intent, raw: text };
  }

  return { kind: 'unknown', suggestedWorkflow: null, raw: text };
}

module.exports = { classifyMessage };
