function classifyMessage(raw, parsedIntent, currentState) {
  const text = (raw || '').trim();
  const lower = text.toLowerCase();

  if (!text) {
    return { kind: 'unknown', suggestedWorkflow: null, raw: text };
  }

  if (lower === 'all' || /^\d+(?:\s*(?:,|and)\s*\d+)*$/.test(lower)) {
    return { kind: 'selection', suggestedWorkflow: currentState?.workflow || null, raw: text };
  }

  if (/^(hello|hi|hey|morning|good morning|afternoon|good afternoon|evening|good evening)\b/i.test(text)) {
    return { kind: 'social', suggestedWorkflow: 'hello', raw: text };
  }

  if (/^(thanks|thank you|cheers|nice one|legend|perfect|great stuff|ta)\b/i.test(text)) {
    return { kind: 'social', suggestedWorkflow: 'thanks', raw: text };
  }

  if (/^(what jobs do i have|what have i got on|what jobs are open|what jobs do i have on|what have i got)$/i.test(lower)) {
    return { kind: 'overview_query', suggestedWorkflow: 'open_jobs', raw: text };
  }

  if (/^(what jobs do i have today|what have i got on today|what's on today|whats on today)$/i.test(lower)) {
    return { kind: 'overview_query', suggestedWorkflow: 'view_schedule_today', raw: text };
  }

  if (/^(what jobs do i have tomorrow|what have i got on tomorrow|what's on tomorrow|whats on tomorrow)$/i.test(lower)) {
    return { kind: 'overview_query', suggestedWorkflow: 'view_schedule_tomorrow', raw: text };
  }

  if (/^(what jobs do i have this week|what have i got on this week|what's on this week|whats on this week)$/i.test(lower)) {
    return { kind: 'overview_query', suggestedWorkflow: 'view_schedule_week', raw: text };
  }

  if (/(change this to|change it to|move this to|move it to|reschedule this to|reschedule it to|change this|move this|reschedule this)/i.test(lower)) {
    return { kind: 'new_action', suggestedWorkflow: 'schedule_job', raw: text };
  }

  if (/^(when|when's|when is|what time|what day|has|is|did)\b/i.test(lower)) {
    return { kind: 'entity_query', suggestedWorkflow: 'query_job_status', raw: text };
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

  if (/^£?\s*\d+(?:\.\d{1,2})?$/.test(text)) {
    return { kind: 'follow_up_answer', suggestedWorkflow: 'create_quote', raw: text };
  }

  if (/^(monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow|next\s+\w+|\d{1,2}(?::\d{2})?\s*(?:am|pm)?)$/i.test(text)) {
    return { kind: 'follow_up_answer', suggestedWorkflow: 'schedule_job', raw: text };
  }

  if (parsedIntent?.intent && parsedIntent.intent !== 'unknown') {
    return { kind: 'new_action', suggestedWorkflow: parsedIntent.intent, raw: text };
  }

  return { kind: 'unknown', suggestedWorkflow: null, raw: text };
}

module.exports = { classifyMessage };
