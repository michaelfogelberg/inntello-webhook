// InnshHub — Inntello Voice Agent Webhook Server
// Kör på Railway. Hanterar alla Twilio-webhooks.
// ─────────────────────────────────────────────

const express = require('express')
const twilio = require('twilio')
const { createClient } = require('@supabase/supabase-js')
const transfer = require('./transfer')

const app = express()
app.use(express.urlencoded({ extended: false }))
app.use(express.json())

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

// ── INKOMMANDE SAMTAL ────────────────────────────────────────────────
app.post('/voice/incoming', async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse()
  const callSid = req.body.CallSid
  const from = req.body.From

  try {
    await supabase.from('calls').insert({
      twilio_call_sid: callSid,
      phone_number: from,
      status: 'active',
    })

    const { data: customer } = await supabase
      .from('leads')
      .select('*')
      .eq('phone', from)
      .single()

    const greeting = customer
      ? `Hej ${customer.name}! Det är jag Lina från StoreInn. Hur kan jag hjälpa dig idag?`
      : 'Hej och välkommen till StoreInn. Du kan prata svenska eller engelska.'

    const gather = twiml.gather({
      input: 'speech',
      language: 'sv-SE',
      speechTimeout: 'auto',
      action: `/voice/process?callSid=${callSid}&customerId=${customer?.id ?? 'new'}`,
      method: 'POST'
    })

    gather.say({ voice: 'Polly.Astrid', language: 'sv-SE' }, greeting)
    twiml.redirect('/voice/incoming')
  } catch (error) {
    console.error('Error in incoming:', error)
    twiml.say({ language: 'sv-SE' }, 'Tekniskt fel. Var god försök igen.')
    twiml.hangup()
  }

  res.type('text/xml').send(twiml.toString())
})

// ── BEARBETA SPEECH INPUT ────────────────────────────────────────────
app.post('/voice/process', async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse()
  const speechResult = req.body.SpeechResult
  const callSid = req.query.callSid
  const customerId = req.query.customerId

  try {
    // Keyword detection i bakgrunden
    fetch(`${process.env.SUPABASE_URL}/functions/v1/keyword-detector`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}`
      },
      body: JSON.stringify({
        transcript_fragment: speechResult,
        call_id: await getCallId(callSid)
      })
    }).catch(err => console.error('Keyword detection error:', err))

    // AI-svar
    const response = await fetch(`${process.env.SUPABASE_URL}/functions/v1/dialog-test`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}`
      },
      body: JSON.stringify({
        message: speechResult,
        customer_type: customerId === 'new' ? 'new' : 'known',
        scenario: 'auto'
      })
    })

    const aiResponse = await response.json()

    if (aiResponse.routing_decision?.should_escalate) {
      const callId = await getCallId(callSid)
      const result = await transfer.initiateTransfer(
        callSid,
        aiResponse.routing_decision.route_to,
        aiResponse.routing_decision.reason,
        `${aiResponse.routing_decision.reason}. Köpsignal: ${aiResponse.has_purchase_signal ? 'Ja' : 'Nej'}`,
        null // leadId
      )

      if (result.success) {
        twiml.say({ language: 'sv-SE' }, 'Ett ögonblick, jag kopplar dig till rätt person.')
        twiml.play({ loop: 0 }, 'http://com.twilio.music.classical.s3.amazonaws.com/BusssyP_-_Moments.mp3')
      } else {
        twiml.say({ language: 'sv-SE' }, 'Ingen agent är tillgänglig just nu. Vill du bli uppringd?')
        twiml.redirect('/voice/callback')
      }
    } else {
      const gather = twiml.gather({
        input: 'speech',
        language: aiResponse.detected_language === 'en' ? 'en-US' : 'sv-SE',
        speechTimeout: 'auto',
        action: `/voice/process?callSid=${callSid}&customerId=${customerId}`,
        method: 'POST'
      })
      gather.say({
        language: aiResponse.detected_language === 'en' ? 'en-US' : 'sv-SE'
      }, aiResponse.response)
    }
  } catch (error) {
    console.error('Error in process:', error)
    twiml.say({ language: 'sv-SE' }, 'Ursäkta, kan du upprepa?')
    twiml.redirect(`/voice/process?callSid=${callSid}&customerId=${customerId}`)
  }

  res.type('text/xml').send(twiml.toString())
})

// ── TRANSFER ROUTES ──────────────────────────────────────────────────

// Agent svarar på förfrågan
app.post('/voice/transfer/agent-response', async (req, res) => {
  const { Digits } = req.body
  const { transferId } = req.query
  const twiml = new twilio.twiml.VoiceResponse()

  const result = await transfer.handleAgentResponse(transferId, Digits)

  if (result.action === 'accepted') {
    twiml.say({ language: 'sv-SE' }, 'Du är nu inkopplad. Kunden hör dig.')
  } else if (result.action === 'declined') {
    twiml.say({ language: 'sv-SE' }, 'Förstått. Samtalet går tillbaka till Lina.')
    twiml.hangup()
  } else {
    twiml.say({ language: 'sv-SE' }, 'Omdirigerar till nästa agent.')
    twiml.hangup()
  }

  res.type('text/xml').send(twiml.toString())
})

// Agent svarar inte — timeout
app.post('/voice/transfer/agent-timeout', async (req, res) => {
  const { transferId } = req.query
  const twiml = new twilio.twiml.VoiceResponse()

  await supabase.from('transfers')
    .update({ status: 'failed', decline_reason: 'agent_timeout' })
    .eq('id', transferId)

  twiml.say({ language: 'sv-SE' },
    'Agenten svarade inte. Vill du vänta i kö eller bli uppringd senare?'
  )
  twiml.redirect('/voice/callback')

  res.type('text/xml').send(twiml.toString())
})

// Konferens-status (join/leave events)
app.post('/voice/transfer/conference-status', async (req, res) => {
  const { StatusCallbackEvent } = req.body
  const { transferId } = req.query

  if (StatusCallbackEvent === 'participant-join') {
    setTimeout(async () => {
      const { data: t } = await supabase
        .from('transfers')
        .select('*')
        .eq('id', transferId)
        .single()

      if (t) {
        await transfer.linaPresentsAndLeaves(transferId, 'kund', 'kollegan')
      }
    }, 3000)
  }

  if (StatusCallbackEvent === 'conference-end') {
    await supabase.from('transfers')
      .update({ status: 'completed', completed_at: new Date().toISOString() })
      .eq('id', transferId)

    const { data: t } = await supabase.from('transfers').select('agent_id').eq('id', transferId).single()
    if (t?.agent_id) {
      await supabase.from('agent_availability')
        .update({ status: 'available', current_call_id: null })
        .eq('agent_id', t.agent_id)
    }
  }

  res.status(200).send('OK')
})

// ── STATUS CALLBACK ──────────────────────────────────────────────────
app.post('/voice/status', async (req, res) => {
  const { CallSid, CallStatus, CallDuration } = req.body

  if (CallStatus === 'completed') {
    const { data: call } = await supabase
      .from('calls').select('*').eq('twilio_call_sid', CallSid).single()

    // Trigga CRM-uppdatering
    if (call) {
      await fetch(`${process.env.SUPABASE_URL}/functions/v1/call-to-crm`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}`
        },
        body: JSON.stringify({
          call_sid: CallSid,
          caller_number: call.phone_number,
          transcript: call.transcript,
          duration_seconds: parseInt(CallDuration) || 0
        })
      }).catch(err => console.error('CRM update error:', err))
    }
  }

  await supabase.from('calls').update({
    status: CallStatus === 'completed' ? 'completed' : CallStatus,
    duration_seconds: parseInt(CallDuration) || 0,
    ended_at: new Date().toISOString()
  }).eq('twilio_call_sid', CallSid)
  res.status(200).send('OK')
})

// ── INTELLIGENT KÖ ──────────────────────────────────────────────────
app.post('/voice/queue', async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse()
  const { callSid } = req.query

  const { data: queueEntry } = await supabase
    .from('queue_entries').select('*')
    .eq('call_id', await getCallId(callSid)).single()

  const position = queueEntry?.position || 1
  const estimatedWait = queueEntry?.estimated_wait_minutes || 5

  const gather = twiml.gather({
    input: 'speech', language: 'sv-SE', speechTimeout: 'auto',
    action: `/voice/queue/qualify?callSid=${callSid}`, timeout: 30
  })

  if (position === 1) {
    gather.say({ language: 'sv-SE' },
      'Du är näst på tur. Medan du väntar — kan du berätta lite mer om vad du behöver hjälp med?')
  } else {
    gather.say({ language: 'sv-SE' },
      `Du är nummer ${position} i kön. Uppskattad väntetid är ${estimatedWait} minuter. Kan du berätta vad ditt ärende gäller?`)
  }

  twiml.pause({ length: 180 })
  twiml.redirect(`/voice/queue/callback-offer?callSid=${callSid}`)
  res.type('text/xml').send(twiml.toString())
})

app.post('/voice/queue/callback-offer', async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse()
  const { callSid } = req.query

  const gather = twiml.gather({
    numDigits: 1,
    action: `/voice/queue/callback-response?callSid=${callSid}`,
    timeout: 10
  })
  gather.say({ language: 'sv-SE' },
    'Väntetiden är längre än vanligt. Tryck 1 för att bli uppringd. Tryck 2 för att boka tid. Tryck 3 för att fortsätta vänta.')
  res.type('text/xml').send(twiml.toString())
})

// ── HEALTH CHECK ─────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    environment: process.env.ENVIRONMENT || 'test',
    timestamp: new Date().toISOString()
  })
})

async function getCallId(callSid) {
  const { data } = await supabase
    .from('calls')
    .select('id')
    .eq('twilio_call_sid', callSid)
    .single()
  return data?.id
}

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`Inntello webhook server running on port ${PORT}`)
})
