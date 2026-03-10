const express = require('express')
const twilio = require('twilio')
const { createClient } = require('@supabase/supabase-js')

const app = express()
app.use(express.urlencoded({ extended: false }))
app.use(express.json())

// ── LAZY INIT — kraschar inte vid start om variabler saknas ────────
function getSupabase() {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.warn('Supabase ej konfigurerad — kör utan databas')
    return null
  }
  return createClient(url, key)
}

// ── HEALTH CHECK ───────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'inntello-webhook',
    time: new Date().toISOString(),
    twilio: !!process.env.TWILIO_ACCOUNT_SID,
    supabase: !!process.env.SUPABASE_URL
  })
})

// ── INKOMMANDE SAMTAL ──────────────────────────────────────────────
app.post('/voice/incoming', (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse()
  const caller = req.body.From || 'unknown'

  console.log(`Inkommande samtal från: ${caller}`)

  const supabase = getSupabase()
  if (supabase) {
    supabase.from('calls').insert({
      caller_number: caller,
      status: 'incoming',
      started_at: new Date().toISOString()
    }).then(({ error }) => {
      if (error) console.error('Supabase insert error:', error)
    })
  }

  const gather = twiml.gather({
    input: 'speech',
    language: 'sv-SE',
    action: '/voice/process',
    method: 'POST',
    speechTimeout: 'auto',
    timeout: 5
  })

  gather.say({
    voice: 'Polly.Astrid',
    language: 'sv-SE'
  }, 'Hej! Det här är Lina på StoreInn. Hur kan jag hjälpa dig idag?')

  twiml.redirect('/voice/incoming')

  res.type('text/xml')
  res.send(twiml.toString())
})

// ── BEARBETA SVAR ──────────────────────────────────────────────────
app.post('/voice/process', async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse()
  const speechResult = req.body.SpeechResult || ''
  const caller = req.body.From || 'unknown'

  console.log(`Kund sa: "${speechResult}"`)

  const transferKeywords = ['människa', 'person', 'agent', 'hjälp', 'prata med någon', 'human']
  const wantsTransfer = transferKeywords.some(kw =>
    speechResult.toLowerCase().includes(kw)
  )

  if (wantsTransfer) {
    twiml.say({ voice: 'Polly.Astrid', language: 'sv-SE' },
      'Självklart, jag kopplar dig vidare. Ett ögonblick.'
    )
    twiml.redirect('/voice/transfer/warm')
  } else {
    try {
      const supabaseUrl = process.env.SUPABASE_URL
      const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY

      if (supabaseUrl && supabaseKey) {
        const response = await fetch(`${supabaseUrl}/functions/v1/chat`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${supabaseKey}`
          },
          body: JSON.stringify({
            message: speechResult,
            site_key: 'inntello',
            channel: 'voice',
            caller
          })
        })
        const data = await response.json()
        const aiReply = data.reply || 'Förlåt, jag förstod inte riktigt. Kan du upprepa?'
        const gather = twiml.gather({
          input: 'speech',
          language: 'sv-SE',
          action: '/voice/process',
          method: 'POST',
          speechTimeout: 'auto',
          timeout: 5
        })
        gather.say({ voice: 'Polly.Astrid', language: 'sv-SE' }, aiReply)
      } else {
        const gather = twiml.gather({
          input: 'speech',
          language: 'sv-SE',
          action: '/voice/process',
          method: 'POST',
          speechTimeout: 'auto',
          timeout: 5
        })
        gather.say({ voice: 'Polly.Astrid', language: 'sv-SE' },
          'Tack för ditt samtal. Hur kan jag hjälpa dig vidare?'
        )
      }
    } catch (err) {
      console.error('Process error:', err)
      twiml.say({ voice: 'Polly.Astrid', language: 'sv-SE' },
        'Förlåt, ett tekniskt fel uppstod. Försök igen om en stund.'
      )
    }
  }

  res.type('text/xml')
  res.send(twiml.toString())
})

// ── SAMTALSSTATUS ──────────────────────────────────────────────────
app.post('/voice/status', async (req, res) => {
  const { CallStatus, From, CallDuration } = req.body
  console.log(`Samtalsstatus: ${CallStatus}, duration: ${CallDuration}s`)
  const supabase = getSupabase()
  if (supabase) {
    await supabase.from('calls')
      .update({
        status: CallStatus,
        duration_seconds: parseInt(CallDuration || '0'),
        ended_at: new Date().toISOString()
      })
      .eq('caller_number', From)
  }
  res.sendStatus(200)
})

// ── VARM TRANSFER ──────────────────────────────────────────────────
app.post('/voice/transfer/warm', (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse()
  twiml.say({ voice: 'Polly.Astrid', language: 'sv-SE' },
    'Tyvärr är transfer-funktionen inte konfigurerad ännu. Tack för ditt samtal.'
  )
  res.type('text/xml')
  res.send(twiml.toString())
})

// ── INKOMMANDE SMS ─────────────────────────────────────────────────
app.post('/sms/incoming', async (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse()
  const { From, Body } = req.body
  console.log(`SMS från ${From}: ${Body}`)
  twiml.message('Tack för ditt meddelande! Vi återkommer inom kort.')
  res.type('text/xml')
  res.send(twiml.toString())
})

// ── STARTA SERVER ──────────────────────────────────────────────────
const PORT = process.env.PORT || 3000
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Inntello webhook server körs på port ${PORT}`)
  console.log(`TWILIO_ACCOUNT_SID: ${process.env.TWILIO_ACCOUNT_SID ? 'OK' : 'SAKNAS'}`)
  console.log(`SUPABASE_URL: ${process.env.SUPABASE_URL ? 'OK' : 'SAKNAS'}`)
})
