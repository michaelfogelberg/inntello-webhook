// transfer.js — Inntello Varm Överkoppling
// Importeras i server.js: const transfer = require('./transfer')

const twilio = require('twilio')
const { createClient } = require('@supabase/supabase-js')

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

// ── STEG 1: Initiera överkoppling ────────────────────────────────────
async function initiateTransfer(callSid, routeTo, reason, briefingText, leadId) {
  // Hitta tillgänglig agent baserat på skill
  const { data: agents } = await supabase
    .from('agent_availability')
    .select('*, profiles(*)')
    .eq('status', 'available')
    .contains('skill_tags', [routeTo])
    .order('last_updated', { ascending: true })
    .limit(1)

  if (!agents || agents.length === 0) {
    return { success: false, reason: 'no_agent_available' }
  }

  const agent = agents[0]

  // Skapa transfer-post
  const { data: transfer } = await supabase
    .from('transfers')
    .insert({
      call_id: await getCallId(callSid),
      lead_id: leadId,
      status: 'briefing',
      route_to: routeTo,
      reason: reason,
      briefing_text: briefingText,
      agent_id: agent.agent_id
    })
    .select()
    .single()

  // Ring agenten med briefing
  await callAgent(agent, transfer, briefingText)

  return { success: true, transferId: transfer.id, agent }
}

// ── STEG 2: Ring agenten med briefing ────────────────────────────────
async function callAgent(agent, transfer, briefingText) {
  const twiml = new twilio.twiml.VoiceResponse()

  const gather = twiml.gather({
    numDigits: 1,
    action: `/voice/transfer/agent-response?transferId=${transfer.id}`,
    method: 'POST',
    timeout: 15
  })

  gather.say({ language: 'sv-SE' },
    `${briefingText} Tryck 1 för att acceptera, 2 för att avvisa, 3 för att omdirigera.`
  )

  twiml.redirect(`/voice/transfer/agent-timeout?transferId=${transfer.id}`)

  await client.calls.create({
    to: agent.profiles?.phone || process.env.TEST_AGENT_NUMBER,
    from: process.env.TWILIO_PHONE_NUMBER,
    twiml: twiml.toString(),
    statusCallback: `/voice/transfer/agent-status?transferId=${transfer.id}`
  })
}

// ── STEG 3: Hantera agentens svar ────────────────────────────────────
async function handleAgentResponse(transferId, digit) {
  const { data: transfer } = await supabase
    .from('transfers')
    .select('*, calls(*)')
    .eq('id', transferId)
    .single()

  if (digit === '1') {
    await startConference(transfer)
    return { action: 'accepted' }
  } else if (digit === '2') {
    await supabase.from('transfers').update({
      status: 'declined',
      decline_reason: 'agent_declined'
    }).eq('id', transferId)
    return { action: 'declined' }
  } else if (digit === '3') {
    await supabase.from('transfers').update({ status: 'redirected' }).eq('id', transferId)
    return { action: 'redirect' }
  }
}

// ── STEG 4: Starta trekoppling ───────────────────────────────────────
async function startConference(transfer) {
  const conferenceName = `inntello-${transfer.id}`

  await supabase.from('transfers').update({
    status: 'in_conference',
    agent_accepted_at: new Date().toISOString(),
    conference_sid: conferenceName
  }).eq('id', transfer.id)

  await supabase.from('agent_availability').update({
    status: 'busy',
    current_call_id: transfer.call_id
  }).eq('agent_id', transfer.agent_id)

  const customerTwiml = new twilio.twiml.VoiceResponse()
  customerTwiml.say({ language: 'sv-SE' }, 'Nu kopplar jag in dig.')
  customerTwiml.dial().conference(conferenceName, {
    startConferenceOnEnter: true,
    endConferenceOnExit: false,
    statusCallback: `/voice/transfer/conference-status?transferId=${transfer.id}`,
    statusCallbackEvent: ['join', 'leave']
  })

  await client.calls(transfer.calls.twilio_call_sid).update({
    twiml: customerTwiml.toString()
  })

  const agentTwiml = new twilio.twiml.VoiceResponse()
  agentTwiml.dial().conference(conferenceName, {
    startConferenceOnEnter: false,
    endConferenceOnExit: true
  })

  return { conferenceName }
}

// ── STEG 5: Presentation och Linas uttåg ─────────────────────────────
async function linaPresentsAndLeaves(transferId, customerName, agentName) {
  const { data: transfer } = await supabase
    .from('transfers')
    .select('conference_sid')
    .eq('id', transferId)
    .single()

  await client.conferences(transfer.conference_sid)
    .participants.create({
      from: process.env.TWILIO_PHONE_NUMBER,
      to: process.env.TWILIO_PHONE_NUMBER,
      twiml: `<Response><Say language="sv-SE">
        Nu har jag ${agentName} med oss här, ${customerName}.
        Tack, lämnar er nu.
      </Say></Response>`
    })

  await supabase.from('transfers').update({
    lina_left_at: new Date().toISOString()
  }).eq('id', transferId)
}

// ── HJÄLPFUNKTIONER ──────────────────────────────────────────────────
async function getCallId(callSid) {
  const { data } = await supabase
    .from('calls')
    .select('id')
    .eq('twilio_call_sid', callSid)
    .single()
  return data?.id
}

module.exports = {
  initiateTransfer,
  handleAgentResponse,
  startConference,
  linaPresentsAndLeaves
}
